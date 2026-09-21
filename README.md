# Pi Software Factory

A Pi package that runs a controlled software-engineering pipeline using:

- **Jev** for bounded semantic classification and routing
- **GPT-6 Astra** for architecture, planning, and independent review
- **local Qwen3.8-27B** for repository scouting, implementation, and repair
- **deterministic tools** for Git/build/test/typecheck/lint truth

Current version: **0.3.0**

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

## v0.3 changes

v0.3 adds proactive context management to the local Qwen implementation/repair tier while preserving the validated controller/Jev/Astra control flow.

Default policy for the ~98K advertised Qwen context:

```text
65K  warn
75K  request factual checkpoint
88K  hard safety region / Pi auto-compaction fallback
```

When a Qwen implementation or repair session crosses the checkpoint threshold, the controller asks it to emit a compact `WorkerCheckpoint`, persists that artifact, disposes the session, and resumes the same unit in a fresh Qwen session. Repository edits remain on disk; conversation history does not.

Checkpoint artifacts contain:

```text
unitId
summary
completedWork
changedFiles
decisions
verifiedFacts
remainingWork
blockers
relevantSymbols
nextAction
```

The factory records max context usage, Pi compactions, checkpoint requests, and checkpoint artifacts in the normal telemetry/run directory.

v0.3 intentionally leaves autonomous Jev `rescout` / `replan` loops for a later release.

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
git commit -m "Software Factory v0.3.0"

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
git tag v0.3.0
git push origin main --tags
```

Then, for example:

```text
pi install git:github.com/<owner>/pi-software-factory@v0.3.0
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
  "contextBudget": {
    "enabled": true,
    "warningTokens": 65000,
    "checkpointTokens": 75000,
    "hardLimitTokens": 88000,
    "maxCheckpointsPerStage": 3
  },
  "runRoot": ".okf/work",
  "contextPaths": ["AGENTS.md", ".okf/project"],
  "contextMaxBytes": 180000,
  "requireCleanWorkingTree": true,
  "verificationCommands": [
    "npm test",
    "npm run typecheck"
  ],
  "maxRepairPasses": 1,
  "maxDiffCharsForReview": 120000
}
```

For projects where `.pi/software-factory.json` and `.okf/work/` are local-only, add them to `.git/info/exclude` or the repository's `.gitignore` as appropriate.

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
.okf/work/SF-<timestamp>/
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
- Worker prompts prohibit commit, push, reset, clean, checkout, and history rewriting.
- The factory does not commit or push.
- A clean working tree is required by default.
- Low Jev confidence stops for human intervention.
- Plan-gate `rescout`/`replan` requests still stop rather than looping in v0.3.
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
    ├── storage.ts
    ├── types.ts
    ├── validate.ts
    └── verification.ts
```


## Transcript UI

v0.3 continues the v0.2.2 transcript design and does not use Pi's dock widget. Factory progress is written as custom transcript entries, so it scrolls naturally with the conversation and is not clipped by terminal height. These entries are TUI/session state only and do not enter the LLM context. The currently executing stage is shown in Pi's one-line status bar.

`/factory-status` appends the complete most-recent run summary and stage list to the transcript. Completed run state is also recovered from persisted session entries after an extension reload.


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
