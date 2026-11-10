// Security gate configuration: ESLint runs ONLY eslint-plugin-security; Biome stays the linter and formatter.
// Run by scripts/check.mjs with `--no-inline-config`, so `eslint-disable` comments cannot silence a finding.
// Factory-owned file: agents must not edit it.
//
// TypeScript is parsed without typescript-eslint (it does not support TypeScript 7): Node's built-in
// `stripTypeScriptTypes` blanks the type annotations with spaces, so espree parses plain JavaScript at the
// same lines and columns. Syntax that cannot be erased (enum, namespace, parameter properties) falls back to
// Node's transform mode, whose positions are close but not exact.

import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import security from "eslint-plugin-security";

// espree is ESLint's own parser; resolve it next to the installed ESLint.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const espree = createRequire(join(root, "node_modules", "eslint", "package.json"))("espree");

function stripTypes(code) {
  try {
    return stripTypeScriptTypes(code, { mode: "strip" });
  } catch (error) {
    if (error?.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") throw error;
    return stripTypeScriptTypes(code, { mode: "transform" });
  }
}

const stripTypesParser = {
  meta: { name: "fabrica-strip-types" },
  parse(code, options) {
    return espree.parse(stripTypes(code), {
      ...options,
      ecmaVersion: "latest",
      sourceType: "module",
      range: true,
      loc: true,
      comment: true,
      tokens: true,
    });
  },
};

// Errors are the high-severity rules: findings that are real vulnerabilities in a library, and they fail the
// gate. Warnings are printed for review but do not fail: detect-unsafe-regex (safe-regex star height) flags
// harmless optional groups such as /^3[.][01][.][0-9]+(?:-[0-9A-Za-z.-]+)?$/. The noisiest heuristics
// (object injection, non-literal fs paths) are off: they flag ordinary code and would train the generator to
// rewrite safe code.
export default [
  {
    files: ["src/**/*.ts", "src/**/*.mts", "src/**/*.tsx"],
    languageOptions: { parser: stripTypesParser },
    plugins: { security },
    rules: {
      "security/detect-bidi-characters": "error",
      "security/detect-buffer-noassert": "error",
      "security/detect-disable-mustache-escape": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-invisible-characters": "error",
      "security/detect-new-buffer": "error",
      "security/detect-no-csrf-before-method-override": "error",
      "security/detect-non-literal-require": "error",
      "security/detect-pseudoRandomBytes": "error",
      "security/detect-child-process": "warn",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-unsafe-regex": "warn",
    },
  },
];
