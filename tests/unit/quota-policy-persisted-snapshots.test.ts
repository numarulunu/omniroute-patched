import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-policy-persisted-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const auth = await import("../../src/sse/services/auth.ts");

function buildConnection(id, providerSpecificData = {}) {
  return {
    id,
    providerSpecificData,
  };
}

function saveCodexSnapshot(connectionId, remainingPercentage, resetAt) {
  quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "codex",
    connection_id: connectionId,
    window_key: "session (5h)",
    remaining_percentage: remainingPercentage,
    is_exhausted: remainingPercentage <= 0 ? 1 : 0,
    next_reset_at: resetAt,
    window_duration_ms: 5 * 60 * 60 * 1000,
    raw_data: null,
  });
}

async function resetStorage() {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("evaluateQuotaLimitPolicy blocks Codex from persisted 5h snapshot after cache miss", () => {
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  saveCodexSnapshot("conn-persisted-warning-buffer", 5, resetAt);

  const result = auth.evaluateQuotaLimitPolicy(
    "codex",
    buildConnection("conn-persisted-warning-buffer", {
      codexLimitPolicy: { use5h: true, useWeekly: false },
    })
  );

  assert.equal(result.blocked, true);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /session usage 95%/i);
  assert.equal(result.resetAt, resetAt);
});

test("evaluateQuotaLimitPolicy keeps Codex eligible from persisted snapshot above warning buffer", () => {
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  saveCodexSnapshot("conn-persisted-above-buffer", 6, resetAt);

  const result = auth.evaluateQuotaLimitPolicy(
    "codex",
    buildConnection("conn-persisted-above-buffer", {
      codexLimitPolicy: { use5h: true, useWeekly: false },
    })
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.resetAt, null);
});

test("evaluateQuotaLimitPolicy ignores persisted Codex snapshot after its reset time passed", () => {
  const resetAt = new Date(Date.now() - 60_000).toISOString();
  saveCodexSnapshot("conn-persisted-stale-reset", 0, resetAt);

  const result = auth.evaluateQuotaLimitPolicy(
    "codex",
    buildConnection("conn-persisted-stale-reset", {
      codexLimitPolicy: { use5h: true, useWeekly: false },
    })
  );

  assert.equal(result.blocked, false);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.resetAt, null);
});
