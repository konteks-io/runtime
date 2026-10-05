# Source-bound CPAL candidate fixtures

These are text fixtures for the Mac13 candidate measurement. They are not compiled,
published, installed, or authorized replacement resources.

`MODULE.bazel`, `Cargo.lock`, `patches.BUILD.bazel`, `prepare_built_runtime.py`,
`voice.BUILD.bazel` and `voice.native_link.bzl` are exact public source bytes
from [Codex commit 687a119](https://github.com/openai/codex/tree/687a119f0fcaace47e1f1abcc77cec6c813fd6da),
under Apache-2.0. Their SHA-256 values are pinned by `cpal-patch.mjs` and
`voice-helper-relocation.mjs`. The latter binds the Mac native-link target and
the actual SolibSymlink action output before deleting its one stale build rpath.
It does not infer the ARM build directory from the Intel directory.

`loopback.upstream.rs`, `Cargo.toml` and `LICENSE` come from the authenticated
[CPAL 0.18.2 crate](https://static.crates.io/crates/cpal/cpal-0.18.2.crate),
archive SHA-256 `6f02e8d0327b42d3e2e4ab2119af397344eb9fc54a34bf0ddeaa1277af8681f1`.
CPAL is Apache-2.0; its upstream loopback member is
`29da4b60b376f742a4c7c211bbd8aed7f292fd78b6cfb5045e0f21e676328aa2`.

`process-tap.patch` is the reviewed seven-hunk local availability candidate
(`97f209eb3af032c04f72522cb7f7282f15f6254cce5badffb2c98fffd7c3e4fe`).
`loopback.candidate.rs` is its exact result
(`981f569aeca0a715f4f403fcbd315dd31f50cdd303f4aa789c56ff878e3041ba`).
It dynamically resolves the optional process-tap pair and class only on loopback;
microphone/speaker paths and Cargo dependencies are unchanged.

The measurement also adds one exact source-bound preservation operation after
the upstream runtime projection: it saves the already-created temporary native
inventory bytes, without reserialization or inspection changes. That extra source
member is excluded by the normal upstream runtime staging file selection and is
retained separately as provenance.

Pure tests prove source/annotation/graph refusal and patch applicability only.
Actual Rust/Bazel compilation, effective action layout, native API/loader behavior,
audio behavior and execution on macOS 13 remain separate evidence requirements.
