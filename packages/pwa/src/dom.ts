// The slice of the DOM this app touches, declared here instead of pulled in.
//
// This looks like a strange thing to hand-write, so here is why it is. One
// `tsconfig.json` covers every package in this repository (`MIGRATION.md`,
// "No build step"), and it compiles with the default libraries for its
// target — no `dom`. Adding `lib: ["dom"]` is not a local change: the DOM
// library declares `fetch`, `Response`, `Request` and `Headers` as globals,
// and so does `@types/node`, which `packages/cli` and both Node stores are
// checked against. Switching it on for the whole program to type eleven
// property reads in one module is the wrong direction, and the alternative —
// a second `tsconfig.json` with its own libraries — is the per-package build
// that `MIGRATION.md` records as tried and abandoned.
//
// So the interfaces below are the contract this module asserts about the
// browser, and `document()` is the single unchecked cast that buys it. They
// are deliberately the narrowest shape that compiles: anything this app
// starts doing to the page has to be added here first, which is a cheap
// reminder that the viewer's markup is in `public/`, not in TypeScript.
//
// `fetch`, `Response` and `Request` are *not* here. Those are declared by
// `@types/node` as well as by browsers, with the same shapes, so `router.ts`
// and `shim.ts` are type-checked against the Node declarations and run
// against the browser ones.

/** Classes is the `classList` slice: one method, used for one class. */
export interface Classes {
  toggle(name: string, on?: boolean): void;
}

/**
 * Elem is an element. `value` and `checked` are optional because the same
 * accessor returns both a `<span>` and an `<input>`, and reading the wrong
 * one off the wrong element is a mistake worth having the type catch.
 */
export interface Elem {
  textContent: string | null;
  readonly classList: Classes;
  toggleAttribute(name: string, force?: boolean): boolean;
  addEventListener(type: string, listener: (event: Ev) => void): void;
  click(): void;
  focus(): void;
  value?: string;
  checked?: boolean;
}

/** Ev is an event, with the one method this app calls on one. */
export interface Ev {
  preventDefault(): void;
}

/** Doc is the document. */
export interface Doc {
  getElementById(id: string): Elem | null;
  readonly body: Elem;
}

/**
 * document returns the page, or undefined when there is none — which is the
 * case under `node --test`, where every module but this one is exercised
 * without a browser. A caller that cannot work without a page does nothing,
 * rather than throwing from a module's top level.
 */
export function document(global: typeof globalThis = globalThis): Doc | undefined {
  const doc = (global as unknown as { document?: unknown }).document;
  if (doc === null || doc === undefined) {
    return undefined;
  }
  return doc as Doc;
}

/**
 * pageScheme is `location.protocol`: `https:` or `http:`, and the empty
 * string where there is no location. It is read through here so that
 * `credentials.mixedContent` takes a string and stays testable.
 */
export function pageScheme(global: typeof globalThis = globalThis): string {
  const loc = (global as unknown as { location?: { protocol?: unknown } }).location;
  const scheme = loc?.protocol;
  return typeof scheme === 'string' ? scheme : '';
}
