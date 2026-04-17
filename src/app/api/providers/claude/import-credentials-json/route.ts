/**
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
    return badRequest("Missing claudeAiOauth object — is this a Claude Code credentials file?");
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
  const prettyName = `Claude ${subscriptionType.charAt(0).toUpperCase()}${subscriptionType.slice(1)}`;

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
