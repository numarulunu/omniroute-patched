/**
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
