import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-import-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "codex-import-test-secret";
delete process.env.INITIAL_PASSWORD;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const route = await import("../../src/app/api/providers/codex/import-auth-json/route.ts");

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function makeIdToken(email = "codex@example.com") {
  return makeJwt({
    email,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "workspace-test",
      chatgpt_plan_type: "team",
      organizations: [],
    },
  });
}

async function importAuthJson(accessToken: string, lastRefresh?: string) {
  return route.POST(
    new Request("http://127.0.0.1/api/providers/codex/import-auth-json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tokens: {
          id_token: makeIdToken(),
          access_token: accessToken,
          refresh_token: "codex-refresh-token",
        },
        ...(lastRefresh ? { last_refresh: lastRefresh } : {}),
      }),
    })
  );
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("Codex auth import stores the access token JWT exp as the connection expiry", async () => {
  resetStorage();

  const jwtExp = Math.floor(Date.now() / 1000) + 3600;
  const oldLastRefresh = new Date(Date.now() - 27 * 24 * 60 * 60 * 1000).toISOString();
  const response = await importAuthJson(makeJwt({ exp: jwtExp }), oldLastRefresh);

  assert.equal(response.status, 200);
  const [connection] = await providersDb.getProviderConnections({ provider: "codex" });
  assert.ok(connection.expiresAt);
  assert.ok(Math.abs(Date.parse(connection.expiresAt) - jwtExp * 1000) < 2000);
});

test("Codex auth import falls back to a one-hour access token expiry for opaque tokens", async () => {
  resetStorage();

  const before = Date.now();
  const response = await importAuthJson("opaque-access-token");
  const after = Date.now();

  assert.equal(response.status, 200);
  const [connection] = await providersDb.getProviderConnections({ provider: "codex" });
  assert.ok(connection.expiresAt);
  const expiresAt = Date.parse(connection.expiresAt);
  assert.ok(expiresAt >= before + 3599 * 1000);
  assert.ok(expiresAt <= after + 3601 * 1000);
});
