import {
  clearModelLock,
  getAllModelLockouts,
} from "@omniroute/open-sse/services/accountFallback.ts";

export type ModelAvailabilityReportItem = {
  provider: string;
  connectionId: string;
  model: string;
  reason: string;
  remainingMs: number;
  failureCount: number;
};

export function getAvailabilityReport(): ModelAvailabilityReportItem[] {
  return getAllModelLockouts().filter((item) => item.remainingMs > 0);
}

export function clearModelUnavailability(provider: string, model: string): boolean {
  let removed = false;
  for (const item of getAllModelLockouts()) {
    if (item.provider !== provider || item.model !== model) continue;
    removed = clearModelLock(item.provider, item.connectionId, item.model) || removed;
  }
  return removed;
}

export function resetAllAvailability(): number {
  let removed = 0;
  for (const item of getAllModelLockouts()) {
    if (clearModelLock(item.provider, item.connectionId, item.model)) {
      removed += 1;
    }
  }
  return removed;
}
