import type { RuntimeSkillPublicationReceipt } from "@konteks/backstage-plugin-common/remote-instance-internal";

export type SkillPublicationConcurrentReplacement = {
  skillId: string;
  observedRevisionId: string;
  replacedRevisionId: string;
  acceptedRevisionId: string;
};

type AcceptedPublication = {
  selection: { skillId?: string | undefined };
  receipt: RuntimeSkillPublicationReceipt;
};

export function skillPublicationConcurrentReplacement(
  skillId: string,
  observedRevisionId: string | undefined,
  receipt: RuntimeSkillPublicationReceipt,
): SkillPublicationConcurrentReplacement | undefined {
  if (
    !observedRevisionId ||
    receipt.baseRevisionId !== observedRevisionId ||
    !receipt.replacedRevisionId ||
    receipt.replacedRevisionId === observedRevisionId
  )
    return undefined;
  return {
    skillId,
    observedRevisionId,
    replacedRevisionId: receipt.replacedRevisionId,
    acceptedRevisionId: receipt.revisionId,
  };
}

export function skillPublicationConcurrentReplacements(
  records: readonly AcceptedPublication[],
  limit = 20,
): SkillPublicationConcurrentReplacement[] {
  return records
    .flatMap((record) => {
      const skillId = record.selection.skillId;
      if (!skillId) return [];
      const replacement = skillPublicationConcurrentReplacement(
        skillId,
        record.receipt.baseRevisionId,
        record.receipt,
      );
      return replacement ? [{ sequence: record.receipt.acceptedSequence, replacement }] : [];
    })
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-limit)
    .map(({ replacement }) => replacement);
}
