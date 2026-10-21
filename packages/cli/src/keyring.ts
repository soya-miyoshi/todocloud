// Module keyring stores provider tokens in the operating system's keychain,
// which is the recommended place for an interactive user: a config file can
// end up committed to a repository, and an exported environment variable
// tends to end up in a dotfiles repository.
//
// The keychain is reached by executing the system's own binaries — `security`
// on macOS, `secret-tool` on Linux — never by linking a framework, so that no
// native module and no build step is involved on any supported platform. Two
// consequences follow, and both are load-bearing:
//
//   - A token must never reach the child's argv. `ps` shows argv to every user
//     on the machine and the shell writes it to its history file. Every secret
//     this module passes to a child goes through the child's stdin, which here
//     means `spawnSync`'s `input` option and nothing else.
//   - A platform whose binary cannot accept a secret that way simply has no
//     writable backend. Set then throws ErrWriteUnsupported and the caller
//     prints ManualInstructions instead of failing; reading still works.
//
// Nothing in this module formats a token into an error, a message or a log
// line: values are carried as Secret, and a child's stdout — which holds the
// token on a read — is never quoted into an error.
//
// The Go package selected one of three implementations with build tags. There
// are no build tags here, so all three live in this file and `currentBackend`
// dispatches on `process.platform` at runtime. The three are kept apart below,
// in the order darwin, linux, unsupported, exactly as the Go files were.
//
// This module belongs to `packages/cli` rather than `packages/core`: it spawns
// processes, so it imports `node:*`, which the PWA cannot resolve.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { REDACTED, Secret } from "@todocloud/core/secret";

/** Service is the keychain service name every entry is filed under. */
export const Service = "todocloud";

// Account names for the entries this CLI owns.
export const AccountTursoToken = "turso.token";
export const AccountD1Token = "d1.token";

// Backend names reported by Backend.
export const BackendKeychain = "keychain";
export const BackendSecretTool = "secret-tool";
export const BackendNone = "none";

// ErrUnavailable and ErrWriteUnsupported let callers degrade instead of fail.
// A command that cannot store a token is still a successful command: the user
// is told what to run themselves.
//
// Go returned these as sentinel errors and callers used `errors.Is`. They are
// sentinel Error instances here, thrown directly or set as the `cause` of a
// more specific error, and `Is` below is the `errors.Is` of this module.

/** ErrUnavailable means no keychain backend exists on this machine. */
export const ErrUnavailable = new Error(
  "no OS keychain backend is available on this platform",
);

/**
 * ErrWriteUnsupported means a backend exists and can be read, but its binary
 * cannot be given a secret without exposing it in argv.
 */
export const ErrWriteUnsupported = new Error(
  "this platform's keychain binary cannot accept a secret without exposing it in argv",
);

/**
 * Is reports whether err is target or wraps it, which is what `errors.Is` did
 * for the Go callers of this package. Only the `cause` chain is walked: this
 * module wraps a sentinel one level deep and nothing here wraps a wrap.
 */
export function Is(err: unknown, target: Error): boolean {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 16; depth++) {
    if (current === target) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Placeholder stands in for the token in every instruction this module
 * prints. It is obviously fake, so a user who pastes the line unchanged gets
 * an obviously wrong entry rather than a plausible one.
 */
export const Placeholder = "TOKEN_GOES_HERE";

/**
 * notFoundExitCode is what `security` returns for "the item does not exist",
 * which is not a failure.
 */
const notFoundExitCode = 44;

/**
 * Options carries what the Go functions took a `context.Context` for. The
 * caller decides the deadline — `tdo` reads the keychain with a two-second
 * timeout — so there is deliberately no default here.
 */
export interface Options {
  /** timeoutMs kills the child after this many milliseconds. */
  timeoutMs?: number;
}

/**
 * Entry is what Get returns. Go returned `(secret.Secret, bool, error)`; the
 * error half is thrown, and present is false when no entry exists, which is
 * not an error.
 */
export interface Entry {
  value: Secret;
  present: boolean;
}

/**
 * Backend reports which mechanism is in use: "keychain" (macOS security),
 * "secret-tool" (Linux libsecret) or "none".
 */
export function Backend(): string {
  return currentBackend().name;
}

/** Available reports whether a keychain backend is usable on this machine. */
export function Available(): boolean {
  return currentBackend().name !== BackendNone;
}

/**
 * Get returns the stored token. `present` is false when no entry exists,
 * which is not an error.
 */
export function Get(account: string, opts: Options = {}): Entry {
  validateAccount(account);
  const b = currentBackend();
  if (b.name === BackendNone || b.get === undefined) {
    throw ErrUnavailable;
  }
  return b.get(account, opts);
}

/**
 * Set stores or replaces a token. It throws an error wrapping
 * ErrWriteUnsupported when the platform's binary cannot accept a secret
 * without exposing it in argv.
 */
export function Set(account: string, value: Secret, opts: Options = {}): void {
  validateAccount(account);
  if (value.empty()) {
    throw new Error("refusing to store an empty token");
  }
  const b = currentBackend();
  if (b.name === BackendNone) {
    throw ErrUnavailable;
  }
  // An undefined set means the platform can be read but not written.
  if (b.set === undefined) {
    throw ErrWriteUnsupported;
  }
  b.set(account, value, opts);
}

/** Delete removes an entry. Deleting a missing entry is not an error. */
export function Delete(account: string, opts: Options = {}): void {
  validateAccount(account);
  const b = currentBackend();
  if (b.name === BackendNone || b.delete === undefined) {
    throw ErrUnavailable;
  }
  b.delete(account, opts);
}

/**
 * ManualInstructions returns the command the user can run themselves to store
 * account's token, for the platforms where Set is unsupported. It must contain
 * a placeholder, never a real token.
 */
export function ManualInstructions(account: string): string {
  return manualInstructionsFor(currentPlatform(), account);
}

/**
 * validateAccount rejects anything that is not one of the entries this CLI
 * owns. Accepting a caller-chosen name would let an account string shaped
 * like a flag reach a child's argv.
 */
function validateAccount(account: string): void {
  switch (account) {
    case AccountTursoToken:
    case AccountD1Token:
      return;
    default:
      throw new Error(`unknown keyring account ${JSON.stringify(account)}`);
  }
}

/**
 * Impl is one platform's implementation. An undefined set means the platform
 * can be read but not written, which is reported as ErrWriteUnsupported.
 */
interface Impl {
  name: string;
  get?: (account: string, opts: Options) => Entry;
  set?: (account: string, value: Secret, opts: Options) => void;
  delete?: (account: string, opts: Options) => void;
}

/** Command is a child to run: its argv, and the text fed to its stdin. */
interface Command {
  /** bin is the binary name, looked up on PATH by the child spawn. */
  bin: string;
  /** args is the argv after the binary name. It never holds a secret. */
  args: string[];
  /** stdin is the text written to the child's standard input. */
  stdin?: string;
}

// --- Shared helpers ----------------------------------------------------

/**
 * lookPath is `exec.LookPath`, replaced in tests to simulate a machine where
 * a backend's binary is absent. The Go package used a package-level `var`
 * that its in-package tests reassigned; the hook is on `forTest` below
 * because the tests here are a separate module.
 */
let lookPath: (file: string) => string | null = defaultLookPath;

/**
 * platformOverride stands in for Go's build tags. Without it, two of the
 * three implementations in this file are unreachable from a test run on any
 * one machine, which is the one thing the build-tagged Go files got for free.
 */
let platformOverride: string | null = null;

function currentPlatform(): string {
  return platformOverride ?? process.platform;
}

/**
 * defaultLookPath resolves file against PATH. The executable bit is what
 * decides, not whether the file is a working program: a `security` on PATH
 * that the kernel refuses to execute is a detected backend whose child fails,
 * and that failure has to be reported rather than read as an absence.
 */
function defaultLookPath(file: string): string | null {
  const pathEnv = process.env["PATH"] ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === "") {
      continue;
    }
    const candidate = path.join(dir, file);
    try {
      // A directory can carry the executable bit too, so the type is checked
      // as well.
      if (!fs.statSync(candidate).isFile()) {
        continue;
      }
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

/** Result is the outcome of a child process. */
interface Result {
  /**
   * code is the child's exit status, or -1 when it never ran — which is
   * `exitCode` in the Go package.
   */
  code: number;
  stdout: string;
  stderr: string;
  /** error is set when the child could not be started or was killed. */
  error: Error | undefined;
}

/**
 * run executes a command. The secret, when there is one, travels in `input`,
 * which `spawnSync` writes to the child's standard input — never in args.
 */
function run(cmd: Command, opts: Options): Result {
  const spawned = spawnSync(cmd.bin, cmd.args, {
    encoding: "utf8",
    ...(cmd.stdin === undefined ? {} : { input: cmd.stdin }),
    ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
  });
  return {
    code: spawned.error !== undefined ? -1 : (spawned.status ?? -1),
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
    error: spawned.error,
  };
}

/** ok reports whether the child ran and exited zero. */
function ok(r: Result): boolean {
  return r.error === undefined && r.code === 0;
}

/**
 * trimOneNewline removes exactly one trailing line ending and nothing else.
 * A token must not be silently altered: trailing whitespace that is not the
 * terminator the binary added is part of the value as far as this code knows.
 */
function trimOneNewline(s: string): string {
  if (s.endsWith("\r\n")) {
    return s.slice(0, -2);
  }
  if (s.endsWith("\n")) {
    return s.slice(0, -1);
  }
  return s;
}

/**
 * childError builds the error for a failed child process. It reports only the
 * exit status and stderr; the child's stdout is deliberately excluded, because
 * on a read it holds the token itself.
 */
function childError(name: string, r: Result, stderr: string): Error {
  const trimmed = stderr.trim();
  if (r.error === undefined) {
    if (trimmed === "") {
      return new Error(`${name} exited with status ${r.code}`);
    }
    return new Error(`${name} exited with status ${r.code}: ${trimmed}`);
  }
  if (trimmed === "") {
    return new Error(`${name}: ${r.error.message}`, { cause: r.error });
  }
  return new Error(`${name}: ${r.error.message}: ${trimmed}`, {
    cause: r.error,
  });
}

/**
 * lexicallySafe reports whether value can be embedded in a command line that
 * a child's own lexer will parse without mangling or splitting it. The set is
 * deliberately narrow: it covers every token shape the supported providers
 * issue (hex, base64url, JWTs) and nothing that needs quoting.
 */
function lexicallySafe(value: string): boolean {
  if (value === "") {
    return false;
  }
  // A regular expression over the whole string rather than a loop, because
  // the set is a character class; `u` keeps a lone surrogate from passing.
  return /^[A-Za-z0-9\-_.~+/=:]+$/u.test(value);
}

/**
 * scrub removes value from text, so that a child's diagnostics cannot carry
 * the token into an error message even if the child echoed its input back.
 */
function scrub(text: string, value: Secret): string {
  if (value.empty()) {
    return text;
  }
  return text.split(value.reveal()).join(REDACTED);
}

// --- darwin ------------------------------------------------------------

/**
 * securityBin is the macOS keychain binary. It is looked up on PATH rather
 * than hard-coded so that its absence is reported as "unavailable".
 */
const securityBin = "security";

// macOS writes through `security -i`, not `security add-generic-password`.
//
// This was settled empirically, because it decides whether this platform can
// store a token at all:
//
//	printf 'FAKE' | security add-generic-password -s svc -a acct -U
//
// exits 0 and creates the item — with an *empty* password. The same holds for
// a bare `-w` with no value. The binary does not read the password from piped
// stdin; it takes it only from `-w <value>`, which would put the token in
// argv, or from /dev/tty. Storing an empty password silently would be worse
// than not storing at all.
//
// `security -i` reads its *commands* from stdin instead. The child's argv is
// exactly {"security", "-i"} — the token is in the command text on stdin, so
// `ps` and the shell history never see it. Verified to round-trip, including
// base64 and JWT-shaped values, and to replace an existing item with -U.
//
// The cost is that the token is parsed by security's own command lexer, so a
// value containing whitespace, a quote or a backslash could be mangled or
// split. Rather than guess at its quoting rules, a token outside a
// conservative character set is refused as unsupported and the user is given
// the command to run themselves.

function darwinImpl(): Impl {
  if (lookPath(securityBin) === null) {
    return { name: BackendNone };
  }
  return {
    name: BackendKeychain,
    get: darwinGet,
    set: darwinSet,
    delete: darwinDelete,
  };
}

function darwinGet(account: string, opts: Options): Entry {
  // -w writes the password to stdout, so nothing secret reaches argv.
  const r = run(
    {
      bin: securityBin,
      args: ["find-generic-password", "-s", Service, "-a", account, "-w"],
    },
    opts,
  );
  if (!ok(r)) {
    if (r.code === notFoundExitCode) {
      return { value: new Secret(""), present: false };
    }
    throw childError(securityBin, r, r.stderr);
  }
  const value = trimOneNewline(r.stdout);
  if (value === "") {
    // An item with an empty password is not a usable credential, and
    // reporting it as present would hide the real problem.
    return { value: new Secret(""), present: false };
  }
  return { value: new Secret(value), present: true };
}

function darwinSet(account: string, value: Secret, opts: Options): void {
  if (!lexicallySafe(value.reveal())) {
    throw new Error(
      `${ErrWriteUnsupported.message}: the token contains a character the macOS keychain binary cannot be given safely`,
      { cause: ErrWriteUnsupported },
    );
  }
  // The child's stdout is discarded: `security -i` echoes nothing useful and
  // anything it did echo could hold the value.
  const r = run(darwinSetCommand(account, value), opts);
  if (!ok(r)) {
    throw childError(securityBin, r, scrub(r.stderr, value));
  }
}

/**
 * darwinSetCommand builds the write command and the text fed to its stdin. It
 * is separate so that a test can assert the token appears in the stdin text
 * and never in the argv.
 */
function darwinSetCommand(account: string, value: Secret): Command {
  return {
    bin: securityBin,
    args: ["-i"],
    // -U updates an existing item instead of failing with a duplicate.
    stdin: `add-generic-password -s ${Service} -a ${account} -U -w ${value.reveal()}\n`,
  };
}

function darwinDelete(account: string, opts: Options): void {
  const r = run(
    {
      bin: securityBin,
      args: ["delete-generic-password", "-s", Service, "-a", account],
    },
    opts,
  );
  if (!ok(r)) {
    if (r.code === notFoundExitCode) {
      return;
    }
    throw childError(securityBin, r, r.stderr);
  }
}

function darwinManualInstructions(account: string): string {
  return `security add-generic-password -s ${Service} -a ${account} -U -w ${Placeholder}`;
}

// --- linux -------------------------------------------------------------

/**
 * secretToolBin is the libsecret CLI. Unlike macOS's `security`, it reads the
 * secret from stdin by design, so a write needs no workaround.
 */
const secretToolBin = "secret-tool";

function linuxImpl(): Impl {
  if (lookPath(secretToolBin) === null) {
    return { name: BackendNone };
  }
  return {
    name: BackendSecretTool,
    get: linuxGet,
    set: linuxSet,
    delete: linuxDelete,
  };
}

function linuxGet(account: string, opts: Options): Entry {
  const r = run(
    {
      bin: secretToolBin,
      args: ["lookup", "service", Service, "account", account],
    },
    opts,
  );
  if (!ok(r)) {
    // `secret-tool lookup` exits non-zero with nothing on either stream
    // when the item simply does not exist. A real failure — no session
    // bus, a locked collection — says so on stderr.
    if (r.code > 0 && r.stdout.length === 0 && r.stderr.trim() === "") {
      return { value: new Secret(""), present: false };
    }
    throw childError(secretToolBin, r, r.stderr);
  }
  const value = trimOneNewline(r.stdout);
  if (value === "") {
    return { value: new Secret(""), present: false };
  }
  return { value: new Secret(value), present: true };
}

function linuxSet(account: string, value: Secret, opts: Options): void {
  const r = run(linuxSetCommand(account, value), opts);
  if (!ok(r)) {
    throw childError(secretToolBin, r, scrub(r.stderr, value));
  }
}

/**
 * linuxSetCommand builds the write command and the text fed to its stdin, so
 * that a test can assert the token reaches stdin and never the argv.
 */
function linuxSetCommand(account: string, value: Secret): Command {
  return {
    bin: secretToolBin,
    args: [
      "store",
      `--label=${Service} ${account}`,
      "service",
      Service,
      "account",
      account,
    ],
    // secret-tool reads the secret from stdin and stops at the first newline,
    // so the value is written on its own without a terminator.
    stdin: value.reveal(),
  };
}

function linuxDelete(account: string, opts: Options): void {
  // `secret-tool clear` succeeds whether or not anything matched.
  const r = run(
    {
      bin: secretToolBin,
      args: ["clear", "service", Service, "account", account],
    },
    opts,
  );
  if (!ok(r)) {
    throw childError(secretToolBin, r, r.stderr);
  }
}

function linuxManualInstructions(account: string): string {
  return `printf %s ${Placeholder} | secret-tool store --label=${JSON.stringify(
    `${Service} ${account}`,
  )} service ${Service} account ${account}`;
}

// --- every other platform ----------------------------------------------

// Windows has no usable CLI for this: `cmdkey` can store a credential but
// cannot print one back, so a token stored there could never be read by this
// tool. Every other platform is simply unknown. In both cases there is no
// backend, and no command may fail because of it — the environment variable
// or the config file is used instead.
function unsupportedImpl(): Impl {
  return { name: BackendNone };
}

/**
 * unsupportedManualInstructions has nothing to run, so it explains where the
 * token goes instead.
 */
function unsupportedManualInstructions(account: string): string {
  return (
    `no OS keychain is available on this platform; set the ${account} token in the environment ` +
    `or in the config file (for example TODOCLOUD_TURSO_TOKEN=${Placeholder})`
  );
}

// --- dispatch ----------------------------------------------------------

/**
 * currentBackend picks the implementation for this machine. This is what the
 * `//go:build` lines did in the Go tree; the detection inside each one — is
 * the binary on PATH — is unchanged.
 */
function currentBackend(): Impl {
  switch (currentPlatform()) {
    case "darwin":
      return darwinImpl();
    case "linux":
      return linuxImpl();
    default:
      return unsupportedImpl();
  }
}

function manualInstructionsFor(platform: string, account: string): string {
  switch (platform) {
    case "darwin":
      return darwinManualInstructions(account);
    case "linux":
      return linuxManualInstructions(account);
    default:
      return unsupportedManualInstructions(account);
  }
}

/**
 * forTest is the one thing this module exports that the Go package did not.
 * Go's tests lived inside the package and reached its unexported functions
 * and its `lookPath` var directly; a test file here is a separate module, so
 * the same reach has to be granted explicitly. Nothing outside a test may use
 * it: the supported surface is everything above.
 */
export const forTest = {
  /** setLookPath replaces PATH resolution; null restores the real one. */
  setLookPath(fn: ((file: string) => string | null) | null): void {
    lookPath = fn ?? defaultLookPath;
  },
  /** setPlatform forces one platform's branch; null restores the real one. */
  setPlatform(platform: string | null): void {
    platformOverride = platform;
  },
  /**
   * setCommand exposes the command Set builds for one platform, so the argv
   * test can inspect it on any host without running it.
   */
  setCommand(platform: string, account: string, value: Secret): Command {
    switch (platform) {
      case "darwin":
        return darwinSetCommand(account, value);
      case "linux":
        return linuxSetCommand(account, value);
      default:
        throw new Error(`no writable backend on ${platform}`);
    }
  },
  manualInstructionsFor,
  trimOneNewline,
  lexicallySafe,
  scrub,
  childError,
  securityBin,
  secretToolBin,
  notFoundExitCode,
};
