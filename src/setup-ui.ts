import { MODEL_ROLES, THINKING_LEVELS } from "./config.js";
import type { AvailableModel } from "./setup.js";
import type { ModelRef, ModelRoles, ThinkingLevel } from "./types.js";

/**
 * Narrow in-memory selection seam for setup presentation. The caller
 * supplies a title plus an ordered list of option strings; the promise
 * resolves to the chosen option string, or to undefined when the user
 * cancels. Deliberately Pi-independent: no TUI, registry, configuration,
 * or persistence surface is involved.
 */
export interface SetupSelector {
  select(title: string, options: string[]): Promise<string | undefined>;
}

/**
 * Builds the deterministic presentation label for one snapshot entry: the
 * one-based snapshot position prefix, then the provider/model identity
 * pair, then the optional display name. The position prefix guarantees
 * uniqueness even when presentation text, delimiter combinations, or
 * entries collide; the display name is presentation only and never
 * participates in identity matching.
 */
function modelLabel(index: number, entry: AvailableModel): string {
  const base = `${index + 1}. ${entry.provider}/${entry.model}`;
  return entry.name !== undefined && entry.name !== "" ? `${base} ${entry.name}` : base;
}

/**
 * Collects a complete five-role model selection from a caller-supplied
 * snapshot through a narrow selector. Pure and in-memory: no Pi runtime,
 * configuration, registry, provider, persistence, or filesystem access.
 *
 * Prompts strictly in canonical MODEL_ROLES order; each role receives
 * exactly one model selector followed by exactly one thinking selector,
 * and the thinking options are exactly THINKING_LEVELS in canonical order.
 * Model options are derived exclusively from the supplied snapshot in
 * snapshot order, with each deterministically unique label explicitly
 * mapped to the exact entry; identity strings are copied verbatim and
 * display names are never parsed back into identity. A fresh mutable
 * option array is passed on every prompt, so neither the snapshot nor the
 * canonical arrays is exposed to mutation. Any undefined response cancels
 * immediately, returning undefined with no further prompts and no partial
 * result; any unexpected non-undefined response throws a descriptive error
 * and stops prompting. The finalized ModelRoles is returned only after all
 * ten selections succeed, with exactly the five canonical role keys, each
 * carrying only provider, model, and thinking.
 */
export async function collectModelRoles(
  selector: SetupSelector,
  availableModels: readonly AvailableModel[],
): Promise<ModelRoles | undefined> {
  const byLabel = new Map<string, AvailableModel>();
  const modelOptions: string[] = availableModels.map((entry, index) => {
    const label = modelLabel(index, entry);
    byLabel.set(label, entry);
    return label;
  });

  const roles = {} as ModelRoles;

  for (const role of MODEL_ROLES) {
    const modelChoice = await selector.select(`Select model for ${role}`, [...modelOptions]);
    if (modelChoice === undefined) return undefined;
    const selected = byLabel.get(modelChoice);
    if (selected === undefined) {
      throw new Error(
        `Unexpected model selection for ${role}: "${modelChoice}" does not match any model in the supplied snapshot.`,
      );
    }

    const thinkingChoice = await selector.select(`Select thinking level for ${role}`, [...THINKING_LEVELS]);
    if (thinkingChoice === undefined) return undefined;
    if (!THINKING_LEVELS.includes(thinkingChoice as ThinkingLevel)) {
      throw new Error(
        `Unexpected thinking level for ${role}: "${thinkingChoice}" is not one of ${THINKING_LEVELS.join(", ")}.`,
      );
    }

    roles[role] = {
      provider: selected.provider,
      model: selected.model,
      thinking: thinkingChoice as ThinkingLevel,
    } satisfies ModelRef;
  }

  return roles;
}
