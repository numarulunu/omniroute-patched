# Project Log

## 2026-05-12 - Codex token tuning deployed

- Summary: Tuned Codex pressure handling to reduce cold context spikes and added metadata-only MCP/tool payload telemetry.
- Files touched: `src/lib/usage/contextCompactionEvents.ts`, `src/lib/usage/callLogs.ts`, `open-sse/handlers/chatCore.ts`, `open-sse/executors/codex.ts`, `open-sse/executors/base.ts`, `tests/unit/context-compaction-events.test.ts`, `tests/unit/call-log-cap.test.ts`, `tests/unit/executor-codex.test.ts`.
- Verification: `node --import tsx/esm --test tests/unit/context-compaction-events.test.ts`; `node --import tsx/esm --test tests/unit/call-log-cap.test.ts`; `node --import tsx/esm --test tests/unit/executor-codex.test.ts --test-name-pattern "context pressure|pressure trim keeps function"`; `npm run typecheck:core`; `git diff --check`.
- Deployment: Built VPS image `omniroute-local:codex-token-tune-base-20260512-014930` with Docker target `runner-base`, smoke-tested on temporary localhost port `20133`, then swapped production to container `omniroute-codex-token-tune-20260512-014930`.
- Production verification: Docker health is healthy; local and public `https://omniroute.ionutrosu.xyz/api/health` return `401`; recent Codex calls return `200`; `toolPayload` request summaries are being recorded.
- Incident: The first token-tune production container was launched with a different `STORAGE_ENCRYPTION_KEY` than the previous running container. That caused credential decryption failures and forced account re-auth. Future deploys must compare the running container's encryption-key fingerprint before any production swap and must not live-swap while Codex sessions are active.
- Next step: Monitor cold input/day, pending pressure sessions, decryption failures, and `request_summary.toolPayload` size distributions after heavy usage.

## 2026-05-09 - Codex pressure-aware context trimming

- Summary: Added a one-shot Codex context-pressure intervention for sessions that produce critical or repeated high-uncached input. The intervention is metadata-triggered, preserves developer/system items plus the last 10 Responses input items, and only trims when the outgoing input is still large.
- Files touched: `src/lib/usage/contextCompactionEvents.ts`, `open-sse/handlers/chatCore.ts`, `open-sse/executors/codex.ts`, `open-sse/executors/base.ts`, `tests/unit/context-compaction-events.test.ts`, `tests/unit/executor-codex.test.ts`.
- Verification: `node --import tsx/esm --test tests/unit/context-compaction-events.test.ts`; `node --import tsx/esm --test tests/unit/executor-codex.test.ts --test-name-pattern "context pressure"`; `node --import tsx/esm --test tests/unit/context-manager.test.ts`; `npm run typecheck:core`; `git diff --check`.
- Decision: Use pressure-aware per-session intervention instead of a global smaller context cap. Pending pressure is consumed once and cleared by real compact-like drops.
- Deployment: Built VPS image `omniroute-local:pressure-trim-base-20260510-132343` with Docker target `runner-base`, smoke-tested it in a disposable container, then swapped production to container `omniroute-pressure-trim-20260510-132343`.
- Production verification: Docker health is healthy; local and public `https://omniroute.ionutrosu.xyz/api/health` return `401`; previous container `omniroute-context-pressure-20260508-050657` is stopped and kept available for rollback.
- Regression fix: User reported Codex 400s for orphan `function_call_output` call IDs after the first pressure-trim deploy. Root cause was pressure trim running after tool-pair repair and splitting `function_call` / `function_call_output` pairs. Production was rolled back to `omniroute-context-pressure-20260508-050657`, then a fixed image `omniroute-local:pressure-trim-fix-base-20260510-193753` was built and deployed as `omniroute-pressure-trim-fix-20260510-193753`. The fix repairs function-call pairs after pressure trimming and drops orphaned tool items instead of sending invalid payloads.
- Regression verification: `node --import tsx/esm --test tests/unit/executor-codex.test.ts --test-name-pattern "pressure trim keeps function"`; `node --import tsx/esm --test tests/unit/executor-codex.test.ts --test-name-pattern "context pressure"`; `node --import tsx/esm --test tests/unit/context-compaction-events.test.ts`; `npm run typecheck:core`; corrected production container is healthy and local/public `/api/health` return `401`.
- Next step: Monitor `context_pressure_sessions.intervention_count`, pending sessions, cache-read %, and high-uncached requests after a heavy-use window.

## 2026-05-08 - Context pressure monitoring deployed

- Summary: Added observe-only context pressure monitoring for Codex `/v1/responses` usage. The detector stores hashed prompt-cache-key metadata only, recording high uncached input spikes and low cache-read rates without request or response bodies.
- Files touched: `src/lib/usage/contextCompactionEvents.ts`, `src/lib/usage/callLogs.ts`, `scripts/compact-health-report.mjs`, `tests/unit/context-compaction-events.test.ts`, `tests/unit/compact-health-report.test.ts`.
- Verification: `node --import tsx/esm --test tests/unit/context-compaction-events.test.ts`; `node --test tests/unit/compact-health-report.test.ts`; `node --import tsx/esm --test tests/unit/executor-codex.test.ts`; `node --import tsx/esm --test tests/unit/context-manager.test.ts`; `npm run typecheck:core`; `git diff --check`.
- Deployment: Built VPS image `omniroute-local:context-pressure-base-20260508-050657` with Docker target `runner-base`, smoke-tested it on temporary localhost port `20132` with disposable data, then swapped production to container `omniroute-context-pressure-20260508-050657` (`7c252b734396`).
- Production verification: Public `https://omniroute.ionutrosu.xyz/api/health` returns `401 Authentication required`; production container is healthy on `127.0.0.1:20128`; compact health report now includes a Context Pressure section.
- Rollback: Previous container `yj7526rpmiup0dbzd1lb9967-105231058753` (`539446f63f54`) using image `omniroute-local:compact-tail-base-20260507-033716` is stopped and kept available.
- Decision: Do not force a smaller max context yet. The useful next data is which prompt-cache-key sessions create uncached spikes despite the overall 94% cache-read rate.
- Next step: After another heavy-use window, compare `context_pressure_events` with compact drops and decide whether to lower max context, improve compact timing, or leave behavior unchanged.

## 2026-05-12 - Repatched on upstream 3.8.0

- Summary: Rebased the OmniRoute/Codex compaction patch stack onto upstream release/v3.8.0 and added the missing model availability domain wrapper required by the new resilience cooldown API route.
- Files touched: patch stack files plus `src/domain/modelAvailability.ts`.
- Verification: targeted Codex/compaction unit tests passed (86 tests, 0 failures); `tests/integration/chat-pipeline.test.ts` reached 26 ok tests but the process stayed alive on Redis retry handles; `npm run typecheck:core` passed; `npm run build` passed after adding the wrapper; `git diff --check` passed.
- Deployment: No VPS deploy or live container swap was performed. GitHub branch update only, to avoid interrupting active Codex sessions.
- Next step: Deploy only through a side-by-side candidate container and a quiet-window/live-session check with matching encryption-key fingerprint.

## 2026-05-12 - Codex OOM and expired retry safeguards

- Summary: Added safeguards for the post-incident Codex path: bounded in-memory Responses replay snapshots by item count and byte budget, and persisted expired OAuth retry bookkeeping so health checks can actually back off instead of re-logging attempt 1.
- Files touched: `open-sse/services/responsesToolCallState.ts`, `src/lib/db/core.ts`, `src/lib/db/providers.ts`, `src/lib/db/migrationRunner.ts`, `src/lib/db/migrations/055_provider_connection_expired_retries.sql`, `tests/unit/executor-codex.test.ts`, `tests/unit/token-health-check.test.ts`.
- Verification: Red tests reproduced the unbounded replay snapshot and missing retry persistence; after the fix, `node --import tsx/esm --test tests/unit/token-health-check.test.ts tests/unit/executor-codex.test.ts` passed with 47/47 tests, `npm run typecheck:core` exited 0, and `git diff --check` exited 0.
- Decision: Did not deploy from this local pass. Production changes still need the compose-based, no-`docker run` deploy path with image tag update and health/smoke monitoring.
- Next step: Deploy through Coolify compose only after explicit approval, then monitor heap/RSS and Codex request logs for at least a heavy-use window.

## 2026-05-12 - Codex stream readiness false 504 fix

- Summary: Fixed false `504 STREAM_READINESS_TIMEOUT` responses on Codex/OpenAI Responses streams where lifecycle frames such as `response.created` arrive before text/tool deltas during long model thinking.
- Files touched: `open-sse/utils/streamReadiness.ts`, `tests/unit/stream-readiness.test.ts`.
- Verification: Added failing OpenAI Responses lifecycle regression tests first; after the fix, `node --import tsx/esm --test tests/unit/stream-readiness.test.ts tests/unit/combo-stream-readiness-fallback.test.ts` passed with 13/13 tests, `node --import tsx/esm --test tests/unit/executor-codex.test.ts` passed with 40/40 tests, `npm run typecheck:core` exited 0, and `git diff --check` exited 0.
- Note: `tests/unit/chat-cooldown-aware-retry.test.ts` still shows two Node test-runner `cancelledByParent` timer cancellations locally; that appears tied to the test's mocked timer harness and was not used as deploy evidence for this stream parser change.
- Next step: Deploy through Coolify compose only, then watch for `Stream produced no useful content` and `Controller is already closed` logs under live Codex traffic.

## 2026-05-12 - Codex 5h quota warning buffer

- Summary: Changed Codex's default quota policy buffer from 99% used to 95% used so routing rotates away from an account before the Codex CLI shows the `<5% of 5h limit left` warning. Existing session affinity now drops naturally because quota filtering runs before affinity selection.
- Files touched: `src/sse/services/auth.ts`, `tests/unit/quota-policy-generalization.test.ts`.
- Verification: Added failing quota-policy coverage first; after the fix, `node --import tsx/esm --test tests/unit/quota-policy-generalization.test.ts` passed with 10/10 tests, `node --import tsx/esm --test tests/unit/codex-connection-defaults.test.ts` passed with 2/2 tests, `node --import tsx/esm --test tests/unit/executor-codex.test.ts` passed with 40/40 tests, `npm run typecheck:core` exited 0, and `git diff --check` exited 0. `tests/unit/sse-auth.test.ts` was attempted but hit a local Redis test harness timeout/noise and was not used as evidence.
- Next step: Deploy through Coolify compose only and confirm live logs filter accounts at `session usage 95%+` instead of waiting for `100%`.
