// ESLint flat config for gui-movie-director.
//
// Purpose: a *focused* bug-class gate, not a style enforcer. It exists to
// deterministically catch the FileUpload-style defect — a local const/function
// SHADOWING an imported (or outer) name — which LLM structural review and
// screenshot UX lanes cannot reliably detect, and which silently broke uploads
// (the imported uploadFile was tree-shaken; the component recursed into itself).
//
// The rule set is intentionally narrow so the baseline stays clean and the
// self-improve lint lane acts as a *regression gate* ("avoid again"), not a
// firehose of legacy style nits.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "data/**",
      "bundle*.js",
      "*.md",
      "scripts/check-*.ts", // generated/regen helpers — keep out of the gate
    ],
  },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // THE bug class: a local binding shadowing an import or outer scope.
      // This is precisely the upload defect. Error-level so the lint lane gates.
      "@typescript-eslint/no-shadow": "error",
      // Dead-import / dead-var signal — the shadowed import was also effectively
      // unused (tree-shaken). Warn so it surfaces without blocking the build.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
