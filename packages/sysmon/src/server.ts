import { createServer, type Server } from "node:http";
import { createLogger } from "@konteks/remote-common";
import { SignalSampler } from "./signals.js";

export interface SysmonServerOptions {
  port: number;
  dataRoot: string;
  bindHost?: string;
}

/**
 * `GET /metrics` on the internal control network only. No other route exists;
 * everything else is 404. The service runs read-only with no volumes but the
 * data root it measures free space for.
 */
export function startSysmonServer(options: SysmonServerOptions): Promise<Server> {
  const logger = createLogger({ name: "sysmon" });
  const sampler = new SignalSampler(options.dataRoot);
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/metrics") {
      sampler
        .sample()
        .then((signals) => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(signals));
        })
        .catch((error: unknown) => {
          logger.warn({ err: error }, "sysmon sample failed");
          response.statusCode = 500;
          response.end();
        });
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.end("ok");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.bindHost ?? "0.0.0.0", () => {
      logger.info({ port: options.port }, "sysmon listening");
      resolve(server);
    });
  });
}
