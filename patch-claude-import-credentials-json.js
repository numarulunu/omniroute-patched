#!/usr/bin/env node
/**
 * patch-claude-import-credentials-json.js — Source-level OmniRoute patch.
 *
 * Adds an "Import credentials.json" feature so remote/headless OmniRoute
 * deploys can register a Claude Code OAuth account without running the
 * full browser callback flow (which Anthropic rate-limits by IP and
 * routinely blocks from headless servers with rate_limit_error).
 *
 * Assumes patch-codex-import-auth-json.js has already run — this patch
 * anchors next to the Codex-inserted blocks to keep diffs compact and
 * reduce risk of upstream-layout drift.
 *
 * Run from the OmniRoute source root AFTER pulling a fresh upstream clone
 * and AFTER patch-codex-import-auth-json.js, BEFORE `docker build`:
 *   node patch-codex-import-auth-json.js
 *   node patch-claude-import-credentials-json.js
 *
 * Idempotent: detects sentinels and no-ops on re-runs.
 *
 * Exit codes:
 *   0 — patched (or already patched)
 *   1 — one or more steps failed; do NOT build until resolved
 *
 * Author: Ionut (2026-04-17)
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const ROUTE_DIR = path.join(
  ROOT,
  "src",
  "app",
  "api",
  "providers",
  "claude",
  "import-credentials-json"
);
const ROUTE_PATH = path.join(ROUTE_DIR, "route.ts");
const PAGE_PATH = path.join(
  ROOT,
  "src",
  "app",
  "(dashboard)",
  "dashboard",
  "providers",
  "[id]",
  "page.tsx"
);

let hadFailure = false;
const fail = (m) => {
  console.error("\u2717 " + m);
  hadFailure = true;
};
const ok = (m) => console.log("\u2713 " + m);

if (!fs.existsSync(PAGE_PATH)) {
  fail("Providers page not found at " + PAGE_PATH + " — run from OmniRoute repo root");
  process.exit(1);
}

// ── Step 1: Write the new API route (overwrite is safe; content is versioned) ─
const ROUTE_BODY = `/**
 * POST /api/providers/claude/import-credentials-json
 *
 * Accepts an uploaded ~/.claude/.credentials.json (Claude Code CLI) body and
 * registers it as a Claude OAuth connection. Bypasses the Anthropic token
 * exchange, which is rate-limited by IP and blocks headless OmniRoute deploys
 * from completing the hosted-callback OAuth flow.
 *
 * Ionut patch (2026-04-17): Claude's mapTokens yields no email/displayName,
 * so upsert matching here is by provider+subscriptionType — one connection
 * per subscription tier per account.
 */
import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/db/providers";

interface ClaudeCredentialsBody {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

function badRequest(message: string, code = "invalid_request") {
  return NextResponse.json({ error: message, code }, { status: 400 });
}

function safeEqual(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a === b;
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: ClaudeCredentialsBody;
  try {
    body = (await request.json()) as ClaudeCredentialsBody;
  } catch {
    return badRequest("Body must be valid JSON matching ~/.claude/.credentials.json");
  }

  const c = body?.claudeAiOauth;
  if (!c || typeof c !== "object") {
    return badRequest(
      "Missing claudeAiOauth object — is this a Claude Code credentials file?"
    );
  }
  if (!c.accessToken || !c.refreshToken) {
    return badRequest(
      "credentials.json missing claudeAiOauth.accessToken or refreshToken",
      "incomplete_tokens"
    );
  }

  const nowMs = Date.now();
  // expiresAt in the file is absolute MS. Derive expiresIn for OmniRoute's
  // health-check refresh math, clamped to min 60s so stale files refresh soon.
  const expiresAtMs = typeof c.expiresAt === "number" ? c.expiresAt : nowMs + 60_000;
  const expiresInS = Math.max(60, Math.floor((expiresAtMs - nowMs) / 1000));
  const expiresAtIso = new Date(expiresAtMs).toISOString();
  const scope = Array.isArray(c.scopes) ? c.scopes.join(" ") : undefined;

  const subscriptionType = typeof c.subscriptionType === "string" ? c.subscriptionType : "unknown";
  const prettyName = \`Claude \${subscriptionType.charAt(0).toUpperCase()}\${subscriptionType.slice(1)}\`;

  const mapped = {
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresIn: expiresInS,
    scope,
    name: prettyName,
    providerSpecificData: {
      subscriptionType,
      rateLimitTier: typeof c.rateLimitTier === "string" ? c.rateLimitTier : null,
    },
  };

  try {
    // Upsert: one connection per subscriptionType. Claude tokens don't carry
    // an email, so this is the narrowest stable identifier we have.
    const existing = await getProviderConnections({ provider: "claude" });
    const match = existing.find((conn: any) => {
      if (conn.authType !== "oauth") return false;
      const existingSub = conn.providerSpecificData?.subscriptionType;
      return safeEqual(existingSub, subscriptionType);
    });

    let connection: any;
    const matchId = typeof match?.id === "string" ? match.id : null;
    if (matchId) {
      connection = await updateProviderConnection(matchId, {
        ...mapped,
        expiresAt: expiresAtIso,
        testStatus: "active",
        isActive: true,
      });
    } else {
      connection = await createProviderConnection({
        provider: "claude",
        authType: "oauth",
        ...mapped,
        expiresAt: expiresAtIso,
        testStatus: "active",
      });
    }

    return NextResponse.json({
      success: true,
      imported: !matchId,
      connection: {
        id: connection?.id,
        provider: connection?.provider,
        name: connection?.name,
        subscriptionType: connection?.providerSpecificData?.subscriptionType ?? null,
      },
    });
  } catch (err: any) {
    console.error("[Claude import-credentials-json] Failed:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to import credentials.json", code: "import_failed" },
      { status: 500 }
    );
  }
}
`;

try {
  fs.mkdirSync(ROUTE_DIR, { recursive: true });
  fs.writeFileSync(ROUTE_PATH, ROUTE_BODY, "utf8");
  ok("Wrote " + path.relative(ROOT, ROUTE_PATH));
} catch (e) {
  fail("Failed to write route file: " + e.message);
}

// ── Step 2: Patch page.tsx with the UI hooks (idempotent, sentinel-guarded) ──
let page;
try {
  page = fs.readFileSync(PAGE_PATH, "utf8");
} catch (e) {
  fail("Failed to read page.tsx: " + e.message);
  process.exit(hadFailure ? 1 : 0);
}

const SENTINEL = "importingClaudeCredentialsJson"; // marker used to detect prior patch
if (page.includes(SENTINEL)) {
  ok("page.tsx already patched (sentinel '" + SENTINEL + "' present)");
  process.exit(hadFailure ? 1 : 0);
}

if (!page.includes("importingCodexAuthJson")) {
  fail(
    "Codex import patch not detected — run patch-codex-import-auth-json.js first. " +
      "This patch anchors on the Codex-inserted blocks."
  );
  process.exit(1);
}

// Anchor 1: state hooks — append right after Codex state hooks
const ANCHOR_STATE = `  const [importingCodexAuthJson, setImportingCodexAuthJson] = useState(false);
  const importCodexAuthJsonInputRef = useRef<HTMLInputElement | null>(null);`;
const INJECT_STATE =
  ANCHOR_STATE +
  `
  const [importingClaudeCredentialsJson, setImportingClaudeCredentialsJson] = useState(false);
  const importClaudeCredentialsJsonInputRef = useRef<HTMLInputElement | null>(null);`;

let out = page.replace(ANCHOR_STATE, INJECT_STATE);
if (out === page) fail("State anchor not found — Codex patch layout drifted");
else ok("Inserted state hooks");

// Anchor 2: handler — insert before the Codex->SwapPriority boundary
const ANCHOR_HANDLER = `    } finally {
      setImportingCodexAuthJson(false);
      if (importCodexAuthJsonInputRef.current) {
        importCodexAuthJsonInputRef.current.value = "";
      }
    }
  };

  const handleSwapPriority = async (conn1, conn2) => {`;
const HANDLER_INJECT = `    } finally {
      setImportingCodexAuthJson(false);
      if (importCodexAuthJsonInputRef.current) {
        importCodexAuthJsonInputRef.current.value = "";
      }
    }
  };

  const handleImportClaudeCredentialsJson = async (file: File) => {
    if (importingClaudeCredentialsJson) return;
    setImportingClaudeCredentialsJson(true);

    const defaultError =
      typeof t.has === "function" && t.has("claudeCredentialsImportFailed")
        ? t("claudeCredentialsImportFailed")
        : "Failed to import credentials.json";
    const defaultSuccess =
      typeof t.has === "function" && t.has("claudeCredentialsImported")
        ? t("claudeCredentialsImported")
        : "Claude account imported from credentials.json";

    try {
      const text = await file.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        notify.error("File is not valid JSON");
        return;
      }

      const res = await fetch("/api/providers/claude/import-credentials-json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });

      if (!res.ok) {
        notify.error(await parseApiErrorMessage(res, defaultError));
        return;
      }

      notify.success(defaultSuccess);
      await fetchConnections();
    } catch (error) {
      console.error("Error importing Claude credentials.json:", error);
      notify.error(defaultError);
    } finally {
      setImportingClaudeCredentialsJson(false);
      if (importClaudeCredentialsJsonInputRef.current) {
        importClaudeCredentialsJsonInputRef.current.value = "";
      }
    }
  };

  const handleSwapPriority = async (conn1, conn2) => {`;
const before2 = out;
out = out.replace(ANCHOR_HANDLER, HANDLER_INJECT);
if (out === before2) fail("Handler anchor not found — Codex patch layout drifted");
else ok("Inserted handleImportClaudeCredentialsJson");

// Anchor 3: header-row button — append right after Codex header button
const ANCHOR_HEADER = `              {providerId === "codex" && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="upload_file"
                  disabled={importingCodexAuthJson}
                  onClick={() => importCodexAuthJsonInputRef.current?.click()}
                >
                  {importingCodexAuthJson ? "Importing…" : "Import auth.json"}
                </Button>
              )}
            </div>
          ) : (`;
const HEADER_INJECT = `              {providerId === "codex" && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="upload_file"
                  disabled={importingCodexAuthJson}
                  onClick={() => importCodexAuthJsonInputRef.current?.click()}
                >
                  {importingCodexAuthJson ? "Importing…" : "Import auth.json"}
                </Button>
              )}
              {providerId === "claude" && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="upload_file"
                  disabled={importingClaudeCredentialsJson}
                  onClick={() => importClaudeCredentialsJsonInputRef.current?.click()}
                >
                  {importingClaudeCredentialsJson ? "Importing…" : "Import credentials.json"}
                </Button>
              )}
            </div>
          ) : (`;
const before3 = out;
out = out.replace(ANCHOR_HEADER, HEADER_INJECT);
if (out === before3) fail("Header-row Codex button anchor not found");
else ok("Inserted header-row Import credentials.json button");

// Anchor 4: empty-state button + hint — insert after Codex empty-state block
const ANCHOR_EMPTY = `                {providerId === "codex" && (
                  <Button
                    variant="secondary"
                    icon="upload_file"
                    disabled={importingCodexAuthJson}
                    onClick={() => importCodexAuthJsonInputRef.current?.click()}
                  >
                    {importingCodexAuthJson ? "Importing…" : "Import auth.json"}
                  </Button>
                )}
              </div>
            )}
            {providerId === "codex" && (
              <p className="text-xs text-text-muted mt-3 max-w-md mx-auto">
                Remote-hosted OmniRoute can&apos;t open the ChatGPT OAuth callback
                on this machine. Run <code className="font-mono">codex login</code> on
                your PC, then upload <code className="font-mono">~/.codex/auth.json</code>.
              </p>
            )}`;
const EMPTY_INJECT = `                {providerId === "codex" && (
                  <Button
                    variant="secondary"
                    icon="upload_file"
                    disabled={importingCodexAuthJson}
                    onClick={() => importCodexAuthJsonInputRef.current?.click()}
                  >
                    {importingCodexAuthJson ? "Importing…" : "Import auth.json"}
                  </Button>
                )}
                {providerId === "claude" && (
                  <Button
                    variant="secondary"
                    icon="upload_file"
                    disabled={importingClaudeCredentialsJson}
                    onClick={() => importClaudeCredentialsJsonInputRef.current?.click()}
                  >
                    {importingClaudeCredentialsJson ? "Importing…" : "Import credentials.json"}
                  </Button>
                )}
              </div>
            )}
            {providerId === "codex" && (
              <p className="text-xs text-text-muted mt-3 max-w-md mx-auto">
                Remote-hosted OmniRoute can&apos;t open the ChatGPT OAuth callback
                on this machine. Run <code className="font-mono">codex login</code> on
                your PC, then upload <code className="font-mono">~/.codex/auth.json</code>.
              </p>
            )}
            {providerId === "claude" && (
              <p className="text-xs text-text-muted mt-3 max-w-md mx-auto">
                Claude&apos;s OAuth is IP rate-limited and often fails on
                headless servers. Run <code className="font-mono">claude</code> on
                your PC once, then upload <code className="font-mono">~/.claude/.credentials.json</code>.
              </p>
            )}`;
const before4 = out;
out = out.replace(ANCHOR_EMPTY, EMPTY_INJECT);
if (out === before4) fail("Empty-state Codex anchor not found");
else ok("Inserted empty-state Import credentials.json button + hint");

// Anchor 5: hidden file input — insert after Codex hidden input
const ANCHOR_FILE_INPUT = `      {/* Codex auth.json file picker (hidden) */}
      {providerId === "codex" && (
        <input
          ref={importCodexAuthJsonInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportCodexAuthJson(file);
          }}
        />
      )}`;
const FILE_INPUT_INJECT = `      {/* Codex auth.json file picker (hidden) */}
      {providerId === "codex" && (
        <input
          ref={importCodexAuthJsonInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportCodexAuthJson(file);
          }}
        />
      )}

      {/* Claude credentials.json file picker (hidden) */}
      {providerId === "claude" && (
        <input
          ref={importClaudeCredentialsJsonInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportClaudeCredentialsJson(file);
          }}
        />
      )}`;
const before5 = out;
out = out.replace(ANCHOR_FILE_INPUT, FILE_INPUT_INJECT);
if (out === before5) fail("Hidden Codex input anchor not found");
else ok("Inserted hidden Claude file input");

if (hadFailure) {
  console.error("\n\u2717 Some anchors failed. Aborting write — page.tsx unchanged.");
  process.exit(1);
}

try {
  fs.writeFileSync(PAGE_PATH, out, "utf8");
  ok("Wrote page.tsx");
} catch (e) {
  fail("Failed to write page.tsx: " + e.message);
}

if (!hadFailure) {
  console.log("\n\u2713 All Claude patches applied. Ready to `docker build`.");
}
process.exit(hadFailure ? 1 : 0);
