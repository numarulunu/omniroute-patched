export interface ApiKeyRateLimitRule {
  limit: number;
  window: number;
}

export const DEFAULT_API_KEY_RATE_LIMITS: ApiKeyRateLimitRule[] = [
  { limit: 100000, window: 86400 },
  { limit: 500000, window: 604800 },
  { limit: 2000000, window: 2592000 },
];

export const DEFAULT_API_KEY_MAX_REQUESTS_PER_DAY = 100000;
export const DEFAULT_API_KEY_MAX_REQUESTS_PER_MINUTE = 600;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRateLimits(value: string | undefined): ApiKeyRateLimitRule[] | null {
  if (!value || value.trim() === "") return null;

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;

    const rules = parsed.filter(
      (rule): rule is ApiKeyRateLimitRule =>
        rule &&
        typeof rule === "object" &&
        typeof rule.limit === "number" &&
        Number.isFinite(rule.limit) &&
        rule.limit > 0 &&
        typeof rule.window === "number" &&
        Number.isFinite(rule.window) &&
        rule.window > 0
    );

    return rules.length > 0 ? rules : null;
  } catch {
    return null;
  }
}

export function getDefaultApiKeyRateLimits(): ApiKeyRateLimitRule[] {
  return (
    parseRateLimits(process.env.OMNIROUTE_API_KEY_DEFAULT_RATE_LIMITS) ??
    DEFAULT_API_KEY_RATE_LIMITS
  ).map((rule) => ({ ...rule }));
}

export function getDefaultApiKeyMaxRequestsPerDay(): number {
  return parsePositiveInteger(
    process.env.OMNIROUTE_API_KEY_DEFAULT_MAX_REQUESTS_PER_DAY,
    DEFAULT_API_KEY_MAX_REQUESTS_PER_DAY
  );
}

export function getDefaultApiKeyMaxRequestsPerMinute(): number {
  return parsePositiveInteger(
    process.env.OMNIROUTE_API_KEY_DEFAULT_MAX_REQUESTS_PER_MINUTE,
    DEFAULT_API_KEY_MAX_REQUESTS_PER_MINUTE
  );
}

export function getDefaultApiKeyPolicySnapshot() {
  return {
    rateLimits: getDefaultApiKeyRateLimits(),
    maxRequestsPerDay: getDefaultApiKeyMaxRequestsPerDay(),
    maxRequestsPerMinute: getDefaultApiKeyMaxRequestsPerMinute(),
  };
}
