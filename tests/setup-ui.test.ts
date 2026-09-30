import { describe, expect, it } from "vitest";
import { MODEL_ROLES, THINKING_LEVELS } from "../src/config.js";
import type { AvailableModel } from "../src/setup.js";
import { collectModelRoles } from "../src/setup-ui.js";
import type { SetupSelector } from "../src/setup-ui.js";
import type { ModelRoles } from "../src/types.js";

/**
 * Scripted in-memory double for the narrow SetupSelector seam. Every
 * prompt's title and a copy of its offered options are recorded; each
 * script step resolves against the options actually offered at call time,
 * so fixture selections are resolved through the live option list rather
 * than by parsing identity from label text.
 */
type ScriptStep =
  | ((options: string[]) => string | undefined)
  | { pick: number }
  | { respond: string }
  | { cancel: true };

interface RecordedPrompt {
  title: string;
  options: string[];
}

function scriptedSelector(script: ScriptStep[], mutateOptions = false) {
  const prompts: RecordedPrompt[] = [];
  let stepIndex = 0;
  const selector: SetupSelector = {
    select(title, options) {
      prompts.push({ title, options: [...options] });
      const step = script[stepIndex] ?? { cancel: true };
      stepIndex += 1;
      if (mutateOptions) options.push("junk");
      if (typeof step === "function") return Promise.resolve(step(options));
      if ("pick" in step) return Promise.resolve(options[step.pick - 1]);
      if ("respond" in step) return Promise.resolve(step.respond);
      return Promise.resolve(undefined);
    },
  };
  return { selector, prompts };
}

/** One-based pick indices for a model-then-thinking success run. */
function successScript(modelPicks: number[], thinkingPicks: number[]): ScriptStep[] {
  const script: ScriptStep[] = [];
  MODEL_ROLES.forEach((_, i) => {
    script.push({ pick: modelPicks[i] }, { pick: thinkingPicks[i] });
  });
  return script;
}

/** Presentation contract: position prefix, provider/model pair, optional name. */
function expectedLabel(index: number, entry: AvailableModel): string {
  const base = `${index + 1}. ${entry.provider}/${entry.model}`;
  return entry.name !== undefined && entry.name !== "" ? `${base} ${entry.name}` : base;
}

/** Presentation contract without the position prefix: identity pair, optional name. */
function unnumberedLabel(entry: AvailableModel): string {
  const base = `${entry.provider}/${entry.model}`;
  return entry.name !== undefined && entry.name !== "" ? `${base} ${entry.name}` : base;
}

function baseSnapshot(): AvailableModel[] {
  return [
    { provider: "prov-scout", model: "model-scout", name: "Scout Model" },
    { provider: "prov-arch", model: "model-arch" },
    { provider: "prov-impl", model: "model-impl", name: "Impl Model" },
    { provider: "prov-review", model: "model-review" },
    { provider: "prov-repair", model: "model-repair" },
  ];
}

function fiveRoleKeys(): string[] {
  return [...MODEL_ROLES].sort();
}

describe("collectModelRoles prompt contract", () => {
  it("prompts the five canonical roles in order, model then thinking, with exactly ten calls", async () => {
    const snapshot = baseSnapshot();
    const { selector, prompts } = scriptedSelector(successScript([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]));
    const result = await collectModelRoles(selector, snapshot);
    expect(result).toBeDefined();
    expect(prompts).toHaveLength(10);
    MODEL_ROLES.forEach((role, i) => {
      expect(prompts[2 * i].title).toBe(`Select model for ${role}`);
      expect(prompts[2 * i + 1].title).toBe(`Select thinking level for ${role}`);
    });
  });

  it("offers the snapshot labels in order on every model prompt and all seven canonical thinking levels on every thinking prompt", async () => {
    const snapshot = baseSnapshot();
    const { selector, prompts } = scriptedSelector(successScript([1, 2, 3, 4, 5], [2, 4, 6, 7, 3]));
    const result = await collectModelRoles(selector, snapshot);
    expect(result).toBeDefined();
    const modelOptions = snapshot.map((entry, i) => expectedLabel(i, entry));
    for (let i = 0; i < MODEL_ROLES.length; i++) {
      expect(prompts[2 * i].options).toEqual(modelOptions);
      expect(prompts[2 * i + 1].options).toEqual([...THINKING_LEVELS]);
    }
  });

  it("passes a fresh option array on every prompt and never exposes the canonical arrays to mutation", async () => {
    const snapshot = baseSnapshot();
    const before = structuredClone(snapshot);
    const { selector, prompts } = scriptedSelector(successScript([2, 3, 4, 5, 1], [5, 6, 7, 1, 2]), true);
    const result = await collectModelRoles(selector, snapshot);
    expect(result).toBeDefined();
    expect(prompts).toHaveLength(10);
    // The double pushed "junk" into every received options array; none of
    // the recorded copies (taken before mutation) carries it, and every
    // prompt received a distinct array object.
    for (const prompt of prompts) {
      expect(prompt.options).not.toContain("junk");
    }
    expect(new Set(prompts.map((prompt) => prompt.options)).size).toBe(10);
    expect(MODEL_ROLES).toEqual(["scout", "architect", "implementer", "reviewer", "repairer"]);
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(snapshot).toEqual(before);
  });
});

describe("collectModelRoles selection and identity", () => {
  it("returns exactly the five roles with exact verbatim identities and per-role thinking", async () => {
    const snapshot: AvailableModel[] = [
      { provider: " prov one ", model: "model/one:2  " },
      { provider: "prov-two", model: "model-two", name: "Two" },
      { provider: "prov-three", model: "model/three" },
      { provider: "prov-four", model: "model-four" },
      { provider: "prov-five", model: "model five" },
    ];
    const { selector } = scriptedSelector(successScript([2, 4, 1, 5, 3], [3, 5, 1, 7, 6]));
    const roles = await collectModelRoles(selector, snapshot);
    expect(roles).toBeDefined();
    expect(roles!).toEqual({
      scout: { provider: "prov-two", model: "model-two", thinking: "low" },
      architect: { provider: "prov-four", model: "model-four", thinking: "high" },
      implementer: { provider: " prov one ", model: "model/one:2  ", thinking: "off" },
      reviewer: { provider: "prov-five", model: "model five", thinking: "max" },
      repairer: { provider: "prov-three", model: "model/three", thinking: "xhigh" },
    });
    expect(Object.keys(roles!).sort()).toEqual(fiveRoleKeys());
    for (const role of MODEL_ROLES) {
      expect(Object.keys(roles![role]).sort()).toEqual(["model", "provider", "thinking"]);
    }
  });

  it("selects duplicate model ids under different providers independently", async () => {
    const snapshot: AvailableModel[] = [
      { provider: "prov-x", model: "shared-id", name: "Shared X" },
      { provider: "prov-y", model: "shared-id", name: "Shared Y" },
      { provider: "prov-a", model: "model-a" },
      { provider: "prov-b", model: "model-b" },
      { provider: "prov-c", model: "model-c" },
    ];
    const labels = snapshot.map((entry, i) => expectedLabel(i, entry));
    const { selector } = scriptedSelector([
      (options) => options.find((option) => option === labels[0]),
      { pick: 1 },
      (options) => options.find((option) => option === labels[1]),
      { pick: 2 },
      { pick: 3 },
      { pick: 3 },
      { pick: 4 },
      { pick: 4 },
      { pick: 5 },
      { pick: 5 },
    ]);
    const roles = await collectModelRoles(selector, snapshot);
    expect(roles).toBeDefined();
    expect(roles!.scout).toEqual({ provider: "prov-x", model: "shared-id", thinking: "off" });
    expect(roles!.architect).toEqual({ provider: "prov-y", model: "shared-id", thinking: "minimal" });
  });
});

describe("collectModelRoles collisions and display names", () => {
  it("maps colliding unnumbered presentation text, including delimiter-ambiguous pairs, to the intended entries", async () => {
    const snapshot: AvailableModel[] = [
      { provider: "prov", model: "a/b", name: "Slash" },
      { provider: "prov/a", model: "b", name: "Slash" },
      { provider: "prov-x", model: "shared-id", name: "Shared" },
      { provider: "prov-y", model: "shared-id", name: "Shared" },
      { provider: "prov-d", model: "model-d", name: "Dup" },
      { provider: "prov-d", model: "model-d", name: "Dup" },
      { provider: "prov-z", model: "model-z" },
    ];
    // The complete unnumbered presentation text (identity pair plus display
    // name) is not unique here: "prov/a/b Slash" appears twice (delimiter
    // ambiguity with the same display name) and "prov-d/model-d Dup" appears
    // twice (full duplicate with the same display name).
    const unnumbered = snapshot.map(unnumberedLabel);
    expect(new Set(unnumbered).size).toBeLessThan(snapshot.length);
    expect(unnumbered[0]).toBe(unnumbered[1]);
    expect(unnumbered[4]).toBe(unnumbered[5]);

    const labels = snapshot.map((entry, i) => expectedLabel(i, entry));
    const { selector, prompts } = scriptedSelector([
      (options) => options.find((option) => option === labels[0]),
      { pick: 2 },
      (options) => options.find((option) => option === labels[1]),
      { pick: 3 },
      (options) => options.find((option) => option === labels[4]),
      { pick: 4 },
      (options) => options.find((option) => option === labels[5]),
      { pick: 5 },
      (options) => options.find((option) => option === labels[3]),
      { pick: 6 },
    ]);
    const roles = await collectModelRoles(selector, snapshot);
    expect(roles).toBeDefined();

    // The position prefix keeps every offered option unique and in
    // snapshot order, even where the unnumbered text collides.
    expect(prompts[0].options).toEqual(labels);
    expect(new Set(prompts[0].options).size).toBe(labels.length);

    // Each colliding option resolves to the intended entry, with identity
    // copied verbatim.
    expect(roles!.scout).toEqual({ provider: "prov", model: "a/b", thinking: "minimal" });
    expect(roles!.architect).toEqual({ provider: "prov/a", model: "b", thinking: "low" });
    expect(roles!.implementer).toEqual({ provider: "prov-d", model: "model-d", thinking: "medium" });
    expect(roles!.reviewer).toEqual({ provider: "prov-d", model: "model-d", thinking: "high" });
    expect(roles!.repairer).toEqual({ provider: "prov-y", model: "shared-id", thinking: "xhigh" });
  });

  it("never lets display names enter the result", async () => {
    const snapshot: AvailableModel[] = [
      { provider: "prov-a", model: "model-a", name: "Alpha Name" },
      { provider: "prov-b", model: "model-b", name: "Beta Name" },
      { provider: "prov-c", model: "model-c", name: "Gamma Name" },
      { provider: "prov-d", model: "model-d", name: "Delta Name" },
      { provider: "prov-e", model: "model-e", name: "Epsilon Name" },
    ];
    const { selector } = scriptedSelector(successScript([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]));
    const roles = await collectModelRoles(selector, snapshot);
    expect(roles).toBeDefined();
    const serialized = JSON.stringify(roles!);
    for (const name of ["Alpha Name", "Beta Name", "Gamma Name", "Delta Name", "Epsilon Name"]) {
      expect(serialized).not.toContain(name);
    }
    for (const role of MODEL_ROLES) {
      expect(Object.keys(roles![role]).sort()).toEqual(["model", "provider", "thinking"]);
    }
  });
});

describe("collectModelRoles cancellation", () => {
  it("returns undefined and stops prompting at every one of the ten prompt positions", async () => {
    const snapshot = baseSnapshot();
    for (let position = 1; position <= 10; position++) {
      const script: ScriptStep[] = [];
      for (let i = 1; i < position; i++) {
        script.push(i % 2 === 1 ? { pick: 1 } : { pick: 2 });
      }
      script.push({ cancel: true });
      const { selector, prompts } = scriptedSelector(script);
      const result = await collectModelRoles(selector, snapshot);
      // Positions 1 (first model prompt), 7 (a later model prompt), and 8
      // and 10 (thinking prompts) are all covered by this sweep, as are
      // every other model and thinking prompt.
      expect(result, `position ${position}`).toBeUndefined();
      expect(prompts, `position ${position}`).toHaveLength(position);
    }
  });
});

describe("collectModelRoles unexpected responses", () => {
  it("throws a descriptive error on an unexpected model response and stops prompting", async () => {
    const snapshot = baseSnapshot();
    const { selector, prompts } = scriptedSelector([{ respond: "ghost/model" }]);
    await expect(collectModelRoles(selector, snapshot)).rejects.toThrow(
      /Unexpected model selection for scout: "ghost\/model"/,
    );
    expect(prompts).toHaveLength(1);
  });

  it("throws a descriptive error on an unexpected thinking response and stops prompting", async () => {
    const snapshot = baseSnapshot();
    const { selector, prompts } = scriptedSelector([{ pick: 1 }, { respond: "ultra" }]);
    await expect(collectModelRoles(selector, snapshot)).rejects.toThrow(
      /Unexpected thinking level for scout: "ultra"/,
    );
    expect(prompts).toHaveLength(2);
  });

  it("rejects an empty-string response on both prompt kinds", async () => {
    const snapshot = baseSnapshot();
    const modelGhost = scriptedSelector([{ respond: "" }]);
    await expect(collectModelRoles(modelGhost.selector, snapshot)).rejects.toThrow(
      /Unexpected model selection for scout/,
    );
    const thinkingGhost = scriptedSelector([{ pick: 1 }, { respond: "" }]);
    await expect(collectModelRoles(thinkingGhost.selector, snapshot)).rejects.toThrow(
      /Unexpected thinking level for scout/,
    );
  });

  it("leaves the canonical arrays and the supplied snapshot unchanged after a failure", async () => {
    const snapshot = baseSnapshot();
    const before = structuredClone(snapshot);
    const { selector } = scriptedSelector([{ pick: 1 }, { pick: 2 }, { respond: "nope" }]);
    await expect(collectModelRoles(selector, snapshot)).rejects.toThrow(
      /Unexpected model selection for architect/,
    );
    expect(MODEL_ROLES).toEqual(["scout", "architect", "implementer", "reviewer", "repairer"]);
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(snapshot).toEqual(before);
  });
});
