# Pi Software Factory

A controlled software-engineering pipeline for Pi Coding Agent.

It combines:

- **Jev** for bounded semantic routing
- **GPT-6 Astra** for architecture and independent review
- **local Qwen** for repository scouting, implementation, and repair
- **deterministic tools** for Git/build/test/typecheck/lint truth

The controller owns the workflow. Models provide evidence and decisions within bounded roles; they do not arbitrarily choose what runs next.

For release history, see [CHANGELOG.md](CHANGELOG.md).

## How it works

```text
/factory <objective>
        │
        ▼
 clean-tree preflight          deterministic
        │
        ▼
 baseline verification         authoritative, no API key
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
 Qwen implementer(s)           isolated/sequential writes
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

### Core control properties

- Deterministic verification is authoritative; semantic gates cannot turn a failing check into a pass.
- Scout, architect, and reviewer are read-only.
- Implementers and repairers may edit files and run shell commands, but prompts prohibit commits, pushes, resets, cleans, checkouts, and history rewriting.
- The factory never commits to your branch or pushes for you. Existing isolated-worker snapshots create temporary Git objects without moving your branch.
- A run-level source journal and exclusive interlock cover baseline checks, sequential writes, parallel integration, and repair. Unaccepted edits are retained for human disposition, never silently rolled back.
- A clean working tree is required by default.
- Before any model call or Jev intake, the configured deterministic checks run against the untouched repository as an authoritative baseline verification. It uses the same commands as later verification but establishes that the repository itself is healthy. A failing baseline check stops the run as blocked before any models run and before repair is ever attempted, and it does not require a `TYPESAFE_API_KEY` or any model to be available.
- Post-implementation verification and repair are unchanged: they run after implementation and remain the gate for the delivered change, while the baseline gate only vets the starting repository.
- Low-confidence Jev decisions stop for human review.
- Planning recovery, worker continuation, repair, and context recovery are bounded by configuration.
- Final acceptance requires deterministic verification, independent Astra review, and Jev acceptance. Normally both configured Jev thresholds must pass. Below-threshold review sufficiency is accepted only when action confidence still passes, residual risk is `low`, Astra's verdict is `clean`, and there are no major/critical findings. Original Jev scores and the selected routing policy are persisted; thresholds and prompts are unchanged.

## Requirements

- Pi Coding Agent
- Node.js 22.20+ (22.x), or 24.12+
- Git
- a TypeSafe API key in `TYPESAFE_API_KEY`
- Astra available through Pi
- a local or remote Qwen model exposed through an OpenAI-compatible provider

The repository defaults target:

```text
Qwen provider:  unsloth-local
Qwen model:     unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M
Qwen endpoint:  http://127.0.0.1:8888/v1
Astra:          openai-codex/gpt-6-astra
```

See [models.qwen.example.json](models.qwen.example.json) for the local-model provider shape.

## Installation

### Install a tagged release

```text
pi install git:github.com/kieran-a-egan/pi-software-factory@v0.7.5
```

Pinned Git refs stay fixed until you explicitly update them.

### Install a local development checkout

Keep the source in a normal development directory rather than under Pi's global extension directory.

PowerShell:

```powershell
cd "$HOME\src\pi-software-factory"
npm install
pi install (Get-Location).Path
```

After editing the checkout, use `/reload` inside Pi.

If you previously copied the extension manually to:

```text
~/.pi/agent/extensions/software-factory/
```

remove or move that copy first so Pi does not load two instances.

## Configuration

Project-specific configuration lives at:

```text
.pi/software-factory.json
```

Start from [software-factory.example.json](software-factory.example.json). The built-in defaults include:

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
  "requireCleanWorkingTree": true,
  "verificationCommands": [],
  "maxRepairPasses": 1,
  "maxWorkerContinuationPasses": 2,
  "workerMaxRuntimeMinutes": 20
}
```

Configure `verificationCommands` for the target repository, for example:

```json
{
  "verificationCommands": [
    "npm test",
    "npm run typecheck"
  ]
}
```

If `.pi/software-factory.json` and `.pi/software-factory/runs/` are local-only for a project, ignore them using `.git/info/exclude` or the project's `.gitignore`.

### TypeSafe / Jev

Set the API key before launching Pi:

```powershell
$env:TYPESAFE_API_KEY = "..."
```

Worker routing dispositions are:

```text
ready | continue | blocked | invalid
```

A `continue` decision starts a fresh Qwen session for the same bounded assignment. It is different from a context-budget checkpoint, which resumes an in-progress worker after context pressure.

## Running the factory

Start a run:

```text
/factory Add organisation-level SSO using Microsoft Entra ID
```

Show the most recent run:

```text
/factory-status
```

The transcript shows stage progress, token usage, wall-clock duration, recovery activity, and concurrent-stage overlap.

## Parallel implementation

The architect declares each implementation unit's dependencies and expected file scope.

The controller may run dependency-ready units concurrently when their declared scopes do not overlap. Each parallel worker runs in its own disposable Git worktree. The primary working tree is updated only after every worker in the batch:

1. completes its bounded assignment,
2. passes its Jev worker gate,
3. stays within its deterministic Git scope, and
4. produces a batch that passes patch preflight.

Independent patches are then integrated together and the normal deterministic verification runs against the primary tree.

Ignored caches such as `node_modules` are intentionally absent from disposable worktrees; authoritative project verification happens after integration.

## Recovery and limits

The factory uses bounded recovery rather than open-ended autonomous loops.

- **Planning recovery:** Jev may request a targeted Qwen rescout or Astra replan.
- **Worker continuation:** Jev may send the same bounded assignment to a fresh Qwen session when concrete work remains.
- **Deterministic repair:** failed verification may trigger a bounded repair pass followed by re-verification.
- **Context checkpoints:** long-running Qwen implementation/repair sessions can persist compact continuation state and resume in a fresh session.
- **Worker watchdog:** implementation and repair sessions are aborted if they exceed the configured runtime limit.

Exhausted limits or low-confidence routing stop at `HUMAN`.

### Source disposition and interrupted runs

Sequential workers and integrated parallel batches still edit the primary working tree. This is **in-place journaling with a human interlock, not automatic rollback or filesystem isolation**. Do not edit the repository concurrently with a run. Git evidence, not worker reports, determines the recorded source disposition:

| Disposition | Meaning |
| --- | --- |
| `active-unaccepted` | Run in progress; no source changes are accepted yet. |
| `accepted-in-place` | Final review accepted and the source still matches authoritative verification. Edits remain uncommitted. |
| `unchanged` | A stopped run left the original source/index state unchanged. |
| `retained-unaccepted` | HUMAN, FAILED, or BLOCKED left changes; all edits remain available for inspection. |
| `unknown-retained` | Capture failed, HEAD changed, source changed after verification, or cancellation/worker failure requires confirmation that writers stopped. Nothing is discarded. |

`source-before.json` and `source-after.json` contain complete Git worktree evidence (including untracked/binary content), staged patches, HEAD, and NUL-delimited status. Runtime paths are excluded. `source-disposition.json`, `state.json`, and the run summary record the disposition. Failed/cancelled parallel workers retain their worktrees; completed worker patches are persisted before cleanup. `parallel-worktree-*.json` records their locations and `parallel-change-*.json` preserves captured patches.

The lock is `pi-software-factory.lock` inside the directory returned by `git rev-parse --absolute-git-dir`. It points to the run artifacts and blocks another factory run even with `requireCleanWorkingTree: false` or a different run root. It is released only after terminal evidence is persisted for accepted or unchanged runs. Process termination or persistence failure leaves the lock in place; there is no automatic stale-lock takeover.

To recover, first confirm that the prior run and its child processes have stopped. Inspect the referenced artifacts, primary source/index, and any retained worktrees. Decide which edits to keep, commit, move, or discard using your own Git workflow; preserve any useful patches first. Only then manually remove that specific lock file. Retained worktrees can likewise be removed with your normal Git worktree workflow after inspection. Removing a lock does **not** approve or restore source, and the factory never commits, resets, or cleans your repository to recover.

## Run artifacts

Each run is stored under:

```text
.pi/software-factory/runs/SF-<timestamp>-<unique suffix>/
```

Important top-level artifacts include:

```text
state.json
telemetry.json
baseline-verification.json
review-routing.json
source-before.json
source-after.json
source-disposition.json
run-summary.json
decisions.jsonl
```

`baseline-verification.json` is written before any model runs. It contains the complete baseline result: the overall `passed` flag, every configured check with its command, exit code, and output, plus `gitStatus`, `diffStat`, and `diff` captured at that point. Baseline success or failure is decided solely by the `passed` result of the deterministic checks; the diagnostic fields (`gitStatus`, `diffStat`, `diff`) are evidence only and do not determine whether the baseline passed.

The run directory also contains stage-specific evidence, plans, worker reports, gates, scope checks, continuation/checkpoint records, verification results, review output, and parallel-batch metadata.

Runtime artifacts are ordinary JSON/JSONL. `.okf/project` remains an optional project-context source; it is not the runtime-state directory.

## Repository layout

```text
pi-software-factory/
├── software-factory.ts
├── package.json
├── README.md
├── CHANGELOG.md
├── software-factory.example.json
├── models.qwen.example.json
└── src/
    ├── agent-runner.ts
    ├── config.ts
    ├── context.ts
    ├── controller.ts
    ├── jev.ts
    ├── parallel.ts
    ├── prompts.ts
    ├── storage.ts
    ├── types.ts
    ├── validate.ts
    └── verification.ts
```

## Development

Use normal Git workflow in the source checkout. The package entry point is `software-factory.ts`.

### Developer verification

Requires Node.js 22.20+ (22.x), or 24.12+, and npm. These minimums match the locked Pi SDK/native dependencies; Node 20 is no longer supported.

```powershell
npm ci
npm test
npm run typecheck
```

- `npm ci` installs the exact dependency tree from `package-lock.json`.
- `npm test` runs the regression suite with Vitest in non-watch mode. Tests are deterministic and offline after installation: pure routing/orchestration helpers, scripted agent sessions, and real Git/controller integration in disposable temporary repositories. They do not call models or the network.
- `npm run typecheck` runs `tsc --noEmit` over the extension entry point, all application sources, test files, and the test configuration without emitting build artifacts.
- GitHub Actions runs these commands after `npm ci` on Windows and Linux, with Node 22.20.0 and 24.12.0.

For a local development install:

```powershell
npm install
pi install (Get-Location).Path
```

Then edit, test, commit, and use `/reload` in Pi.

Release-specific changes belong in [CHANGELOG.md](CHANGELOG.md), not in this README.
