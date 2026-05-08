# Project Log

## 2026-05-08 - Context pressure monitoring deployed

- Summary: Added observe-only context pressure monitoring for Codex `/v1/responses` usage. The detector stores hashed prompt-cache-key metadata only, recording high uncached input spikes and low cache-read rates without request or response bodies.
- Files touched: `src/lib/usage/contextCompactionEvents.ts`, `src/lib/usage/callLogs.ts`, `scripts/compact-health-report.mjs`, `tests/unit/context-compaction-events.test.ts`, `tests/unit/compact-health-report.test.ts`.
- Verification: `node --import tsx/esm --test tests/unit/context-compaction-events.test.ts`; `node --test tests/unit/compact-health-report.test.ts`; `node --import tsx/esm --test tests/unit/executor-codex.test.ts`; `node --import tsx/esm --test tests/unit/context-manager.test.ts`; `npm run typecheck:core`; `git diff --check`.
- Deployment: Built VPS image `omniroute-local:context-pressure-base-20260508-050657` with Docker target `runner-base`, smoke-tested it on temporary localhost port `20132` with disposable data, then swapped production to container `omniroute-context-pressure-20260508-050657` (`7c252b734396`).
- Production verification: Public `https://omniroute.ionutrosu.xyz/api/health` returns `401 Authentication required`; production container is healthy on `127.0.0.1:20128`; compact health report now includes a Context Pressure section.
- Rollback: Previous container `yj7526rpmiup0dbzd1lb9967-105231058753` (`539446f63f54`) using image `omniroute-local:compact-tail-base-20260507-033716` is stopped and kept available.
- Decision: Do not force a smaller max context yet. The useful next data is which prompt-cache-key sessions create uncached spikes despite the overall 94% cache-read rate.
- Next step: After another heavy-use window, compare `context_pressure_events` with compact drops and decide whether to lower max context, improve compact timing, or leave behavior unchanged.
