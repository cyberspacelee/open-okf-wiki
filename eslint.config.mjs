// @ts-check
/**
 * Root ESLint flat config (ESLint 9+/10, typescript-eslint v8).
 *
 * Scope: product packages under packages/* and apps/* only.
 * refs/, .scratch/, dist, and generated Playwright artifacts are ignored.
 *
 * Policy (2026 community-aligned for small TS monorepos):
 * - Lint is fast enough for pre-commit (staged files) and CI.
 * - Typecheck is a separate `pnpm typecheck` / CI step (tsc project graph).
 * - e2e is Playwright + CI job (not a commit gate).
 * - React Compiler-style hooks rules stay off until data-fetch patterns migrate.
 */
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/*.tsbuildinfo",
    "refs/**",
    ".scratch/**",
    ".agents/**",
    "tmp/**",
    "packages/web/playwright-report/**",
    "packages/web/test-results/**",
    "packages/web/dist/**",
    // Vendored / registry UI (shadcn + AI Elements) — lint product code first
    "packages/web/src/components/ui/**",
    "packages/web/src/components/ai-elements/**",
    "pnpm-lock.yaml",
    "eslint.config.mjs",
  ]),

  // Shared TypeScript / JS for monorepo packages
  {
    files: [
      "packages/**/*.{js,mjs,cjs,ts,tsx}",
      "apps/**/*.{js,mjs,cjs,ts,tsx}",
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Keep off while product APIs still use pragmatic escape hatches.
      "@typescript-eslint/no-explicit-any": "off",
      // Prefer type imports when easy; don't fight import() type annotations.
      "@typescript-eslint/consistent-type-imports": "off",
      // ESLint 10: good practice, but rethrow sites are often intentional wrappers.
      // Enable later when cause chains are productized.
      "preserve-caught-error": "off",
    },
  },

  // Web (Vite + React 19) — classic hooks rules, not React Compiler suite
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    extends: [reactRefresh.configs.vite],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          // Shared helpers colocated with presentational components.
          allowExportNames: ["formatError", "buttonVariants", "cn"],
        },
      ],
    },
  },

  // Playwright e2e helpers (Node)
  {
    files: [
      "packages/web/e2e/**/*.{ts,tsx}",
      "packages/web/playwright.config.ts",
      "packages/web/scripts/**/*.{js,mjs,ts}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },

  // Plain JS (config / scripts)
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
