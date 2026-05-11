import crypto from "node:crypto";

const HASH_LENGTH = 10;
const DEFAULT_MIN_HIGH_TOKENS = 100000;
const DEFAULT_MAX_DROP_RATIO = 0.5;
const DEFAULT_HIGH_UNCACHED_INPUT_TOKENS = 50000;
const DEFAULT_CRITICAL_UNCACHED_INPUT_TOKENS = 120000;
const DEFAULT_LOW_CACHE_READ_PCT = 85;
const DEFAULT_MIN_RAW_INPUT_TOKENS_FOR_LOW_CACHE_RATE = 100000;
const DEFAULT_REPEATED_PRESSURE_WINDOW_MINUTES = 15;
const DEFAULT_PENDING_INTERVENTION_TTL_MINUTES = 6 * 60;

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

export type ContextPressureReason = "high_uncached_input" | "low_cache_rate";

export type ContextPressureEvent = {
  id: string;
  promptCacheKeyHash: string;
  callLogId: string;
  tokensIn: number;
  tokensCacheRead: number;
  nonCachedInputTokens: number;
  cacheReadPct: number;
  reason: ContextPressureReason;
};

export type ContextPressureInterventionReason =
  | "critical_high_uncached_input"
  | "repeated_high_uncached_input";

export type ContextPressureIntervention = {
  promptCacheKeyHash: string;
  reason: ContextPressureInterventionReason;
  eventCount: number;
  lastTokensIn: number;
  lastNonCachedInputTokens: number;
  lastCacheReadPct: number;
  pendingSince: string;
};

type SessionRow = {
  prompt_cache_key_hash: string;
  high_water_call_log_id: string;
  high_water_tokens_in: number;
  high_water_noncached_input_tokens: number;
};

type PressureSessionRow = {
  prompt_cache_key_hash: string;
  pressure_event_count: number;
  recent_high_uncached_event_count: number;
  recent_high_uncached_window_start: string | null;
  last_tokens_in: number;
  last_noncached_input_tokens: number;
  last_cache_read_pct: number;
  pending_intervention: number;
  pending_reason: string | null;
  pending_since: string | null;
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

function roundPct(value: number): number {
  return Math.round(value * 10) / 10;
}

function cacheReadPct(tokensIn: number, cacheRead: number | null): number {
  if (tokensIn <= 0) return 0;
  return roundPct((Math.max(0, cacheRead || 0) / tokensIn) * 100);
}

function roundDropPct(previous: number, current: number): number {
  if (previous <= 0) return 0;
  return Math.round((1 - current / previous) * 1000) / 10;
}

function nonCachedInput(tokensIn: number, cacheRead: number | null): number {
  return Math.max(0, tokensIn - Math.max(0, cacheRead || 0));
}

function minutesBetween(startIso: string | null | undefined, endIso: string): number {
  if (!startIso) return Number.POSITIVE_INFINITY;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (end - start) / 60000);
}

function isStalePendingPressureIntervention(row: PressureSessionRow, timestamp: string): boolean {
  return (
    row.pending_intervention === 1 &&
    minutesBetween(row.pending_since, timestamp) > DEFAULT_PENDING_INTERVENTION_TTL_MINUTES
  );
}

function clearStalePendingPressureIntervention(db: SqliteDatabase, promptCacheKeyHash: string) {
  db.prepare(
    `UPDATE context_pressure_sessions
     SET pending_intervention = 0,
         pending_reason = NULL,
         pending_since = NULL,
         recent_high_uncached_event_count = 0,
         recent_high_uncached_window_start = NULL
     WHERE prompt_cache_key_hash = ?
       AND pending_intervention = 1`
  ).run(promptCacheKeyHash);
}

function shouldMarkPressurePending(
  reason: ContextPressureReason,
  tokensNonCached: number,
  previous: PressureSessionRow | undefined,
  recentHighUncachedEventCount: number
): ContextPressureInterventionReason | null {
  if (reason !== "high_uncached_input") return null;
  if (tokensNonCached >= DEFAULT_CRITICAL_UNCACHED_INPUT_TOKENS) {
    return "critical_high_uncached_input";
  }

  const alreadyPending = previous?.pending_intervention === 1;
  if (alreadyPending) return null;

  if (recentHighUncachedEventCount >= 2) {
    return "repeated_high_uncached_input";
  }

  return null;
}

function upsertPressureSession(
  db: SqliteDatabase,
  input: RecordInput,
  event: ContextPressureEvent,
  pendingReason: ContextPressureInterventionReason | null
) {
  let previous = db
    .prepare(
      `SELECT prompt_cache_key_hash, pressure_event_count, last_tokens_in,
              last_noncached_input_tokens, last_cache_read_pct, pending_intervention,
              pending_reason, pending_since, recent_high_uncached_event_count,
              recent_high_uncached_window_start
       FROM context_pressure_sessions
       WHERE prompt_cache_key_hash = ?`
    )
    .get(event.promptCacheKeyHash) as PressureSessionRow | undefined;

  if (previous && isStalePendingPressureIntervention(previous, input.timestamp)) {
    clearStalePendingPressureIntervention(db, event.promptCacheKeyHash);
    previous = {
      ...previous,
      recent_high_uncached_event_count: 0,
      recent_high_uncached_window_start: null,
      pending_intervention: 0,
      pending_reason: null,
      pending_since: null,
    };
  }

  const isHighUncached = event.reason === "high_uncached_input";
  const resetRecentWindow =
    !previous ||
    !isHighUncached ||
    minutesBetween(previous.recent_high_uncached_window_start, input.timestamp) >
      DEFAULT_REPEATED_PRESSURE_WINDOW_MINUTES;
  const recentHighUncachedWindowStart = isHighUncached
    ? resetRecentWindow
      ? input.timestamp
      : previous?.recent_high_uncached_window_start || input.timestamp
    : previous?.recent_high_uncached_window_start || null;
  const recentHighUncachedEventCount = isHighUncached
    ? resetRecentWindow
      ? 1
      : (previous?.recent_high_uncached_event_count || 0) + 1
    : previous?.recent_high_uncached_event_count || 0;

  const resolvedPendingReason =
    pendingReason ||
    shouldMarkPressurePending(
      event.reason,
      event.nonCachedInputTokens,
      previous,
      recentHighUncachedEventCount
    );
  const pendingIntervention =
    previous?.pending_intervention === 1 || !!resolvedPendingReason ? 1 : 0;
  const pendingSince =
    previous?.pending_intervention === 1
      ? previous.pending_since
      : resolvedPendingReason
        ? input.timestamp
        : null;
  const pendingReasonValue =
    previous?.pending_intervention === 1 ? previous.pending_reason : resolvedPendingReason;

  db.prepare(
    `INSERT INTO context_pressure_sessions (
       prompt_cache_key_hash, provider, model, first_seen, last_seen,
       pressure_event_count, high_uncached_event_count,
       recent_high_uncached_event_count, recent_high_uncached_window_start,
       last_call_log_id, last_reason, last_tokens_in, last_tokens_cache_read,
       last_noncached_input_tokens, last_cache_read_pct,
       pending_intervention, pending_reason, pending_since
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(prompt_cache_key_hash) DO UPDATE SET
       provider = excluded.provider,
       model = excluded.model,
       last_seen = excluded.last_seen,
       pressure_event_count = context_pressure_sessions.pressure_event_count + 1,
       high_uncached_event_count = context_pressure_sessions.high_uncached_event_count + ?,
       recent_high_uncached_event_count = excluded.recent_high_uncached_event_count,
       recent_high_uncached_window_start = excluded.recent_high_uncached_window_start,
       last_call_log_id = excluded.last_call_log_id,
       last_reason = excluded.last_reason,
       last_tokens_in = excluded.last_tokens_in,
       last_tokens_cache_read = excluded.last_tokens_cache_read,
       last_noncached_input_tokens = excluded.last_noncached_input_tokens,
       last_cache_read_pct = excluded.last_cache_read_pct,
       pending_intervention = excluded.pending_intervention,
       pending_reason = excluded.pending_reason,
       pending_since = excluded.pending_since`
  ).run(
    event.promptCacheKeyHash,
    input.provider,
    input.model,
    input.timestamp,
    input.timestamp,
    1,
    isHighUncached ? 1 : 0,
    recentHighUncachedEventCount,
    recentHighUncachedWindowStart,
    input.callLogId,
    event.reason,
    event.tokensIn,
    event.tokensCacheRead,
    event.nonCachedInputTokens,
    event.cacheReadPct,
    pendingIntervention,
    pendingReasonValue,
    pendingSince,
    isHighUncached ? 1 : 0
  );
}

function pressureInterventionFromRow(row: PressureSessionRow): ContextPressureIntervention | null {
  if (row.pending_intervention !== 1) return null;
  const reason = row.pending_reason;
  if (reason !== "critical_high_uncached_input" && reason !== "repeated_high_uncached_input") {
    return null;
  }
  if (!row.pending_since) return null;

  return {
    promptCacheKeyHash: row.prompt_cache_key_hash,
    reason,
    eventCount: row.pressure_event_count,
    lastTokensIn: row.last_tokens_in,
    lastNonCachedInputTokens: row.last_noncached_input_tokens,
    lastCacheReadPct: row.last_cache_read_pct,
    pendingSince: row.pending_since,
  };
}

export function getPendingContextPressureIntervention(
  db: SqliteDatabase,
  requestBody: unknown,
  timestamp = new Date().toISOString()
): ContextPressureIntervention | null {
  ensureContextCompactionTables(db);
  const promptCacheKeyHash = extractPromptCacheKeyHash(requestBody);
  if (!promptCacheKeyHash) return null;

  const row = db
    .prepare(
      `SELECT prompt_cache_key_hash, pressure_event_count, recent_high_uncached_event_count,
              recent_high_uncached_window_start, last_tokens_in,
              last_noncached_input_tokens, last_cache_read_pct, pending_intervention,
              pending_reason, pending_since
       FROM context_pressure_sessions
       WHERE prompt_cache_key_hash = ?`
    )
    .get(promptCacheKeyHash) as PressureSessionRow | undefined;

  if (!row) return null;
  if (isStalePendingPressureIntervention(row, timestamp)) {
    clearStalePendingPressureIntervention(db, promptCacheKeyHash);
    return null;
  }

  return pressureInterventionFromRow(row);
}

export function consumeContextPressureIntervention(
  db: SqliteDatabase,
  requestBody: unknown,
  timestamp = new Date().toISOString()
): ContextPressureIntervention | null {
  ensureContextCompactionTables(db);
  const promptCacheKeyHash = extractPromptCacheKeyHash(requestBody);
  if (!promptCacheKeyHash) return null;

  const row = db
    .prepare(
      `SELECT prompt_cache_key_hash, pressure_event_count, recent_high_uncached_event_count,
              recent_high_uncached_window_start, last_tokens_in,
              last_noncached_input_tokens, last_cache_read_pct, pending_intervention,
              pending_reason, pending_since
       FROM context_pressure_sessions
       WHERE prompt_cache_key_hash = ?`
    )
    .get(promptCacheKeyHash) as PressureSessionRow | undefined;
  if (!row) return null;
  if (isStalePendingPressureIntervention(row, timestamp)) {
    clearStalePendingPressureIntervention(db, promptCacheKeyHash);
    return null;
  }

  const intervention = pressureInterventionFromRow(row);
  if (!intervention) return null;

  db.prepare(
    `UPDATE context_pressure_sessions
     SET pending_intervention = 0,
         pending_reason = NULL,
         pending_since = NULL,
         intervention_count = intervention_count + 1,
         last_intervention_at = ?
     WHERE prompt_cache_key_hash = ?`
  ).run(timestamp, promptCacheKeyHash);

  return intervention;
}

function clearPendingPressureIntervention(
  db: SqliteDatabase,
  promptCacheKeyHash: string,
  timestamp: string
) {
  db.prepare(
    `UPDATE context_pressure_sessions
     SET pending_intervention = 0,
         pending_reason = NULL,
         pending_since = NULL,
         recent_high_uncached_event_count = 0,
         recent_high_uncached_window_start = NULL,
         last_compaction_at = ?
     WHERE prompt_cache_key_hash = ?`
  ).run(timestamp, promptCacheKeyHash);
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

    CREATE TABLE IF NOT EXISTS context_pressure_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      prompt_cache_key_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      call_log_id TEXT NOT NULL,
      tokens_in INTEGER NOT NULL,
      tokens_cache_read INTEGER NOT NULL,
      noncached_input_tokens INTEGER NOT NULL,
      cache_read_pct REAL NOT NULL,
      reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_pressure_sessions (
      prompt_cache_key_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      pressure_event_count INTEGER NOT NULL,
      high_uncached_event_count INTEGER NOT NULL,
      recent_high_uncached_event_count INTEGER NOT NULL,
      recent_high_uncached_window_start TEXT,
      last_call_log_id TEXT NOT NULL,
      last_reason TEXT NOT NULL,
      last_tokens_in INTEGER NOT NULL,
      last_tokens_cache_read INTEGER NOT NULL,
      last_noncached_input_tokens INTEGER NOT NULL,
      last_cache_read_pct REAL NOT NULL,
      pending_intervention INTEGER NOT NULL DEFAULT 0,
      pending_reason TEXT,
      pending_since TEXT,
      intervention_count INTEGER NOT NULL DEFAULT 0,
      last_intervention_at TEXT,
      last_compaction_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_context_pressure_events_timestamp
      ON context_pressure_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_context_pressure_events_session
      ON context_pressure_events(prompt_cache_key_hash, timestamp);
    CREATE INDEX IF NOT EXISTS idx_context_pressure_events_reason
      ON context_pressure_events(reason, timestamp);
    CREATE INDEX IF NOT EXISTS idx_context_pressure_sessions_pending
      ON context_pressure_sessions(pending_intervention, pending_since);

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

function getPressureReason(
  input: RecordInput,
  tokensNonCached: number,
  currentCacheReadPct: number
): ContextPressureReason | null {
  if (tokensNonCached >= DEFAULT_HIGH_UNCACHED_INPUT_TOKENS) {
    return "high_uncached_input";
  }

  if (
    input.tokensIn >= DEFAULT_MIN_RAW_INPUT_TOKENS_FOR_LOW_CACHE_RATE &&
    currentCacheReadPct < DEFAULT_LOW_CACHE_READ_PCT
  ) {
    return "low_cache_rate";
  }

  return null;
}

export function recordContextPressureCandidate(
  db: SqliteDatabase,
  input: RecordInput
): ContextPressureEvent | null {
  ensureContextCompactionTables(db);

  if (!isSuccessfulResponsesRow(input)) return null;
  const promptCacheKeyHash = extractPromptCacheKeyHash(input.requestBody);
  if (!promptCacheKeyHash) return null;

  const tokensCacheRead = Math.max(0, input.tokensCacheRead || 0);
  const tokensNonCached = nonCachedInput(input.tokensIn, input.tokensCacheRead);
  const currentCacheReadPct = cacheReadPct(input.tokensIn, input.tokensCacheRead);
  const reason = getPressureReason(input, tokensNonCached, currentCacheReadPct);
  if (!reason) return null;

  const event: ContextPressureEvent = {
    id: crypto.randomUUID(),
    promptCacheKeyHash,
    callLogId: input.callLogId,
    tokensIn: input.tokensIn,
    tokensCacheRead,
    nonCachedInputTokens: tokensNonCached,
    cacheReadPct: currentCacheReadPct,
    reason,
  };

  db.prepare(
    `INSERT INTO context_pressure_events (
       id, timestamp, prompt_cache_key_hash, provider, model,
       call_log_id, tokens_in, tokens_cache_read, noncached_input_tokens, cache_read_pct, reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    input.timestamp,
    event.promptCacheKeyHash,
    input.provider,
    input.model,
    event.callLogId,
    event.tokensIn,
    event.tokensCacheRead,
    event.nonCachedInputTokens,
    event.cacheReadPct,
    event.reason
  );

  upsertPressureSession(db, input, event, null);

  return event;
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
  clearPendingPressureIntervention(db, promptCacheKeyHash, input.timestamp);
  return event;
}
