#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_HOURS = 3;
const DEFAULT_MIN_HIGH_TOKENS = 100000;
const DEFAULT_MAX_DROP_RATIO = 0.5;
const HASH_LENGTH = 10;

function toFiniteNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function toNullableFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = toFiniteNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeJsonParse(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hashPromptCacheKey(value) {
  if (typeof value !== "string" || value.length === 0) return "no-key";
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);
}

function normalizeModelName(model) {
  if (typeof model !== "string" || model.length === 0) return "unknown";
  if (!model.includes("/")) return model;
  const parts = model.split("/").filter(Boolean);
  return parts.at(-1) || model;
}

function resolveArtifactPath(artifactDir, relPath) {
  if (!artifactDir || typeof relPath !== "string" || relPath.length === 0) return null;
  const base = path.resolve(artifactDir);
  const candidate = path.resolve(base, relPath);
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) return null;
  return candidate;
}

function readPromptCacheKeyHash(artifactDir, relPath) {
  const artifactPath = resolveArtifactPath(artifactDir, relPath);
  if (!artifactPath) return "no-key";

  try {
    const artifact = safeJsonParse(fs.readFileSync(artifactPath, "utf8"));
    return hashPromptCacheKey(artifact?.requestBody?.prompt_cache_key);
  } catch {
    return "artifact-unavailable";
  }
}

function normalizeRow(row, artifactDir) {
  const rawInputTokens = toFiniteNumber(row.tokens_in);
  const cacheReadTokens = toFiniteNumber(row.tokens_cache_read);
  const cacheCreationTokens = toFiniteNumber(row.tokens_cache_creation);
  const nonCachedInputTokens = Math.max(0, rawInputTokens - cacheReadTokens);

  return {
    timestamp: String(row.timestamp || ""),
    path: String(row.path || ""),
    status: toFiniteNumber(row.status),
    provider: String(row.provider || "unknown"),
    model: normalizeModelName(String(row.model || row.requested_model || "unknown")),
    requestedModel: row.requested_model ? String(row.requested_model) : null,
    rawInputTokens,
    outputTokens: toFiniteNumber(row.tokens_out),
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens: toFiniteNumber(row.tokens_reasoning),
    nonCachedInputTokens,
    promptCacheKeyHash: readPromptCacheKeyHash(artifactDir, row.artifact_relpath),
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function compactDropBetween(prev, row) {
  if (!prev || prev.rawInputTokens <= 0) return null;
  const ratio = row.rawInputTokens / prev.rawInputTokens;
  return {
    timestamp: row.timestamp,
    beforeRawInputTokens: prev.rawInputTokens,
    afterRawInputTokens: row.rawInputTokens,
    rawInputDropPct: round1((1 - ratio) * 100),
    beforeNonCachedInputTokens: prev.nonCachedInputTokens,
    afterNonCachedInputTokens: row.nonCachedInputTokens,
  };
}

function buildSessionSummary(promptCacheKeyHash, rows, options) {
  const sortedRows = [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const drops = [];
  let previousHigh = null;

  for (const row of sortedRows) {
    if (previousHigh && row.rawInputTokens / previousHigh.rawInputTokens <= options.maxDropRatio) {
      drops.push(compactDropBetween(previousHigh, row));
      previousHigh = null;
    }

    if (
      row.rawInputTokens >= options.minHighTokens &&
      (!previousHigh || row.rawInputTokens > previousHigh.rawInputTokens)
    ) {
      previousHigh = row;
    }
  }

  const rawInputTokens = sortedRows.reduce((sum, row) => sum + row.rawInputTokens, 0);
  const cacheReadTokens = sortedRows.reduce((sum, row) => sum + row.cacheReadTokens, 0);
  const nonCachedInputTokens = sortedRows.reduce((sum, row) => sum + row.nonCachedInputTokens, 0);
  const outputTokens = sortedRows.reduce((sum, row) => sum + row.outputTokens, 0);
  const maxRawInputTokens = Math.max(...sortedRows.map((row) => row.rawInputTokens));
  const minRawInputTokens = Math.min(...sortedRows.map((row) => row.rawInputTokens));
  const last = sortedRows.at(-1);

  return {
    promptCacheKeyHash,
    requestCount: sortedRows.length,
    firstSeen: sortedRows[0]?.timestamp || null,
    lastSeen: last?.timestamp || null,
    rawInputTokens,
    cacheReadTokens,
    nonCachedInputTokens,
    outputTokens,
    cacheReadPct: rawInputTokens > 0 ? round1((cacheReadTokens / rawInputTokens) * 100) : 0,
    minRawInputTokens,
    maxRawInputTokens,
    lastRawInputTokens: last?.rawInputTokens || 0,
    lastNonCachedInputTokens: last?.nonCachedInputTokens || 0,
    compactLikeDropCount: drops.length,
    drops: drops.filter(Boolean),
  };
}

function parsePricingRows(pricingRows) {
  const layers = new Map();
  for (const row of pricingRows || []) {
    const namespace = String(row.namespace || "");
    const provider = String(row.key || "");
    const parsed = safeJsonParse(row.value);
    if (!namespace || !provider || !parsed || typeof parsed !== "object") continue;

    for (const [model, pricing] of Object.entries(parsed)) {
      if (!pricing || typeof pricing !== "object") continue;
      layers.set(`${provider}\u0000${normalizeModelName(model)}`, {
        provider,
        model: normalizeModelName(model),
        source: namespace,
        input: toNullableFiniteNumber(pricing.input),
        cached: toNullableFiniteNumber(pricing.cached),
      });
    }
  }
  return layers;
}

function buildPricingReport(rows, pricingRows) {
  const pricing = parsePricingRows(pricingRows);
  const seenPairs = new Set();
  for (const row of rows) {
    if (row.provider === "unknown" || row.model === "unknown") continue;
    seenPairs.add(`${row.provider}\u0000${row.model}`);
  }

  return [...seenPairs].sort().map((pair) => {
    const [provider, model] = pair.split("\u0000");
    const match = pricing.get(pair);
    if (!match) {
      return {
        provider,
        model,
        source: null,
        input: null,
        cached: null,
        status: "missing_pricing",
      };
    }
    return {
      provider,
      model,
      source: match.source,
      input: match.input,
      cached: match.cached,
      status: match.cached === null ? "missing_cached_price" : "cached_price_configured",
    };
  });
}

export function buildCompactHealthReport({
  rows,
  pricingRows = [],
  artifactDir = null,
  minHighTokens = DEFAULT_MIN_HIGH_TOKENS,
  maxDropRatio = DEFAULT_MAX_DROP_RATIO,
  topSessions = 20,
} = {}) {
  const normalizedRows = (rows || []).map((row) => normalizeRow(row, artifactDir));
  const successfulRows = normalizedRows.filter((row) => row.status >= 200 && row.status < 300);
  const responseRows = successfulRows.filter((row) => row.path === "/v1/responses");
  const explicitCompactRows = successfulRows.filter((row) =>
    row.path.includes("/responses/compact")
  );
  const totalRawInput = successfulRows.reduce((sum, row) => sum + row.rawInputTokens, 0);
  const totalCacheRead = successfulRows.reduce((sum, row) => sum + row.cacheReadTokens, 0);
  const totalCacheCreation = successfulRows.reduce((sum, row) => sum + row.cacheCreationTokens, 0);
  const totalNonCached = successfulRows.reduce((sum, row) => sum + row.nonCachedInputTokens, 0);
  const totalOutput = successfulRows.reduce((sum, row) => sum + row.outputTokens, 0);

  const sessionsByKey = new Map();
  for (const row of responseRows) {
    if (!sessionsByKey.has(row.promptCacheKeyHash)) sessionsByKey.set(row.promptCacheKeyHash, []);
    sessionsByKey.get(row.promptCacheKeyHash).push(row);
  }

  const sessions = [...sessionsByKey.entries()]
    .filter(([, groupRows]) => groupRows.length > 0)
    .map(([key, groupRows]) => buildSessionSummary(key, groupRows, { minHighTokens, maxDropRatio }))
    .sort(
      (a, b) => b.compactLikeDropCount - a.compactLikeDropCount || b.requestCount - a.requestCount
    )
    .slice(0, topSessions);

  return {
    generatedAt: new Date().toISOString(),
    thresholds: {
      minHighTokens,
      maxDropRatio,
    },
    routes: {
      explicitCompactHits: explicitCompactRows.length,
      responsesHits: responseRows.length,
      totalSuccessfulRows: successfulRows.length,
    },
    totals: {
      rawInputTokens: totalRawInput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      nonCachedInputTokens: totalNonCached,
      outputTokens: totalOutput,
      cacheReadPct: totalRawInput > 0 ? round1((totalCacheRead / totalRawInput) * 100) : 0,
    },
    sessions,
    pricing: buildPricingReport(successfulRows, pricingRows),
  };
}

function defaultDataDir() {
  return process.env.DATA_DIR || path.join(os.homedir(), ".omniroute");
}

function parseArgs(argv) {
  const args = {
    dataDir: defaultDataDir(),
    db: null,
    hours: DEFAULT_HOURS,
    since: null,
    json: false,
    topSessions: 20,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--data-dir") {
      args.dataDir = argv[++i];
    } else if (arg === "--db") {
      args.db = argv[++i];
    } else if (arg === "--hours") {
      args.hours = toFiniteNumber(argv[++i], DEFAULT_HOURS);
    } else if (arg === "--since") {
      args.since = argv[++i];
    } else if (arg === "--top-sessions") {
      args.topSessions = toFiniteNumber(argv[++i], 20);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.db ||= path.join(args.dataDir, "storage.sqlite");
  return args;
}

function usage() {
  return `Usage: node scripts/compact-health-report.mjs [options]\n\nOptions:\n  --db <path>           SQLite database path (default: <data-dir>/storage.sqlite)\n  --data-dir <path>     OmniRoute data directory (default: DATA_DIR or ~/.omniroute)\n  --hours <n>           Lookback window in hours (default: ${DEFAULT_HOURS})\n  --since <iso>         Explicit lower timestamp bound\n  --top-sessions <n>    Number of sessions to show (default: 20)\n  --json                Print full JSON report\n`;
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSqliteJson(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || "sqlite3 query failed").trim());
  }

  const text = result.stdout.trim();
  if (!text) return [];
  const parsed = safeJsonParse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("sqlite3 did not return a JSON array");
  }
  return parsed;
}

function readRowsFromDb(dbPath, sinceIso) {
  const since = quoteSqlString(sinceIso);
  const rows = runSqliteJson(
    dbPath,
    `SELECT timestamp, path, status, provider, model, requested_model, tokens_in, tokens_out,
            tokens_cache_read, tokens_cache_creation, tokens_reasoning, artifact_relpath
     FROM call_logs
     WHERE timestamp >= ${since}
       AND path LIKE '%/v1/responses%'
     ORDER BY timestamp ASC`
  );

  const pricingRows = runSqliteJson(
    dbPath,
    `SELECT namespace, key, value
     FROM key_value
     WHERE namespace IN ('pricing', 'pricing_synced', 'models_dev_pricing')`
  );

  return { rows, pricingRows };
}

function printTextReport(report) {
  console.log("OmniRoute Compact Health Report");
  console.log(`Generated: ${report.generatedAt}`);
  console.log("");
  console.log("Routes");
  console.log(`  /v1/responses: ${report.routes.responsesHits}`);
  console.log(`  /v1/responses/compact: ${report.routes.explicitCompactHits}`);
  console.log("");
  console.log("Tokens");
  console.log(`  Raw input: ${report.totals.rawInputTokens}`);
  console.log(`  Cache read: ${report.totals.cacheReadTokens} (${report.totals.cacheReadPct}%)`);
  console.log(`  Noncached input: ${report.totals.nonCachedInputTokens}`);
  console.log(`  Output: ${report.totals.outputTokens}`);
  console.log("");
  console.log("Pricing");
  for (const item of report.pricing) {
    console.log(
      `  ${item.provider}/${item.model}: ${item.status}` +
        (item.source ? ` source=${item.source} input=${item.input} cached=${item.cached}` : "")
    );
  }
  if (report.pricing.length === 0) console.log("  No provider/model pricing rows in window.");
  console.log("");
  console.log("Top Sessions");
  for (const session of report.sessions) {
    console.log(
      `  ${session.promptCacheKeyHash}: requests=${session.requestCount} drops=${session.compactLikeDropCount} ` +
        `raw_min=${session.minRawInputTokens} raw_max=${session.maxRawInputTokens} ` +
        `last_raw=${session.lastRawInputTokens} last_noncached=${session.lastNonCachedInputTokens} ` +
        `cache_read=${session.cacheReadPct}%`
    );
    for (const drop of session.drops) {
      console.log(
        `    drop ${drop.timestamp}: ${drop.beforeRawInputTokens} -> ${drop.afterRawInputTokens} ` +
          `(${drop.rawInputDropPct}%), noncached ${drop.beforeNonCachedInputTokens} -> ${drop.afterNonCachedInputTokens}`
      );
    }
  }
  if (report.sessions.length === 0) console.log("  No /v1/responses sessions found.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const sinceIso = args.since || new Date(Date.now() - args.hours * 60 * 60 * 1000).toISOString();
  const artifactDir = path.join(args.dataDir, "call_logs");
  const { rows, pricingRows } = readRowsFromDb(args.db, sinceIso);
  const report = buildCompactHealthReport({
    rows,
    pricingRows,
    artifactDir,
    topSessions: args.topSessions,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report);
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  main().catch((error) => {
    console.error(
      `compact-health-report failed: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 1;
  });
}
