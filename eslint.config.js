import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // contracts/ is copied into the web app verbatim, so it must stay dependency-free.
    files: ["contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["@/*", "@contracts/*", "@prisma/*", "fastify*", "zod", "node:*"], message: "contracts/ may only import other files inside contracts/ (relative paths)." }] }],
    },
  },
);
