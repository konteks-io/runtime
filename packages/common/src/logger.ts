import { pino, type Logger as PinoLogger, type LoggerOptions } from "pino";
import { redactText, redactValue } from "./redaction.js";

export type Logger = PinoLogger;

export interface CreateLoggerOptions {
  name: string;
  level?: "error" | "warn" | "info" | "debug";
  silent?: boolean;
}

/**
 * Structured, bounded, redacted-before-persistence logging. Every field goes
 * through the redactor; raw command stdout, ACP payloads, and provider bodies
 * are never log fields (callers log identifiers and sizes instead).
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const silent = options.silent ?? process.env.LOG_SILENT === "true";
  const pinoOptions: LoggerOptions = {
    name: options.name,
    level: silent ? "silent" : (options.level ?? process.env.LOG_LEVEL ?? "info"),
    // No pid/hostname: a host identifier is a forbidden public field.
    base: null,
    formatters: {
      log: (object) => redactValue(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const redacted = args.map((arg) => (typeof arg === "string" ? redactText(arg) : arg));
        method.apply(this, redacted as Parameters<typeof method>);
      },
    },
  };
  return pino(pinoOptions);
}

export const nullLogger: Logger = pino({ level: "silent" });
