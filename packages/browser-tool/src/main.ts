import { z } from "zod";
import { BrowserSessions } from "./browser.js";
import { BrowserToolPolicySchema } from "./policy.js";
import { startBrowserToolServer } from "./server.js";

const env = z
  .object({
    BROWSER_TOOL_PORT: z.coerce.number().int().default(41850),
    BROWSER_TOOL_ALLOWED_ORIGINS: z.string().default(""),
    PLAYWRIGHT_CHROMIUM_EXECUTABLE: z.string().optional(),
  })
  .parse(process.env);

const policy = BrowserToolPolicySchema.parse({
  allowedOrigins: env.BROWSER_TOOL_ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter((value) => value.length > 0),
});
const sessions = new BrowserSessions({ policy, ...(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

startBrowserToolServer({ port: env.BROWSER_TOOL_PORT, sessions })
  .then(() => {
    const shutdown = (): void => {
      sessions.shutdown().finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  })
  .catch((error: unknown) => {
    process.stderr.write(`browser tool failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
