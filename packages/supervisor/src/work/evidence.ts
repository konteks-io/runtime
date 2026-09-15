/**
 * Evidence authority is most-restrictive (invariant 33): the per-instance
 * desired configuration is a ceiling and the per-assignment policy may only
 * narrow it. `selected_artifacts` requires BOTH authorities to allow it;
 * anything else is `structured_only`. No component or caller can widen.
 */
export type EvidenceUpload = "structured_only" | "selected_artifacts";

export function intersectEvidencePolicy(instance: EvidenceUpload, assignment: EvidenceUpload): EvidenceUpload {
  return instance === "selected_artifacts" && assignment === "selected_artifacts" ? "selected_artifacts" : "structured_only";
}
