# Autonomy benchmark corpus — v1

This directory is a plain, frozen corpus of tiny solvable TypeScript benchmark
cases. **This tranche contains exactly three cases: `autonomy-v1-001`,
`autonomy-v1-002`, and `autonomy-v1-003`.** No other cases, shared runners,
or helpers live here.

## Layout

Each case occupies its own directory named after its stable identifier:

```
v1/
  <case-id>/
    definition.json   # the BenchmarkCaseDefinition (schema v1)
    assert.ts         # the case-specific, manually invoked checks
    fixture/
      index.ts        # the pristine starting candidate source
      tsconfig.json   # the fixture's standalone strict tsconfig
      package.json    # minimal fixture manifest (type: module, no deps)
```

There is no per-case README; this single README at the v1 root covers the whole
tranche.

## Definition → fixture mapping

`definition.json` holds only the required `BenchmarkCaseDefinition` fields
(`id`, `schemaVersion`, `kind`, `category`, `objective`,
`expectedTerminalOutcome`, `humanImplementationInterventionAllowed`, and
`assertionIdentifiers`). All cases use `schemaVersion: "v1"`, `kind:
"solvable"`, `expectedTerminalOutcome: "ACCEPTED"`, and
`humanImplementationInterventionAllowed: false`.

The definition carries no path fields. Instead, the surrounding directory is the
contract: `fixture/` is the starting candidate contents, and `assert.ts` is the
external required behavioral check suite plus the isolated fixture typecheck.
The directory name equals the definition's `id`.

- `autonomy-v1-001` — focused arithmetic bug: `mean([])` currently returns
  `NaN`; the fix must return `0` while preserving nonempty means.
- `autonomy-v1-002` — additive parser feature: `parseBoolean` initially
  recognizes only `'true'`/`'false'`; add the exact `'yes'`/`'no'` aliases while
  preserving existing tokens, case-sensitivity, and no trimming.
- `autonomy-v1-003` — boundary bug: `parsePort("0")` currently returns `0`
  instead of `undefined`; the fix must reject `'0'` while preserving valid
  decimal ports up to `'65535'`, strict digit-only parsing, and rejection of
  out-of-range, negative, fractional, whitespace, and nonnumeric inputs.

## Assertions and manual invocation

`assert.ts` is a standalone, manually invoked, case-specific test script — not a
runner abstraction. It is deliberately kept outside the candidate fixture. It
runs the requested behavioral checks, the regression checks, and a fixture-local
typecheck, emitting only the declared `{ assertionId, passed }` results to
stdout and diagnostics to stderr.

To evaluate a candidate, **copy the `fixture/` directory** into a working
location, edit the copy, and point the assertion script at that copy. Do not edit
the frozen inputs in place:

```
node --import tsx <case-id>/assert.ts <candidate-fixture-dir>
```

`<candidate-fixture-dir>` is the directory containing the candidate's
`index.ts` and `tsconfig.json`; candidate files are resolved only from this
argument, never from the frozen fixture or an assumed working-tree location.

## Frozen status

These inputs are frozen on acceptance. Once accepted, a case's `definition.json`,
`assert.ts`, and `fixture/` are the fixed starting point for that case and are
not modified by later work.
