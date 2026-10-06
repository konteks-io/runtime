import { expect, it, vi } from "vitest";
import { FixedClock, generateInstanceKey } from "@konteks/remote-common";
import { CoreClient } from "../core/client.js";

it("reads an admitted Ops workload without widening the strict response shape", async () => {
  const body = { assignmentId: "assignment", attempt: 1, kind: "operations", workload: { sessionId: "session" } };
  const fetchFn = vi.fn(async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
  const key = generateInstanceKey();
  const client = new CoreClient({ baseUrl: "https://core.example", clock: new FixedClock(Date.now()), key: () => key, credential: () => "fixture-lease", fetchFn });
  await expect(client.fetchWorkload("instance", "assignment")).resolves.toEqual(body);
});
