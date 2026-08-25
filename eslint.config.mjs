// MatSci-SAM lints a Next.js application, so its rule set does not apply
// here. This is the equivalent floor for a plain Node project: the
// recommended rules, Node globals, and Prettier left in charge of layout.

import js from "@eslint/js"
import globals from "globals"
import prettier from "eslint-config-prettier/flat"
import { defineConfig, globalIgnores } from "eslint/config"

export default defineConfig([
  globalIgnores(["node_modules/**", "build/**", "cache/**", "tools/**"]),
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: {
      // An unused name is either a mistake or a leftover. Arguments named
      // with a leading underscore are the documented exception.
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" }
      ],
      // These read as intent but are almost always a bug in an async
      // pipeline, where a rejected promise nobody awaits fails silently.
      "no-floating-decimal": "error",
      "require-atomic-updates": "error",
      eqeqeq: ["error", "smart"]
    }
  },
  {
    // A browser script served to a page, not run by Node.
    files: ["app/static/**/*.js"],
    languageOptions: { globals: { ...globals.browser } }
  },
  prettier
])
