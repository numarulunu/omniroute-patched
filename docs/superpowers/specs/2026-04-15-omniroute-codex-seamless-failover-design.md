# OmniRoute Codex Seamless Failover Design

## Goal

Make Codex account handoff invisible for the user's six-account setup.
When the active Codex account hits quota, OmniRoute should stop sending that
scope to the exhausted account until the real quota reset, then continue on
the next eligible account without bouncing back after a short cooldown.

## Current Problem

The current runtime behavior in the installed OmniRoute build is:

1. Account 1 receives a Codex `429` usage-limit error.
2. OmniRoute falls back to account 2 for the next request.
3. The short cooldown expires almost immediately.
4. Fill-first selection returns to account 1, so routing keeps oscillating.

This breaks the user's intended behavior:

- use account 1 until quota is gone
- then use account 2
- then 3, and so on
- only reconsider the exhausted account after its quota reset

## Constraints

- Preserve existing fill-first or priority semantics for Codex accounts.
- Preserve Codex scope separation (`codex` vs `spark`) so one exhausted scope
  does not unnecessarily disable the other.
- Reuse existing persisted state where possible instead of adding a new table.
- Keep a safe fallback path when live quota fetch is unavailable.

## Chosen Approach

Use a scope-level hard park for Codex quota exhaustion.

On a Codex `429` that represents quota exhaustion:

1. Determine the affected Codex scope from the requested model.
2. Resolve the real reset time for that scope.
3. Persist the scope lockout until that reset.
4. Make credential selection skip that scope on that account until the reset passes.

This keeps the current account-selection strategy intact while fixing the
incorrect short retry window.

## Reset-Time Resolution

Resolve the lockout end time in this order:

1. Existing persisted scope reset in `providerSpecificData.codexScopeRateLimitedUntil`
2. Fresh quota fetch through `fetchCodexQuota(connectionId, connectionSnapshot)`
3. Cooldown derived from `getCodexQuotaCooldownMs(quota)`
4. Existing short exponential backoff only when no reset time can be discovered

This gives the desired behavior when quota data is available and keeps a safe
fallback when it is not.

## Persistence Model

No new schema is required.

Reuse:

- `providerSpecificData.codexScopeRateLimitedUntil[scope]`
- existing `testStatus`, `lastError`, `errorCode`, and `backoffLevel`

Do not convert Codex quota exhaustion into a full connection-wide
`rateLimitedUntil` by default. Scope-level parking is the correct behavior for
Codex because `codex` and `spark` can have separate pools.

## Selection Rules

`getProviderCredentials()` already skips:

- connection-wide `rateLimitedUntil`
- terminal connection status
- Codex scope unavailability via `isCodexScopeUnavailable()`
- model-level locks

The fix is therefore not a new selector. The fix is making the persisted
Codex scope lockout point at the real reset time instead of a short cooldown.

## Expected User-Visible Behavior

For a fill-first Codex setup:

1. Requests use account 1.
2. Account 1 hits quota on `gpt-5.4`.
3. OmniRoute parks the `codex` scope on account 1 until reset.
4. Subsequent `gpt-5.4` requests use account 2.
5. OmniRoute keeps using account 2 until it also exhausts.
6. Account 1 only becomes eligible again after its stored reset time passes.

This should feel like uninterrupted routing rather than repeated retries.

## Files

- Modify `src/sse/services/auth.ts`
  - tighten Codex `429` handling in `markAccountUnavailable()`
  - prefer real Codex reset times for scope parking
- Possibly modify `open-sse/services/codexQuotaFetcher.ts`
  - only if a small helper is needed for extracting a stable reset timestamp
- Add regression coverage in `tests/unit/`
  - selection remains on the next account while the first scope is parked
  - parked scope becomes eligible again after reset
  - spark scope is not blocked by a codex-scope lockout

## Testing

### Regression tests

1. Codex `429` with quota data parks the affected scope until the fetched reset time.
2. Fill-first credential selection skips the parked account and keeps selecting the next account.
3. Once the parked-until time passes, the first account becomes eligible again.
4. Codex scope parking remains scope-specific and does not block the other Codex pool.

### Safety tests

1. If quota fetch fails, existing short cooldown behavior still applies.
2. Non-Codex providers keep current behavior.
3. Non-quota Codex errors keep current fallback handling.

## Rollout

Implement in the upstream source tree, verify with targeted unit tests, then
replace the user's outdated global install with a build from the patched repo.
