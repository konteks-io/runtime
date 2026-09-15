/** Executes the D143 Markdown schema annexes against sibling shared source schemas.
 * No generated files, production exports, services or credentials are involved.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { require as tsxRequire } from "tsx/cjs/api";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shared = resolve(root, "../packages/packages/backstage-plugin-common/src/remote-instance");
const draftPath = resolve(root, "proof/runtime-assignment-wire-draft.md");
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--pending-claims"),
  "usage: node scripts/validate-assignment-wire-draft.mjs [--pending-claims]",
);
const includePendingClaims = args[0] === "--pending-claims";
const draftPaths = [
  draftPath,
  ...(includePendingClaims ? [resolve(root, "proof/pending-claim-recovery-wire-draft.md")] : []),
];
const blocks = draftPaths.flatMap((path) => {
  const markdown = readFileSync(path, "utf8");
  const extracted = [...markdown.matchAll(/^```ts\n([\s\S]*?)^```/gm)].map((match) => match[1]);
  assert.ok(extracted.length > 0, `${path} must contain executable TypeScript blocks`);
  return extracted;
});
const source = blocks.join("\n\n");
// A virtual sibling module preserves real relative imports without writing or
// changing the shared package. Semantic diagnostics catch undefined types too.
const virtualPath = resolve(shared, "__assignment_wire_draft_validation__.ts");
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  types: ["node"],
  typeRoots: [resolve(root, "node_modules/@types")],
};
const host = ts.createCompilerHost(options);
const getSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (path, ...args) =>
  path === virtualPath
    ? ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true)
    : getSourceFile(path, ...args);
const program = ts.createProgram([virtualPath], options, host);
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter((d) => d.category === ts.DiagnosticCategory.Error);
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    }),
  );
  process.exit(1);
}
const parsed = ts.createSourceFile("wire-draft.ts", source, ts.ScriptTarget.Latest, true);
const names = [];
for (const statement of parsed.statements) {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    }
  } else if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text);
}
const compiled = ts.transpileModule(`${source}\nmodule.exports = { ${names.join(", ")} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
assert.equal(
  compiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length,
  0,
  "draft snippets must have valid TypeScript syntax",
);
const localRequire = createRequire(import.meta.url);
const load = (id) =>
  id.startsWith("./")
    ? tsxRequire(resolve(shared, id.replace(/\.js$/, ".ts")), import.meta.url)
    : localRequire(id);
const module = { exports: {} };
vm.runInNewContext(
  compiled.outputText,
  { module, exports: module.exports, require: load, Buffer },
  { filename: draftPath, timeout: 10_000 },
);
const d = module.exports;
const failures = [];
let passed = 0;
function check(name, run) {
  try {
    run();
    passed += 1;
  } catch (error) {
    failures.push({ name, error: error.message });
  }
}
const valid = (schema, value) => assert.equal(schema.safeParse(value).success, true);
const invalid = (schema, value) => assert.equal(schema.safeParse(value).success, false);
const at = "2026-09-06T00:00:00.000Z";
const digest = "A".repeat(43);
const channelId = "assignment:instance";
const origin = { runnerIncarnation: "origin-process", manifestId: "origin-manifest" };
const frame = {
  channel: "assignment",
  channelId,
  direction: "to_core",
  seq: 1,
  connectionEpoch: 7,
  issuedAt: at,
  origin,
  body: { instanceId: "instance", maxItems: 1, acceptedKinds: ["assistant_execution"] },
};
const { connectionEpoch: _epoch, ...logical } = frame;
const originFrame = { ...frame, origin };
const originLogical = { ...logical, origin };
const requestRef = {
  requestSequence: 1,
  requestDigest: d.assignmentRequestDigest(frame),
  requestKind: "pull",
};
const reply = { ...requestRef, body: { assignments: [] } };
const replyFrame = {
  channel: "assignment",
  channelId,
  direction: "to_runtime",
  seq: 1,
  connectionEpoch: 7,
  issuedAt: at,
  body: reply,
};
const { connectionEpoch: _replyEpoch, ...logicalReply } = replyFrame;
const nativeIdentity = {
  instanceId: "instance",
  runnerIncarnation: "process",
  manifestId: "manifest",
  receiptDigest: digest,
  leaseJti: "lease",
};
const auth = {
  ...nativeIdentity,
  requestedAt: at,
  proof: { algorithm: "ES256", nonce: "A".repeat(22), signature: "AA" },
};
const responseContext = { ...nativeIdentity, requestNonce: auth.proof.nonce };
const runtimeContext = { instanceId: "instance", connectionRef: "connection", connectionEpoch: 7 };
const delivery = {
  type: "runtime_assignment_delivery",
  method: "POST",
  path: { instanceId: "instance" },
  nodeId: "node",
  connectionRef: "connection",
  connectionEpoch: 7,
  deliveryId: "delivery",
  responseDigest: d.assignmentResponseDigest(replyFrame),
  frame: replyFrame,
  keyId: "control",
  nonce: "A".repeat(22),
  issuedAt: at,
  expiresAt: "2026-09-06T00:01:00.000Z",
  signature: "AA",
};

check("all declared schemas/functions typecheck and evaluate using actual shared imports", () => {
  assert.ok(names.length > 40);
  assert.ok(d.NativeAssignmentAckResultSchema);
});
check("positive relay request", () => valid(d.AssignmentRequestFrameSchema, frame));
check("immutable origin accepted over relay", () =>
  valid(d.AssignmentRequestFrameSchema, originFrame),
);
check("immutable origin accepted over direct HTTPS", () =>
  valid(d.NativeAssignmentIngestRequestSchema, { ...auth, frame: originLogical }),
);
for (const [transport, schema, candidate] of [
  ["relay", d.AssignmentRequestFrameSchema, originFrame],
  ["HTTPS", d.LogicalAssignmentRequestFrameSchema, originLogical],
]) {
  check(`missing origin rejected over ${transport}`, () => {
    const { origin: _origin, ...missing } = candidate;
    invalid(schema, missing);
  });
  for (const field of ["runnerIncarnation", "manifestId"]) {
    check(`missing origin ${field} rejected over ${transport}`, () => {
      const incomplete = { ...origin };
      delete incomplete[field];
      invalid(schema, { ...candidate, origin: incomplete });
    });
  }
  for (const [field, value] of Object.entries({
    leaseJti: "lease",
    receiptDigest: digest,
    connectionEpoch: 7,
  })) {
    check(`origin ${field} forbidden over ${transport}`, () =>
      invalid(schema, { ...candidate, origin: { ...origin, [field]: value } }),
    );
  }
}
check("origin-bearing digest agrees across relay and HTTPS", () =>
  assert.equal(
    d.assignmentRequestDigest(originFrame),
    d.logicalAssignmentRequestDigest(originLogical),
  ),
);
for (const field of ["runnerIncarnation", "manifestId"]) {
  check(`origin ${field} mutation changes both logical digests`, () => {
    const changed = { ...origin, [field]: "different" };
    assert.notEqual(
      d.assignmentRequestDigest({ ...originFrame, origin: changed }),
      d.assignmentRequestDigest(originFrame),
    );
    assert.notEqual(
      d.logicalAssignmentRequestDigest({ ...originLogical, origin: changed }),
      d.logicalAssignmentRequestDigest(originLogical),
    );
  });
}
check("origin-bearing digest excludes socket epoch", () =>
  assert.equal(
    d.assignmentRequestDigest({ ...originFrame, connectionEpoch: 8 }),
    d.assignmentRequestDigest(originFrame),
  ),
);
check("zero relay request rejected", () =>
  invalid(d.AssignmentRequestFrameSchema, { ...frame, seq: 0 }),
);
check("zero direct request rejected", () =>
  invalid(d.LogicalAssignmentRequestFrameSchema, { ...logical, seq: 0 }),
);
check("unsafe relay sequence rejected", () =>
  invalid(d.AssignmentRequestFrameSchema, { ...frame, seq: Number.MAX_SAFE_INTEGER + 1 }),
);
check("epoch-free direct ingress accepted", () =>
  valid(d.NativeAssignmentIngestRequestSchema, { ...auth, frame: logical }),
);
check("socket epoch forbidden in logical direct frame", () =>
  invalid(d.LogicalAssignmentRequestFrameSchema, frame),
);
check("relay credentials forbidden in direct request", () =>
  invalid(d.NativeAssignmentIngestRequestSchema, {
    ...auth,
    frame: logical,
    connectionRef: "invented",
  }),
);
check("piggyback ACK forbidden", () =>
  invalid(d.AssignmentRequestFrameSchema, { ...frame, ack: 1 }),
);
check("empty pull response correlated", () => valid(d.AssignmentTransportReplySchema, reply));
check("obsolete pull response accepted", () =>
  valid(d.AssignmentTransportReplySchema, {
    ...reply,
    body: { kind: "request_obsolete", reason: "origin_superseded" },
  }),
);
check("obsolete claim response requires accepted resolution manifest", () =>
  valid(d.AssignmentTransportReplySchema, {
    ...reply,
    requestKind: "claim",
    body: {
      kind: "request_obsolete",
      reason: "origin_superseded",
      resolutionManifestId: "resolution",
    },
  }),
);
check("obsolete claim without resolution rejected", () =>
  invalid(d.AssignmentTransportReplySchema, {
    ...reply,
    requestKind: "claim",
    body: { kind: "request_obsolete", reason: "origin_superseded" },
  }),
);
check("obsolete pull rejects claim-only resolution field", () =>
  invalid(d.AssignmentTransportReplySchema, {
    ...reply,
    body: {
      kind: "request_obsolete",
      reason: "origin_superseded",
      resolutionManifestId: "resolution",
    },
  }),
);
check("report rejects generic obsolete outcome", () =>
  invalid(d.AssignmentTransportReplySchema, {
    ...reply,
    requestKind: "report",
    body: { kind: "request_obsolete", reason: "origin_superseded" },
  }),
);
check("bare pull reply rejected", () =>
  invalid(d.AssignmentTransportReplySchema, { assignments: [] }),
);
check("claim body cannot masquerade as pull", () =>
  invalid(d.AssignmentTransportReplySchema, {
    ...reply,
    body: { assignmentId: "assignment", attempt: 1, claimId: "claim", outcome: "claimed" },
  }),
);
check("pull cannot catch claim not_found", () =>
  invalid(d.AssignmentTransportReplySchema, {
    ...reply,
    body: { kind: "request_refused", reason: "not_found" },
  }),
);
check("pull operational refusal accepted", () =>
  valid(d.AssignmentTransportReplySchema, {
    ...reply,
    body: { kind: "request_refused", reason: "capability_unavailable" },
  }),
);
check("claim indistinguishable not_found accepted", () =>
  valid(d.AssignmentTransportReplySchema, {
    ...reply,
    requestKind: "claim",
    body: { kind: "request_refused", reason: "not_found" },
  }),
);
check("report generic refusal rejected", () =>
  invalid(d.AssignmentTransportReplySchema, {
    ...reply,
    requestKind: "report",
    body: { kind: "request_refused", reason: "not_found" },
  }),
);
check("request logical and relay digest equivalence", () =>
  assert.equal(d.logicalAssignmentRequestDigest(logical), d.assignmentRequestDigest(frame)),
);
check("response logical and relay digest equivalence", () =>
  assert.equal(
    d.logicalAssignmentResponseDigest(logicalReply),
    d.assignmentResponseDigest(replyFrame),
  ),
);
check("relay epoch does not change durable digest", () =>
  assert.equal(
    d.assignmentRequestDigest({ ...frame, connectionEpoch: 8 }),
    d.assignmentRequestDigest(frame),
  ),
);
check("original timestamp remains digest-bound", () =>
  assert.notEqual(
    d.assignmentRequestDigest({ ...frame, issuedAt: "2026-09-06T00:00:01.000Z" }),
    d.assignmentRequestDigest(frame),
  ),
);
check("reply request reference remains digest-bound", () =>
  assert.notEqual(
    d.assignmentResponseDigest({ ...replyFrame, body: { ...reply, requestSequence: 2 } }),
    d.assignmentResponseDigest(replyFrame),
  ),
);
check("exact delivery accepted", () => valid(d.RuntimeAssignmentDeliveryRequestSchema, delivery));
check("delivery instance/channel mismatch rejected", () =>
  invalid(d.RuntimeAssignmentDeliveryRequestSchema, { ...delivery, path: { instanceId: "other" } }),
);
check("delivery epoch mismatch rejected", () =>
  invalid(d.RuntimeAssignmentDeliveryRequestSchema, { ...delivery, connectionEpoch: 8 }),
);
check("delivery lifetime over sixty seconds rejected", () =>
  invalid(d.RuntimeAssignmentDeliveryRequestSchema, {
    ...delivery,
    expiresAt: "2026-09-06T00:01:00.001Z",
  }),
);
check("zero delivery lifetime rejected", () =>
  invalid(d.RuntimeAssignmentDeliveryRequestSchema, { ...delivery, expiresAt: at }),
);
check("delivery supplied public key rejected", () =>
  invalid(d.RuntimeAssignmentDeliveryRequestSchema, { ...delivery, publicKey: "untrusted" }),
);
check("zero ACK/observation checkpoint accepted", () =>
  valid(d.NativeAssignmentAckRequestSchema, {
    ...auth,
    channelId,
    consumedReplySequence: 0,
    observedCoreRequestAckSequence: 0,
  }),
);
check("negative ACK prefix rejected", () =>
  invalid(d.NativeAssignmentAckRequestSchema, {
    ...auth,
    channelId,
    consumedReplySequence: -1,
    observedCoreRequestAckSequence: 0,
  }),
);
check("retirement floor cannot exceed observed request ACK", () =>
  invalid(d.AssignmentRetentionStateSchema, {
    observedCoreRequestAckSequence: 1,
    retiredThroughRequestSequence: 2,
    nativeConsumedReplySequence: 99,
  }),
);
check("request and reply sequence domains remain independent", () =>
  valid(d.AssignmentRetentionStateSchema, {
    observedCoreRequestAckSequence: 2,
    retiredThroughRequestSequence: 2,
    nativeConsumedReplySequence: 1,
  }),
);

const ackResult = {
  ok: true,
  ...responseContext,
  channelId,
  acknowledgedSequence: 1,
  nativeConsumedSequence: 1,
  observedCoreRequestAckSequence: 1,
  retiredThroughRequestSequence: 1,
  disposition: "advanced",
  requestAck: {
    kind: "ack",
    origin: "core",
    dataDirection: "to_core",
    channelId,
    cumulativeSeq: 1,
    issuedAt: at,
  },
};
check("direct ACK result accepted", () => valid(d.NativeAssignmentAckResultSchema, ackResult));
check("direct ACK result cannot understate accepted consumption", () =>
  invalid(d.NativeAssignmentAckResultSchema, { ...ackResult, acknowledgedSequence: 2 }),
);
check("direct ACK result floor cannot exceed observed request ACK", () =>
  invalid(d.NativeAssignmentAckResultSchema, { ...ackResult, retiredThroughRequestSequence: 2 }),
);
check("direct ACK result observation cannot exceed Core request ACK", () =>
  invalid(d.NativeAssignmentAckResultSchema, { ...ackResult, observedCoreRequestAckSequence: 2 }),
);
check("relay ACK result cannot understate accepted consumption", () =>
  invalid(d.AssignmentAckResultSchema, {
    ok: true,
    ...runtimeContext,
    channelId,
    acknowledgedSequence: 2,
    nativeConsumedSequence: 1,
    observedCoreRequestAckSequence: 1,
    retiredThroughRequestSequence: 1,
    disposition: "advanced",
  }),
);
check("present cursor floor cannot exceed committed requests", () =>
  invalid(d.AssignmentCursorEntrySchema, {
    channelId,
    state: "present",
    cursors: { to_core: 1, to_runtime: 10 },
    retiredThroughRequestSequence: 2,
  }),
);
check("retired response only names requests at or below floor", () =>
  invalid(d.NativeAssignmentIngestResultSchema, {
    ok: false,
    code: "assignment_replay_retired",
    ...responseContext,
    channelId,
    request: { ...requestRef, requestSequence: 3 },
    retiredThroughRequestSequence: 2,
  }),
);
check("relay retired response only names requests at or below floor", () =>
  invalid(d.AssignmentFrameIngestResultSchema, {
    ok: false,
    code: "assignment_replay_retired",
    ...runtimeContext,
    channelId,
    request: { ...requestRef, requestSequence: 3 },
    retiredThroughRequestSequence: 2,
  }),
);
check("production control signer matches the promoted delivery projection", () => {
  const { signature: _signature, ...body } = delivery;
  assert.equal(
    load("./control-signing.js").remoteControlSigningBytes(delivery).toString("utf8"),
    load("./proof.js").canonicalizeJson(body),
  );
});

const pendingClaimsUnproven = [
  "Authenticated outer scope, original manifest authority and fence projection/evidence binding",
  "Committed receipt/canonical claim/origin/floor owner classification",
  "Actual mounted raw-body limits and durable snapshot/result acceptance",
  "Approved lifecycle profile, local fence predicate and fence/open serialization",
  "Manifest-bound applied receipt acceptance and ordinary recovery evidence",
];
if (includePendingClaims) {
  const claim = { assignmentId: "assignment", attempt: 1, claimId: "claim", agentId: "agent" };
  const claimFrame = { ...logical, body: claim };
  const admission = {
    instanceId: "instance",
    workspaceId: "workspace",
    runnerIncarnation: origin.runnerIncarnation,
    ...claim,
    executionGeneration: "execution-generation",
    openedAt: at,
  };
  const proofHelpers = load("./proof.js");
  const admissionDigest = proofHelpers.sha256Base64Url(proofHelpers.canonicalizeJson(admission));
  const pending = {
    frame: claimFrame,
    requestDigest: d.logicalAssignmentRequestDigest(claimFrame),
    admission,
    admissionDigest,
  };
  const request = {
    channelId,
    requestSequence: claimFrame.seq,
    requestDigest: pending.requestDigest,
    origin,
    ...claim,
    executionGeneration: admission.executionGeneration,
    admissionDigest,
  };
  const receipt = {
    response: { deliveryId: "delivery", sequence: 1, digest },
    verdict: {
      assignmentId: "assignment",
      attempt: 1,
      claimId: "claim",
      outcome: "denied",
      reason: "assignment_conflict",
    },
  };
  const noEffect = { outcome: "no_effect", request };
  const decision = {
    action: "cancel",
    assignmentId: claim.assignmentId,
    attempt: claim.attempt,
    reason: "superseded",
  };
  const confirmed = { outcome: "claim_confirmed", request, requestReceipt: null, decision };
  const committedDenied = {
    outcome: "request_committed_without_claim",
    request,
    requestReceipt: receipt,
  };
  for (const decision of [noEffect, confirmed, committedDenied]) {
    check(`pending decision ${decision.outcome} shape accepted`, () =>
      valid(d.PendingClaimDecisionSchema, decision),
    );
    check(`pending decision ${decision.outcome} rejects extra field`, () =>
      invalid(d.PendingClaimDecisionSchema, { ...decision, reportId: "fabricated" }),
    );
  }
  check("confirmed claim permits actual request receipt evidence", () =>
    valid(d.PendingClaimDecisionSchema, { ...confirmed, requestReceipt: receipt }),
  );
  check("confirmed claim requires explicit nullable receipt field", () =>
    invalid(d.PendingClaimDecisionSchema, { outcome: "claim_confirmed", request, decision }),
  );
  check("confirmed claim requires embedded ordinary recovery decision", () =>
    invalid(d.PendingClaimDecisionSchema, {
      outcome: "claim_confirmed",
      request,
      requestReceipt: null,
    }),
  );
  check("no-effect branch cannot carry ordinary recovery decision", () =>
    invalid(d.PendingClaimDecisionSchema, { ...noEffect, decision }),
  );
  check("no-effect decision cannot carry invented committed receipt", () =>
    invalid(d.PendingClaimDecisionSchema, { ...noEffect, requestReceipt: receipt }),
  );
  check("committed-without-claim decision cannot omit receipt", () =>
    invalid(d.PendingClaimDecisionSchema, { outcome: "request_committed_without_claim", request }),
  );
  check("committed-without-claim decision cannot use null receipt", () =>
    invalid(d.PendingClaimDecisionSchema, { ...committedDenied, requestReceipt: null }),
  );
  check("pending request requires a complete logical claim frame", () =>
    valid(d.PendingClaimRequestSchema, pending),
  );
  check("pending pull frame rejected", () =>
    invalid(d.PendingClaimRequestSchema, { ...pending, frame: logical }),
  );
  check("pending request requires immutable origin", () => {
    const { origin: _origin, ...missing } = claimFrame;
    invalid(d.PendingClaimRequestSchema, { ...pending, frame: missing });
  });
  check("pending request rejects hop epoch", () =>
    invalid(d.PendingClaimRequestSchema, {
      ...pending,
      frame: { ...claimFrame, connectionEpoch: 7 },
    }),
  );
  check("pending request rejects extra authority fields", () =>
    invalid(d.PendingClaimRequestSchema, { ...pending, lease: "forbidden" }),
  );
  check("pending admission rejects extra secret fields", () =>
    invalid(d.PendingClaimAdmissionSchema, { ...admission, token: "forbidden" }),
  );
  check("pending reference rejects zero sequence", () =>
    invalid(d.PendingClaimReferenceSchema, { ...request, requestSequence: 0 }),
  );
  check("pending reference rejects origin receipt digest", () =>
    invalid(d.PendingClaimReferenceSchema, {
      ...request,
      origin: { ...origin, receiptDigest: digest },
    }),
  );
  check("partial committed response reference rejected", () =>
    invalid(d.CommittedClaimRequestEvidenceSchema, {
      ...receipt,
      response: { sequence: 1, digest },
    }),
  );
  check("existing claim-denial reason correlation retained", () =>
    invalid(d.CommittedClaimRequestEvidenceSchema, {
      ...receipt,
      verdict: { assignmentId: "assignment", attempt: 1, claimId: "claim", outcome: "denied" },
    }),
  );
  const projection = {
    schemaVersion: 1,
    instanceId: "instance",
    workspaceId: "workspace",
    request,
    resolutionManifestId: "resolution",
    lifecycleProfileDigest: digest,
    executionProfileDigest: digest,
  };
  const evidence = {
    kind: "qualified_pre_execution",
    resolutionManifestId: "resolution",
    lifecycleProfileDigest: digest,
    executionProfileDigest: digest,
    fenceDigest: proofHelpers.sha256Base64Url(proofHelpers.canonicalizeJson(projection)),
  };
  const fenced = { disposition: "pending_claim_fenced", request, evidence };
  check("pending fence projection shape accepted", () =>
    valid(d.PendingClaimFenceProjectionSchema, projection),
  );
  check("complete qualified fence evidence shape accepted", () =>
    valid(d.PendingClaimResultSchema, fenced),
  );
  for (const field of Object.keys(evidence)) {
    check(`partial qualified fence evidence missing ${field} rejected`, () => {
      const partial = { ...evidence };
      delete partial[field];
      invalid(d.PendingClaimResultSchema, { ...fenced, evidence: partial });
    });
  }
  check("pending fence result rejects synthetic report", () =>
    invalid(d.PendingClaimResultSchema, { ...fenced, reportId: "fabricated" }),
  );
  const result = {
    disposition: "applied",
    assignmentId: claim.assignmentId,
    attempt: claim.attempt,
    terminalReportId: "report",
    terminalEvidence: {
      kind: "queued",
      reportSequence: 1,
      payloadDigest: digest,
      terminalResultHash: digest,
    },
  };
  const confirmedResult = { disposition: "pending_claim_confirmed", request, result };
  const recomputePending = (value) => ({
    ...value,
    requestDigest: d.logicalAssignmentRequestDigest(value.frame),
    admissionDigest: proofHelpers.sha256Base64Url(proofHelpers.canonicalizeJson(value.admission)),
  });
  for (const field of ["requestDigest", "admissionDigest"]) {
    check(`pending ${field} is recomputed`, () =>
      invalid(d.PendingClaimRequestSchema, { ...pending, [field]: "B".repeat(43) }),
    );
  }
  for (const field of ["assignmentId", "attempt", "claimId", "agentId"]) {
    check(`pending claim/admission ${field} mismatch rejected despite correct digests`, () =>
      invalid(
        d.PendingClaimRequestSchema,
        recomputePending({
          ...pending,
          admission: { ...admission, [field]: field === "attempt" ? 2 : "other" },
        }),
      ),
    );
  }
  check("pending origin/admission incarnation mismatch rejected despite correct digests", () =>
    invalid(
      d.PendingClaimRequestSchema,
      recomputePending({ ...pending, admission: { ...admission, runnerIncarnation: "other" } }),
    ),
  );
  check("pending channel/instance mismatch rejected despite correct digests", () =>
    invalid(
      d.PendingClaimRequestSchema,
      recomputePending({ ...pending, frame: { ...claimFrame, channelId: "assignment:other" } }),
    ),
  );
  check("pending reference derives exactly from validated request", () =>
    assert.equal(
      proofHelpers.canonicalizeJson(d.derivePendingClaimReference(pending)),
      proofHelpers.canonicalizeJson(request),
    ),
  );
  check("derived reference refuses invalid full request", () => {
    assert.equal(typeof d.derivePendingClaimReference, "function");
    assert.throws(() =>
      d.derivePendingClaimReference({ ...pending, admissionDigest: "B".repeat(43) }),
    );
  });
  check("retained full request and exact reference validate together", () =>
    valid(d.PendingClaimReferencedRequestSchema, { pending, reference: request }),
  );
  check("reference pair safely refuses child digest validation failure", () =>
    invalid(d.PendingClaimReferencedRequestSchema, {
      pending: { ...pending, requestDigest: "B".repeat(43) },
      reference: request,
    }),
  );
  for (const [field, value] of Object.entries({
    channelId: "assignment:other",
    requestSequence: 2,
    requestDigest: "B".repeat(43),
    origin: { ...origin, manifestId: "other" },
    assignmentId: "other",
    attempt: 2,
    claimId: "other",
    agentId: "other",
    executionGeneration: "other",
    admissionDigest: "B".repeat(43),
  })) {
    check(`full request/reference ${field} mismatch rejected`, () =>
      invalid(d.PendingClaimReferencedRequestSchema, {
        pending,
        reference: { ...request, [field]: value },
      }),
    );
  }
  for (const [field, value] of Object.entries({ assignmentId: "other", attempt: 2 })) {
    check(`confirmed decision ${field} mismatch rejected`, () =>
      invalid(d.PendingClaimDecisionSchema, {
        ...confirmed,
        decision: { ...decision, [field]: value },
      }),
    );
    check(`confirmed result ${field} mismatch rejected`, () =>
      invalid(d.PendingClaimResultSchema, {
        ...confirmedResult,
        result: { ...result, [field]: value },
      }),
    );
  }
  const restart = {
    action: "restart_new_attempt_same_instance",
    priorAssignmentId: claim.assignmentId,
    newAssignmentId: "successor",
    newAttempt: claim.attempt + 1,
    recoveryEpoch: 1,
    approvalRequired: false,
  };
  check("confirmed restart binds prior assignment and next attempt", () =>
    valid(d.PendingClaimDecisionSchema, { ...confirmed, decision: restart }),
  );
  check("confirmed restart rejects another prior assignment", () =>
    invalid(d.PendingClaimDecisionSchema, {
      ...confirmed,
      decision: { ...restart, priorAssignmentId: "other" },
    }),
  );
  check("confirmed restart rejects skipped attempt", () =>
    invalid(d.PendingClaimDecisionSchema, {
      ...confirmed,
      decision: { ...restart, newAttempt: 3 },
    }),
  );
  check("confirmed result rejects absent-local shortcut", () =>
    invalid(d.PendingClaimResultSchema, {
      ...confirmedResult,
      result: {
        disposition: "absent_local_cancelled",
        assignmentId: claim.assignmentId,
        attempt: claim.attempt,
      },
    }),
  );
  check("pending confirmed result with ordinary evidence shape accepted", () =>
    valid(d.PendingClaimResultSchema, confirmedResult),
  );
  check("pending confirmed result requires embedded ordinary result", () =>
    invalid(d.PendingClaimResultSchema, { disposition: "pending_claim_confirmed", request }),
  );
  check("pending confirmed result cannot carry fence evidence", () =>
    invalid(d.PendingClaimResultSchema, { ...confirmedResult, evidence }),
  );
  check("pending fenced result cannot carry ordinary result", () =>
    invalid(d.PendingClaimResultSchema, { ...fenced, result }),
  );
  check("embedded ordinary result rejects partial terminal evidence", () => {
    const { terminalEvidence: _evidence, ...partial } = result;
    invalid(d.PendingClaimResultSchema, { ...confirmedResult, result: partial });
  });
  check("pending result rejects invented no-effect disposition", () =>
    invalid(d.PendingClaimResultSchema, { disposition: "no_effect", request }),
  );

  const ordinaryClaim = {
    assignmentId: "ordinary",
    attempt: 1,
    claimId: "ordinary-claim",
    state: "claimed",
    recoveryEpoch: 0,
  };
  const ordinaryDecision = {
    action: "cancel",
    assignmentId: "ordinary",
    attempt: 1,
    reason: "superseded",
  };
  const ordinaryResult = { disposition: "applied", assignmentId: "ordinary", attempt: 1 };
  const reconnect = {
    instanceId: "instance",
    runnerIncarnation: "current-process",
    reconnectIntentId: "intent",
    establishment: null,
    lastHeartbeatSequence: 0,
    bundleVersion: "2.0.0",
    protocolVersion: "2.0",
    claims: [],
    pendingClaims: [pending],
  };
  const reconnectRequest = { ...reconnect, connection: { kind: "https" }, proof: auth.proof };
  const manifest = {
    instanceId: "instance",
    runnerIncarnation: "current-process",
    reconnectIntentId: "intent",
    ownerRevision: 1,
    lease: "opaque-lease",
    manifestId: "resolution",
    issuedAt: at,
    applyDeadlineAt: "2026-09-06T00:01:00.000Z",
    acceptedHeartbeatSequence: 0,
    heartbeatSequenceFloor: 0,
    decisions: [],
    pendingClaimDecisions: [noEffect],
  };
  const receiptSnapshot = {
    instanceId: "instance",
    runnerIncarnation: "current-process",
    manifestId: "resolution",
    decisionResults: [],
    pendingClaimResults: [fenced],
  };
  const applied = { ...receiptSnapshot, connection: { kind: "https" }, proof: auth.proof };
  const coverage = { reconnect, manifest, receipt: receiptSnapshot };
  for (const [name, schema, value, array] of [
    ["reconnect snapshot", d.ExtendedReconnectSnapshotSchema, reconnect, "pendingClaims"],
    ["reconnect request", d.ExtendedReconnectRequestSchema, reconnectRequest, "pendingClaims"],
    ["manifest", d.ExtendedManifestSchema, manifest, "pendingClaimDecisions"],
    ["receipt snapshot", d.ExtendedReceiptSnapshotSchema, receiptSnapshot, "pendingClaimResults"],
    ["applied request", d.ExtendedAppliedRequestSchema, applied, "pendingClaimResults"],
  ]) {
    check(`${name} complete pending wrapper accepted`, () => valid(schema, value));
    check(`${name} requires pending array`, () => {
      const missing = { ...value };
      delete missing[array];
      invalid(schema, missing);
    });
    check(`${name} rejects duplicated pending entry`, () =>
      invalid(schema, { ...value, [array]: [...value[array], ...value[array]] }),
    );
  }
  const claims256 = Array.from({ length: 256 }, (_, i) => ({
    ...ordinaryClaim,
    assignmentId: `ordinary-${String(i).padStart(3, "0")}`,
  }));
  const decisions256 = claims256.map((c) => ({
    ...ordinaryDecision,
    assignmentId: c.assignmentId,
  }));
  const results256 = claims256.map((c) => ({ ...ordinaryResult, assignmentId: c.assignmentId }));
  check("combined reconnect 257 rejected", () =>
    invalid(d.ExtendedReconnectSnapshotSchema, { ...reconnect, claims: claims256 }),
  );
  check("combined manifest 257 rejected", () =>
    invalid(d.ExtendedManifestSchema, { ...manifest, decisions: decisions256 }),
  );
  check("combined receipt 257 rejected", () =>
    invalid(d.ExtendedReceiptSnapshotSchema, { ...receiptSnapshot, decisionResults: results256 }),
  );
  check("combined reconnect 256 accepted", () =>
    valid(d.ExtendedReconnectSnapshotSchema, { ...reconnect, claims: claims256.slice(0, 255) }),
  );
  check("reconnect ordinary/pending overlap rejected", () =>
    invalid(d.ExtendedReconnectSnapshotSchema, {
      ...reconnect,
      claims: [{ ...ordinaryClaim, assignmentId: claim.assignmentId }],
    }),
  );
  check("manifest ordinary/pending overlap rejected", () =>
    invalid(d.ExtendedManifestSchema, { ...manifest, decisions: [decision] }),
  );
  check("receipt ordinary/pending overlap rejected", () =>
    invalid(d.ExtendedReceiptSnapshotSchema, { ...receiptSnapshot, decisionResults: [result] }),
  );
  check("pending inventory wrapper instance must match", () =>
    invalid(d.ExtendedReconnectSnapshotSchema, { ...reconnect, instanceId: "other" }),
  );
  check("pending decision wrapper channel must match", () =>
    invalid(d.ExtendedManifestSchema, { ...manifest, instanceId: "other" }),
  );
  check("pending result wrapper channel must match", () =>
    invalid(d.ExtendedReceiptSnapshotSchema, { ...receiptSnapshot, instanceId: "other" }),
  );
  check("manifest preserves deadline refinement", () =>
    invalid(d.ExtendedManifestSchema, { ...manifest, applyDeadlineAt: at }),
  );
  check("manifest preserves heartbeat floor refinement", () =>
    invalid(d.ExtendedManifestSchema, { ...manifest, acceptedHeartbeatSequence: 1 }),
  );
  check("reconnect preserves ordinary checkpoint evidence refinement", () =>
    invalid(d.ExtendedReconnectRequestSchema, {
      ...reconnectRequest,
      claims: [{ ...ordinaryClaim, state: "checkpointed" }],
    }),
  );
  check("applied preserves ordinary result ordering", () =>
    invalid(d.ExtendedAppliedRequestSchema, {
      ...applied,
      decisionResults: [results256[1], results256[0]],
    }),
  );
  check("manifest ordinary decisions must be sorted", () =>
    invalid(d.ExtendedManifestSchema, {
      ...manifest,
      decisions: [decisions256[1], decisions256[0]],
    }),
  );
  check("reconnect ordinary claims must be sorted", () =>
    invalid(d.ExtendedReconnectRequestSchema, {
      ...reconnectRequest,
      claims: [claims256[1], claims256[0]],
    }),
  );
  check("full recovery coverage accepts matching fence", () =>
    valid(d.ExtendedRecoveryCoverageSchema, coverage),
  );
  check("full coverage permits Core-known omitted ordinary claim", () =>
    valid(d.ExtendedRecoveryCoverageSchema, {
      ...coverage,
      manifest: { ...manifest, decisions: [ordinaryDecision] },
      receipt: { ...receiptSnapshot, decisionResults: [ordinaryResult] },
    }),
  );
  check("full coverage missing pending decision rejected", () =>
    invalid(d.ExtendedRecoveryCoverageSchema, {
      ...coverage,
      manifest: { ...manifest, pendingClaimDecisions: [] },
    }),
  );
  check("full coverage missing pending result rejected", () =>
    invalid(d.ExtendedRecoveryCoverageSchema, {
      ...coverage,
      receipt: { ...receiptSnapshot, pendingClaimResults: [] },
    }),
  );
  check("full coverage changed pending reference rejected", () =>
    invalid(d.ExtendedRecoveryCoverageSchema, {
      ...coverage,
      receipt: {
        ...receiptSnapshot,
        pendingClaimResults: [
          { ...fenced, request: { ...request, admissionDigest: "B".repeat(43) } },
        ],
      },
    }),
  );
  check("full coverage mismatched disposition rejected", () =>
    invalid(d.ExtendedRecoveryCoverageSchema, {
      ...coverage,
      receipt: { ...receiptSnapshot, pendingClaimResults: [confirmedResult] },
    }),
  );
  check("full coverage mismatched manifest identity rejected", () =>
    invalid(d.ExtendedRecoveryCoverageSchema, {
      ...coverage,
      receipt: { ...receiptSnapshot, manifestId: "other" },
    }),
  );
  check("full coverage confirmed branch stays one entry", () =>
    valid(d.ExtendedRecoveryCoverageSchema, {
      ...coverage,
      manifest: { ...manifest, pendingClaimDecisions: [confirmed] },
      receipt: { ...receiptSnapshot, pendingClaimResults: [confirmedResult] },
    }),
  );
  check("full coverage missing ordinary result rejected", () =>
    invalid(d.ExtendedRecoveryCoverageSchema, {
      ...coverage,
      manifest: { ...manifest, decisions: [ordinaryDecision] },
    }),
  );
  check("full coverage cannot drop an ordinary reconnect claim", () =>
    invalid(d.ExtendedRecoveryCoverageSchema, {
      ...coverage,
      reconnect: { ...reconnect, claims: [ordinaryClaim] },
    }),
  );
  check("reconnect digest equals snapshot digest", () =>
    assert.equal(
      d.computeExtendedReconnectIntentDigest(reconnectRequest),
      d.computeExtendedReconnectSnapshotDigest(reconnect),
    ),
  );
  check("receipt digest equals snapshot digest", () =>
    assert.equal(
      d.computeExtendedReceiptDigest(applied),
      d.computeExtendedReceiptSnapshotDigest(receiptSnapshot),
    ),
  );
  check("reconnect digest excludes proof and connection", () =>
    assert.equal(
      d.computeExtendedReconnectIntentDigest(reconnectRequest),
      d.computeExtendedReconnectIntentDigest({
        ...reconnectRequest,
        connection: { kind: "relay", connectionEpoch: 2 },
        proof: { ...auth.proof, nonce: "B".repeat(22) },
      }),
    ),
  );
  check("receipt digest excludes proof and connection", () =>
    assert.equal(
      d.computeExtendedReceiptDigest(applied),
      d.computeExtendedReceiptDigest({
        ...applied,
        connection: { kind: "relay", connectionEpoch: 2 },
        proof: { ...auth.proof, nonce: "B".repeat(22) },
      }),
    ),
  );
  check("manifest digest excludes renewable lease and heartbeat projections", () =>
    assert.equal(
      d.computeExtendedManifestDigest(manifest),
      d.computeExtendedManifestDigest({
        ...manifest,
        lease: "renewed",
        acceptedHeartbeatSequence: 1,
        heartbeatSequenceFloor: 2,
      }),
    ),
  );
  check("reconnect digest binds pending inventory", () =>
    assert.notEqual(
      d.computeExtendedReconnectSnapshotDigest(reconnect),
      d.computeExtendedReconnectSnapshotDigest({ ...reconnect, pendingClaims: [] }),
    ),
  );
  check("manifest digest binds pending decisions", () =>
    assert.notEqual(
      d.computeExtendedManifestDigest(manifest),
      d.computeExtendedManifestDigest({ ...manifest, pendingClaimDecisions: [] }),
    ),
  );
  check("receipt digest binds pending results", () =>
    assert.notEqual(
      d.computeExtendedReceiptSnapshotDigest(receiptSnapshot),
      d.computeExtendedReceiptSnapshotDigest({ ...receiptSnapshot, pendingClaimResults: [] }),
    ),
  );
  check("snapshot refuses transport credentials", () =>
    invalid(d.ExtendedReconnectSnapshotSchema, reconnectRequest),
  );
  check("complete reconnect wire rejects over2MiB even within count cap", () => {
    const huge = recomputePending({
      ...pending,
      admission: { ...admission, openedAt: `2026-09-06T00:00:00.${"0".repeat(2 * 1024 * 1024)}Z` },
    });
    invalid(d.ExtendedReconnectRequestSchema, { ...reconnectRequest, pendingClaims: [huge] });
  });
  check("pending claim frame rejects over1MiB inside otherwise bounded reconnect", () => {
    const huge = recomputePending({
      ...pending,
      frame: { ...claimFrame, issuedAt: `2026-09-06T00:00:00.${"0".repeat(1024 * 1024)}Z` },
    });
    invalid(d.ExtendedReconnectRequestSchema, { ...reconnectRequest, pendingClaims: [huge] });
  });
}

console.log(
  JSON.stringify(
    {
      artifact: "D143 assignment schema annex (not production acceptance)",
      pendingClaimsIncluded: includePendingClaims,
      ...(includePendingClaims ? { pendingClaimsUnproven } : {}),
      blocks: blocks.length,
      declarations: names.length,
      semanticTypecheck: "passed",
      passed,
      failed: failures.length,
      failures,
      limits:
        "Runtime schema validation only; no production exports, owner transactions, cryptographic delivery, or end-to-end execution proved.",
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
