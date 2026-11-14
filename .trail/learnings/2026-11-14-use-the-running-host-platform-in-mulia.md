---
title: Use the running host platform in fetched-agent installation fixtures
author: Mulia
date: 2026-11-14
branch: fix/antigravity-linux-windows
id: l-7ee20506
scope: repo
status: active
src: agent
touches:
  - packages/supervisor/src/__tests__/native-installation.test.ts
  - packages/supervisor/src/native/antigravity-installation.ts
---

## Decided
A test that calls the real Antigravity install adapter constructs its missing fetched folder from fetchedAgentPlatformKey() and fetchedAgentFolderName(). The adapter verifies the running host's pin, even when the separate signed connector fixture describes another platform.

## Tried and ruled out
A darwin-arm64 folder passed on the development Mac but failed the Ubuntu x64, Ubuntu ARM64 and Windows native CI jobs. Those hosts correctly classified that different-platform folder as antigravity_unsafe_install before checking whether its files were missing. Expanding the expected refusal to include unsafe_install would hide the wrong fixture. Keep a separate regression proving a different-platform record is refused.

## Watch out
Do not weaken fetched-folder identity or skip non-macOS coverage to make this test green. A manifest platform and the actual host adapter's platform are distinct test inputs. No production behavior changes are needed for this fixture repair.

In the code: packages/supervisor/src/__tests__/native-installation.test.ts; packages/supervisor/src/native/antigravity-installation.ts verifyNativeAntigravityRecord.
