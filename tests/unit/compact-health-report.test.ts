import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildCompactHealthReport } from "../../scripts/compact-health-report.mjs";

function makeArtifact(baseDir: string, relPath: string, promptCacheKey: string) {
  const absPath = path.join(baseDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(
    absPath,
    JSON.stringify({
      requestBody: {
        prompt_cache_key: promptCacheKey,
        input: [{ role: "user", content: "secret prompt body must never appear" }],
      },
      responseBody: {
        output_text: "secret response body must never appear",
      },
    })
  );
}

describe("compact health report", () => {
  it("groups by hashed prompt cache key without exposing artifact content", () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compact-health-"));
    makeArtifact(artifactDir, "2026-05-05/a.json", "conversation-secret-key");

    const report = buildCompactHealthReport({
      artifactDir,
      rows: [
        {
          timestamp: "2026-05-05T18:00:00.000Z",
          path: "/v1/responses",
          status: 200,
          provider: "codex",
          model: "gpt-5.5",
          requested_model: "codex/gpt-5.5",
          tokens_in: 1000,
          tokens_out: 100,
          tokens_cache_read: 900,
          artifact_relpath: "2026-05-05/a.json",
        },
      ],
    });

    const expectedHash = crypto
      .createHash("sha256")
      .update("conversation-secret-key")
      .digest("hex")
      .slice(0, 10);
    assert.equal(report.sessions[0].promptCacheKeyHash, expectedHash);

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /conversation-secret-key/);
    assert.doesNotMatch(serialized, /secret prompt body/);
    assert.doesNotMatch(serialized, /secret response body/);
  });

  it("detects compact-like token drops and reports noncached input tokens", () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compact-health-"));
    makeArtifact(artifactDir, "2026-05-05/a.json", "session-a");
    makeArtifact(artifactDir, "2026-05-05/b.json", "session-a");

    const report = buildCompactHealthReport({
      artifactDir,
      minHighTokens: 100000,
      maxDropRatio: 0.5,
      rows: [
        {
          timestamp: "2026-05-05T18:00:00.000Z",
          path: "/v1/responses",
          status: 200,
          provider: "codex",
          model: "gpt-5.5",
          tokens_in: 210000,
          tokens_out: 300,
          tokens_cache_read: 200000,
          artifact_relpath: "2026-05-05/a.json",
        },
        {
          timestamp: "2026-05-05T18:01:00.000Z",
          path: "/v1/responses",
          status: 200,
          provider: "codex",
          model: "gpt-5.5",
          tokens_in: 30000,
          tokens_out: 600,
          tokens_cache_read: 20000,
          artifact_relpath: "2026-05-05/b.json",
        },
      ],
    });

    assert.equal(report.totals.rawInputTokens, 240000);
    assert.equal(report.totals.cacheReadTokens, 220000);
    assert.equal(report.totals.nonCachedInputTokens, 20000);
    assert.equal(report.sessions[0].compactLikeDropCount, 1);
    assert.deepEqual(report.sessions[0].drops[0], {
      timestamp: "2026-05-05T18:01:00.000Z",
      beforeRawInputTokens: 210000,
      afterRawInputTokens: 30000,
      rawInputDropPct: 85.7,
      beforeNonCachedInputTokens: 10000,
      afterNonCachedInputTokens: 10000,
    });
  });

  it("summarizes explicit compact hits and cached pricing coverage", () => {
    const report = buildCompactHealthReport({
      rows: [
        {
          timestamp: "2026-05-05T18:00:00.000Z",
          path: "/v1/responses/compact",
          status: 200,
          provider: "codex",
          model: "gpt-5.5",
          tokens_in: 1000,
          tokens_out: 100,
        },
        {
          timestamp: "2026-05-05T18:00:01.000Z",
          path: "/v1/responses",
          status: 200,
          provider: "codex",
          model: "gpt-5.5",
          tokens_in: 2000,
          tokens_cache_read: 1500,
        },
      ],
      pricingRows: [
        {
          namespace: "pricing_synced",
          key: "codex",
          value: JSON.stringify({ "gpt-5.5": { input: 1.25, output: 10 } }),
        },
      ],
    });

    assert.equal(report.routes.explicitCompactHits, 1);
    assert.equal(report.routes.responsesHits, 1);
    assert.deepEqual(report.pricing, [
      {
        provider: "codex",
        model: "gpt-5.5",
        source: "pricing_synced",
        input: 1.25,
        cached: null,
        status: "missing_cached_price",
      },
    ]);
  });
});
