import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  consumeContextPressureIntervention,
  ensureContextCompactionTables,
  getPendingContextPressureIntervention,
  recordContextCompactionCandidate,
  recordContextPressureCandidate,
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

test("records metadata-only context pressure events for high uncached input", () => {
  const db = createDb();

  const event = recordContextPressureCandidate(db, {
    callLogId: "call_pressure",
    timestamp: "2026-05-05T18:02:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 130000,
    tokensCacheRead: 70000,
    requestBody: { prompt_cache_key: "conversation-secret-key", input: "do not store this" },
  });

  assert.ok(event);
  assert.equal(event?.callLogId, "call_pressure");
  assert.equal(event?.tokensIn, 130000);
  assert.equal(event?.tokensCacheRead, 70000);
  assert.equal(event?.nonCachedInputTokens, 60000);
  assert.equal(event?.cacheReadPct, 53.8);
  assert.equal(event?.reason, "high_uncached_input");

  const stored = db.prepare("SELECT * FROM context_pressure_events").all() as Array<
    Record<string, unknown>
  >;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].prompt_cache_key_hash, event?.promptCacheKeyHash);
  assert.equal(JSON.stringify(stored).includes("conversation-secret-key"), false);
  assert.equal(JSON.stringify(stored).includes("do not store this"), false);
});

test("records low cache-rate pressure only for large cached sessions", () => {
  const db = createDb();

  const smallLowCache = recordContextPressureCandidate(db, {
    callLogId: "small_low_cache",
    timestamp: "2026-05-05T18:02:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 20000,
    tokensCacheRead: 1000,
    requestBody: { prompt_cache_key: "conversation-secret-key" },
  });

  const largeLowCache = recordContextPressureCandidate(db, {
    callLogId: "large_low_cache",
    timestamp: "2026-05-05T18:03:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 120000,
    tokensCacheRead: 90000,
    requestBody: { prompt_cache_key: "conversation-secret-key" },
  });

  assert.equal(smallLowCache, null);
  assert.ok(largeLowCache);
  assert.equal(largeLowCache?.reason, "low_cache_rate");
  assert.equal(largeLowCache?.nonCachedInputTokens, 30000);
  assert.equal(largeLowCache?.cacheReadPct, 75);
});

test("ignores pressure candidates without successful responses prompt cache keys", () => {
  const db = createDb();

  for (const input of [
    { path: "/v1/responses/compact", status: 200, requestBody: { prompt_cache_key: "key" } },
    { path: "/v1/responses", status: 500, requestBody: { prompt_cache_key: "key" } },
    { path: "/v1/responses", status: 200, requestBody: {} },
  ]) {
    assert.equal(
      recordContextPressureCandidate(db, {
        callLogId: `${input.path}-${input.status}`,
        timestamp: "2026-05-05T18:04:00.000Z",
        provider: "codex",
        model: "gpt-5.5",
        tokensIn: 200000,
        tokensCacheRead: 0,
        ...input,
      }),
      null
    );
  }

  const count = db.prepare("SELECT COUNT(*) AS count FROM context_pressure_events").get() as {
    count: number;
  };
  assert.equal(count.count, 0);
});

test("marks repeated high-uncached sessions for one-shot pressure intervention", () => {
  const db = createDb();
  const requestBody = { prompt_cache_key: "conversation-secret-key" };

  recordContextPressureCandidate(db, {
    callLogId: "call_pressure_1",
    timestamp: "2026-05-05T18:00:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 120000,
    tokensCacheRead: 60000,
    requestBody,
  });

  assert.equal(
    getPendingContextPressureIntervention(db, requestBody, "2026-05-05T18:05:30.000Z"),
    null
  );

  recordContextPressureCandidate(db, {
    callLogId: "call_pressure_2",
    timestamp: "2026-05-05T18:04:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 130000,
    tokensCacheRead: 65000,
    requestBody,
  });

  const pending = getPendingContextPressureIntervention(
    db,
    requestBody,
    "2026-05-05T18:04:30.000Z"
  );
  assert.ok(pending);
  assert.equal(pending?.reason, "repeated_high_uncached_input");
  assert.equal(pending?.lastNonCachedInputTokens, 65000);

  const consumed = consumeContextPressureIntervention(db, requestBody, "2026-05-05T18:05:00.000Z");
  assert.ok(consumed);
  assert.equal(
    getPendingContextPressureIntervention(db, requestBody, "2026-05-05T18:05:30.000Z"),
    null
  );

  const stored = db.prepare("SELECT * FROM context_pressure_sessions").get() as Record<
    string,
    unknown
  >;
  assert.equal(stored.pending_intervention, 0);
  assert.equal(stored.intervention_count, 1);
  assert.equal(JSON.stringify(stored).includes("conversation-secret-key"), false);
});

test("clears pending pressure intervention after a real compact-like drop", () => {
  const db = createDb();
  const requestBody = { prompt_cache_key: "conversation-secret-key" };

  recordContextPressureCandidate(db, {
    callLogId: "call_pressure_big",
    timestamp: "2026-05-05T18:00:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 210000,
    tokensCacheRead: 2000,
    requestBody,
  });

  assert.ok(getPendingContextPressureIntervention(db, requestBody, "2026-05-05T18:00:30.000Z"));

  recordContextCompactionCandidate(db, {
    callLogId: "call_high",
    timestamp: "2026-05-05T18:01:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 210000,
    tokensCacheRead: 190000,
    requestBody,
  });

  recordContextCompactionCandidate(db, {
    callLogId: "call_low",
    timestamp: "2026-05-05T18:02:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 30000,
    tokensCacheRead: 10000,
    requestBody,
  });

  assert.equal(
    getPendingContextPressureIntervention(db, requestBody, "2026-05-05T18:05:30.000Z"),
    null
  );
});
test("marks a single 120k uncached spike for critical pressure intervention", () => {
  const db = createDb();
  const requestBody = { prompt_cache_key: "conversation-secret-key" };

  recordContextPressureCandidate(db, {
    callLogId: "call_pressure_120k",
    timestamp: "2026-05-05T18:00:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 160000,
    tokensCacheRead: 40000,
    requestBody,
  });

  const pending = getPendingContextPressureIntervention(
    db,
    requestBody,
    "2026-05-05T18:04:30.000Z"
  );
  assert.ok(pending);
  assert.equal(pending.reason, "critical_high_uncached_input");
  assert.equal(pending.lastNonCachedInputTokens, 120000);
});

test("expires stale pending pressure interventions instead of consuming them", () => {
  const db = createDb();
  const requestBody = { prompt_cache_key: "conversation-secret-key" };

  recordContextPressureCandidate(db, {
    callLogId: "call_pressure_stale",
    timestamp: "2026-05-05T18:00:00.000Z",
    path: "/v1/responses",
    status: 200,
    provider: "codex",
    model: "gpt-5.5",
    tokensIn: 210000,
    tokensCacheRead: 2000,
    requestBody,
  });

  assert.ok(getPendingContextPressureIntervention(db, requestBody, "2026-05-05T23:59:00.000Z"));
  assert.equal(
    consumeContextPressureIntervention(db, requestBody, "2026-05-06T00:01:00.000Z"),
    null
  );

  const stored = db.prepare("SELECT * FROM context_pressure_sessions").get() as Record<
    string,
    unknown
  >;
  assert.equal(stored.pending_intervention, 0);
  assert.equal(stored.intervention_count, 0);
  assert.equal(stored.pending_reason, null);
});
