/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: "module",
  },
  env: {
    browser: true,
    es2020: true,
    node: true,
  },
  ignorePatterns: ["dist/", "node_modules/", "*.cjs", "*.mjs"],
  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/explicit-module-boundary-types": "off",
    // A leading underscore marks something declared on purpose and not read.
    // Sometimes the declaration IS the point: the fetch spy in
    // react-native/src/telemetry.test.ts has to name its parameters or
    // TypeScript infers a zero-length tuple for mock.calls and every assertion
    // that reads the RequestInit stops compiling. Without this the only way to
    // satisfy the linter is to break the types.
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
  },
};
