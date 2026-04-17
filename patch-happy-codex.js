#!/usr/bin/env node
/**
 * patch-codex-config.js — Patches ~/.codex/config.toml so Codex CLI
 * routes through OmniRoute (localhost:20128) using SSE instead of WebSocket.
 *
 * Also sets the OMNIROUTE_API_KEY user env var on Windows.
 *
 * Run: node patch-codex-config.js
 * Version: 1.0.0 — 2026-04-16
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const CODEX_DIR = path.join(os.homedir(), ".codex");
const CONFIG_PATH = path.join(CODEX_DIR, "config.toml");
const API_KEY = "sk-969648594a1c9eaf-91d5ed-1014e6e3";
const BASE_URL = "http://localhost:20128/v1";

let hadFailure = false;
function fail(msg) {
  console.error("\u2717 " + msg);
  hadFailure = true;
}
function ok(msg) {
  console.log("\u2713 " + msg);
}

// --- Read existing config ---
if (!fs.existsSync(CONFIG_PATH)) {
  fail(`Config not found: ${CONFIG_PATH}`);
  process.exit(1);
}

let txt = fs.readFileSync(CONFIG_PATH, "utf8");
const orig = txt;

// --- Remove old flat openai_base_url / openai_api_key if present ---
txt = txt.replace(/^openai_base_url\s*=.*$/m, "");
txt = txt.replace(/^openai_api_key\s*=.*$/m, "");

// --- Add model_provider = "omniroute" if missing ---
if (!txt.includes("model_provider")) {
  txt = txt.replace(/^(model\s*=\s*"[^"]*")$/m, '$1\nmodel_provider = "omniroute"');
  ok('Added model_provider = "omniroute"');
} else {
  ok("model_provider already set");
}

// --- Add [model_providers.omniroute] block if missing ---
if (!txt.includes("[model_providers.omniroute]")) {
  // Find first [projects. or [notice or end-of-top-section
  const insertBefore = txt.match(/^\[(projects|notice|windows|features|mcp_servers)\./m);
  const block = [
    "",
    "[model_providers.omniroute]",
    'name = "OmniRoute Local Proxy"',
    `base_url = "${BASE_URL}"`,
    'env_key = "OMNIROUTE_API_KEY"',
    'wire_api = "responses"',
    "supports_websockets = false",
    "",
  ].join("\n");

  if (insertBefore) {
    txt = txt.slice(0, insertBefore.index) + block + "\n" + txt.slice(insertBefore.index);
  } else {
    txt += "\n" + block;
  }
  ok("Added [model_providers.omniroute] block");
} else {
  ok("[model_providers.omniroute] already present");
}

// --- Write config ---
if (txt !== orig) {
  // Clean up blank line runs
  txt = txt.replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(CONFIG_PATH, txt, "utf8");
  ok(`Config written: ${CONFIG_PATH}`);
} else {
  ok("Config unchanged — already patched");
}

// --- Set env var (Windows only) ---
if (process.platform === "win32") {
  try {
    execSync(
      `powershell -NoProfile -Command "[System.Environment]::SetEnvironmentVariable('OMNIROUTE_API_KEY', '${API_KEY}', 'User')"`,
      { stdio: "pipe" }
    );
    ok("Set OMNIROUTE_API_KEY as persistent user env var");
  } catch (e) {
    fail("Failed to set OMNIROUTE_API_KEY env var: " + e.message);
  }
} else {
  console.log("  Non-Windows: export OMNIROUTE_API_KEY=" + API_KEY + " in your shell profile");
}

// --- Summary ---
console.log("");
if (hadFailure) {
  console.error("\u2717 One or more steps failed.");
  process.exit(1);
} else {
  ok("Codex config patched for OmniRoute (SSE, no WebSocket).");
  console.log("  Restart Codex / Happy for changes to take effect.");
}
