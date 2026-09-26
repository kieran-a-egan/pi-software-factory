import { pathsOverlap } from "./parallel.js";
import type { ImplementationUnit, WorkerReport } from "./types.js";

export function unexpectedReportedFiles(assignment: unknown, report: WorkerReport): string[] {
  const filesExpected = (assignment as any)?.filesExpected;
  if (!Array.isArray(filesExpected) || filesExpected.length === 0) return [];

  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "");
  const allowed = filesExpected.map((value: unknown) => normalize(String(value)));
  return report.changedFiles
    .map(normalize)
    .filter((path) => !allowed.some((expected: string) => pathsOverlap(path, expected)));
}

export function implementationGraphIssue(units: ImplementationUnit[]): string | undefined {
  const ids = new Set<string>();
  for (const unit of units) {
    if (ids.has(unit.id)) return `duplicate implementation unit id: ${unit.id}`;
    ids.add(unit.id);
  }

  for (const unit of units) {
    for (const dependency of unit.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        return `implementation unit ${unit.id} depends on unknown unit ${dependency}`;
      }
    }
  }

  const remaining = new Set(units.map((unit) => unit.id));
  const resolved = new Set<string>();
  while (remaining.size > 0) {
    const ready = units.filter(
      (unit) =>
        remaining.has(unit.id) &&
        (unit.dependsOn ?? []).every((dependency) => resolved.has(dependency)),
    );
    if (ready.length === 0) {
      return `implementation dependency graph contains a cycle involving: ${[...remaining].join(", ")}`;
    }
    for (const unit of ready) {
      remaining.delete(unit.id);
      resolved.add(unit.id);
    }
  }

  return undefined;
}

export function readyImplementationUnits(
  units: ImplementationUnit[],
  pending: Set<string>,
  completed: Set<string>,
): ImplementationUnit[] {
  return units.filter(
    (unit) =>
      pending.has(unit.id) &&
      (unit.dependsOn ?? []).every((dependency) => completed.has(dependency)),
  );
}

export function selectParallelUnits(
  ready: ImplementationUnit[],
  maxParallelUnits: number,
): ImplementationUnit[] {
  const selected: ImplementationUnit[] = [];

  for (const unit of ready) {
    if (!unit.filesExpected?.length || !Array.isArray(unit.dependsOn)) continue;

    const overlaps = selected.some((other) =>
      unit.filesExpected!.some((path) =>
        other.filesExpected!.some((otherPath) => pathsOverlap(path, otherPath)),
      ),
    );
    if (overlaps) continue;

    selected.push(unit);
    if (selected.length >= maxParallelUnits) break;
  }

  return selected;
}
