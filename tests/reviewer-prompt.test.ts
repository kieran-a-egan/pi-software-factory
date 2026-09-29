import { describe, expect, it } from "vitest";
import { reviewerPrompt } from "../src/prompts.js";

// The three evidence-role statements in the post-repair guidance. Asserting
// these substrings (rather than snapshotting the whole prompt) pins the
// guidance's semantic claims:
const IMMEDIATELY_PRECEDING_STATEMENT =
  'The payload includes "reviewRepair", containing the immediately preceding review and the latest repair report.';
const CURRENT_VERIFICATION_STATEMENT =
  'The top-level "verification" was run after that latest repair and is the current deterministic evidence.';
const WORKERS_BACKGROUND_STATEMENT =
  '"workers" is the original implementation background, not the latest repair claims.';

describe("reviewerPrompt first review (no reviewRepair)", () => {
  it("omits reviewRepair and therefore emits no post-repair guidance", () => {
    const payload = {
      objective: "objective-token-alpha",
      projectContext: "project-context-token-beta",
      architecture: "architecture-token-gamma",
      workers: ["worker-token-delta"],
      verification: "verification-token-epsilon",
    };
    expect("reviewRepair" in payload).toBe(false);
    const prompt = reviewerPrompt(payload);

    // The guidance's three evidence-role statements are absent.
    expect(prompt).not.toContain(IMMEDIATELY_PRECEDING_STATEMENT);
    expect(prompt).not.toContain(CURRENT_VERIFICATION_STATEMENT);
    expect(prompt).not.toContain(WORKERS_BACKGROUND_STATEMENT);
    // No guidance references the repair fields at all.
    expect(prompt).not.toContain("reviewRepair");
    expect(prompt).not.toContain("immediately preceding review");
    expect(prompt).not.toContain("current deterministic evidence");
    // The ordinary payload is still serialized into the prompt.
    expect(prompt).toContain(JSON.stringify(payload, null, 2));
    expect(prompt).toContain("objective-token-alpha");
  });
});

describe("reviewerPrompt post-repair review (with reviewRepair)", () => {
  it("guides to the evidence roles and serializes the complete input including nested reviewRepair", () => {
    const payload = {
      objective: "objective-token-alpha",
      projectContext: "project-context-token-beta",
      architecture: "architecture-token-gamma",
      workers: ["earlier-worker-implementation-background"],
      verification: "current-deterministic-verification-after-repair",
      reviewRepair: {
        previousReview: "distinct-immediately-preceding-review",
        repair: "distinct-latest-repair-report",
      },
    };
    const prompt = reviewerPrompt(payload);

    // Guidance identifies reviewRepair as the immediately preceding review and
    // the latest repair report.
    expect(prompt).toContain(IMMEDIATELY_PRECEDING_STATEMENT);
    // Guidance identifies top-level verification as run after the latest repair
    // and as current deterministic evidence.
    expect(prompt).toContain(CURRENT_VERIFICATION_STATEMENT);
    // Guidance identifies workers as original implementation background, not
    // latest repair claims.
    expect(prompt).toContain(WORKERS_BACKGROUND_STATEMENT);

    // The entire pretty-printed input is embedded verbatim, proving that both
    // nested reviewRepair fields are serialized without indentation-sensitive
    // extraction logic.
    expect(prompt).toContain(JSON.stringify(payload, null, 2));
    // Both nested reviewRepair fields are serialized inside the embedded JSON.
    expect(prompt).toContain('"reviewRepair"');
    expect(prompt).toContain('"previousReview": "distinct-immediately-preceding-review"');
    expect(prompt).toContain('"repair": "distinct-latest-repair-report"');
    // Distinct inline content proves the right values were serialized.
    expect(prompt).toContain("earlier-worker-implementation-background");
    expect(prompt).toContain("current-deterministic-verification-after-repair");
  });
});
