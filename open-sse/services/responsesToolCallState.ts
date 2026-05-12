import { sanitizeResponsesInputItems } from "./responsesInputSanitizer.ts";

type JsonRecord = Record<string, unknown>;

type RememberedFunctionCall = {
  call_id: string;
  name: string;
  arguments: string;
};

type RememberedResponseToolState = {
  functionCalls: RememberedFunctionCall[];
  conversationItems: unknown[];
  expiresAt: number;
  updatedAt: number;
};

type RememberedFunctionCallByIdState = RememberedFunctionCall & {
  expiresAt: number;
  updatedAt: number;
};

const RESPONSE_TOOL_CALL_TTL_MS = 30 * 60 * 1000;
const RESPONSE_TOOL_CALL_CACHE_MAX_ENTRIES = 128;
const RESPONSE_CONVERSATION_RECENT_ITEM_COUNT = 10;
const RESPONSE_CONVERSATION_PRESERVED_ITEM_COUNT = 8;
const RESPONSE_CONVERSATION_ENTRY_MAX_CHARS = 64_000;
const RESPONSE_CONVERSATION_TOTAL_MAX_CHARS = 1_000_000;
const RESPONSE_CONVERSATION_STRING_MAX_CHARS = 4_000;

const rememberedResponseToolCalls = new Map<string, RememberedResponseToolState>();
const rememberedFunctionCallsById = new Map<string, RememberedFunctionCallByIdState>();

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function truncateRememberedString(value: string): string {
  if (value.length <= RESPONSE_CONVERSATION_STRING_MAX_CHARS) return value;
  return value.slice(0, RESPONSE_CONVERSATION_STRING_MAX_CHARS - 14).trimEnd() + " [truncated]";
}

function truncateRememberedValue(value: unknown): unknown {
  if (typeof value === "string") return truncateRememberedString(value);
  if (Array.isArray(value)) return value.map(truncateRememberedValue);
  const record = toRecord(value);
  if (!record) return value;

  return Object.fromEntries(
    Object.entries(record).map(([key, childValue]) => [key, truncateRememberedValue(childValue)])
  );
}

function getConversationItemRole(item: unknown): string {
  const record = toRecord(item);
  const role = typeof record?.role === "string" ? record.role : "";
  const type = typeof record?.type === "string" ? record.type : "";
  return (role || type).trim().toLowerCase();
}

function isPreservedConversationItem(item: unknown): boolean {
  const role = getConversationItemRole(item);
  return role === "system" || role === "developer";
}

function compactRememberedConversationItems(items: readonly unknown[]): unknown[] {
  const sanitized = sanitizeResponsesInputItems(items);
  const preserved: unknown[] = [];
  const replayable: unknown[] = [];

  for (const item of sanitized) {
    const compactItem = truncateRememberedValue(item);
    if (
      isPreservedConversationItem(compactItem) &&
      preserved.length < RESPONSE_CONVERSATION_PRESERVED_ITEM_COUNT
    ) {
      preserved.push(compactItem);
      continue;
    }
    replayable.push(compactItem);
  }

  const compacted = [...preserved, ...replayable.slice(-RESPONSE_CONVERSATION_RECENT_ITEM_COUNT)];

  while (
    safeJsonLength(compacted) > RESPONSE_CONVERSATION_ENTRY_MAX_CHARS &&
    compacted.length > 0
  ) {
    const dropIndex = compacted.findIndex((item) => !isPreservedConversationItem(item));
    if (dropIndex < 0) break;
    compacted.splice(dropIndex, 1);
  }

  return compacted;
}

function getConversationItemsChars(entry: RememberedResponseToolState): number {
  return safeJsonLength(entry.conversationItems);
}

function enforceRememberedResponseToolCallLimits() {
  let totalConversationChars = 0;
  for (const entry of rememberedResponseToolCalls.values()) {
    totalConversationChars += getConversationItemsChars(entry);
  }

  if (
    rememberedResponseToolCalls.size <= RESPONSE_TOOL_CALL_CACHE_MAX_ENTRIES &&
    totalConversationChars <= RESPONSE_CONVERSATION_TOTAL_MAX_CHARS
  ) {
    return;
  }

  const oldestEntries = [...rememberedResponseToolCalls.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );

  while (
    oldestEntries.length > 0 &&
    (rememberedResponseToolCalls.size > RESPONSE_TOOL_CALL_CACHE_MAX_ENTRIES ||
      totalConversationChars > RESPONSE_CONVERSATION_TOTAL_MAX_CHARS)
  ) {
    const oldest = oldestEntries.shift();
    if (!oldest) break;
    const [responseId, entry] = oldest;
    if (rememberedResponseToolCalls.delete(responseId)) {
      totalConversationChars -= getConversationItemsChars(entry);
    }
  }
}

function cleanupRememberedResponseToolCalls(now: number = Date.now()) {
  for (const [responseId, entry] of rememberedResponseToolCalls.entries()) {
    if (entry.expiresAt <= now) {
      rememberedResponseToolCalls.delete(responseId);
    }
  }

  for (const [callId, entry] of rememberedFunctionCallsById.entries()) {
    if (entry.expiresAt <= now) {
      rememberedFunctionCallsById.delete(callId);
    }
  }

  enforceRememberedResponseToolCallLimits();

  if (rememberedFunctionCallsById.size > RESPONSE_TOOL_CALL_CACHE_MAX_ENTRIES) {
    const oldestCallEntries = [...rememberedFunctionCallsById.entries()].sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt
    );

    while (rememberedFunctionCallsById.size > RESPONSE_TOOL_CALL_CACHE_MAX_ENTRIES) {
      const oldest = oldestCallEntries.shift();
      if (!oldest) break;
      rememberedFunctionCallsById.delete(oldest[0]);
    }
  }
}

export function rememberResponseFunctionCalls(
  responseId: unknown,
  outputItems: readonly unknown[]
) {
  const normalizedResponseId = typeof responseId === "string" ? responseId.trim() : "";
  if (!normalizedResponseId || !Array.isArray(outputItems) || outputItems.length === 0) {
    return;
  }

  const existingEntry = rememberedResponseToolCalls.get(normalizedResponseId);

  const functionCalls: RememberedFunctionCall[] = [];

  for (const item of outputItems) {
    const record = toRecord(item);
    if (!record || record.type !== "function_call") continue;

    const callId = typeof record.call_id === "string" ? record.call_id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const argumentsValue =
      typeof record.arguments === "string"
        ? truncateRememberedString(record.arguments)
        : truncateRememberedString(JSON.stringify(record.arguments ?? {}));

    if (!callId || !name) continue;

    functionCalls.push({
      call_id: callId,
      name,
      arguments: argumentsValue,
    });
  }

  if (functionCalls.length === 0) {
    return;
  }

  cleanupRememberedResponseToolCalls();

  const now = Date.now();
  for (const functionCall of functionCalls) {
    rememberedFunctionCallsById.set(functionCall.call_id, {
      ...functionCall,
      updatedAt: now,
      expiresAt: now + RESPONSE_TOOL_CALL_TTL_MS,
    });
  }

  rememberedResponseToolCalls.set(normalizedResponseId, {
    functionCalls,
    conversationItems: compactRememberedConversationItems(existingEntry?.conversationItems || []),
    updatedAt: now,
    expiresAt: now + RESPONSE_TOOL_CALL_TTL_MS,
  });
  enforceRememberedResponseToolCallLimits();
}

export function rememberResponseConversationState(
  responseId: unknown,
  requestInput: readonly unknown[],
  outputItems: readonly unknown[]
) {
  const normalizedResponseId = typeof responseId === "string" ? responseId.trim() : "";
  if (!normalizedResponseId) {
    return;
  }

  const normalizedRequestInput = Array.isArray(requestInput) ? requestInput : [];
  const normalizedOutputItems = Array.isArray(outputItems) ? outputItems : [];
  const conversationItems = compactRememberedConversationItems([
    ...normalizedRequestInput,
    ...normalizedOutputItems,
  ]);
  if (conversationItems.length === 0) {
    return;
  }

  cleanupRememberedResponseToolCalls();

  const existingEntry = rememberedResponseToolCalls.get(normalizedResponseId);
  const now = Date.now();
  rememberedResponseToolCalls.set(normalizedResponseId, {
    functionCalls: existingEntry?.functionCalls?.map((functionCall) => ({ ...functionCall })) || [],
    conversationItems,
    updatedAt: now,
    expiresAt: now + RESPONSE_TOOL_CALL_TTL_MS,
  });
  enforceRememberedResponseToolCallLimits();
}

export function getRememberedResponseFunctionCalls(responseId: unknown): RememberedFunctionCall[] {
  cleanupRememberedResponseToolCalls();

  const normalizedResponseId = typeof responseId === "string" ? responseId.trim() : "";
  if (!normalizedResponseId) {
    return [];
  }

  const entry = rememberedResponseToolCalls.get(normalizedResponseId);
  if (!entry) {
    return [];
  }

  return entry.functionCalls.map((functionCall) => ({ ...functionCall }));
}

export function getRememberedResponseConversationItems(responseId: unknown): unknown[] {
  cleanupRememberedResponseToolCalls();

  const normalizedResponseId = typeof responseId === "string" ? responseId.trim() : "";
  if (!normalizedResponseId) {
    return [];
  }

  const entry = rememberedResponseToolCalls.get(normalizedResponseId);
  if (!entry) {
    return [];
  }

  return compactRememberedConversationItems(entry.conversationItems);
}

export function getRememberedFunctionCallsByIds(
  callIds: readonly string[]
): RememberedFunctionCall[] {
  cleanupRememberedResponseToolCalls();

  if (!Array.isArray(callIds) || callIds.length === 0) {
    return [];
  }

  const remembered: RememberedFunctionCall[] = [];
  for (const rawCallId of callIds) {
    const callId = typeof rawCallId === "string" ? rawCallId.trim() : "";
    if (!callId) continue;
    const entry = rememberedFunctionCallsById.get(callId);
    if (!entry) continue;
    remembered.push({
      call_id: entry.call_id,
      name: entry.name,
      arguments: entry.arguments,
    });
  }

  return remembered;
}

export function clearRememberedResponseFunctionCallsForTesting() {
  rememberedResponseToolCalls.clear();
  rememberedFunctionCallsById.clear();
}
