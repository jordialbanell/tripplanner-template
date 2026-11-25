import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // TripPlanner was ported as-is from its own repo (never linted under React 19 rules).
  // Keep the newer React Compiler rules as warnings there until it gets a proper pass.
  {
    files: ["app/projects/tripplanner/**", "lib/trip/**", "app/projects/skillscout/**", "lib/skillscout/**", "app/projects/site-auditor/**", "app/projects/gmat-trainer/**", "lib/gmat/**", "app/projects/wc26-sweepstake/**", "lib/wc26/**"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "react/no-unescaped-entities": "warn",
      "prefer-const": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
]);

export default eslintConfig;
