# Changelog

## 0.4.0

- add bounded Jev-driven plan-gate `rescout` and `replan` loops before implementation
- add targeted rescout/replan focus classifications and persist revised evidence, architecture, and gate artifacts
- add configurable `planningLoops.maxRescoutPasses` and `planningLoops.maxReplanPasses` safeguards
- move runtime JSON/JSONL artifacts from `.okf/work` to `.pi/software-factory/runs`
- treat the legacy `.okf/work` config value as a migration alias without moving or deleting historical runs
- keep `.okf/project` only as an optional source for genuine OKF project context
- exclude the runtime run directory from factory Git-clean/status checks so operational artifacts do not dirty the working tree
- keep review-stage `replan` conservative: it still requires human intervention after implementation has begun
- enforce implementation-unit file scope before Jev worker routing; reported edits outside `filesExpected` stop for human review
- pass deferred/completed unit context to Qwen so workers do not perform later units early
- add a configurable worker watchdog (`workerMaxRuntimeMinutes`, default 20) that aborts a Qwen implementation/repair session and routes to human instead of allowing an unbounded stage


## 0.3.0

- add Qwen context-budget accounting for implementation and repair workers
- emit a warning at 65K context and request a factual checkpoint at 75K by default
- persist checkpoint artifacts and resume the same implementation unit in a fresh Pi/Qwen session
- keep Pi auto-compaction as a safety net before the 88K hard limit
- add configurable `contextBudget` thresholds and maximum checkpoint count
- record max context, compaction count, and checkpoint requests in stage telemetry
- distinguish context warnings, checkpoint requests, and persisted checkpoints inline in the Pi transcript

## 0.2.2

- Replaced the height-limited live widget with durable transcript entries.
- Completed stages now render inline in Pi's normal scrollable transcript.
- Current work uses only the one-line Pi status bar.
- `/factory-status` now prints a complete run summary into the transcript.
- Transcript entries do not participate in LLM context.
- Last completed run can be recovered from persisted session entries after reload.
- Clears stale `software-factory` widgets left by v0.2.0/v0.2.1.

## 0.2.1

- Keep the live factory widget compact so Pi cannot hide the newest stage behind dock truncation.
- Move the current/final state to the top of the widget.
- Truncate the objective to a single compact line.
- Change `/factory-status` into a scrollable stage browser with per-stage duration/model/token details.

## 0.2.0

- Package the factory as a first-class Pi package with a named `software-factory.ts` entrypoint.
- Add per-stage telemetry persisted to `telemetry.json` and `run-summary.json`.
- Capture Pi subagent token usage, cost, and context-usage snapshots where the runtime exposes them.
- Capture Jev input/output token usage from decision responses.
- Add a live Pi factory widget with recent stage durations and token counts.
- Add `/factory-status` for redisplaying the latest run in the current Pi session.
- Keep v0.1.4 control-flow semantics unchanged: no autonomous rescout/replan and no proactive Qwen checkpoint/restart yet.

## 0.1.4

- Move implementation and repair completion classification from Qwen to Jev.
- Deterministic verification failures route directly to bounded repair.
