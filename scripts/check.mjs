#!/usr/bin/env node
// Local quality gates: the single definition run by developers, the factory reconciler and CI.
// Node standard library only. Runs every step in order and stops at the first failure.
// `node scripts/check.mjs semgrep osv` runs only the named steps (in the standard order).
// Factory-owned file: agents must not edit it.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ciTier = process.env.FABRICA_CI === "1"; // CI: a missing security scanner fails instead of being skipped
const semgrepRules = ".semgrep/factory-rules.yml"; // the factory's own rules; never Semgrep-maintained ones
const osvLockfile = "package-lock.json";
const highCvss = 7.0;
const osvNoPackages = 128; // osv-scanner's exit code when the lockfile lists no package

/** Resolve a dev dependency's JS entry so it runs through `node` without a shell (works on Windows). */
function packageBin(pkg, bin) {
  const manifestPath = join(root, "node_modules", pkg, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`${pkg} is not installed; run "npm install" first`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
  if (!rel) {
    throw new Error(`${pkg} does not declare a "${bin}" executable`);
  }
  return [process.execPath, join(root, "node_modules", pkg, rel)];
}

/** Find a native executable on PATH. On Windows only .exe/.com can be spawned without a shell. */
function findOnPath(name) {
  const exts = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

function run(label, argv) {
  console.log(`\n==> ${label}: ${argv.slice(1).join(" ")}`);
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`${label}: FAILED to start (${result.error.message})`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`${label}: FAILED (exit ${result.status ?? result.signal})`);
    return false;
  }
  console.log(`${label}: ok`);
  return true;
}

function secrets() {
  const gitleaks = findOnPath("gitleaks");
  if (gitleaks) {
    return run("secrets", [gitleaks, "dir", ".", "--redact", "--verbose", "--no-banner"]);
  }
  if (process.env.FABRICA_ALLOW_MISSING_GITLEAKS === "1") {
    console.log("\n==> secrets\ngitleaks: SKIPPED (not installed)");
    return true;
  }
  console.error(
    "\n==> secrets\nsecrets: FAILED, gitleaks is not on PATH.\n" +
      "Install it (https://github.com/gitleaks/gitleaks#installing): " +
      "`winget install Gitleaks.Gitleaks`, `brew install gitleaks`, or download a release binary.\n" +
      "To skip this step explicitly, set FABRICA_ALLOW_MISSING_GITLEAKS=1.",
  );
  return false;
}

/**
 * Known vulnerabilities in production dependencies, through the npm that runs `npm run check`.
 * `--omit=dev` keeps optional dependencies (the extras users may install) in the audit.
 */
function audit() {
  if (process.env.FABRICA_ALLOW_OFFLINE_AUDIT === "1") {
    console.log("\n==> audit\naudit: SKIPPED (FABRICA_ALLOW_OFFLINE_AUDIT=1)");
    return true;
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const runtime = { ...manifest.dependencies, ...manifest.optionalDependencies };
  if (Object.keys(runtime).length === 0) {
    console.log("\n==> audit\naudit: no runtime dependencies");
    return true;
  }
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    console.error("\n==> audit\naudit: FAILED, run the gates through `npm run check`.");
    return false;
  }
  return run("audit", [process.execPath, npmCli, "audit", "--omit=dev", "--audit-level=moderate"]);
}

/** A scanner that is not installed: skipped locally, a failure in CI (FABRICA_CI=1). */
function missingScanner(label, tool) {
  if (ciTier) {
    console.error(`\n==> ${label}\n${tool}: FAILED, ${tool} not installed (required in CI).`);
    return false;
  }
  console.log(`\n==> ${label}\n${tool}: skipped: ${tool} not installed`);
  return true;
}

/** Semgrep CE with the factory's own rules only; ERROR rules fail. `nosemgrep` comments are ignored. */
function semgrep() {
  const exe = findOnPath("semgrep");
  if (!exe) return missingScanner("semgrep", "semgrep");
  return run("semgrep", [
    exe,
    "scan",
    "--config",
    semgrepRules,
    "--error",
    "--severity",
    "ERROR",
    "--metrics",
    "off",
    "--disable-version-check",
    "--disable-nosem",
    "--quiet",
    "src",
  ]);
}

/** Advisories in an OSV-Scanner JSON report with CVSS >= 7.0 or no score (unknown counts as high). */
export function osvBlocking(report) {
  const out = [];
  for (const result of report?.results ?? []) {
    for (const pkg of result?.packages ?? []) {
      const name = `${pkg?.package?.name ?? "?"}@${pkg?.package?.version ?? "?"}`;
      for (const group of pkg?.groups ?? []) {
        const raw = String(group?.max_severity ?? "");
        const score = raw.trim() === "" ? Number.NaN : Number(raw);
        if (Number.isNaN(score) || score >= highCvss) {
          const ids = (group?.ids ?? []).join(",") || "?";
          out.push(`${name} ${ids} (${Number.isNaN(score) ? "unknown" : raw})`);
        }
      }
    }
  }
  return out;
}

/** Known vulnerabilities in every locked package (OSV-Scanner); high or unknown severity fails. */
function osv() {
  const exe = findOnPath("osv-scanner");
  if (!exe) return missingScanner("osv", "osv-scanner");
  console.log(`\n==> osv: osv-scanner scan source --lockfile=${osvLockfile}`);
  const lock = join(root, osvLockfile);
  if (!existsSync(lock)) {
    if (ciTier) {
      console.error(`osv: FAILED, ${osvLockfile} not found (run npm install).`);
      return false;
    }
    console.log(`osv-scanner: skipped: no ${osvLockfile} (run npm install)`);
    return true;
  }
  const result = spawnSync(exe, ["scan", "source", "--format", "json", `--lockfile=${lock}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    shell: false,
  });
  if (result.error) {
    console.error(`osv: FAILED to start (${result.error.message})`);
    return false;
  }
  if (result.status === 0 || result.status === osvNoPackages) {
    console.log(`osv: ok, no known vulnerabilities in ${osvLockfile}`);
    return true;
  }
  if (result.status !== 1) {
    console.error(`osv: FAILED (exit ${result.status ?? result.signal})`);
    return false;
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error("osv: FAILED, unreadable JSON report");
    return false;
  }
  const blocking = osvBlocking(report);
  for (const line of blocking) console.error(`osv-scanner: ${line}`);
  if (blocking.length > 0) {
    console.error("osv: FAILED (high or unknown severity)");
    return false;
  }
  console.log("osv: ok, only advisories below high severity (reported, not failing)");
  return true;
}

function main(selected) {
  const steps = [
    [
      "lint+format",
      () =>
        run("lint+format", [
          ...packageBin("@biomejs/biome", "biome"),
          "ci",
          ...(process.stdout.isTTY ? [] : ["--colors=off"]),
          ".",
        ]),
    ],
    // tsconfig.json includes test/, so this also type-checks the CI-only *.conformance.test.ts files that vitest
    // skips locally: a conformance test that does not compile fails here and not first in CI (L48).
    ["types", () => run("types", [...packageBin("typescript", "tsc"), "--noEmit"])],
    // ESLint with eslint-plugin-security only: errors (high severity) fail; inline disables are ignored.
    [
      "security",
      () =>
        run("security", [
          process.execPath,
          "--disable-warning=ExperimentalWarning",
          packageBin("eslint", "eslint")[1],
          "--config",
          join("scripts", "eslint-security.config.mjs"),
          "--no-inline-config",
          "src",
        ]),
    ],
    ["semgrep", semgrep],
    ["tests", () => run("tests", [...packageBin("vitest", "vitest"), "run", "--coverage"])],
    ["docs", () => run("docs", [process.execPath, join(root, "scripts", "check-docs.mjs")])],
    ["secrets", secrets],
    ["audit", audit],
    ["osv", osv],
  ];
  const known = steps.map(([name]) => name);
  const unknown = selected.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    console.error(`check: unknown steps ${unknown.join(", ")}; known: ${known.join(", ")}`);
    return 2;
  }
  for (const [name, step] of steps) {
    if (selected.length > 0 && !selected.includes(name)) continue;
    if (!step()) return 1;
  }
  console.log("\nAll gates passed.");
  return 0;
}

// Fail-safe: the gates always run, unless a test that only imports this module (osvBlocking) sets
// FABRICA_CHECK_IMPORT_ONLY=1. Comparing paths to detect "run as a script" could skip every gate and exit 0.
if (process.env.FABRICA_CHECK_IMPORT_ONLY !== "1") {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
