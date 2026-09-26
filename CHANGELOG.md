# Changelog

## Unreleased — 0.8.0

- add an offline deterministic Vitest regression suite and typecheck covering orchestration, Git evidence, controller routing, and scripted agent lifecycle/checkpoint/submission recovery
- make agent/session construction injectable for deterministic regression tests without changing production model routing
- capture complete review evidence for tracked, staged, unstaged, untracked, and binary changes without modifying the real index; exclude runtime artifacts literally
- defer low-confidence repair READY routing to authoritative verification without weakening Jev thresholds
- verify the repository baseline before any model call; failed baseline checks block implementation and repair
- extract pure final-review routing and accept below-threshold review sufficiency only with confident Jev acceptance, low residual risk, passing deterministic verification, a clean Astra verdict, and no major/critical findings; preserve original scores and explicit routing evidence
- journal full-run source/index state with an exclusive per-checkout interlock; retain unaccepted edits after HUMAN/FAILED/BLOCKED/cancellation rather than resetting or cleaning the user's repository
- persist failures and source disposition, reject acceptance of post-verification source changes, retain failed/cancelled parallel worktrees, and save completed worker patches before cleanup
- prevent same-second run-artifact collisions and atomically replace JSON artifacts
- fix runtime status exclusions for unstaged and quoted/spaced paths using literal Git pathspecs
- add Windows/Linux CI using `npm ci`, `npm test`, and `npm run typecheck`; align supported Node versions with locked dependencies (22.20+ on 22.x, or 24.12+)

Release preparation still required: promote this section to `0.8.0`, update the version in `package.json`, both root version entries in `package-lock.json`, and `VERSION` in `software-factory.ts`; update the README tagged-install example to `v0.8.0` when that tag is published. No tag or release has been created.

## 0.7.5

- give scout, architect, reviewer, implementer, and repairer concrete structured `submit_result` schemas instead of leaving non-worker roles unconstrained
- add one bounded same-session recovery turn when an agent finishes without calling `submit_result`
- when a context checkpoint was requested, recovery requires exactly one `submit_result` or `submit_checkpoint` rather than continuing implementation
- preserve the existing worker runtime deadline across the recovery turn
- record whether structured-submission recovery was attempted in stage telemetry
- fixes long scout/review/planning stages terminating the whole factory solely because the model ended without the required submission tool call

## 0.7.4

- persist a run-level completion timestamp and report true wall-clock duration separately from cumulative stage work
- compute exact overlap between stage intervals so concurrent work is visible in run summaries
- stop presenting the sum of stage durations as elapsed run time when parallel stages overlap
- show overlapping stage work and cumulative stage work in final and `/factory-status` transcript output
- keep token totals cumulative while making concurrency timing explicit

## 0.7.3

- preserve raw `git diff --binary` output exactly when capturing isolated worktree changes instead of trimming patch-significant trailing context
- stop concatenating independent worker patches into one synthetic patch document
- preflight the complete batch with `git apply --check` and then apply the original per-worker patch files together
- record patch byte sizes in successful parallel-batch artifacts
- fixes Windows parallel integration failures such as `corrupt patch at ...` after both workers and Jev gates have succeeded

## 0.7.2

- pass explicit worker execution context into Jev worker routing
- distinguish primary sequential, isolated parallel-worktree, and repair execution modes at the semantic gate
- make deferred post-integration verification authoritative for isolated parallel workers
- prevent missing ignored dependency caches/tooling in disposable worktrees from being treated as unfinished assignment work or an external blocker
- retain the existing Jev confidence threshold; this changes routing evidence rather than weakening the gate

## 0.7.1

- strongly type `submit_result` for implementation/repair workers so local Qwen receives the concrete WorkerReport schema instead of an unconstrained payload
- strongly type context-checkpoint submissions with the WorkerCheckpoint schema
- accept a JSON-encoded object string from a local worker as a narrow compatibility fallback, then run the normal strict structural validation
- fixes parallel workers finishing with `WorkerReport must be an object` after otherwise completing their sessions

## 0.7.0

- persist semantic decision history in `state.json` as well as `decisions.jsonl`
- add decision counts to run summaries and show bounded routing history in `/factory-status`
- show context checkpoints, worker continuations, parallel batches, planning recovery, and active concurrent stages in the transcript status view
- track multiple simultaneously active parallel stages instead of reporting only the most recently started one
- harden sequential implementation-unit scope enforcement using deterministic before/after Git snapshots
- compare actual changed paths with both `filesExpected` and the worker-reported `changedFiles`, persisting scope evidence per unit
- route to human intervention when a sequential worker changes files outside its declared scope even if its report omits those edits
- allow snapshot diff capture to exclude runtime artifact paths consistently

## 0.6.0

- add dependency-aware scheduling for implementation units
- run dependency-ready units concurrently only when they declare explicit non-overlapping `filesExpected` scopes and explicit `dependsOn` arrays
- isolate parallel Qwen workers in disposable detached Git worktrees created from an ephemeral snapshot of the current working tree
- capture each accepted worktree as a patch and integrate a whole parallel batch only after every worker/gate succeeds
- verify reported and actual changed paths against the unit scope and detect post-run cross-worker path overlap before integration
- cancel sibling Qwen sessions when one parallel worker fails or routes to human intervention
- fall back to sequential execution if parallel snapshot creation is unavailable
- require architect plans to make dependency and file ownership explicit so concurrency is conservative by construction
- persist implementation graph and parallel-batch artifacts and expose parallel-batch counts in transcript status
- keep final deterministic verification authoritative after all patches are integrated

## 0.5.0

- add bounded Jev-driven worker continuation for implementation and repair assignments
- start each continuation in a fresh Qwen session using the prior factual report plus Jev routing evidence
- keep Jev `continue` distinct from context-budget checkpoint/resume semantics
- add configurable `maxWorkerContinuationPasses` with human escalation when the bound is exhausted
- persist continuation reports, gates, continuation records, decisions, and summary counts
- preserve hard implementation-unit file scope across continuation passes
- show worker-continuation counts in final and `/factory-status` transcript output
- correct deferred/already-completed unit relation metadata passed to implementation workers
- fix the README legacy runtime-path migration wording

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
