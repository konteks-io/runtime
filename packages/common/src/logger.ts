import { pino, type Logger as PinoLogger, type LoggerOptions } from "pino";
import { redactText, redactValue } from "./redaction.js";
import { repeatedLogOutput } from "./repeated-log.js";

export type Logger = PinoLogger;

interface CreateLoggerOptions {
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
      bindings: (bindings) => redactValue(bindings) as Record<string, unknown>,
      log: (object) => redactValue(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const redacted = args.map((arg) => (typeof arg === "string" ? redactText(arg) : arg));
        method.apply(this, redacted as Parameters<typeof method>);
      },
    },
  };
  const logger = pino(pinoOptions, pinoOptions.level === "silent" ? undefined : repeatedLogOutput());
  // Pino resets the bindings formatter for children created without options.
  // Redact before serialization; descendants inherit this method as well.
  const child = logger.child;
  logger.child = function (this: Logger, bindings, childOptions) {
    return child.call(this, redactValue(bindings) as Record<string, unknown>, childOptions);
  } as typeof logger.child;
  return logger;
}

export const nullLogger: Logger = pino({ level: "silent" });
