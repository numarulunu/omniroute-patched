import test from "node:test";
import assert from "node:assert/strict";

import { refreshCodexToken, refreshWithRetry } from "../../open-sse/services/tokenRefresh.ts";

const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

test("Codex refresh treats refresh_token_invalidated as unrecoverable", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "refresh_token_invalidated",
          message: "Your refresh token has been invalidated. Please try signing in again.",
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await refreshCodexToken("stale-refresh-token", silentLog);

  assert.equal(result?.error, "unrecoverable_refresh_error");
  assert.equal(result?.code, "refresh_token_invalidated");
});

test("refreshWithRetry does not retry unrecoverable refresh results", async () => {
  let attempts = 0;

  const result = await refreshWithRetry(
    async () => {
      attempts += 1;
      return { error: "unrecoverable_refresh_error", code: "refresh_token_invalidated" };
    },
    3,
    silentLog,
    "codex-unit-no-retry"
  );

  assert.equal(attempts, 1);
  assert.equal(result?.error, "unrecoverable_refresh_error");
  assert.equal(result?.code, "refresh_token_invalidated");
});
