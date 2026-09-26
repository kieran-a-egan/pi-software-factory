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
- The factory never commits or pushes for you.
- A clean working tree is required by default.
- Low-confidence Jev decisions stop for human review.
- Planning recovery, worker continuation, repair, and context recovery are bounded by configuration.
- Final acceptance requires deterministic verification, independent Astra review, and Jev acceptance.

## Requirements

- Pi Coding Agent
- Node.js 20+
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
pi install git:github.com/kieran-a-egan/pi-software-factory@v0.7.4
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

## Run artifacts

Each run is stored under:

```text
.pi/software-factory/runs/SF-<timestamp>/
```

Important top-level artifacts include:

```text
state.json
telemetry.json
run-summary.json
decisions.jsonl
```

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

For a local development install:

```powershell
npm install
pi install (Get-Location).Path
```

Then edit, test, commit, and use `/reload` in Pi.

Release-specific changes belong in [CHANGELOG.md](CHANGELOG.md), not in this README.
