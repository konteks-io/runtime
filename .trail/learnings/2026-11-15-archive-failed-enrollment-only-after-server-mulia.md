---
title: Archive failed enrollment only after server-authorized retirement
author: Mulia
date: 2026-11-15
branch: fix/finding-170-enrollment-recovery-20261116
id: l-c517bca7
scope: repo
status: active
src: agent
touches:
  - package-lock.json
  - package.json
  - packages/common/src/contracts.ts
  - packages/supervisor/src/__tests__/native-activation.test.ts
  - packages/supervisor/src/core/client.ts
  - packages/supervisor/src/native/activation.ts
  - packages/supervisor/src/provisioning/activation.ts
  - packages/supervisor/src/state/local-execution.ts
  - vendor/konteks-agent-core-7.31.0.tgz
  - vendor/konteks-backstage-plugin-common-7.31.0.tgz
---

## Decided
A changed activation must first ask Core to recover the original registration using its retained key and retry nonce. A recovered response keeps the same lineage. Only a server-confirmed retired result permits an archive; preserve every private file in a resumable archive and require a fresh key before creating a new seed.
## Tried and ruled out
Blindly clearing enrollment_seed loses the ability to recover a committed exchange and may duplicate an instance. Reusing the old key after retirement also defeats the new lineage boundary. Checking only a successful HTTP status accepts the wrong activation response; validate both old and replacement IDs.
## Watch out
Unsupported or malformed recovery responses leave the original key, attempt and journal intact. Existing execution history requires normal runtime retirement. Keep root ownership across mutations and verify the archive receipt before resuming. Refresh remote-common dist after changing contract exports before running source tests.
In the code: native/activation-recovery.ts, native/activation-retirement.ts, runNativeActivationExchange and canRetireEnrollment. The contract is vendored from the officially published Packages 7.31.4 cohort.
