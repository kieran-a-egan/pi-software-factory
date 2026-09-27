import { describe, expect, it } from "vitest";
import {
  checkpointContinuationPrompt,
  implementerPrompt,
  workerContinuationPrompt,
} from "../src/prompts.js";
import { selectImplementationEvidence } from "../src/implementation-evidence.js";
import type { ImplementationUnit, ScoutResult } from "../src/types.js";

// Fixtures use deliberately distinct paths so that legitimate retention
// (recommendedReads, otherUnits ownership) can never be mistaken for a leak
// of filtered structured evidence:
//  - in-scope evidence:   src/prompts.ts (file + symbol)
//  - unrelated evidence:  src/unrelated.ts (file), src/legacy.ts (symbol)
//  - retained read ctx:   docs/design-notes.md (recommendedReads)
//  - other-unit ownership:src/controller.ts (otherUnits filesExpected)
function fixtureScout(): ScoutResult {
  return {
    summary: "Factory prompt pipeline summary",
    files: [
      { path: "src/prompts.ts", relevance: "prompt builders under test" },
      { path: "src/parallel.ts", relevance: "path helpers" },
      { path: "src/unrelated.ts", relevance: "unrelated runtime" },
    ],
    symbols: [
      { name: "implementerPrompt", path: "src/prompts.ts", relevance: "entry point" },
      { name: "legacyHelper", path: "src/legacy.ts", relevance: "unrelated helper" },
    ],
    relationships: ["prompts are shared across controller and repair stages"],
    constraints: ["evidence is read context only"],
    tests: ["vitest run"],
    unknowns: ["whether repair prompts need the same handoff"],
    recommendedReads: ["docs/design-notes.md"],
  };
}

function fixtureUnit(): ImplementationUnit {
  return {
    id: "guide-implementation-evidence-use",
    objective: "Teach implementation workers to use the scout evidence handoff.",
    filesExpected: ["src/prompts.ts"],
    acceptance: ["instructions reference the evidence handoff"],
    constraints: ["keep prompt structure additive"],
  };
}

function fixtureInput() {
  const unit = fixtureUnit();
  return {
    executionMode: "primary-sequential" as const,
    projectContext: "project-context-token-alpha",
    architectureSummary: "architecture-summary-token-beta",
    architecturalDecisions: ["architectural-decision-token-gamma"],
    currentUnit: unit,
    otherUnits: [
      {
        id: "wire-worker-evidence-handoff",
        objective: "Wire controller handoff",
        filesExpected: ["src/controller.ts"],
        relation: "deferred",
      },
    ],
    repositoryEvidence: selectImplementationEvidence(fixtureScout(), unit),
  };
}

function extractEmbeddedInput(prompt: string): unknown {
  const marker = "Execute ONLY the currentUnit in this factory input:\n";
  const start = prompt.indexOf(marker);
  expect(start).toBe(0);
  const jsonStart = start + marker.length;
  const jsonEnd = prompt.indexOf("\n\n", jsonStart);
  expect(jsonEnd).toBeGreaterThan(jsonStart);
  return JSON.parse(prompt.slice(jsonStart, jsonEnd));
}

describe("implementerPrompt repositoryEvidence handoff", () => {
  it("serializes the helper-selected repositoryEvidence with unchanged payload fields", () => {
    const input = fixtureInput();
    const prompt = implementerPrompt(input);

    expect(extractEmbeddedInput(prompt)).toEqual(input);
    expect(prompt).toContain("project-context-token-alpha");
    expect(prompt).toContain("architecture-summary-token-beta");
    expect(prompt).toContain("architectural-decision-token-gamma");
    expect(prompt).toContain('"executionMode": "primary-sequential"');
    expect(prompt).toContain('"guide-implementation-evidence-use"');
    // Compact otherUnits ownership fields are serialized unchanged.
    expect(prompt).toContain("wire-worker-evidence-handoff");
    expect(prompt).toContain("src/controller.ts");
  });

  it("includes selected file and symbol evidence but no unrelated structured evidence", () => {
    const prompt = implementerPrompt(fixtureInput());

    // Selected (in-scope) structured evidence is present.
    expect(prompt).toContain("src/prompts.ts");
    expect(prompt).toContain("prompt builders under test");
    expect(prompt).toContain("implementerPrompt");
    // Unrelated structured evidence is absent: these paths/names appear
    // nowhere else in the fixture, so any occurrence would be a leak.
    expect(prompt).not.toContain("src/unrelated.ts");
    expect(prompt).not.toContain("unrelated runtime");
    expect(prompt).not.toContain("src/legacy.ts");
    expect(prompt).not.toContain("legacyHelper");
    // Legitimate retention is present and must not be mistaken for a leak.
    expect(prompt).toContain("docs/design-notes.md");
  });

  it("teaches evidence use: starting map, authoritative repository state, direct dependencies", () => {
    const prompt = implementerPrompt(fixtureInput());

    expect(prompt).toContain("repositoryEvidence");
    expect(prompt).toMatch(/avoid repeating broad repository discovery/);
    expect(prompt).toMatch(/inspect the current files before relying on it/);
    expect(prompt).toMatch(/current repository state is authoritative/);
    expect(prompt).toMatch(/direct dependencies needed for the assigned unit/);
  });

  it("prohibits treating evidence as authorization to edit outside filesExpected, and retains existing boundary guidance", () => {
    const prompt = implementerPrompt(fixtureInput());

    expect(prompt).toMatch(/never authorize editing outside currentUnit\.filesExpected/);
    expect(prompt).toMatch(/never expand the unit's scope/);
    expect(prompt).toMatch(/never assign work from other units/);
    // Existing boundaries and isolated-worktree guidance remain intact.
    expect(prompt).toContain(
      "The overall feature has already been decomposed by the architect. otherUnits are explicitly outside this worker's scope. Do not perform their work early.",
    );
    expect(prompt).toContain(
      'If executionMode is "isolated-parallel-worktree", do not install missing dependencies or treat absent ignored caches as a product blocker.',
    );
  });

  it("emits no evidence guidance when the payload has no repositoryEvidence field", () => {
    const input = fixtureInput();
    const { repositoryEvidence: _omitted, ...withoutEvidence } = input;
    const prompt = implementerPrompt(withoutEvidence);

    expect(extractEmbeddedInput(prompt)).toEqual(withoutEvidence);
    expect(prompt).not.toContain("repositoryEvidence");
    // Output report contract is unchanged.
    expect(prompt).toContain('"testsRun": [{"command": string, "result": string}]');
    expect(prompt).toContain('If there is no blocker or remaining work within this unit, submit empty arrays.');
  });

  it("is deterministic for the same payload", () => {
    expect(implementerPrompt(fixtureInput())).toBe(implementerPrompt(fixtureInput()));
  });
});

describe("continuation wrappers preserve the evidence-bearing base prompt", () => {
  it("checkpointContinuationPrompt appends to the identical base prompt verbatim", () => {
    const basePrompt = implementerPrompt(fixtureInput());
    const checkpoint = {
      unitId: "guide-implementation-evidence-use",
      nextAction: "finish prompt tests",
      remainingWork: ["run focused vitest file"],
    };

    const wrapped = checkpointContinuationPrompt(basePrompt, checkpoint);

    // The base prompt (evidence JSON and guidance included) appears verbatim
    // exactly once, at the start, followed by the unchanged wrapper.
    expect(wrapped.startsWith(basePrompt)).toBe(true);
    expect(wrapped.indexOf(basePrompt)).toBe(0);
    expect(wrapped.indexOf(basePrompt, basePrompt.length)).toBe(-1);
    expect(wrapped).toContain(
      "\n\n--- FACTORY CONTINUATION ---\nThis is a fresh Qwen worker session resumed from a context-budget checkpoint.",
    );
    expect(wrapped).toContain(JSON.stringify(checkpoint, null, 2));
    expect(wrapped).toContain("Resume from checkpoint.nextAction and remainingWork.");
  });

  it("workerContinuationPrompt appends to the identical base prompt verbatim", () => {
    const basePrompt = implementerPrompt(fixtureInput());
    const previousReport = { unitId: "guide-implementation-evidence-use", summary: "partial", changedFiles: ["src/prompts.ts"], testsRun: [], decisions: [], blockers: [], remainingWork: ["add tests"], notes: [] };
    const gate = { disposition: "continue", confidence: 0.7, raw: null };

    const wrapped = workerContinuationPrompt({
      basePrompt,
      previousReport,
      gate,
      pass: 2,
    });

    expect(wrapped.startsWith(basePrompt)).toBe(true);
    expect(wrapped.indexOf(basePrompt)).toBe(0);
    expect(wrapped.indexOf(basePrompt, basePrompt.length)).toBe(-1);
    expect(wrapped).toContain("\n\n--- JEV WORKER CONTINUATION ---");
    expect(wrapped).toContain("continuation pass 2");
    expect(wrapped).toContain(JSON.stringify(previousReport, null, 2));
    expect(wrapped).toContain(JSON.stringify(gate, null, 2));
    expect(wrapped).toContain(
      "Do not redo completed work, broaden scope, or perform work assigned to other implementation units.",
    );
  });
});
