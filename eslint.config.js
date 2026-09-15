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
);
