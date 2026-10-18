import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        fetch: "readonly",
        FormData: "readonly",
        Headers: "readonly",
        URL: "readonly",
        TextDecoder: "readonly",
        AbortSignal: "readonly",
        Buffer: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // stdout is the MCP channel — forbid console.log; use console.error (stderr).
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  prettier,
);
