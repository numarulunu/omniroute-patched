import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  ensureContextCompactionTables,
  recordContextCompactionCandidate,
} from "../../src/lib/usage/contextCompactionEvents.ts";

function createDb() {
  const db = new Database(":memory:");
  ensureContextCompactionTables(db);
  return db;
}

test("records a metadata-only compaction event when a session drops from high context", () => {
  const db = createDb();

  const first = recordContextCompactionCandidate(db, {
    callLogId: "call_high",
    timestamp: "2026-05-05T18:00:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 210000,
    tokensCacheRead: 200000,
    requestBody: { prompt_cache_key: "conversation-secret-key", input: "do not store this" },
  });

  const second = recordContextCompactionCandidate(db, {
    callLogId: "call_low",
    timestamp: "2026-05-05T18:01:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 30000,
    tokensCacheRead: 20000,
    requestBody: { prompt_cache_key: "conversation-secret-key", input: "do not store this" },
  });

  assert.equal(first, null);
  assert.ok(second);
  assert.equal(second?.previousCallLogId, "call_high");
  assert.equal(second?.currentCallLogId, "call_low");
  assert.equal(second?.previousTokensIn, 210000);
  assert.equal(second?.currentTokensIn, 30000);
  assert.equal(second?.previousNonCachedInputTokens, 10000);
  assert.equal(second?.currentNonCachedInputTokens, 10000);

  const stored = db.prepare("SELECT * FROM context_compaction_events").all() as Array<
    Record<string, unknown>
  >;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].prompt_cache_key_hash, second?.promptCacheKeyHash);
  assert.equal(JSON.stringify(stored).includes("conversation-secret-key"), false);
  assert.equal(JSON.stringify(stored).includes("do not store this"), false);
});

test("ignores explicit compact endpoint and failed rows for implicit compaction detection", () => {
  const db = createDb();

  const explicit = recordContextCompactionCandidate(db, {
    callLogId: "explicit",
    timestamp: "2026-05-05T18:00:00.000Z",
    path: "/v1/responses/compact",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 210000,
    tokensCacheRead: 0,
    requestBody: { prompt_cache_key: "conversation-secret-key" },
  });

  const failed = recordContextCompactionCandidate(db, {
    callLogId: "failed",
    timestamp: "2026-05-05T18:00:01.000Z",
    path: "/v1/responses",
    status: 429,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 20000,
    tokensCacheRead: 0,
    requestBody: { prompt_cache_key: "conversation-secret-key" },
  });

  assert.equal(explicit, null);
  assert.equal(failed, null);
  const count = db.prepare("SELECT COUNT(*) AS count FROM context_compaction_events").get() as {
    count: number;
  };
  assert.equal(count.count, 0);
});
