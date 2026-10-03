import { expect } from "vitest";
import type { DoctorReport } from "@konteks/remote-common";

/** A doctor report must never carry a filesystem path. */
export function expectNoPath(report: DoctorReport): void {
  expect(JSON.stringify(report)).not.toMatch(/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//);
}
