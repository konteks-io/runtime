import { z } from "zod";

/** Local launcher hand-off of the release already verified by the service. */
export const NATIVE_UPDATE_TARGET_ENV = "KONTEKS_NATIVE_UPDATE_TARGET";
export const NativeUpdateTargetSchema = z.object({
  bundleVersion: z.string().min(1).max(128),
  manifestDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
