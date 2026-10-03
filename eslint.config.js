import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Wire payloads are typed by the shared contract package; `unknown` is
      // allowed only at a parse boundary and must be narrowed immediately.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Cyclomatic complexity of 8 at most (HARDENING.md) in every package.
    files: ["packages/*/src/**/*.{ts,mjs}"],
    rules: { complexity: ["error", 8] },
  },
  {
    // These match terminal escapes and control bytes on purpose: they strip
    // them from untrusted agent and preview output, or refuse them in paths.
    files: [
      "packages/agent-runner/src/auth/login-flow.ts",
      "packages/agent-runner/src/auth/opencode-auth.ts",
      "packages/launcher/src/native/service.ts",
      "packages/supervisor/src/preview/process-manager.ts",
      "packages/supervisor/src/session/permissions.ts",
    ],
    rules: { "no-control-regex": "off" },
  },
);
