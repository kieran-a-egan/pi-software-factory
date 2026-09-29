import { describe, expect, it } from "vitest";
import { THINKING_LEVELS } from "../src/config.js";
import { normalizeAvailableModels, validateModelRoles } from "../src/setup.js";
import type { AvailableModel } from "../src/setup.js";
import type { ModelRoles } from "../src/types.js";

const ROLES = ["scout", "architect", "implementer", "reviewer", "repairer"] as const;

function registryEntry(provider: string, id: string, name?: string): Record<string, unknown> {
  const entry: Record<string, unknown> = { provider, id };
  if (name !== undefined) entry.name = name;
  return entry;
}

function snapshotOf(pairs: Array<[string, string, string?]>): AvailableModel[] {
  return normalizeAvailableModels(pairs.map(([provider, id, name]) => registryEntry(provider, id, name)));
}

function validSelection(snapshot: AvailableModel[]): Record<string, unknown> {
  const selection: Record<string, unknown> = {};
  ROLES.forEach((role, i) => {
    selection[role] = {
      provider: snapshot[i].provider,
      model: snapshot[i].model,
      thinking: "medium",
    };
  });
  return selection;
}

function refOf(selection: Record<string, unknown>, role: string): Record<string, unknown> {
  return selection[role] as Record<string, unknown>;
}

describe("normalizeAvailableModels", () => {
  it("maps registry entries to exact provider/model identities with optional name metadata", () => {
    const models = normalizeAvailableModels([
      registryEntry("prov-a", "model-x", "Model X"),
      registryEntry("prov-b", "model-x"),
    ]);
    expect(models[0]).toEqual({ provider: "prov-a", model: "model-x", name: "Model X" });
    expect(models[1]).toEqual({ provider: "prov-b", model: "model-x" });
    expect(models[1]).not.toHaveProperty("name");
  });

  it("returns independent objects and never mutates the input entries", () => {
    const input = [registryEntry("prov-a", "model-x", "Model X")];
    const models = normalizeAvailableModels(input);
    expect(models[0]).not.toBe(input[0]);
    models[0].provider = "mutated";
    models[0].model = "mutated";
    models[0].name = "mutated";
    expect(input[0]).toEqual({ provider: "prov-a", id: "model-x", name: "Model X" });
  });

  it("preserves mixed case, punctuation, and surrounding whitespace exactly", () => {
    const models = normalizeAvailableModels([
      registryEntry("Prov Mixed.Case-1", "  spaced: id /with-slashes  ", "  spaced name  "),
    ]);
    expect(models[0]).toEqual({
      provider: "Prov Mixed.Case-1",
      model: "  spaced: id /with-slashes  ",
      name: "  spaced name  ",
    });
  });

  it("accepts arbitrary entries without a hardcoded catalogue", () => {
    const models = normalizeAvailableModels([registryEntry("brand-new-provider", "brand/new:model:v1")]);
    expect(models[0].provider).toBe("brand-new-provider");
    expect(models[0].model).toBe("brand/new:model:v1");
  });

  it("keeps duplicate ids under different providers as distinct entries", () => {
    const models = normalizeAvailableModels([
      registryEntry("prov-x", "shared-id", "Shared X"),
      registryEntry("prov-y", "shared-id", "Shared Y"),
    ]);
    expect(models).toHaveLength(2);
    expect(models[0]).not.toEqual(models[1]);
  });

  it("tolerates extra registry fields and returns an empty array for an empty registry", () => {
    const models = normalizeAvailableModels([
      { provider: "p", id: "m", reasoning: true, contextWindow: 128_000, cost: { input: 0 } },
    ]);
    expect(models[0]).toEqual({ provider: "p", model: "m" });
    expect(normalizeAvailableModels([])).toEqual([]);
  });

  it("fails closed on non-array input", () => {
    expect(() => normalizeAvailableModels(null)).toThrow(/expected an array/);
    expect(() => normalizeAvailableModels({ provider: "a", id: "b" })).toThrow(/expected an array/);
    expect(() => normalizeAvailableModels("registry")).toThrow(/expected an array/);
    expect(() => normalizeAvailableModels(42)).toThrow(/expected an array/);
  });

  it("fails closed on malformed entries", () => {
    expect(() => normalizeAvailableModels(["nope"])).toThrow(/entry 0/);
    expect(() => normalizeAvailableModels([null])).toThrow(/entry 0/);
    expect(() => normalizeAvailableModels([42])).toThrow(/entry 0/);
    expect(() => normalizeAvailableModels([{}, registryEntry("a", "b")])).toThrow(/entry 0\.provider/);
    expect(() => normalizeAvailableModels([registryEntry("a", "b"), { provider: "p" }])).toThrow(/entry 1\.id/);
    expect(() => normalizeAvailableModels([registryEntry("a", "b"), { provider: "p", id: "" }])).toThrow(/entry 1\.id/);
    expect(() => normalizeAvailableModels([registryEntry("a", "b"), { provider: "p", id: "   " }])).toThrow(/entry 1\.id/);
    expect(() => normalizeAvailableModels([{ provider: "", id: "m" }])).toThrow(/entry 0\.provider/);
    expect(() => normalizeAvailableModels([{ provider: "   ", id: "m" }])).toThrow(/entry 0\.provider/);
    expect(() => normalizeAvailableModels([{ provider: 1, id: "m" }])).toThrow(/entry 0\.provider/);
    expect(() => normalizeAvailableModels([{ provider: "p", id: null }])).toThrow(/entry 0\.id/);
  });

  it("fails closed on non-string names", () => {
    expect(() => normalizeAvailableModels([{ provider: "p", id: "m", name: 42 }])).toThrow(/entry 0\.name/);
    expect(() => normalizeAvailableModels([{ provider: "p", id: "m", name: true }])).toThrow(/entry 0\.name/);
  });
});

describe("validateModelRoles", () => {
  const snapshot = snapshotOf([
    ["unsloth-local", "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M", "Qwen3.8 27B Local"],
    ["openai-codex", "gpt-6-astra", "GPT-6 Astra"],
    ["anthropic", "claude-opus-4", "Claude Opus 4"],
    ["prov-x", "shared-id", "Shared X"],
    ["prov-y", "shared-id", "Shared Y"],
    ["  spaced-provider  ", "  spaced-id  ", "  spaced-name  "],
  ]);

  it("returns exactly the selected identities and per-role thinking as fresh ModelRefs", () => {
    const selection = validSelection(snapshot);
    const roles = validateModelRoles(selection, snapshot);
    expect(roles).toEqual({
      scout: { provider: snapshot[0].provider, model: snapshot[0].model, thinking: "medium" },
      architect: { provider: snapshot[1].provider, model: snapshot[1].model, thinking: "medium" },
      implementer: { provider: snapshot[2].provider, model: snapshot[2].model, thinking: "medium" },
      reviewer: { provider: snapshot[3].provider, model: snapshot[3].model, thinking: "medium" },
      repairer: { provider: snapshot[4].provider, model: snapshot[4].model, thinking: "medium" },
    });
    for (const role of ROLES) {
      expect(Object.keys(roles[role]).sort()).toEqual(["model", "provider", "thinking"]);
      expect(roles[role]).not.toBe(selection[role]);
    }
  });

  it("does not mutate the selection or the snapshot", () => {
    const selection = validSelection(snapshot);
    const selectionBefore = structuredClone(selection);
    const snapshotBefore = structuredClone(snapshot);
    const roles = validateModelRoles(selection, snapshot);
    expect(selection).toEqual(selectionBefore);
    expect(snapshot).toEqual(snapshotBefore);
    roles.scout.thinking = "max";
    expect(refOf(selection, "scout").thinking).toBe("medium");
  });

  it("accepts every canonical thinking level per role", () => {
    for (const level of THINKING_LEVELS) {
      const selection = validSelection(snapshot);
      selection.scout = { ...refOf(selection, "scout"), thinking: level };
      const roles = validateModelRoles(selection, snapshot);
      expect(roles.scout.thinking).toBe(level);
    }
  });

  it("requires all five roles as own properties and rejects unknown roles", () => {
    const missing = validSelection(snapshot);
    delete missing.repairer;
    expect(() => validateModelRoles(missing, snapshot)).toThrow(/missing role "repairer"/);
    const extra = validSelection(snapshot);
    extra.custom = { provider: "p", model: "m", thinking: "low" };
    expect(() => validateModelRoles(extra, snapshot)).toThrow(/unknown role "custom"/);
  });

  it("rejects unknown fields inside a role entry", () => {
    const selection = validSelection(snapshot);
    refOf(selection, "scout").alias = "scout";
    expect(() => validateModelRoles(selection, snapshot)).toThrow(/scout\.alias: unknown field/);
  });

  it("rejects invalid selection containers", () => {
    expect(() => validateModelRoles(null, snapshot)).toThrow(/expected an object/);
    expect(() => validateModelRoles("scout", snapshot)).toThrow(/expected an object/);
    expect(() => validateModelRoles(42, snapshot)).toThrow(/expected an object/);
    expect(() => validateModelRoles(true, snapshot)).toThrow(/expected an object/);
    expect(() => validateModelRoles([{}], snapshot)).toThrow(/expected an object/);
  });

  it("rejects invalid role containers", () => {
    for (const bad of [null, "ref", 7, [], true]) {
      const selection = validSelection(snapshot);
      selection.architect = bad;
      expect(() => validateModelRoles(selection, snapshot)).toThrow(
        /architect: expected an object/,
      );
    }
  });

  it("rejects blank or non-string provider and model identities", () => {
    for (const bad of ["", "   ", 42, null]) {
      const byProvider = validSelection(snapshot);
      refOf(byProvider, "scout").provider = bad;
      expect(() => validateModelRoles(byProvider, snapshot)).toThrow(
        /scout\.provider: expected a nonblank string/,
      );
      const byModel = validSelection(snapshot);
      refOf(byModel, "scout").model = bad;
      expect(() => validateModelRoles(byModel, snapshot)).toThrow(
        /scout\.model: expected a nonblank string/,
      );
    }
  });

  it("requires own properties for each ModelRef field and rejects inherited values", () => {
    const proto = {
      provider: snapshot[0].provider,
      model: snapshot[0].model,
      thinking: "low",
    };
    for (const key of ["provider", "model", "thinking"] as const) {
      const selection = validSelection(snapshot);
      const inherited: Record<string, unknown> = Object.create(proto);
      for (const field of ["provider", "model", "thinking"] as const) {
        if (field !== key) inherited[field] = proto[field];
      }
      selection.scout = inherited;
      expect(() => validateModelRoles(selection, snapshot)).toThrow(
        new RegExp(`scout\\.${key}: missing field`),
      );
    }

    // A role entry with no own properties at all, even with a fully populated
    // prototype chain, is rejected on the first field.
    const whole = validSelection(snapshot);
    whole.architect = Object.create({
      provider: snapshot[1].provider,
      model: snapshot[1].model,
      thinking: "high",
    });
    expect(() => validateModelRoles(whole, snapshot)).toThrow(
      /architect\.provider: missing field/,
    );
  });

  it("rejects missing or invalid thinking values", () => {
    const missing = validSelection(snapshot);
    delete refOf(missing, "scout").thinking;
    expect(() => validateModelRoles(missing, snapshot)).toThrow(/scout\.thinking: missing field/);
    for (const bad of ["ultra", "OFF", "medium ", 5, null, true]) {
      const selection = validSelection(snapshot);
      refOf(selection, "scout").thinking = bad;
      expect(() => validateModelRoles(selection, snapshot)).toThrow(
        /scout\.thinking: expected one of/,
      );
    }
  });

  it("rejects pairs outside the supplied snapshot", () => {
    const unknownProvider = validSelection(snapshot);
    refOf(unknownProvider, "scout").provider = "ghost-provider";
    expect(() => validateModelRoles(unknownProvider, snapshot)).toThrow(
      /not in the available model snapshot/,
    );

    const unknownModel = validSelection(snapshot);
    refOf(unknownModel, "scout").model = "unsloth/Qwen9-99B";
    expect(() => validateModelRoles(unknownModel, snapshot)).toThrow(
      /not in the available model snapshot/,
    );

    // Cross-provider confusion: shared-id exists under prov-x and prov-y only,
    // never under openai-codex.
    const crossed = validSelection(snapshot);
    refOf(crossed, "reviewer").provider = "openai-codex";
    expect(() => validateModelRoles(crossed, snapshot)).toThrow(
      /not in the available model snapshot/,
    );
  });

  it("distinguishes identical model ids under different providers", () => {
    const selection = validSelection(snapshot);
    const roles = validateModelRoles(selection, snapshot);
    expect(roles.reviewer).toEqual({ provider: "prov-x", model: "shared-id", thinking: "medium" });
    expect(roles.repairer).toEqual({ provider: "prov-y", model: "shared-id", thinking: "medium" });

    const swapped = validSelection(snapshot);
    swapped.reviewer = { provider: "prov-y", model: "shared-id", thinking: "low" };
    expect(validateModelRoles(swapped, snapshot).reviewer).toEqual({
      provider: "prov-y",
      model: "shared-id",
      thinking: "low",
    });
  });

  it("accepts a model only present in the supplied snapshot, not other snapshots", () => {
    const other = snapshotOf([
      ["prov-a", "model-a"],
      ["prov-b", "model-b"],
      ["prov-c", "model-c"],
      ["prov-d", "model-d"],
      ["prov-e", "model-only-here"],
    ]);
    const selection = validSelection(other);
    const roles = validateModelRoles(selection, other);
    expect(roles.repairer).toEqual({ provider: "prov-e", model: "model-only-here", thinking: "medium" });

    // The same selection is invalid against the captured snapshot above.
    expect(() => validateModelRoles(validSelection(other), snapshot)).toThrow(
      /not in the available model snapshot/,
    );
  });

  it("matches surrounding-whitespace identities exactly, never trimmed", () => {
    const selection = validSelection(snapshot);
    refOf(selection, "implementer").provider = "  spaced-provider  ";
    refOf(selection, "implementer").model = "  spaced-id  ";
    const roles = validateModelRoles(selection, snapshot);
    expect(roles.implementer).toEqual({
      provider: "  spaced-provider  ",
      model: "  spaced-id  ",
      thinking: "medium",
    });

    const trimmed = validSelection(snapshot);
    refOf(trimmed, "implementer").provider = "spaced-provider";
    refOf(trimmed, "implementer").model = "  spaced-id  ";
    expect(() => validateModelRoles(trimmed, snapshot)).toThrow(
      /not in the available model snapshot/,
    );
  });

  it("never authorizes an assignment from display names", () => {
    // A registry entry whose name equals the selected model id but whose id
    // does not must not authorize the assignment.
    const named = snapshotOf([
      ["prov-a", "model-x", "model-y"],
      ["prov-b", "model-b"],
      ["prov-c", "model-c"],
      ["prov-d", "model-d"],
      ["prov-e", "model-e"],
    ]);
    const selection = validSelection(named);
    refOf(selection, "scout").model = "model-y";
    expect(() => validateModelRoles(selection, named)).toThrow(
      /not in the available model snapshot/,
    );

    // A changed name on an otherwise matching entry cannot save a non-matching id.
    const renamed = snapshotOf([
      ["prov-a", "model-z", "model-x"],
      ["prov-b", "model-b"],
      ["prov-c", "model-c"],
      ["prov-d", "model-d"],
      ["prov-e", "model-e"],
    ]);
    const selection2 = validSelection(renamed);
    refOf(selection2, "scout").model = "model-x";
    expect(() => validateModelRoles(selection2, renamed)).toThrow(
      /not in the available model snapshot/,
    );
  });

  it("fails closed on malformed snapshot entries", () => {
    const selection = validSelection(snapshot);
    const badEntries: Array<unknown> = [
      null,
      "prov-a",
      42,
      [],
      { provider: "prov-a" },
      { provider: "prov-a", model: "" },
      { provider: "prov-a", model: "model-x", name: 7 },
    ];
    for (const bad of badEntries) {
      const badSnapshot = [...snapshot.slice(0, 5), bad] as unknown as readonly AvailableModel[];
      expect(() => validateModelRoles(selection, badSnapshot)).toThrow(
        /Invalid available model entry 5/,
      );
    }
  });

  it("fails closed on a non-array snapshot", () => {
    const selection = validSelection(snapshot);
    expect(() =>
      validateModelRoles(selection, null as unknown as readonly AvailableModel[]),
    ).toThrow(/expected an array/);
  });
});

describe("validateModelRoles result shape", () => {
  it("returns exactly the five canonical roles", () => {
    const snapshot = snapshotOf([
      ["p1", "m1"],
      ["p2", "m2"],
      ["p3", "m3"],
      ["p4", "m4"],
      ["p5", "m5"],
    ]);
    const roles: ModelRoles = validateModelRoles(validSelection(snapshot), snapshot);
    expect(Object.keys(roles).sort()).toEqual([
      "architect",
      "implementer",
      "repairer",
      "reviewer",
      "scout",
    ]);
  });
});
