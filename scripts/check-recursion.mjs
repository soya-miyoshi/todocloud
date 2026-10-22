// Finds a function that calls itself with its own arguments, unchanged.
//
// That is not a style question. `const messageOf = (err) => (err instanceof
// Error ? messageOf(err) : String(err))` shipped from this repository and
// crashed the installed PWA on load — `RangeError: Maximum call stack size
// exceeded`, which on an iPhone is Safari killing the web process and saying
// "a problem repeatedly occurred". A call to yourself with exactly the
// parameters you were given cannot make progress: whatever the condition
// around it decided this time, it decides the same way next time. It is
// always a bug, which is what makes it worth a check rather than a lint
// preference.
//
// Nothing off the shelf catches it in JavaScript. Sonar's S2190 ("Recursion
// should not be infinite") exists for Java, C# and C but is not among
// `eslint-plugin-sonarjs`'s 295 rules; Biome has only
// `noParametersOnlyUsedInRecursion`, which is about unused parameters. So it
// is here, over the AST of the compiler this repository already depends on —
// `typescript` is the one devDependency, and this adds none.
//
// What it deliberately does not try to be is a termination prover. It reports
// one shape, the one that has no innocent reading:
//
//   f(a, b) { … f(a, b) … }          reported
//   f(a, b) { … f(a, b - 1) … }      not reported: an argument changed
//   f(a) { … g(a) … }                not reported: mutual recursion is not
//                                    this check's business (and a real one
//                                    would need the call graph)
//   f() { … f() … }                  reported — a no-argument function that
//                                    calls itself depends on outer state to
//                                    stop, and none of this tree does that
//
// Usage: node scripts/check-recursion.mjs [path…]   (default: the whole tree)

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

/** The files this walks: everything tracked that a runtime executes. */
function tracked() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out
    .split('\0')
    .filter((f) => /\.(ts|mts|js|mjs|cjs)$/.test(f) && !f.endsWith('.d.ts'));
}

/**
 * nameOf is the name a function is called by: its own, or the variable it is
 * assigned to. An arrow function has no name of its own, and every helper
 * this check exists for is an arrow.
 */
function nameOf(node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

/** params is the parameter list as plain names, or undefined if any is not. */
function params(node) {
  const names = [];
  for (const p of node.parameters) {
    if (!ts.isIdentifier(p.name)) {
      return undefined; // a destructured or defaulted parameter: not this shape
    }
    names.push(p.name.text);
  }
  return names;
}

/**
 * shadows reports whether this body declares `name` itself — as a variable,
 * a function or a parameter of a nested function — in which case a call to
 * `name` inside it may not be a call to the function being examined.
 */
function shadows(body, name) {
  let hit = false;
  const look = (node) => {
    if (hit) {
      return;
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      hit = true;
      return;
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      hit = true;
      return;
    }
    ts.forEachChild(node, look);
  };
  ts.forEachChild(body, look);
  return hit;
}

/** sameArgs reports whether a call passes exactly these identifiers, in order. */
function sameArgs(call, names) {
  if (call.arguments.length !== names.length) {
    return false;
  }
  return call.arguments.every(
    (arg, i) => ts.isIdentifier(arg) && arg.text === names[i],
  );
}

/**
 * findings walks one file and returns what it found: the function's name, the
 * line of the call, and the text of the call as written.
 */
export function findings(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const found = [];

  const visit = (node) => {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);
    if (isFn) {
      const name = nameOf(node);
      const names = params(node);
      // A body that declares the name again is a body where the name means
      // something else, and resolving which is a job for the type checker
      // rather than for a walk. Such a function is left alone: the cost is a
      // shape this check does not see, and the alternative is reporting one
      // that is not there.
      if (name !== undefined && names !== undefined && node.body && !shadows(node.body, name)) {
        const look = (inner) => {
          if (
            ts.isCallExpression(inner) &&
            ts.isIdentifier(inner.expression) &&
            inner.expression.text === name &&
            sameArgs(inner, names)
          ) {
            const { line } = source.getLineAndCharacterOfPosition(inner.getStart(source));
            found.push({
              file,
              line: line + 1,
              name,
              call: inner.getText(source),
            });
          }
          ts.forEachChild(inner, look);
        };
        ts.forEachChild(node.body, look);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

/** check reports every finding in these files. */
export function check(files) {
  return files.flatMap((file) => findings(file, readFileSync(file, 'utf8')));
}

if (process.argv[1] !== undefined && import.meta.url.endsWith('check-recursion.mjs')) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : tracked();
  const hits = check(files);
  for (const hit of hits) {
    process.stderr.write(
      `${hit.file}:${hit.line}: ${hit.name} calls itself with its own arguments: ${hit.call}\n`,
    );
  }
  if (hits.length > 0) {
    process.stderr.write(
      `\n${hits.length} unconditional self-call(s). A call with the arguments you were\n` +
        'given cannot make progress; it is a stack overflow on the first call.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`${files.length} files, no self-call with unchanged arguments\n`);
}
