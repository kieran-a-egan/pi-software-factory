# Changelog

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
