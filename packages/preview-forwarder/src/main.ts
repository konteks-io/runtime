import { createServer } from "node:http";
import { z } from "zod";
import { ForwarderLink } from "./link.js";

const env = z
  .object({
    PREVIEW_FORWARDER_SUPERVISOR_URL: z.string().url().default("ws://supervisor:41820"),
    PREVIEW_FORWARDER_STATUS_PORT: z.coerce.number().int().default(41860),
  })
  .parse(process.env);

const link = new ForwarderLink({ supervisorUrl: env.PREVIEW_FORWARDER_SUPERVISOR_URL });
link.start();

/** Exposure display: what this forwarder currently maps, for `konteks-remote status`/doctor. */
createServer((request, response) => {
  if (request.url === "/health" || request.url === "/status") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(link.status()));
    return;
  }
  response.statusCode = 404;
  response.end();
}).listen(env.PREVIEW_FORWARDER_STATUS_PORT, "0.0.0.0");

const shutdown = (): void => {
  link.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
