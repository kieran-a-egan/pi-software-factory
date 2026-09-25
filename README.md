# Pi Software Factory

A Pi package that runs a controlled software-engineering pipeline using:

- **Jev** for bounded semantic classification and routing
- **GPT-6 Astra** for architecture, planning, and independent review
- **local Qwen3.8-27B** for repository scouting, implementation, and repair
- **deterministic tools** for Git/build/test/typecheck/lint truth

Current version: **0.7.1**

## Pipeline

```text
/factory <objective>
        │
        ▼
   Jev intake
        │
        ▼
   Qwen scout                  read-only
        │
        ▼
 Astra architect               read-only
        │
        ▼
   Jev plan gate
        │
        ▼
 Qwen implementer(s)           repo write/shell
        │
        ▼
 Jev worker gate
        │
        ▼
 deterministic verification    authoritative
        │
        ├── fail → Qwen repair → Jev repair gate → reverify
        │
        ▼
 Astra independent review      read-only
        │
        ▼
 Jev final gate
        │
        ├── accept
        └── human/rework/replan
```

The controller owns the state machine. Models do not arbitrarily select the next agent.

## v0.7.1 changes

v0.7.1 hardens the local-Qwen structured submission boundary. Implementation and repair workers now receive an explicit WorkerReport schema for `submit_result`, checkpoints receive an explicit WorkerCheckpoint schema, and JSON-encoded object strings are narrowly normalized before the existing strict validator runs. This prevents a completed local worker from being discarded solely because it serialized the report object as JSON text.

## v0.7 changes

v0.7 closes the remaining observability and scope-enforcement gaps.

Every semantic routing decision is now retained in the in-memory/persisted run state as well as the append-only `decisions.jsonl` log. `/factory-status` shows decision history, planning recovery counts, context checkpoints, Jev worker continuations, parallel batches, and all currently active concurrent stages.

Implementation-unit scope is now checked against Git truth in both execution modes. Parallel workers already captured isolated worktree diffs; v0.7 adds before/after ephemeral snapshots around sequential implementation units as well. The controller persists `implementation-scope-<unit>.json` with declared scope, worker-reported files, actual changed paths, and report omissions. Actual out-of-scope changes route to `HUMAN` even if the worker report did not disclose them.

## v0.6 changes

v0.6 adds conservative parallel execution for implementation units. The architect must declare an explicit `dependsOn` array and `filesExpected` scope for a unit to be considered for parallel execution. The controller only batches dependency-ready units whose file scopes do not overlap.

Parallel workers never share the primary working tree. The controller creates an ephemeral Git snapshot of the current uncommitted project state, starts each worker in a disposable detached worktree, lets the existing Jev worker/continuation gates run there, then captures each accepted worktree as a patch. A batch is integrated into the primary tree only after every worker succeeds and the actual changed paths remain disjoint and inside the declared scopes. A failed worker cancels sibling Qwen sessions and leaves the primary tree untouched by that batch.

Ignored dependency caches such as `node_modules` are intentionally not copied into isolated worktrees. Parallel-worker prompts therefore prohibit dependency installation and treat unavailable ignored tooling as non-authoritative; the normal deterministic verification stage still runs against the integrated primary tree.

Default parallel settings:

```text
parallelImplementation.enabled:          true
parallelImplementation.maxParallelUnits: 2
```

Units without explicit dependency/file-scope metadata continue sequentially.

## v0.5 changes

v0.5 adds bounded autonomous continuation after a Qwen worker submits evidence and Jev classifies that bounded assignment as `continue`.

A continuation is not a context checkpoint. Context checkpoints resume the same in-progress worker because its live context is under pressure. A Jev continuation starts only after a complete worker report has been submitted and semantically classified as having concrete work remaining inside the same assignment. Continuations always use a fresh Qwen session, preserve the same unit/file scope, and are capped by `maxWorkerContinuationPasses` (default: 2). Exhaustion, low-confidence routing, `blocked`, or `invalid` still routes to human intervention.

Continuation artifacts are persisted alongside the existing worker/gate history, and final/status transcript entries include the total continuation count.

## v0.4 changes

v0.4 keeps the v0.3 Qwen context-checkpoint mechanism and adds bounded planning recovery.

When Jev returns `rescout`, Qwen performs a targeted read-only evidence pass, the evidence is merged, Astra revises the architecture, and the plan gate runs again. When Jev returns `replan`, Astra revises the plan against the existing evidence and the gate runs again. Both loops are bounded and fall back to human intervention when their configured limits are exhausted.

Jev also returns bounded focus classifications so the recovery pass is directed at the most likely gap, such as dependencies, tests, interfaces, security, architecture, sequencing, or verification.

Runtime artifacts are ordinary JSON/JSONL and now live under:

```text
.pi/software-factory/runs/SF-<timestamp>/
```

They no longer live under `.okf`. The optional `.okf/project` context path remains available only for genuine OKF project context. If an existing config still contains the exact legacy default `"runRoot": ".okf/work"`, v0.4+ transparently maps it to the new runtime location without moving or deleting historical runs.

Worker stages also have a wall-clock watchdog. `workerMaxRuntimeMinutes` defaults to 20; if an implementation or repair session exceeds it, Pi aborts that subagent and the factory routes to `HUMAN` rather than running indefinitely. Implementation units are also treated as hard worker scope: when `filesExpected` is present, reported edits outside that set stop the run for review.

Default planning-loop limits:

```text
maxRescoutPasses: 2
maxReplanPasses:  2
```

## Requirements

- Pi coding agent
- Node.js 20+
- Git
- `TYPESAFE_API_KEY`
- Astra available through Pi (default: `openai-codex/gpt-6-astra`)
- local Qwen exposed through an OpenAI-compatible endpoint

The included defaults match the development setup used for this package:

```text
provider: unsloth-local
model:    unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M
endpoint: http://127.0.0.1:8888/v1
context:  98,304 advertised tokens
```

Project configuration can override all model references.

## Install for development from a local Git repo

Do not keep the package source under `~/.pi/agent/extensions`. Put it in a normal source directory and let Pi install it as a package.

Example on PowerShell:

```powershell
cd $HOME
mkdir src -ErrorAction SilentlyContinue
cd src

# Extract/copy this package as:
# C:\Users\<you>\src\pi-software-factory
cd pi-software-factory

npm install

git init
git branch -M main
git add -A
git commit -m "Software Factory v0.7.1"

pi install (Get-Location).Path
```

`pi install` records the local package path in Pi settings. Pi then loads resources according to the `pi` manifest in `package.json`.

During development, edit this Git checkout, commit normally, and run `/reload` in Pi. There is no need to recopy the extension into the global extensions directory.

### Remove the old manually copied extension

If an earlier version exists at:

```text
~/.pi/agent/extensions/software-factory/
```

remove or move it before using the package install. Otherwise Pi may load two copies and both will register `/factory`.

PowerShell:

```powershell
Remove-Item -Recurse -Force "$HOME\.pi\agent\extensions\software-factory"
```

Only do this after your package checkout is safely stored elsewhere.

Verify the package install:

```powershell
pi list
```

Then start Pi and run:

```text
/reload
```

The package manifest points directly to `software-factory.ts`, so the extension resource is no longer the generic `src` entry.

## Publish/install from Git later

Once the repository has a remote, tag releases and install the Git source instead of the local path:

```powershell
git tag v0.7.1
git push origin main --tags
```

Then, for example:

```text
pi install git:github.com/<owner>/pi-software-factory@v0.7.1
```

Pi can update unpinned Git package sources with its package update commands; pinned refs remain fixed until explicitly changed.

## TypeSafe / Jev

Set the key before launching Pi:

```powershell
$env:TYPESAFE_API_KEY = "..."
```

The extension uses `@typesafe-ai/sdk` and `TypeSafeClient.systemOne()`.

Qwen workers report facts only. Jev owns semantic worker routing:

```text
ready | continue | blocked | invalid
```

Deterministic verification remains authoritative. Jev cannot convert a failing build/test/lint/typecheck into a pass.

## Qwen model configuration

If your `~/.pi/agent/models.json` already contains the working local model, keep it. `models.qwen.example.json` is only a reference.

The factory defaults to:

```json
{
  "qwen": {
    "provider": "unsloth-local",
    "model": "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
    "thinking": "medium"
  }
}
```

Override this per project in `.pi/software-factory.json` if necessary.

## Project configuration

Create `.pi/software-factory.json` in the target repository when you need overrides. See `software-factory.example.json`.

Typical configuration:

```json
{
  "qwen": {
    "provider": "unsloth-local",
    "model": "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
    "thinking": "medium"
  },
  "astra": {
    "provider": "openai-codex",
    "model": "gpt-6-astra",
    "thinking": "high"
  },
  "jev": {
    "model": "jev-latest",
    "minChoiceConfidence": 0.6,
    "minNoulProbability": 0.65
  },
  "planningLoops": {
    "maxRescoutPasses": 2,
    "maxReplanPasses": 2
  },
  "parallelImplementation": {
    "enabled": true,
    "maxParallelUnits": 2
  },
  "contextBudget": {
    "enabled": true,
    "warningTokens": 65000,
    "checkpointTokens": 75000,
    "hardLimitTokens": 88000,
    "maxCheckpointsPerStage": 3
  },
  "runRoot": ".pi/software-factory/runs",
  "contextPaths": ["AGENTS.md", ".okf/project"],
  "contextMaxBytes": 180000,
  "requireCleanWorkingTree": true,
  "verificationCommands": [
    "npm test",
    "npm run typecheck"
  ],
  "maxRepairPasses": 1,
  "maxWorkerContinuationPasses": 2,
  "workerMaxRuntimeMinutes": 20,
  "maxDiffCharsForReview": 120000
}
```

For projects where `.pi/software-factory.json` and `.pi/software-factory/runs/` are local-only, add them to `.git/info/exclude` or the repository's `.gitignore` as appropriate.

## Commands

Start a run:

```text
/factory Add organisation-level SSO using Microsoft Entra ID
```

Redisplay the latest run from the current Pi session:

```text
/factory-status
```

## Run artifacts

Each run is written under:

```text
.pi/software-factory/runs/SF-<timestamp>/
```

Artifacts include the stage-specific evidence and gates plus:

```text
telemetry.json
run-summary.json
state.json
decisions.jsonl
```

`telemetry.json` contains stage-level data such as:

```json
{
  "stage": "qwen-implement",
  "label": "division-tests",
  "actor": "qwen",
  "model": "unsloth-local/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
  "durationMs": 23142,
  "outcome": "completed",
  "tokens": {
    "input": 18342,
    "output": 2411,
    "cacheRead": 0,
    "cacheWrite": 0,
    "total": 20753
  }
}
```

Provider usage can be zero or incomplete if the configured OpenAI-compatible backend does not report streaming usage. The factory records Pi's authoritative session statistics rather than estimating provider tokens itself.

## Safety/control properties

- Scout, architect, and reviewer are read-only.
- Qwen implementer/repairer can edit and execute shell commands.
- Dependency-ready implementation units may run in isolated Git worktrees when explicit dependency/file scopes prove they are non-overlapping.
- Parallel worktree patches are integrated only after all workers in the batch pass their bounded Jev gates and deterministic scope checks.
- Sequential implementation units are also checked against deterministic before/after Git snapshots, so worker-reported file lists are not trusted as scope truth.
- Worker prompts prohibit commit, push, reset, clean, checkout, and history rewriting.
- The factory does not commit or push.
- A clean working tree is required by default.
- Low Jev confidence stops for human intervention.
- Plan-gate `rescout`/`replan` requests run bounded recovery loops before implementation; review-stage `replan` still requires human intervention.
- Deterministic checks are authoritative.
- Final acceptance requires deterministic verification plus independent Astra review plus Jev acceptance.

## Source layout

```text
pi-software-factory/
├── software-factory.ts       # named Pi extension entrypoint
├── package.json              # Pi package manifest
├── CHANGELOG.md
├── README.md
├── software-factory.example.json
├── models.qwen.example.json
└── src/
    ├── agent-runner.ts
    ├── config.ts
    ├── context.ts
    ├── controller.ts
    ├── jev.ts
    ├── prompts.ts
    ├── parallel.ts
    ├── storage.ts
    ├── types.ts
    ├── validate.ts
    └── verification.ts
```


## Transcript UI

v0.7.1 continues the v0.2.2 transcript design and does not use Pi's dock widget. Factory progress is written as custom transcript entries, so it scrolls naturally with the conversation and is not clipped by terminal height. These entries are TUI/session state only and do not enter the LLM context. The currently executing stage is shown in Pi's one-line status bar.

`/factory-status` appends the complete most-recent run summary, stage list, decision history, checkpoint/continuation history, and parallel-batch history to the transcript. While a run is active it also shows every currently active concurrent stage. Completed run state is recovered from persisted session entries after an extension reload.


## Qwen context budget

The implementation and repair workers are checkpointable. With the defaults:

```text
warningTokens:            65000
checkpointTokens:         75000
hardLimitTokens:          88000
maxCheckpointsPerStage:       3
```

At the warning threshold the transcript records context pressure. At the checkpoint threshold the controller queues a checkpoint instruction. The worker either finishes normally with `submit_result`, or emits `submit_checkpoint`. A checkpoint is persisted as `checkpoint-<stage>-<n>.json`, the Pi session is disposed, and a fresh Qwen session resumes from that compact record plus the original implementation contract.

Pi auto-compaction remains enabled as a safety net before the hard limit. It is not the primary continuity mechanism.
