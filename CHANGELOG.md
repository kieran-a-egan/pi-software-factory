# Changelog

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
