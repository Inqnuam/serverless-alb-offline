import type { PluginBuild, BuildResult } from "esbuild";
import type { Config, OfflineConfig } from "./config";
import type { ILambdaMock } from "./lib/runtime/rapidApi";
import type { HttpMethod } from "./lib/server/handlers";
import type { IncomingMessage, ServerResponse } from "http";
import type Serverless from "serverless";
import { log } from "./lib/utils/colorize";
import type { SQSClientConfig, SQSClient } from "@aws-sdk/client-sqs";
import type { ILambdaFunction } from "./standalone_types";

export type ILambda = {
  /**
   * Set environment variable.
   */
  setEnv: (key: string, value: string | null) => void;
  virtualEnvs?: {
    [key: string]: any;
  };
  /**
   * Be notified when this lambda is invoked.
   *
   * Can be used to edit (local) input payload before invokation.
   */
  onInvoke: (callback: (event: any, info?: any) => void) => void | { [key: string]: any };
  /**
   * Called when handler throws an error.
   */
  onInvokeError: (callback: (input: any, error: any, info?: any) => void) => void;
  /**
   * Called when handler returns successfully.
   */
  onInvokeSuccess: (callback: (input: any, output: any, info?: any) => void) => void;
} & Omit<ILambdaMock, "invokeSub" | "invokeSuccessSub" | "invokeErrorSub" | "runner">;

interface IServicesConfig {
  sqs?: SQSClientConfig;
}

export interface ClientConfigParams {
  stop: (err?: any) => Promise<void>;
  lambdas: ILambda[];
  isDeploying: boolean;
  isPackaging: boolean;
  /**
   * @deprecated use `someLambda.setEnv(key, value)` instead.
   */
  setEnv: (lambdaName: string, key: string, value: string) => void;
  stage: string;
  region: string;
  esbuild: PluginBuild["esbuild"];
  config: Config;
  options: Options;
  serverless: Serverless;
  resources: {
    ddb: {};
    kinesis: {};
    sns: {};
    sqs: {};
  };
  getServices(): { sqs?: SQSClient };
  setServices({ sqs }: IServicesConfig): Promise<void>;
  /** Must be called only inside `onInit`, otherwise it has no effect */
  addLambda(func: ILambdaFunction): void;
}

export interface OfflineRequest {
  /**
   * @default "ANY"
   */
  method?: HttpMethod | HttpMethod[];
  /**
   * Filter for request path.
   */
  filter: string | RegExp;
  callback: (this: ClientConfigParams, req: IncomingMessage, res: ServerResponse) => Promise<any | void> | any | void;
}

export interface SlsAwsLambdaPlugin {
  name: string;
  /**
   * Share any data with other plugins
   */
  pluginData?: any;
  buildCallback?: (this: ClientConfigParams, result: BuildResult, isRebuild: boolean) => Promise<void> | void;
  onInit?: (this: ClientConfigParams) => Promise<void> | void;
  onKill?: (this: ClientConfigParams) => Promise<void> | void;
  afterDeploy?: (this: ClientConfigParams) => Promise<void> | void;
  afterPackage?: (this: ClientConfigParams) => Promise<void> | void;
  server?: {
    onReady?: (this: ClientConfigParams, port: number, ip: string) => Promise<void> | void;
    /**
     * Add new requests to the local server.
     */
    request?: OfflineRequest[];
  };
}

export interface Options {
  esbuild?: Config["esbuild"];
  /**
   * shim `require`, `__dirname` and `__filename` when bundeling Lambdas with ESM format
   * @default false
   */
  shimRequire?: boolean;
  /**
   * Speed up build process during dev mode
   * @default true
   */
  optimizeBuild?: boolean;
  server?: {
    /**
     * Serve files locally from provided directory
     */
    staticPath?: string;
    port?: number;
  };
  /**
   * Only SlsAwsLambdaPlugin type objects are considered as valid plugins.
   *
   * Others are ignored.
   *
   * This allows conditionnally ( condition == true ?? customPlugin) plugin import.
   */
  plugins?: (SlsAwsLambdaPlugin | null | undefined | boolean)[];
  /**
   * AWS clients configs used by EventSourceMapping, Lambda error/success destination.
   */
  services?: IServicesConfig;
  functions?: ILambdaFunction[];
}

function defineConfig(options: Options) {
  // validate plugin names
  const pluginNames = new Set();

  if (options.plugins) {
    options.plugins = options.plugins.filter((plugin, index) => {
      if (typeof plugin != "object" || !plugin || !("name" in plugin)) {
        return false;
      }
      if (!plugin.name || !plugin.name.length || typeof plugin.name != "string") {
        plugin.name = "plugin-" + index;
        log.YELLOW(`Invalid plugin name at index ${index}`);
      }
      const exists = pluginNames.has(plugin.name);
      if (exists) {
        plugin.name = plugin.name + index;
      } else {
        pluginNames.add(plugin.name);
      }
      return true;
    });
  }
  return async function config(
    this: ClientConfigParams,
    { stop, lambdas, isDeploying, isPackaging, setEnv, stage, region, esbuild, serverless, resources, getServices, setServices, addLambda }: ClientConfigParams
  ): Promise<Omit<Config, "config" | "options">> {
    let config: Config = {
      esbuild: options.esbuild ?? {},
      shimRequire: options.shimRequire,
      optimizeBuild: options.optimizeBuild,
      server: {
        staticPath: options.server?.staticPath,
        port: options.server?.port,
      },
      afterDeployCallbacks: [],
      afterPackageCallbacks: [],
      onKill: [],
    };

    if (Array.isArray(options.functions)) {
      options.functions.forEach((f) => {
        addLambda(f);
      });
    }

    if (options.services) {
      await setServices(options.services);
    }

    const self = {
      stop,
      lambdas,
      isDeploying,
      isPackaging,
      setEnv,
      stage,
      region,
      esbuild,
      serverless,
      options,
      config,
      resources,
      getServices,
      setServices,
      addLambda,
    };
    if (options.plugins) {
      config.server!.onReady = async (port, ip) => {
        for (const plugin of options.plugins! as SlsAwsLambdaPlugin[]) {
          if (plugin.server?.onReady) {
            try {
              await plugin.server.onReady!.call(self, port, ip);
            } catch (error) {
              log.RED(plugin.name);
              console.error(error);
            }
          }
        }
      };

      config.buildCallback = async (result, isRebuild) => {
        for (const plugin of options.plugins! as SlsAwsLambdaPlugin[]) {
          if (plugin.buildCallback) {
            try {
              await plugin.buildCallback.call(self, result, isRebuild);
            } catch (error) {
              log.RED(plugin.name);
              console.error(error);
              if (!isRebuild) {
                process.exit(1);
              }
            }
          }
        }
      };

      const pluginsRequests: OfflineConfig["request"] = (options.plugins as SlsAwsLambdaPlugin[]).reduce((accum: OfflineConfig["request"], obj) => {
        if (obj.server?.request?.length) {
          accum!.push(...obj.server.request);
        }
        return accum;
      }, []);
      if (pluginsRequests?.length) {
        config.server!.request = pluginsRequests.map((x) => {
          x.callback = x.callback.bind(self);

          return x;
        });
      }
      for (const plugin of options.plugins! as SlsAwsLambdaPlugin[]) {
        if (plugin.onKill) {
          config.onKill!.push(plugin.onKill.bind(self));
        }

        if (typeof plugin.afterDeploy == "function") {
          config.afterDeployCallbacks!.push(plugin.afterDeploy.bind(self));
        }

        if (typeof plugin.afterPackage == "function") {
          config.afterPackageCallbacks!.push(plugin.afterPackage.bind(self));
        }

        if (plugin.onInit) {
          try {
            await plugin.onInit.call(self);
          } catch (error) {
            log.RED(plugin.name);
            console.error(error);
          }
        }
      }
    }

    if (!config.afterDeployCallbacks!.length) {
      delete config.afterDeployCallbacks;
    }
    if (!config.afterPackageCallbacks!.length) {
      delete config.afterPackageCallbacks;
    }

    return config;
  };
}
export { defineConfig };
export default defineConfig;
