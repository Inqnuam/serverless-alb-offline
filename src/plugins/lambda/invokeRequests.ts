import type { OfflineRequest } from "../../defineConfig";
import { errorType, parseBody, parseClientContext, collectBody, InvokationType, isStreamResponse, setRequestId, invalidPayloadErrorMsg, base64ErorMsg, notFound } from "./utils";
import { Handlers } from "../../lib/server/handlers";
import { log } from "../../lib/utils/colorize";
import { BufferedStreamResponse } from "../../lib/runtime/bufferedStreamResponse";

export const invokeRequests: OfflineRequest = {
  filter: /(^\/2015-03-31\/functions\/)|(^\/@invoke\/)/,
  callback: async function (req, res) {
    const { url, method, headers } = req;
    const parsedURL = new URL(url as string, "http://localhost:3003");

    const requestedName = Handlers.parseNameFromUrl(parsedURL.pathname);
    const foundHandler = Handlers.handlers.find((x) => x.name == requestedName || x.outName == requestedName);
    const awsRequestId = setRequestId(res);
    res.setHeader("Content-Type", "application/json");

    req.on("error", (err) => {
      res.statusCode = 502;
      res.end(JSON.stringify(err));
    });

    if (!foundHandler) {
      res.statusCode = 404;
      res.setHeader("x-amzn-errortype", errorType.notFound);
      return res.end(notFound(requestedName));
    }

    const invokeType = headers["x-amz-invocation-type"];
    const clientContext = parseClientContext(headers["x-amz-client-context"] as string);

    if (clientContext instanceof Error) {
      res.setHeader("x-amzn-errortype", errorType.invalidRequest);
      res.statusCode = 400;
      return res.end(base64ErorMsg);
    }

    const exceptedStatusCode = invokeType == "DryRun" ? InvokationType.DryRun : invokeType == "Event" ? InvokationType.Event : InvokationType.RequestResponse;

    const collectedBody = await collectBody(req);
    const body: any = parseBody(collectedBody);
    res.setHeader("X-Amzn-Trace-Id", `root=1-xxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxx;sampled=0`);

    if (body instanceof Error) {
      res.statusCode = 400;
      res.setHeader("x-amzn-errortype", errorType.invalidRequest);

      return res.end(invalidPayloadErrorMsg(body.message));
    }

    res.setHeader("X-Amz-Executed-Version", "$LATEST");

    const date = new Date();

    let info: any = {};
    res.statusCode = exceptedStatusCode;
    if (exceptedStatusCode !== 200) {
      res.end();
    }
    // "Event" invokation type is an async invoke
    if (exceptedStatusCode == 202) {
      // required for destinations executions
      info.kind = "async";
    }
    log.CYAN(`${date.toLocaleDateString()} ${date.toLocaleTimeString()} requestId: ${awsRequestId} | '${foundHandler.name}' ${method}`);

    try {
      const result = await foundHandler.invoke(body, info, clientContext);
      if (exceptedStatusCode == 200) {
        if (result) {
          const isStreamRes = isStreamResponse(result);
          let response = isStreamRes ? result.buffer : result;

          if (isStreamRes) {
            response = BufferedStreamResponse.codec.decode(response);
          } else {
            try {
              JSON.parse(response);
            } catch (error) {
              response = JSON.stringify(response);
            }
          }

          res.end(response);
        } else {
          res.end();
        }
      }
    } catch (error: any) {
      console.error(error);
      if (!res.writableFinished) {
        res.setHeader("X-Amz-Function-Error", error.errorType ?? error.message ?? "");
        res.statusCode = 200;
        res.end(JSON.stringify(error));
      }
    }
  },
};
