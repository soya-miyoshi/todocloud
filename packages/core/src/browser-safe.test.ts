// `packages/core` is imported by the PWA, so a `node:*` import anywhere in it
// breaks the browser build (CLAUDE.md §3). A review catches that unreliably:
// the import that breaks it is one line, added for a good local reason, in a
// file nobody is looking at. This asserts the invariant instead.
//
// It reads the sources rather than importing them, because an import that
// resolves under Node is exactly the failure being looked for — it would pass.
// Test files are exempt: they run under Node only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

// Matches a static import, a re-export and a dynamic import of a `node:`
// specifier, with either quote style. A mention inside a comment has no
// `import`/`from` keyword in front of it and is not matched.
const nodeImport =
  /(?:^|\s)(?:import|export)[\s\S]*?from\s*["']node:[^"']+["']|\bimport\s*\(\s*["']node:[^"']+["']\s*\)|\brequire\s*\(\s*["']node:[^"']+["']\s*\)/;

// Walks subdirectories. An earlier version read only the top level, which
// silently stopped guarding the moment the first source moved into
// `src/store/` — the failure mode of a guard that reports success is worse
// than not having one, so the recursion is the point.
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

test("no source file in core imports a node: module", () => {
  const found = sources(srcDir);

  // A floor, not a formality: if a refactor moved the sources somewhere this
  // no longer looks, an empty sweep would otherwise pass.
  assert.ok(found.length >= 8, `only found ${found.length} sources to check`);

  for (const file of found) {
    const name = path.relative(srcDir, file);
    const contents = fs.readFileSync(file, "utf8");
    const found = nodeImport.exec(contents);
    assert.equal(
      found,
      null,
      `${name} imports a node: module (${found?.[0].trim()}), which the PWA ` +
        `cannot resolve. Move the code to packages/cli or packages/store-sqlite.`,
    );
  }
});
