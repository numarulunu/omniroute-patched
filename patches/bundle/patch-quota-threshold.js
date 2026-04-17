#!/usr/bin/env node
/**
 * patch-quota-threshold.js — Sets OmniRoute's Codex quota threshold to 100%
 * so accounts are only filtered when fully exhausted, not at 90%.
 *
 * Patches both source (.ts) and compiled (.js) files.
 *
 * Run: node patch-quota-threshold.js
 * Version: 1.0.0 — 2026-04-16
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const APPDATA =
  process.env.APPDATA ||
  (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Roaming") : null);
if (!APPDATA) {
  console.error("\u2717 Windows-only.");
  process.exit(1);
}

const APP_ROOT = path.join(APPDATA, "npm", "node_modules", "omniroute", "app");
const NEW_THRESHOLD = 100;

let hadFailure = false;
function fail(msg) {
  console.error("\u2717 " + msg);
  hadFailure = true;
}
function ok(msg) {
  console.log("\u2713 " + msg);
}

// --- 1. Patch source: src/sse/services/auth.ts ---
const authTs = path.join(APP_ROOT, "src", "sse", "services", "auth.ts");
if (fs.existsSync(authTs)) {
  let txt = fs.readFileSync(authTs, "utf8");
  const orig = txt;
  txt = txt.replace(
    /const CODEX_QUOTA_THRESHOLD_PERCENT\s*=\s*\d+;/,
    `const CODEX_QUOTA_THRESHOLD_PERCENT = ${NEW_THRESHOLD};`
  );
  if (txt !== orig) {
    fs.writeFileSync(authTs, txt);
    ok(`auth.ts: CODEX_QUOTA_THRESHOLD_PERCENT -> ${NEW_THRESHOLD}`);
  } else if (txt.includes(`CODEX_QUOTA_THRESHOLD_PERCENT = ${NEW_THRESHOLD}`)) {
    ok("auth.ts: already patched");
  } else {
    fail("auth.ts: pattern not found");
  }
} else {
  fail("auth.ts not found: " + authTs);
}

// --- 2. Patch source: open-sse/executors/codex.ts ---
const codexTs = path.join(APP_ROOT, "open-sse", "executors", "codex.ts");
if (fs.existsSync(codexTs)) {
  let txt = fs.readFileSync(codexTs, "utf8");
  const orig = txt;
  txt = txt.replace(/threshold\s*=\s*0\.9\d+\)/, `threshold = 1.0)`);
  if (txt !== orig) {
    fs.writeFileSync(codexTs, txt);
    ok("codex.ts: threshold -> 1.0");
  } else if (txt.includes("threshold = 1.0)")) {
    ok("codex.ts: already patched");
  } else {
    fail("codex.ts: pattern not found");
  }
} else {
  fail("codex.ts not found: " + codexTs);
}

// --- 3. Patch source: open-sse/services/codexQuotaFetcher.ts ---
const fetcherTs = path.join(APP_ROOT, "open-sse", "services", "codexQuotaFetcher.ts");
if (fs.existsSync(fetcherTs)) {
  let txt = fs.readFileSync(fetcherTs, "utf8");
  const orig = txt;
  txt = txt.replace(/threshold\s*=\s*0\.9\d+\)\s*:\s*number/, "threshold = 1.0): number");
  if (txt !== orig) {
    fs.writeFileSync(fetcherTs, txt);
    ok("codexQuotaFetcher.ts: threshold -> 1.0");
  } else if (txt.includes("threshold = 1.0)")) {
    ok("codexQuotaFetcher.ts: already patched");
  } else {
    fail("codexQuotaFetcher.ts: pattern not found");
  }
} else {
  fail("codexQuotaFetcher.ts not found: " + fetcherTs);
}

// --- 4. Patch compiled chunk: .next/server/chunks ---
const chunksDir = path.join(APP_ROOT, ".next", "server", "chunks");
if (fs.existsSync(chunksDir)) {
  const files = fs.readdirSync(chunksDir).filter((f) => f.endsWith(".js") && !f.endsWith(".map"));
  let found = false;
  for (const f of files) {
    const fp = path.join(chunksDir, f);
    const txt = fs.readFileSync(fp, "utf8");
    if (txt.includes("quota policy filtered")) {
      // Minified normalizeQuotaThreshold: $(e,t=90){...}
      const patched = txt.replace(
        /(\w=)90(\)\{let \w=\w\(\w,\w\);return Math\.min\(100,)/,
        `$1${NEW_THRESHOLD}$2`
      );
      if (patched !== txt) {
        fs.writeFileSync(fp, patched);
        ok(`Compiled chunk ${f}: 90 -> ${NEW_THRESHOLD}`);
        found = true;
      } else if (txt.includes(`=${NEW_THRESHOLD}){let`)) {
        ok(`Compiled chunk ${f}: already patched`);
        found = true;
      }
    }
  }
  if (!found) fail("No compiled chunk matched the quota threshold pattern");
} else {
  fail("Chunks dir not found: " + chunksDir);
}

// --- Summary ---
console.log("");
if (hadFailure) {
  console.error("\u2717 One or more steps failed. Check above.");
  process.exit(1);
} else {
  ok(`Quota threshold set to ${NEW_THRESHOLD}%. Restart OmniRoute.`);
}
