import { describe, expect, it } from "vitest";
import { skillPublicationConcurrentReplacements } from "../native/skill-publication-events.js";

const receipt = (acceptedSequence: number, replacedRevisionId?: string) => ({
  publicationId: "publication-a",
  revisionId: `revision-${acceptedSequence}`,
  acceptedSequence,
  treeDigest: `digest-${acceptedSequence}`,
  ...(replacedRevisionId
    ? { baseRevisionId: "revision-base", replacedRevisionId }
    : {}),
});

describe("skill publication replacement reporting", () => {
  it("restores concurrent replacements from accepted receipts in server order", () => {
    const result = skillPublicationConcurrentReplacements([
      {
        selection: { skillId: "skill-late" },
        receipt: receipt(9, "revision-raced-late"),
      },
      {
        selection: { skillId: "skill-early" },
        receipt: receipt(3, "revision-raced-early"),
      },
      { selection: { skillId: "skill-current" }, receipt: receipt(10) },
      { selection: {}, receipt: receipt(11, "revision-unidentified") },
    ]);

    expect(result).toEqual([
      {
        skillId: "skill-early",
        observedRevisionId: "revision-base",
        replacedRevisionId: "revision-raced-early",
        acceptedRevisionId: "revision-3",
      },
      {
        skillId: "skill-late",
        observedRevisionId: "revision-base",
        replacedRevisionId: "revision-raced-late",
        acceptedRevisionId: "revision-9",
      },
    ]);
  });

  it("keeps only the newest accepted replacement receipts", () => {
    const records = Array.from({ length: 25 }, (_, acceptedSequence) => ({
      selection: { skillId: `skill-${acceptedSequence}` },
      receipt: receipt(acceptedSequence + 1, `revision-raced-${acceptedSequence}`),
    }));

    const result = skillPublicationConcurrentReplacements(records, 20);

    expect(result).toHaveLength(20);
    expect(result[0]?.acceptedRevisionId).toBe("revision-6");
    expect(result.at(-1)?.acceptedRevisionId).toBe("revision-25");
  });
});
