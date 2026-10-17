import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What a site page ships to its visitors (M8-2, ADR 0029). Next sends the browser every client component reachable
 * from a route's server imports, used or not. Site pages draw nothing interactive, so nothing of the app reachable
 * from `app/(sites)` may be a client component: through a module's barrel, the admin's screens (the media library,
 * the sign-in forms, the appearance editor…) were shipped on every public page, about 200 KB of scripts.
 *
 * The walk follows the app's own imports (`@/…` and relative), static and dynamic, as written; packages are left out.
 */

const ROOT = path.resolve(__dirname, "../../..");
const ENTRY_DIR = path.join(ROOT, "src/app/(sites)");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? path.join(ROOT, "src", specifier.slice(2)) : specifier.startsWith(".") ? path.resolve(path.dirname(from), specifier) : null;
  if (!base) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const isClientModule = (source: string) => /^\s*["']use client["']/.test(withoutComments(source));

/** Every module of the app reachable from the entries, with the import that first reached it. */
function reachable(entries: string[]) {
  const reachedFrom = new Map<string, string | null>(entries.map((entry) => [entry, null]));
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!;
    const source = withoutComments(readFileSync(file, "utf8"));
    const specifiers = [
      ...[...source.matchAll(/(?:^|[\s;])(?:import|export)(?!\s+type\s)\s*(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/g)].map((match) => match[1]!),
      ...[...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]!),
    ];
    for (const specifier of specifiers) {
      const target = resolveImport(file, specifier);
      if (target && !reachedFrom.has(target)) {
        reachedFrom.set(target, file);
        queue.push(target);
      }
    }
  }
  return reachedFrom;
}

describe("what a site page ships (M8-2, ADR 0029)", () => {
  const graph = reachable(filesUnder(ENTRY_DIR));
  const relative = (file: string) => path.relative(ROOT, file);

  it("reaches the renderer, the themes and media's images: the walk sees the whole site tree", () => {
    for (const file of ["src/modules/rendering/document.tsx", "src/themes/journal/templates/blog.tsx", "src/themes/studio/theme.ts", "src/modules/media/images.ts"]) {
      expect(graph.has(path.join(ROOT, file)), file).toBe(true);
    }
  });

  it("reaches no client component of the app, and no module's barrel but the renderer's", () => {
    const chainTo = (file: string) => {
      const chain: string[] = [];
      for (let at: string | null | undefined = file; at; at = graph.get(at)) chain.unshift(relative(at));
      return chain.join(" → ");
    };
    const clients = [...graph.keys()].filter((file) => isClientModule(readFileSync(file, "utf8"))).map(chainTo);
    expect(clients).toEqual([]);
    const barrels = [...graph.keys()].map(relative).filter((file) => /^src\/modules\/[^/]+\/index\.tsx?$/.test(file));
    expect(barrels).toEqual(["src/modules/rendering/index.ts"]);
  });
});
