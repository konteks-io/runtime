import type { RuntimeSkillPublicationReceipt } from "@konteks/backstage-plugin-common/remote-instance-internal";

export type SkillPublicationConcurrentReplacement = {
  skillId: string;
  observedRevisionId: string;
  replacedRevisionId: string;
  acceptedRevisionId: string;
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
