import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // stdout is the MCP channel — forbid console.log; use console.error (stderr).
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  prettier,
];
