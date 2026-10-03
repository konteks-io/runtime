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
    // Cyclomatic complexity of 8 at most (HARDENING.md), enforced per package
    // as each one is brought under it.
    files: ["packages/common/src/**/*.ts", "packages/release/src/**/*.ts", "packages/sysmon/src/**/*.ts", "packages/agent-runner/src/**/*.{ts,mjs}"],
    rules: { complexity: ["error", 8] },
  },
);
