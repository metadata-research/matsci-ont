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
    // The layering, enforced rather than described. shared/ holds what both
    // need, so neither layer has a reason to import the other. The one
    // deliberate crossing is the end-to-end harness in pipeline/verify.mjs,
    // which loads the application on purpose and says so.
    files: ["app/**/*.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/pipeline/**"],
              message:
                "app/ must not import pipeline/. Anything both layers need belongs in shared/."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["shared/**/*.mjs"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/app/**", "**/pipeline/**"],
              message:
                "shared/ is what both layers may depend on, so it depends on neither."
            }
          ]
        }
      ]
    }
  },
  {
    // A browser script served to a page, not run by Node. cytoscape is the
    // pinned package the page loads from /assets before this one, so it is a
    // global here rather than an import.
    files: ["app/static/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser, cytoscape: "readonly" }
    }
  },
  prettier
])
