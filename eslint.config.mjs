import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["app/**", "components/**", "lib/**"],
    ignores: ["app/api/**", "lib/base-path.ts", "lib/__tests__/**"],
    rules: {
      "no-restricted-globals": ["error", {
        name: "fetch",
        message: "Use apiFetch from @/lib/base-path: a bare fetch misses the CC_TAP_BASE_PATH prefix.",
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "proxy/**",
    "bin/**",
    ".claude/**",
  ]),
]);

export default eslintConfig;
