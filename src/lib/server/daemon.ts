import http, { Server, IncomingMessage, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { networkInterfaces } from "os";
import { Handlers } from "./handlers";
import { type ILambdaMock, LambdaMock } from "../runtime/rapidApi";
import { log } from "../utils/colorize";
import inspector from "inspector";
import { html404 } from "../../plugins/lambda/htmlStatusMsg";
import serveStatic from "serve-static";
import { randomUUID } from "crypto";
import { CommonEventGenerator } from "../../plugins/lambda/events/common";
import { defaultServer } from "../../plugins/lambda/defaultServer";
import { UnsupportedRuntime } from "../runtime/runners/index";
import { NodeRunner } from "../runtime/runners/node/runner";
import { PythonRunner } from "../runtime/runners/python/runner";
import { RubyRunner } from "../runtime/runners/ruby/runner";
import { initEventSourceMapping } from "../runtime/eventSourceMapping/utils";
import type { Socket } from "net";

enum runners {
  node = "n",
  python = "p",
  ruby = "r",
}

let localIp: string;
if (networkInterfaces) {
  localIp = Object.values(networkInterfaces())
    .reduce((accum: any[], obj: any) => {
      accum.push(...obj);
      return accum;
    }, [])
    ?.filter((item) => !item.internal && item.family === "IPv4")
    .find(Boolean)?.address;
}

const debuggerIsAttached = inspector?.url() != undefined;

if (debuggerIsAttached) {
  console.warn("Lambdas timeout are disabled when a Debugger is attached");
  LambdaMock.ENABLE_TIMEOUT = false;
}

const fakeBuildResult = {
  errors: [],
  warnings: [],
  outputFiles: [],
  metafile: { inputs: {}, outputs: {} },
  mangleCache: {},
};

interface IDaemonConfig {
  debug: boolean;
}
export class Daemon extends Handlers {
  #server: Server;
  runtimeConfig: any = {};
  #serve: any;
  sco: Socket[] = [];
  customOfflineRequests: {
    method?: string | string[];
    filter: RegExp | string;
    callback: (req: any, res: any) => Promise<any> | any | undefined;
  }[] = [];
  customBuildCallback?: Function;
  onReady?: (port: number, ip: string) => any;
  stop(cb?: (err?: any) => void) {
    this.#server.close(cb);
  }

  #keys: string[] = [];
  #getKeys(keys: any[], genereatedKeys: Record<string, string>) {
    for (const k of keys) {
      if (typeof k == "string") {
        const value = Buffer.from(randomUUID(), "utf-8").toString("base64");
        this.#keys.push(value);
        genereatedKeys[k] = value;
      } else if (k && typeof k == "object" && !Array.isArray(k)) {
        if (typeof k.value == "string") {
          this.#keys.push(k.value);
        } else {
          for (const keysWithUsagePlan of Object.values(k)) {
            if (Array.isArray(keysWithUsagePlan)) {
              this.#getKeys(keysWithUsagePlan, genereatedKeys);
            }
          }
        }
      }
    }
  }
  setApiKeys(keys?: any[]) {
    if (!keys) {
      return;
    }

    const genereatedKeys: Record<string, string> = {};
    this.#getKeys(keys, genereatedKeys);

    if (Object.keys(genereatedKeys).length) {
      console.log("\n\x1b[90mREST API Gateway generated API Keys:\x1b[0m");

      for (const [key, value] of Object.entries(genereatedKeys)) {
        console.log(`\x1b[35m${key}: \x1b[0m\x1b[36m${value}\x1b[0m`);
      }
    }
  }

  constructor(config: IDaemonConfig = { debug: false }) {
    super(config);
    log.setDebug(config.debug);
    this.sco = [];
    this.#server = http.createServer({ maxHeaderSize: 105536 }, this.#requestListener.bind(this));
    this.#server.on("connection", (socket) => {
      socket.on("close", () => {
        const connectionIndex = this.sco.findIndex((x) => x == socket);
        if (connectionIndex != -1) {
          this.sco.splice(connectionIndex, 1);
        }
      });

      this.sco.push(socket);
    });
    const uuid = randomUUID();
    CommonEventGenerator.accountId = Buffer.from(uuid).toString("hex").slice(0, 16);
    CommonEventGenerator.apiId = Buffer.from(uuid).toString("ascii").slice(0, 10);
    CommonEventGenerator.port = this.port;
  }

  setPort(p: number) {
    this.port = p;
    CommonEventGenerator.port = p;
  }

  set serve(root: string) {
    this.#serve = serveStatic(root);
  }
  listen(port = 0, callback?: Function) {
    if (isNaN(port)) {
      throw Error("port should be a number");
    }
    this.#server.once("error", async (err: any) => {
      if (err.code === "EADDRINUSE") {
        log.RED(err.message);
        process.exit(1);
      } else {
        console.log(err);
      }
    });
    this.#server.listen(port, async () => {
      const { port: listeningPort, address } = this.#server.address() as AddressInfo;

      this.setPort(listeningPort);
      if (localIp) {
        Handlers.ip = localIp;
      }
      if (typeof callback == "function") {
        await callback(listeningPort, localIp);
      }
      try {
        await this.onReady?.(listeningPort, Handlers.ip);
        await initEventSourceMapping(this.handlers);
      } catch (error) {
        console.error(error);
      }
      process.send?.({ port: listeningPort, ip: Handlers.ip });
    });
  }

  #findRequestHandler(method: string, pathname: string) {
    pathname = pathname.endsWith("/") ? pathname : `${pathname}/`;
    const foundCustomCallback = this.customOfflineRequests.find((x) => {
      let validPath = false;
      let validMethod = true;
      if (typeof x.filter == "string") {
        if (!x.filter.endsWith("/")) {
          x.filter += "/";
        }
        validPath = x.filter == pathname;
      } else if (x.filter instanceof RegExp) {
        validPath = x.filter.test(pathname);
      }
      if (typeof x.method == "string" && x.method.toUpperCase() != "ANY") {
        validMethod = x.method.toUpperCase() == method;
      } else if (Array.isArray(x.method)) {
        const foundAny = x.method.findIndex((x) => x.toUpperCase() == "ANY") !== -1;
        if (!foundAny) {
          validMethod = x.method.findIndex((x) => x.toUpperCase() == method) !== -1;
        }
      }

      return validPath && validMethod;
    });
    if (foundCustomCallback) {
      return foundCustomCallback.callback;
    }
  }
  async #requestListener(req: IncomingMessage, res: ServerResponse) {
    const { url, method } = req;
    const parsedURL = new URL(url as string, CommonEventGenerator.dummyHost);

    const customCallback = this.#findRequestHandler(method!, parsedURL.pathname);

    if (customCallback) {
      //SECTION: Route @invoke, @url and other routes provided by plugins
      try {
        await customCallback(req, res);
      } catch (err) {
        if (!res.writableFinished) {
          res.end("Internal Server Error");
        }
      }
    } else {
      // fallback to ALB and APG server

      req.on("error", (err) => {
        console.error(err.stack);
      });

      const foundLambda = await defaultServer(req, res, this, parsedURL, this.#keys);

      const notFound = () => {
        res.setHeader("Content-Type", "text/html");
        res.statusCode = 404;
        res.end(html404);
      };

      if (!foundLambda) {
        if (this.#serve) {
          this.#serve(req, res, notFound);
        } else {
          notFound();
        }
      }
    }
  }

  fakeRebuildEmitter = async () => {
    if (this.customBuildCallback) {
      try {
        await this.customBuildCallback(fakeBuildResult, true);
      } catch (error) {
        console.log(error);
      }
    }
    console.log(`\x1b[32m${new Date().toLocaleString()} 🔄✅ Rebuild\x1b[0m`);
    process.send?.({ rebuild: true });
  };
  async load(lambdaDefinitions: ILambdaMock[]) {
    for (const lambda of lambdaDefinitions) {
      const r = lambda.runtime.charAt(0);
      lambda.runner =
        r == runners.node
          ? new NodeRunner(lambda)
          : r == runners.python
            ? new PythonRunner(lambda, this.fakeRebuildEmitter)
            : r == runners.ruby
              ? new RubyRunner(lambda, this.fakeRebuildEmitter)
              : new UnsupportedRuntime(lambda.runtime);

      const lambdaController = new LambdaMock(lambda);

      this.addHandler(lambdaController);
    }
  }
}
