import { z } from "zod";

/** Local endpoint identity only; it never grants upstream or execution authority. */
export const McpLocalTransportIdentitySchema = z.object({
  port: z.number().int().min(1).max(65535),
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type McpLocalTransportIdentity = z.infer<typeof McpLocalTransportIdentitySchema>;

/** Companion endpoints cached by the same provider thread, including its browser proxy. */
export const SessionToolTransportsSchema = z.object({
  version: z.literal(1),
  preview: McpLocalTransportIdentitySchema.optional(),
  result: McpLocalTransportIdentitySchema.optional(),
  browser: z.object({
    port: z.number().int().min(1).max(65535),
    // A generated basename under the host temporary directory, never a supplied path.
    outputDirectoryName: z.string().regex(/^konteks-browser-[A-Za-z0-9_-]{6,64}$/),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  const ports = [value.preview?.port, value.result?.port, value.browser?.port].filter(port => port !== undefined);
  if (new Set(ports).size !== ports.length) context.addIssue({ code: "custom", message: "Session tool transports must use distinct ports" });
});
export type SessionToolTransports = z.infer<typeof SessionToolTransportsSchema>;
