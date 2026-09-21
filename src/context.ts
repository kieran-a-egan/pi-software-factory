import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const TEXT_EXTENSIONS = new Set([".md", ".okf", ".json", ".yaml", ".yml", ".txt"]);

function collectFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

export function loadProjectContext(cwd: string, paths: string[], maxBytes: number): string {
  let remaining = maxBytes;
  const chunks: string[] = [];

  for (const configured of paths) {
    for (const file of collectFiles(join(cwd, configured)).sort()) {
      if (remaining <= 0) break;
      const raw = readFileSync(file);
      const slice = raw.subarray(0, Math.min(raw.length, remaining));
      chunks.push(`\n--- ${relative(cwd, file)} ---\n${slice.toString("utf8")}`);
      remaining -= slice.length;
    }
    if (remaining <= 0) break;
  }

  return chunks.join("\n").trim();
}
