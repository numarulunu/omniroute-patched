import crypto from "node:crypto";

const HASH_LENGTH = 10;
const DEFAULT_MIN_HIGH_TOKENS = 100000;
const DEFAULT_MAX_DROP_RATIO = 0.5;

type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
};

type RecordInput = {
  callLogId: string;
  timestamp: string;
  path: string;
  status: number;
  provider: string;
  model: string;
  tokensIn: number;
  tokensCacheRead: number | null;
  requestBody: unknown;
};

export type ContextCompactionEvent = {
  id: string;
  promptCacheKeyHash: string;
  previousCallLogId: string;
  currentCallLogId: string;
  previousTokensIn: number;
  currentTokensIn: number;
  previousNonCachedInputTokens: number;
  currentNonCachedInputTokens: number;
  dropPct: number;
};

type SessionRow = {
  prompt_cache_key_hash: string;
  high_water_call_log_id: string;
  high_water_tokens_in: number;
  high_water_noncached_input_tokens: number;
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hashPromptCacheKey(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);
}

function extractPromptCacheKeyHash(requestBody: unknown): string | null {
  const body = toRecord(requestBody);
  return hashPromptCacheKey(body.prompt_cache_key);
}

function isSuccessfulResponsesRow(input: RecordInput): boolean {
  return input.path === "/v1/responses" && input.status >= 200 && input.status < 300;
}

function roundDropPct(previous: number, current: number): number {
  if (previous <= 0) return 0;
  return Math.round((1 - current / previous) * 1000) / 10;
}

function nonCachedInput(tokensIn: number, cacheRead: number | null): number {
  return Math.max(0, tokensIn - Math.max(0, cacheRead || 0));
}

export function ensureContextCompactionTables(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_compaction_sessions (
      prompt_cache_key_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      high_water_call_log_id TEXT NOT NULL,
      high_water_tokens_in INTEGER NOT NULL,
      high_water_noncached_input_tokens INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_compaction_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      prompt_cache_key_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      previous_call_log_id TEXT NOT NULL,
      current_call_log_id TEXT NOT NULL,
      previous_tokens_in INTEGER NOT NULL,
      current_tokens_in INTEGER NOT NULL,
      previous_noncached_input_tokens INTEGER NOT NULL,
      current_noncached_input_tokens INTEGER NOT NULL,
      drop_pct REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_context_compaction_events_timestamp
      ON context_compaction_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_context_compaction_events_session
      ON context_compaction_events(prompt_cache_key_hash, timestamp);
  `);
}

function upsertSession(
  db: SqliteDatabase,
  input: RecordInput,
  promptCacheKeyHash: string,
  tokensNonCached: number
) {
  db.prepare(
    `INSERT INTO context_compaction_sessions (
       prompt_cache_key_hash, provider, model, first_seen, last_seen,
       high_water_call_log_id, high_water_tokens_in, high_water_noncached_input_tokens
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(prompt_cache_key_hash) DO UPDATE SET
       provider = excluded.provider,
       model = excluded.model,
       last_seen = excluded.last_seen,
       high_water_call_log_id = excluded.high_water_call_log_id,
       high_water_tokens_in = excluded.high_water_tokens_in,
       high_water_noncached_input_tokens = excluded.high_water_noncached_input_tokens`
  ).run(
    promptCacheKeyHash,
    input.provider,
    input.model,
    input.timestamp,
    input.timestamp,
    input.callLogId,
    input.tokensIn,
    tokensNonCached
  );
}

export function recordContextCompactionCandidate(
  db: SqliteDatabase,
  input: RecordInput
): ContextCompactionEvent | null {
  ensureContextCompactionTables(db);

  if (!isSuccessfulResponsesRow(input)) return null;
  const promptCacheKeyHash = extractPromptCacheKeyHash(input.requestBody);
  if (!promptCacheKeyHash) return null;

  const currentNonCached = nonCachedInput(input.tokensIn, input.tokensCacheRead);
  const previous = db
    .prepare(
      `SELECT prompt_cache_key_hash, high_water_call_log_id, high_water_tokens_in,
              high_water_noncached_input_tokens
       FROM context_compaction_sessions
       WHERE prompt_cache_key_hash = ?`
    )
    .get(promptCacheKeyHash) as SessionRow | undefined;

  if (!previous) {
    upsertSession(db, input, promptCacheKeyHash, currentNonCached);
    return null;
  }

  const isDropFromHighWater =
    previous.high_water_tokens_in >= DEFAULT_MIN_HIGH_TOKENS &&
    input.tokensIn / previous.high_water_tokens_in <= DEFAULT_MAX_DROP_RATIO;

  if (!isDropFromHighWater) {
    if (input.tokensIn > previous.high_water_tokens_in) {
      upsertSession(db, input, promptCacheKeyHash, currentNonCached);
    } else {
      db.prepare(
        `UPDATE context_compaction_sessions
         SET last_seen = ?, provider = ?, model = ?
         WHERE prompt_cache_key_hash = ?`
      ).run(input.timestamp, input.provider, input.model, promptCacheKeyHash);
    }
    return null;
  }

  const event: ContextCompactionEvent = {
    id: crypto.randomUUID(),
    promptCacheKeyHash,
    previousCallLogId: previous.high_water_call_log_id,
    currentCallLogId: input.callLogId,
    previousTokensIn: previous.high_water_tokens_in,
    currentTokensIn: input.tokensIn,
    previousNonCachedInputTokens: previous.high_water_noncached_input_tokens,
    currentNonCachedInputTokens: currentNonCached,
    dropPct: roundDropPct(previous.high_water_tokens_in, input.tokensIn),
  };

  db.prepare(
    `INSERT INTO context_compaction_events (
       id, timestamp, prompt_cache_key_hash, provider, model,
       previous_call_log_id, current_call_log_id,
       previous_tokens_in, current_tokens_in,
       previous_noncached_input_tokens, current_noncached_input_tokens, drop_pct
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    input.timestamp,
    event.promptCacheKeyHash,
    input.provider,
    input.model,
    event.previousCallLogId,
    event.currentCallLogId,
    event.previousTokensIn,
    event.currentTokensIn,
    event.previousNonCachedInputTokens,
    event.currentNonCachedInputTokens,
    event.dropPct
  );

  upsertSession(db, input, promptCacheKeyHash, currentNonCached);
  return event;
}
