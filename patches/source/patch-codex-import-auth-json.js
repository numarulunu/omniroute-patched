#!/usr/bin/env node
/**
 * patch-codex-import-auth-json.js — Source-level OmniRoute patch.
 *
 * Adds an "Import auth.json" feature so remote/headless OmniRoute deploys
 * can register a ChatGPT Codex OAuth account without running the
 * localhost:1455 PKCE callback listener.
 *
 * Run from the OmniRoute source root AFTER pulling a fresh upstream clone
 * (and BEFORE `docker build`):
 *   node patch-codex-import-auth-json.js
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
const ROUTE_DIR = path.join(ROOT, "src", "app", "api", "providers", "codex", "import-auth-json");
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
const info = (m) => console.log("  " + m);

if (!fs.existsSync(PAGE_PATH)) {
  fail("Providers page not found at " + PAGE_PATH + " — run from OmniRoute repo root");
  process.exit(1);
}

// ── Step 1: Write the new API route (overwrite is safe; content is versioned) ─
const ROUTE_BODY = `/**
 * POST /api/providers/codex/import-auth-json
 *
 * Accepts an uploaded ~/.codex/auth.json body and registers it as a Codex OAuth
 * connection — so users on remote/headless OmniRoute deployments can finish
 * ChatGPT auth locally (codex login) and paste the file here, skipping the
 * localhost:1455 PKCE callback flow that only works on the box running Codex.
 *
 * Ionut patch (2026-04-17): upstream only EXPORTS tokens to the filesystem via
 * apply-local; there is no import counterpart for headless servers.
 */
import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/db/providers";
import { codex } from "@/lib/oauth/providers/codex";

// OpenAI ChatGPT Codex access tokens live ~28 days; refresh handled by
// OmniRoute's health-check loop once the token approaches expiry.
const CODEX_ACCESS_TOKEN_LIFETIME_S = 28 * 24 * 60 * 60;

interface AuthJsonBody {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

function badRequest(message: string, code = "invalid_request") {
  return NextResponse.json({ error: message, code }, { status: 400 });
}

function computeExpiresIn(lastRefresh: string | undefined): number {
  if (!lastRefresh) return CODEX_ACCESS_TOKEN_LIFETIME_S;
  const lastMs = Date.parse(lastRefresh);
  if (Number.isNaN(lastMs)) return CODEX_ACCESS_TOKEN_LIFETIME_S;
  const elapsed = Math.floor((Date.now() - lastMs) / 1000);
  const remaining = CODEX_ACCESS_TOKEN_LIFETIME_S - elapsed;
  // Min 60s so the next health-check refreshes it if the uploaded file is old.
  return remaining > 60 ? remaining : 60;
}

function safeEqual(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a === b;
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: AuthJsonBody;
  try {
    body = (await request.json()) as AuthJsonBody;
  } catch {
    return badRequest("Body must be valid JSON matching ~/.codex/auth.json");
  }

  if (!body || typeof body !== "object") {
    return badRequest("Empty or non-object body");
  }

  const t = body.tokens;
  if (!t || typeof t !== "object") {
    return badRequest("Missing tokens object — is this a ChatGPT auth.json?");
  }
  if (!t.id_token || !t.access_token || !t.refresh_token) {
    return badRequest(
      "auth.json missing one of: tokens.id_token, tokens.access_token, tokens.refresh_token",
      "incomplete_tokens"
    );
  }

  // Feed the uploaded tokens through codex.postExchange + mapTokens so we
  // inherit the same workspace-resolution logic the live OAuth flow uses.
  const syntheticTokens = {
    id_token: t.id_token,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_in: computeExpiresIn(body.last_refresh),
  };

  const extra = await codex.postExchange(syntheticTokens);
  const mapped = codex.mapTokens(syntheticTokens, extra);

  if (!mapped.email) {
    return badRequest(
      "Could not extract an email from id_token — is the file corrupted?",
      "email_missing"
    );
  }

  const expiresAt = mapped.expiresIn
    ? new Date(Date.now() + mapped.expiresIn * 1000).toISOString()
    : null;

  try {
    // Mirror poll-callback's upsert behaviour: match on email + workspace.
    const existing = await getProviderConnections({ provider: "codex" });
    const match = existing.find((c: any) => {
      if (!safeEqual(c.email, mapped.email) || c.authType !== "oauth") return false;
      const wsNew = mapped.providerSpecificData?.workspaceId;
      if (wsNew) {
        return safeEqual(c.providerSpecificData?.workspaceId, wsNew);
      }
      return true;
    });

    let connection: any;
    const matchId = typeof match?.id === "string" ? match.id : null;
    if (matchId) {
      connection = await updateProviderConnection(matchId, {
        ...mapped,
        expiresAt,
        testStatus: "active",
        isActive: true,
      });
    } else {
      connection = await createProviderConnection({
        provider: "codex",
        authType: "oauth",
        ...mapped,
        expiresAt,
        testStatus: "active",
      });
    }

    return NextResponse.json({
      success: true,
      imported: !matchId,
      connection: {
        id: connection?.id,
        provider: connection?.provider,
        email: connection?.email,
        displayName: connection?.displayName,
        workspaceId: connection?.providerSpecificData?.workspaceId ?? null,
      },
    });
  } catch (err: any) {
    console.error("[Codex import-auth-json] Failed:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to import auth.json", code: "import_failed" },
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

const SENTINEL = "importingCodexAuthJson"; // marker used to detect prior patch
if (page.includes(SENTINEL)) {
  ok("page.tsx already patched (sentinel '" + SENTINEL + "' present)");
  process.exit(hadFailure ? 1 : 0);
}

// Anchor 1: add state hooks right after exportingCodexAuthId state
const ANCHOR_STATE = `  const [exportingCodexAuthId, setExportingCodexAuthId] = useState<string | null>(null);`;
const INJECT_STATE =
  ANCHOR_STATE +
  `
  const [importingCodexAuthJson, setImportingCodexAuthJson] = useState(false);
  const importCodexAuthJsonInputRef = useRef<HTMLInputElement | null>(null);`;

let out = page.replace(ANCHOR_STATE, INJECT_STATE);
if (out === page) fail("State anchor not found — upstream page.tsx changed");
else ok("Inserted state hooks");

// Anchor 2: insert handler above handleSwapPriority
const ANCHOR_HANDLER = `  const handleSwapPriority = async (conn1, conn2) => {`;
const HANDLER_BODY = `  const handleImportCodexAuthJson = async (file: File) => {
    if (importingCodexAuthJson) return;
    setImportingCodexAuthJson(true);

    const defaultError =
      typeof t.has === "function" && t.has("codexAuthImportFailed")
        ? t("codexAuthImportFailed")
        : "Failed to import auth.json";
    const defaultSuccess =
      typeof t.has === "function" && t.has("codexAuthImported")
        ? t("codexAuthImported")
        : "Codex account imported from auth.json";

    try {
      const text = await file.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        notify.error("File is not valid JSON");
        return;
      }

      const res = await fetch("/api/providers/codex/import-auth-json", {
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
      console.error("Error importing Codex auth.json:", error);
      notify.error(defaultError);
    } finally {
      setImportingCodexAuthJson(false);
      if (importCodexAuthJsonInputRef.current) {
        importCodexAuthJsonInputRef.current.value = "";
      }
    }
  };

`;
const before2 = out;
out = out.replace(ANCHOR_HANDLER, HANDLER_BODY + ANCHOR_HANDLER);
if (out === before2) fail("Handler anchor (handleSwapPriority) not found");
else ok("Inserted handleImportCodexAuthJson");

// Anchor 3: header-row Codex button — append inside the qoder-only block's parent
const ANCHOR_HEADER_QODER = `              {providerId === "qoder" && (
                <Button size="sm" variant="secondary" onClick={() => setShowOAuthModal(true)}>
                  Experimental OAuth
                </Button>
              )}
            </div>
          ) : (`;
const HEADER_CODEX_BUTTON = `              {providerId === "qoder" && (
                <Button size="sm" variant="secondary" onClick={() => setShowOAuthModal(true)}>
                  Experimental OAuth
                </Button>
              )}
              {providerId === "codex" && (
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
const before3 = out;
out = out.replace(ANCHOR_HEADER_QODER, HEADER_CODEX_BUTTON);
if (out === before3) fail("Header-row qoder anchor not found");
else ok("Inserted header-row Import auth.json button");

// Anchor 4: empty-state Codex button + hint
const ANCHOR_EMPTY_QODER = `                {providerId === "qoder" && (
                  <Button variant="secondary" onClick={() => setShowOAuthModal(true)}>
                    Experimental OAuth
                  </Button>
                )}
              </div>
            )}
          </div>`;
const EMPTY_CODEX_BUTTON = `                {providerId === "qoder" && (
                  <Button variant="secondary" onClick={() => setShowOAuthModal(true)}>
                    Experimental OAuth
                  </Button>
                )}
                {providerId === "codex" && (
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
            )}
          </div>`;
const before4 = out;
out = out.replace(ANCHOR_EMPTY_QODER, EMPTY_CODEX_BUTTON);
if (out === before4) fail("Empty-state qoder anchor not found");
else ok("Inserted empty-state Import auth.json button + hint");

// Anchor 5: hidden file input right before the Modals comment
const ANCHOR_MODALS = `      {/* Modals */}
      {providerId === "kiro" ? (`;
const FILE_INPUT_BLOCK = `      {/* Codex auth.json file picker (hidden) */}
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

      {/* Modals */}
      {providerId === "kiro" ? (`;
const before5 = out;
out = out.replace(ANCHOR_MODALS, FILE_INPUT_BLOCK);
if (out === before5) fail("Modals anchor not found");
else ok("Inserted hidden file input");

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
  console.log("\n\u2713 All patches applied. Ready to `docker build`.");
}
process.exit(hadFailure ? 1 : 0);
