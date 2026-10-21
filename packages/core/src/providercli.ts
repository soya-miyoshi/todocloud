// Drives the providers' own command-line tools, so that a user who has
// already logged in with `turso auth login` or
// `gcloud auth application-default login` does not have to find a token in a
// dashboard and paste it.
//
// Three rules shape every function here, and all three are load-bearing:
//
//   - A secret never reaches a child's argv. The only secret this module
//     handles is the token `turso db tokens create` mints, and that arrives on
//     the child's stdout; it is wrapped in a Secret before it is returned and
//     it is never formatted into anything.
//   - A child's stdout is never quoted into an error. An error reports the
//     exit status and a scrubbed stderr only, exactly as the keyring does,
//     because on a mint stdout *is* the token.
//   - Login state is read from an exit status, never from output. `turso auth
//     token` prints a credential, so this module runs it and looks only at
//     whether it succeeded.
//
// Every exec'd command goes through two module-level indirections — lookPath
// and runner — so the tests drive fake executables and never a real provider
// CLI.
//
// Why this lives in `packages/core` rather than `packages/cli`, where the
// commands that call it live: the PWA needs the same Turso URL validation —
// databaseFromURL, matchDatabaseInURL and the name rules behind them — and
// duplicating that in two places is how the two copies drift apart. Spawning
// a child process is the part a browser cannot do, and it is precisely the
// part that was already behind an indirection in the Go tree. So this module
// imports no `node:*` module and ships NO default runner: `installRunner`
// below is how `packages/cli` supplies one built on `node:child_process`.
// Until it does, the four `turso*` functions report that no runner is
// installed, which is the correct answer in a browser and an obvious one in a
// misconfigured Node process. The pure URL functions need no runner and work
// in both runtimes.

import { Secret, REDACTED } from './secret.ts';

/** The Turso CLI's name on PATH. */
export const TURSO_BIN = 'turso';

/**
 * SOURCE_TURSO_CLI and SOURCE_STDIN name where a token came from, for the
 * documented --json output of `tdo login`.
 */
export const SOURCE_TURSO_CLI = 'turso-cli';
export const SOURCE_STDIN = 'stdin';

/**
 * The default bound on every child process. A provider CLI that hangs — on a
 * prompt, on a stalled network call — must not wedge `tdo login`.
 * It is settable through `installRunner` only so that a test can shorten it;
 * nothing changes it at run time.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

let commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;

/**
 * What a child process did. `stdout` is held separately and is never included
 * in an error by anything in this module.
 */
export interface Output {
  stdout: string;
  stderr: string;
  err?: Error | undefined;
}

/**
 * Runs `name` with `args` and collects its output. It is installed rather
 * than imported so that tests can drive every branch — success, a non-zero
 * exit, a timeout, empty output — without a real binary, and so that this
 * module itself never names a process API.
 *
 * The `signal` carries the deadline. A runner is expected to abandon the
 * child when it aborts and to return an Output whose `err` is set; which
 * error it is does not matter, because `run` recognises its own deadline and
 * rewrites the message.
 */
export type Runner = (
  signal: AbortSignal,
  name: string,
  args: readonly string[],
) => Output | Promise<Output>;

/**
 * Resolves `file` on PATH, returning its absolute path, or throwing when it
 * is not installed. The Go tree used exec.LookPath; a Node runner wraps
 * whichever lookup it prefers, and a test replaces it to simulate a machine
 * where a provider CLI is absent.
 */
export type LookPath = (file: string) => string;

/**
 * The error a runner reports for a child that ran and exited non-zero, as
 * distinct from one that could not be started at all. The distinction is not
 * cosmetic: `tursoLoggedIn` treats a non-zero exit as "not logged in" — an
 * answer — and anything else as a failure to report.
 */
export class ExitError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message = `exit status ${exitCode}`) {
    super(message);
    this.name = 'ExitError';
    this.exitCode = exitCode;
  }
}

/** Thrown by the placeholder runner when no real one has been installed. */
const noRunner: Runner = (_signal, name) => ({
  stdout: '',
  stderr: '',
  err: new Error(`cannot run ${name}: no provider CLI runner is installed`),
});

const noLookPath: LookPath = (file) => {
  throw new Error(`cannot look for ${file}: no provider CLI runner is installed`);
};

let lookPath: LookPath = noLookPath;
let runner: Runner = noRunner;

/**
 * Installs the process indirections. `packages/cli` calls it once at startup
 * with a runner over `node:child_process`; a test calls it to drive fakes.
 * Returns the previous settings, so a caller can restore them.
 *
 * A runner must give the child no stdin: none of these commands may prompt,
 * and a CLI waiting on a terminal would otherwise block until the timeout.
 */
export function installRunner(opts: {
  lookPath?: LookPath | undefined;
  runner?: Runner | undefined;
  commandTimeoutMs?: number | undefined;
}): { lookPath: LookPath; runner: Runner; commandTimeoutMs: number } {
  const previous = { lookPath, runner, commandTimeoutMs };
  if (opts.lookPath !== undefined) {
    lookPath = opts.lookPath;
  }
  if (opts.runner !== undefined) {
    runner = opts.runner;
  }
  if (opts.commandTimeoutMs !== undefined) {
    commandTimeoutMs = opts.commandTimeoutMs;
  }
  return previous;
}

/** Puts the indirections back to their uninstalled state. */
export function resetRunner(): void {
  lookPath = noLookPath;
  runner = noRunner;
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
}

/** Executes one provider CLI command under a timeout. */
async function run(name: string, args: readonly string[]): Promise<Output> {
  const controller = new AbortController();
  // A flag rather than a look at the signal's reason: a runner is free to
  // abort for its own reasons too, and only this deadline should be reported
  // as this deadline.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, commandTimeoutMs);
  try {
    const out = await runner(controller.signal, name, args);
    // A child killed by the deadline reports a generic failure, so the
    // deadline is reported explicitly instead.
    if (out.err !== undefined && timedOut) {
      return {
        ...out,
        err: new Error(`${name} did not finish within ${commandTimeoutMs}ms`),
      };
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the error for a failed child. It reports the exit status and a
 * trimmed stderr, and never the child's stdout.
 */
export function childError(name: string, out: Output): Error {
  const stderr = out.stderr.trim();
  const err = out.err;
  if (err instanceof ExitError) {
    if (stderr === '') {
      return new Error(`${name} exited with status ${err.exitCode}`, { cause: err });
    }
    return new Error(`${name} exited with status ${err.exitCode}: ${stderr}`, { cause: err });
  }
  const message = err === undefined ? 'failed' : err.message;
  if (stderr === '') {
    return new Error(`${name}: ${message}`, { cause: err });
  }
  return new Error(`${name}: ${message}: ${stderr}`, { cause: err });
}

/**
 * Removes `value` from `text`, so a child that echoed its own output onto
 * stderr cannot carry the token into an error message.
 */
function scrub(text: string, value: Secret): string {
  if (value.empty()) {
    return text;
  }
  return text.split(value.reveal()).join(REDACTED);
}

/**
 * Removes exactly one trailing line ending and nothing else. A token is used
 * as given: trailing whitespace that is not the terminator the CLI added is
 * part of the value as far as this code knows.
 */
export function trimOneNewline(s: string): string {
  if (s.endsWith('\r\n')) {
    return s.slice(0, -2);
  }
  if (s.endsWith('\n')) {
    return s.slice(0, -1);
  }
  return s;
}

/** Reports whether the Turso CLI is on PATH. */
export function tursoAvailable(): boolean {
  try {
    lookPath(TURSO_BIN);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reports whether the Turso CLI holds a usable session.
 *
 * It runs `turso auth token` and looks at the exit status only. That command
 * prints a credential on success, so its stdout is never read, never logged
 * and never placed in the thrown error. A non-zero exit means "not logged
 * in", which is not an error; an error is thrown only when the command could
 * not be run at all.
 */
export async function tursoLoggedIn(): Promise<boolean> {
  if (!tursoAvailable()) {
    throw new Error(`${TURSO_BIN} is not installed`);
  }
  const out = await run(TURSO_BIN, ['auth', 'token']);
  if (out.err === undefined) {
    return true;
  }
  if (out.err instanceof ExitError) {
    // A refused session is an answer, not a failure.
    return false;
  }
  // Deliberately built from an Output with its stdout dropped.
  throw childError(TURSO_BIN, { stdout: '', stderr: out.stderr, err: out.err });
}

/**
 * Lists the databases the logged-in user owns, by name.
 *
 * `turso db list` prints a table whose first column is the name and whose
 * first row is a header. Only the first column of each following row is read;
 * the URL column is not a credential but is not needed here either.
 */
export async function tursoDatabases(): Promise<string[]> {
  if (!tursoAvailable()) {
    throw new Error(`${TURSO_BIN} is not installed`);
  }
  const out = await run(TURSO_BIN, ['db', 'list']);
  if (out.err !== undefined) {
    throw childError(TURSO_BIN, { stdout: '', stderr: out.stderr, err: out.err });
  }
  const names: string[] = [];
  for (const line of out.stdout.split('\n')) {
    // The first whitespace-separated field, standing in for
    // strings.Fields(line)[0]; a line that is empty or all whitespace has
    // none and is skipped.
    const field = /\S+/.exec(line);
    if (field === null) {
      continue;
    }
    const name = field[0];
    if (name.toLowerCase() === 'name') {
      // The table header.
      continue;
    }
    names.push(name);
  }
  return names;
}

/**
 * Mints a token scoped to one database.
 *
 * This is narrower than anything a user would create by hand in the
 * dashboard: the token reaches this database and no other. It arrives on the
 * child's stdout and becomes a Secret immediately, before any other code can
 * see it as a string.
 */
export async function tursoCreateToken(database: string): Promise<Secret> {
  validateDatabaseName(database);
  if (!tursoAvailable()) {
    throw new Error(`${TURSO_BIN} is not installed`);
  }
  const out = await run(TURSO_BIN, ['db', 'tokens', 'create', database]);
  const token = new Secret(trimOneNewline(out.stdout));
  if (out.err !== undefined) {
    throw childError(TURSO_BIN, {
      stdout: '',
      stderr: scrub(out.stderr, token),
      err: out.err,
    });
  }
  if (token.empty()) {
    throw new Error(`${TURSO_BIN} db tokens create ${database} printed no token`);
  }
  return token;
}

/**
 * Returns the libsql:// URL of a database. A URL is not a credential, so it
 * may be printed; it is only ever used as a hint for the user's config file.
 */
export async function tursoDatabaseURL(database: string): Promise<string> {
  validateDatabaseName(database);
  if (!tursoAvailable()) {
    throw new Error(`${TURSO_BIN} is not installed`);
  }
  const out = await run(TURSO_BIN, ['db', 'show', database, '--url']);
  if (out.err !== undefined) {
    throw childError(TURSO_BIN, { stdout: '', stderr: out.stderr, err: out.err });
  }
  const url = out.stdout.trim();
  if (url === '') {
    throw new Error(`${TURSO_BIN} db show ${database} --url printed no url`);
  }
  return url;
}

/**
 * Refuses anything that is not a plain name. A name reaches a child's argv,
 * so a value that could be read as a flag or as shell text is rejected rather
 * than quoted. Throws on a bad name; returns nothing on a good one.
 */
export function validateDatabaseName(database: string): void {
  if (database === '') {
    throw new Error('no database name given');
  }
  if (database.startsWith('-')) {
    throw new Error(`invalid database name ${quote(database)}: it must not start with a dash`);
  }
  // Iterated by code point, as Go iterates a string by rune.
  for (const r of database) {
    if (
      (r >= 'a' && r <= 'z') ||
      (r >= 'A' && r <= 'Z') ||
      (r >= '0' && r <= '9') ||
      r === '-' ||
      r === '_'
    ) {
      continue;
    }
    throw new Error(
      `invalid database name ${quote(database)}: only letters, digits, dashes and underscores are allowed`,
    );
  }
}

/** Reports whether a name is one every command here accepts. */
function databaseNameValid(database: string): boolean {
  try {
    validateDatabaseName(database);
    return true;
  } catch {
    return false;
  }
}

/**
 * Renders a value for an error message the way Go's %q does, so that an
 * invisible or control character in a rejected name is visible to the user
 * rather than mangling their terminal.
 */
function quote(s: string): string {
  return JSON.stringify(s);
}

/**
 * Recovers a database name from a Turso URL.
 *
 * Turso hostnames are `<database>-<organization>.turso.io`, so the name is
 * everything before the last dash of the first label. The boolean is false
 * whenever that cannot be read confidently — a host that is not Turso's, or a
 * label with no dash at all, where the whole label might be the name or might
 * not. An uncertain answer is reported as uncertain so the caller can check it
 * against `turso db list` instead of guessing.
 *
 * Returned as a `[name, ok]` tuple, which is the Go signature read
 * mechanically; on `ok === false` the name is always the empty string.
 */
export function databaseFromURL(url: string): [name: string, ok: boolean] {
  const [label, ok] = tursoHostLabel(url);
  if (!ok) {
    return ['', false];
  }
  const dash = label.lastIndexOf('-');
  if (dash <= 0 || dash === label.length - 1) {
    // No dash, or nothing on one side of it: the organization cannot be told
    // apart from the name.
    return ['', false];
  }
  const name = label.slice(0, dash);
  // The host label is whatever the configured URL happens to contain, so a
  // name sliced out of it is not automatically a name this module would
  // accept as an argument. Reporting "certain" for one that the very next
  // call would refuse is worse than reporting uncertainty: the caller falls
  // back to `turso db list`, or asks for --database.
  if (!databaseNameValid(name)) {
    return ['', false];
  }
  return [name, true];
}

/**
 * Resolves a Turso URL against a known list of databases. It is the reliable
 * path where databaseFromURL's heuristic is uncertain, because a database
 * name may itself contain dashes. The longest name that the host's first
 * label starts with wins.
 */
export function matchDatabaseInURL(
  url: string,
  databases: readonly string[] | null | undefined,
): [name: string, ok: boolean] {
  const [label, ok] = tursoHostLabel(url);
  if (!ok) {
    return ['', false];
  }
  let best = '';
  for (const name of databases ?? []) {
    if (name === '' || !databaseNameValid(name)) {
      continue;
    }
    if (label !== name && !label.startsWith(name + '-')) {
      continue;
    }
    if (name.length > best.length) {
      best = name;
    }
  }
  return [best, best !== ''];
}

/**
 * Returns the first label of a Turso hostname.
 *
 * This is deliberately hand-written string slicing rather than the WHATWG
 * `URL` parser, even though `URL` is available in both runtimes. The input is
 * not required to be a URL at all — `tasks-acme.turso.io` with no scheme is a
 * value a user writes in their config file, and `new URL` rejects it — and
 * `URL` also normalises, percent-encodes and IDNA-maps a host, so a value it
 * accepted would not be the bytes the user wrote. What matters downstream is
 * only which bytes end up in a name that reaches a child's argv, so the split
 * stays explicit and the name is checked by validateDatabaseName afterwards.
 */
function tursoHostLabel(url: string): [label: string, ok: boolean] {
  let host = url.trim();
  if (host === '') {
    return ['', false];
  }
  const scheme = host.indexOf('://');
  if (scheme >= 0) {
    host = host.slice(scheme + 3);
  }
  const delim = /[/?#]/.exec(host);
  if (delim !== null) {
    host = host.slice(0, delim.index);
  }
  const at = host.lastIndexOf('@');
  if (at >= 0) {
    host = host.slice(at + 1);
  }
  const colon = host.lastIndexOf(':');
  if (colon >= 0) {
    host = host.slice(0, colon);
  }
  host = host.toLowerCase();
  if (!host.endsWith('.turso.io')) {
    return ['', false];
  }
  const label = host.slice(0, -'.turso.io'.length);
  if (label === '' || label.includes('.')) {
    return ['', false];
  }
  return [label, true];
}
