// The command layer: the command table, the flag parsing, the store
// construction and the mapping from a failure onto one of the fixed exit
// codes.
//
// Everything a command needs is reached through an `App` value, which holds
// the injected environment. That indirection is what lets the tests drive the
// real command tree with captured streams and a controlled environment
// instead of touching the user's own configuration or state directory.
//
// Go's `urfave/cli/v3` has no replacement here. The dispatcher below is
// hand-written over `node:util`'s `parseArgs`, which is a deliberate project
// decision (PLAN.md §1, MIGRATION.md, CLAUDE.md §3): exit code 2 for a usage
// error and the exact `--json` shapes in docs/agents.md are contracts, and a
// framework owns both. `parseArgs` knows nothing about subcommands, so argv is
// split here, the command is resolved, and `parseArgs` is then called once
// with that command's own option descriptors merged over the global ones.
//
// Go attached the helpers below to the `*app` receiver. A TypeScript class
// cannot be extended from another file, so the methods that `app.go` itself
// owned — the store construction and the override notice — stay on the `App`
// class, and the helpers that lived on the receiver in `refs.go` and
// `view.ts` are free functions taking the app as their first parameter. That
// is the whole of the shape change; the exported surface is otherwise 1:1.
//
// ===========================================================================
// THE COMMAND-REGISTRATION CONTRACT
// ===========================================================================
//
// A command is a plain object. Nothing is registered by a side effect, there
// is no decorator and no base class: a command module exports a factory that
// takes the `App` and returns a `Command`, and the factory's name is added to
// `registry` at the bottom of this file, in the order the command should read
// in `tdo --help`.
//
//   1. `name` is the word typed on the command line. `usage` is the one line
//      `tdo --help` prints beside it. `argsUsage` is the argument summary in
//      the command's own help, e.g. "<ref>...".
//
//   2. `flags` maps a long flag name to its descriptor. `type` is 'boolean'
//      or 'string' — there is no number type, because a numeric flag has to
//      report its own bad input as a usage error anyway. `multiple: true`
//      makes a repeated flag collect into an array. A flag never takes a
//      secret (CLAUDE.md §1.6): there is no `--token` flag and there must
//      never be one. The four global flags (--json, --debug, --config,
//      --provider) are added to every command automatically and must not be
//      redeclared.
//
//   3. `store` says what the command needs from the store, and the dispatcher
//      does the opening, the schema check and the closing:
//        'read'      — open, check the schema version, run, close.
//        'write'     — the same, and name the store on stderr first when the
//                      provider was overridden, so a stale TODOCLOUD_PROVIDER
//                      cannot quietly redirect a write.
//        'create'    — `tdo init` only: may bring the store into being, and
//                      refuses a stray argument before it does.
//        'unchecked' — `tdo migrate`/`tdo doctor` only: skips the version
//                      check, because the mismatch is the subject.
//      Omit it for a command that needs no store at all. Inside `run`, the
//      store is `ctx.store()`.
//
//   4. `run(ctx)` is the body. It returns a promise, writes machine output
//      through `ctx.app.out.emit` and everything else through `warnf`,
//      `hintf` and `debugf`, and reports a failure by throwing. Every failure
//      is routed through `classify`, so a command never chooses an exit code:
//      it throws `usagef(...)` for a mistake at the command line, a store
//      sentinel for a missing or ambiguous task, and a plain Error otherwise.
//
//   5. `subcommands` replaces `run` for a command that is only a group, such
//      as `tdo project`. A group's own flags are parsed before the
//      subcommand name, exactly as the global flags are.
//
// A worked example — this is the whole of a command, and it compiles:
//
//   import type { Store } from '@todocloud/core/store';
//   import { type App, type Command, type Context, usagef } from './app.ts';
//   import { resolveRef } from './refs.ts';
//   import { renderTask } from './view.ts';
//
//   export function showCommand(a: App): Command {
//     return {
//       name: 'show',
//       usage: 'show one item in full, including why it is blocked',
//       argsUsage: '<ref>',
//       store: 'read',
//       flags: {},
//       async run(ctx: Context): Promise<void> {
//         if (ctx.args.length !== 1) {
//           throw usagef('show expects exactly one item reference');
//         }
//         const st: Store = ctx.store();
//         const t = await resolveRef(a, st, ctx.args[0] ?? '');
//         await renderTask(a, st, t);
//       },
//     };
//   }
//
// Then, in `registry` below: `showCommand,`.
//
// ===========================================================================

import { isatty } from 'node:tty';
import { parseArgs } from 'node:util';

import * as exit from '@todocloud/core/exit';
import { Printer } from '@todocloud/core/output';
import type { Writer } from '@todocloud/core/output';
import type { Store } from '@todocloud/core/store';
import { checkSchema } from '@todocloud/core/store/version';
import { open as openSQLite, openExisting as openExistingSQLite } from '@todocloud/store-sqlite';
import { open as openTurso, openExisting as openExistingTurso } from '@todocloud/store-turso';

import * as config from './config.ts';
import * as keyring from './keyring.ts';
import { addCommand } from './add.ts';
import { configCommand, doctorCommand, initCommand, migrateCommand, versionCommand } from './admin.ts';
import { editCommand } from './edit.ts';
import { forecastCommand } from './forecast.ts';
import { inboxCommand, listAliasCommand, listCommand, nextCommand } from './list.ts';
import { loginCommand } from './login.ts';
import {
  deferCommand,
  doneCommand,
  dropCommand,
  dueCommand,
  flagItemsCommand,
  holdCommand,
  moveCommand,
  undoneCommand,
  unflagCommand,
  unholdCommand,
} from './mark.ts';
import { removeAliasCommand, removeCommand } from './remove.ts';
import { perspectiveCommand, repeatCommand, reviewCommand, seriesCommand } from './repeat.ts';
import { serveCommand } from './serve.ts';
import { showCommand } from './show.ts';
import { folderCommand, projectCommand } from './structure.ts';
import { tagCommand } from './tags.ts';
import { exportCommand, importCommand } from './transfer.ts';

/**
 * Reader is what a command reads stdin through: one call returning everything
 * there is. Go took an `io.Reader`; the two users of it — `tdo import -` and
 * the `tdo rm --purge` confirmation — both want the whole of the input, and a
 * promise is the only honest shape for that in Node.
 */
export interface Reader {
  read(): Promise<string>;
  /**
   * readLine resolves with the first line, newline included, or with whatever
   * arrived if the input ended first. A prompt on a terminal needs it: the
   * terminal's Enter is not an end of input, so `read` would wait for Ctrl-D.
   * A test reader may leave it out, and `read` stands in.
   */
  readLine?(): Promise<string>;
}

/**
 * Ticker is how a redrawing command waits between frames: one call that
 * resolves true to draw again and false to stop. `--watch` is the only user
 * of it (see watch.ts).
 *
 * It is a seam for the same reason `stdinIsTTY` is one. A loop that waits on
 * a real timer and stops on a real SIGINT cannot be driven from a test: the
 * test would have to wait out the interval it is trying to check, and it has
 * no signal to send. A test supplies a ticker that counts frames instead, and
 * what it exercises is the loop itself rather than an imitation of it.
 */
export interface Ticker {
  wait(ms: number): Promise<boolean>;
}

/**
 * Env is everything the command layer reads from outside the process
 * arguments. Every field is optional and defaults to the real process, which
 * is what the Go zero value meant.
 */
export interface Env {
  stdout?: Writer | undefined;
  stderr?: Writer | undefined;
  stdin?: Reader | undefined;
  /**
   * getenv reads an environment variable. Tests supply a closed-over map so
   * that a developer's own TODOCLOUD_* variables cannot change a result.
   */
  getenv?: ((name: string) => string) | undefined;
  /**
   * stdinIsTTY reports whether stdin is a terminal. It replaces
   * mattn/go-isatty with `node:tty`'s isatty, and it is a field rather than a
   * call so that `tdo rm --purge` can be tested in both directions: it must
   * refuse rather than prompt when stdin is not a terminal, and a test cannot
   * give itself one.
   */
  stdinIsTTY?: (() => boolean) | undefined;
  /**
   * stdoutIsTTY reports whether stdout is a terminal. `--watch` takes the
   * screen over, so it needs one, and a redirected stdout is a mistake worth
   * naming rather than a stream of escape sequences in a file.
   */
  stdoutIsTTY?: (() => boolean) | undefined;
  /**
   * ticker paces a redrawing command. Left unset, watch.ts builds the one
   * over `setTimeout` and SIGINT.
   */
  ticker?: Ticker | undefined;
  /**
   * keyring is the seam through which configuration resolves a token from the
   * OS keychain. Go had it as a package variable (`configKeyringLookup`);
   * here it is injected, for the same reason: without it, a test that runs
   * with a cloud provider selected would query the developer's real keychain,
   * which CLAUDE.md §1.5 forbids and which would make the result depend on
   * the machine. Left unset, `config.Load` uses its own default.
   */
  keyring?: config.KeyringLookup | undefined;
}

/** Everything in an Env, resolved. */
interface ResolvedEnv {
  stdout: Writer;
  stderr: Writer;
  stdin: Reader;
  getenv: (name: string) => string;
  stdinIsTTY: () => boolean;
  stdoutIsTTY: () => boolean;
  ticker: Ticker | undefined;
  keyring: config.KeyringLookup | undefined;
}

/** emptyReader is the default stdin for a process that was given none. */
const emptyReader: Reader = {
  read: (): Promise<string> => Promise.resolve(''),
};

/** processStdin reads the whole of the real stdin. */
export const processStdin: Reader = {
  async read(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString('utf8');
  },
  readLine(): Promise<string> {
    return new Promise((resolve) => {
      let buf = '';
      const finish = (text: string): void => {
        process.stdin.off('data', onData);
        process.stdin.off('end', onEnd);
        // Paused so that the process can exit once the prompt is answered.
        process.stdin.pause();
        resolve(text);
      };
      const onData = (chunk: string): void => {
        buf += chunk;
        const i = buf.indexOf('\n');
        if (i >= 0) {
          finish(buf.slice(0, i + 1));
        }
      };
      const onEnd = (): void => finish(buf);
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
    });
  },
};

function normalizeEnv(env: Env): ResolvedEnv {
  return {
    stdout: env.stdout ?? process.stdout,
    stderr: env.stderr ?? process.stderr,
    stdin: env.stdin ?? processStdin,
    getenv: env.getenv ?? ((name: string): string => process.env[name] ?? ''),
    stdinIsTTY: env.stdinIsTTY ?? ((): boolean => isatty(0)),
    stdoutIsTTY: env.stdoutIsTTY ?? ((): boolean => isatty(1)),
    ticker: env.ticker,
    keyring: env.keyring,
  };
}

/**
 * keyringLookup is the default Env.keyring: the real keychain, with a short
 * timeout so that a wedged helper cannot hang every command.
 */
export function keyringLookup(account: string): keyring.Entry {
  return keyring.Get(account, { timeoutMs: keyringTimeoutMs });
}

/**
 * keyringTimeoutMs bounds the keychain lookup. A local keychain answers in
 * milliseconds; the timeout exists so that a hung helper process cannot wedge
 * every command.
 */
export const keyringTimeoutMs = 2_000;

/**
 * SilentError carries an exit code without a message. `tdo doctor` uses it to
 * report a failed check through its own documented JSON shape rather than
 * through the error envelope.
 */
export class SilentError extends Error {
  override readonly name = 'SilentError';
  readonly code: number;

  constructor(code: number) {
    super('');
    this.code = code;
  }
}

/** usagef returns a usage error, which exits with code 2. */
export function usagef(message: string): Error {
  return exit.usagef(new Error(message)) as Error;
}

/** asError normalizes a thrown value, which TypeScript types as `unknown`. */
export function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** configf marks a configuration or credential problem. Exit 3. */
function configf(err: unknown): Error {
  return exit.configf(asError(err)) as Error;
}

/** providerf marks a provider or network failure. Exit 4. */
function providerf(err: unknown): Error {
  return exit.providerf(asError(err)) as Error;
}

// ---------------------------------------------------------------------------
// The command shape. See THE COMMAND-REGISTRATION CONTRACT above.
// ---------------------------------------------------------------------------

/** What a command needs from the store; see the contract, point 3. */
export type StoreMode = 'read' | 'write' | 'create' | 'unchecked';

/** Flag is one flag's descriptor. */
export interface Flag {
  /**
   * type is 'boolean' for a flag that takes no value and 'string' for one
   * that does. There is deliberately no number type: a numeric flag has to
   * report its own bad input as a usage error, so it parses the string.
   */
  type: 'boolean' | 'string';
  /** usage is the line printed beside the flag in the command's help. */
  usage: string;
  /** multiple collects a repeated flag into an array. */
  multiple?: boolean | undefined;
  /**
   * placeholder names the value in the help line, e.g. `PATH`. Go wrote it
   * inside the usage string in backticks; here it is its own field.
   */
  placeholder?: string | undefined;
  /** hidden keeps a flag out of the help, for a deprecated spelling. */
  hidden?: boolean | undefined;
}

/** Flags is a command's flag set, keyed by the long name without dashes. */
export type Flags = Readonly<Record<string, Flag>>;

/** Command is one entry in the command table. */
export interface Command {
  /** name is the word typed on the command line. */
  name: string;
  /** usage is the one-line summary `tdo --help` prints. */
  usage: string;
  /** argsUsage summarises the positional arguments, e.g. "<ref>...". */
  argsUsage?: string | undefined;
  /** flags are this command's own flags; the global four are added to them. */
  flags?: Flags | undefined;
  /** store says what the command needs from the store, if anything. */
  store?: StoreMode | undefined;
  /** run is the command body. A group leaves it unset. */
  run?: ((ctx: Context) => Promise<void>) | undefined;
  /** subcommands makes this a group, such as `tdo project`. */
  subcommands?: readonly Command[] | undefined;
  /** hidden keeps the command out of `tdo --help`. */
  hidden?: boolean | undefined;
}

/** CommandFactory is what a command module exports. */
export type CommandFactory = (a: App) => Command;

/** ParsedValues is what parseArgs produced for one command. */
type ParsedValues = Record<string, string | boolean | string[] | boolean[] | undefined>;

/**
 * Context is what a command body is handed: the resolved flags, the
 * positional arguments, the app and — when the command declared a store mode
 * — the open store.
 */
export class Context {
  /** app is the shared state: streams, printer, configuration. */
  readonly app: App;
  /**
   * name is the command's full path, so that an error message reads
   * "project ls" rather than "ls".
   */
  readonly name: string;
  /** args are the positional arguments, in order, `--` already removed. */
  readonly args: readonly string[];

  private readonly values: ParsedValues;
  private readonly opened: Store | undefined;

  constructor(
    app: App,
    name: string,
    args: readonly string[],
    values: ParsedValues,
    opened: Store | undefined,
  ) {
    this.app = app;
    this.name = name;
    this.args = args;
    this.values = values;
    this.opened = opened;
  }

  /** bool reports a boolean flag's value; false when it was not given. */
  bool(name: string): boolean {
    const v = this.values[name];
    if (Array.isArray(v)) {
      // A repeated boolean: given at all means true, as urfave had it.
      return v.length > 0;
    }
    return v === true;
  }

  /** string reports a string flag's value; "" when it was not given. */
  string(name: string): string {
    const v = this.values[name];
    if (Array.isArray(v)) {
      // The last wins, which is what urfave did for a non-slice flag.
      const last = v[v.length - 1];
      return typeof last === 'string' ? last : '';
    }
    return typeof v === 'string' ? v : '';
  }

  /** strings reports a repeated flag's values, in the order they were given. */
  strings(name: string): string[] {
    const v = this.values[name];
    if (Array.isArray(v)) {
      return v.filter((e): e is string => typeof e === 'string');
    }
    return typeof v === 'string' ? [v] : [];
  }

  /**
   * isSet reports whether the flag appeared on the command line at all. It is
   * the difference between `--note ""`, which clears the note, and no --note
   * at all, which leaves it alone.
   */
  isSet(name: string): boolean {
    return this.values[name] !== undefined;
  }

  /**
   * store returns the store the dispatcher opened for this command. It throws
   * for a command that declared no store mode, which is a programming
   * mistake rather than anything a user can cause.
   */
  store(): Store {
    if (this.opened === undefined) {
      throw new Error(`internal: ${this.name} did not declare a store mode`);
    }
    return this.opened;
  }
}

/**
 * globalFlags are accepted before and after the subcommand, so that
 * `tdo ls --json` and `tdo --json ls` behave identically. Go got that from
 * urfave applying a non-Local flag to every subcommand's flag set; here they
 * are merged into every command's option descriptors and scanned ahead of the
 * command name as well.
 */
export const globalFlags: Flags = {
  json: { type: 'boolean', usage: 'write machine-readable JSON on stdout' },
  debug: { type: 'boolean', usage: 'write diagnostics to stderr (never a credential)' },
  config: {
    type: 'string',
    placeholder: 'PATH',
    usage: 'read configuration from PATH instead of the default',
  },
  provider: {
    type: 'string',
    placeholder: 'NAME',
    usage: 'override the configured provider NAME',
  },
};

/**
 * helpFlag is understood everywhere. It is kept out of globalFlags because it
 * never reaches a command body: the dispatcher answers it and returns.
 */
const helpFlag: Flags = {
  help: { type: 'boolean', usage: 'show this help' },
};

/** App carries the state shared by every command. */
export class App {
  /** env is the injected environment, fully resolved. */
  readonly env: ResolvedEnv;
  /** out renders every byte this process writes. */
  out: Printer;

  /** configPath and providerName mirror the global flags of the same name. */
  configPath = '';
  providerName = '';

  /**
   * cfg caches the resolved configuration, and warned records that its
   * warnings have already been printed, so a command that opens the store
   * twice does not repeat them.
   */
  cfg: config.Config | undefined = undefined;
  private warned = false;

  constructor(env: Env = {}) {
    this.env = normalizeEnv(env);
    this.out = new Printer({ out: this.env.stdout, err: this.env.stderr });
  }

  /**
   * config resolves the configuration once per process, applying the
   * --provider override and printing any warnings to stderr.
   */
  config(): config.Config {
    if (this.cfg !== undefined) {
      return this.cfg;
    }
    let cfg: config.Config;
    try {
      const opts: config.Options = { Getenv: this.env.getenv, ConfigPath: this.configPath };
      if (this.env.keyring !== undefined) {
        opts.Keyring = this.env.keyring;
      }
      cfg = config.Load(opts);
    } catch (err) {
      throw configf(err);
    }
    if (this.providerName !== '') {
      cfg.Provider = this.providerName.trim();
      cfg.Origins['provider'] = 'flag:--provider';
    }
    try {
      cfg.Validate();
    } catch (err) {
      throw configf(err);
    }
    if (!this.warned) {
      for (const w of cfg.Warnings) {
        this.out.warnf(w);
      }
      this.warned = true;
    }
    this.cfg = cfg;
    return cfg;
  }

  /**
   * openStore resolves the configuration and opens the configured provider.
   * The caller closes the store.
   *
   * create says whether this command is allowed to bring the store into
   * being. Only `tdo init` passes true: a command that merely reads must not
   * leave a directory tree and an empty database behind when the path is a
   * typo, because an empty task list is indistinguishable from the real one.
   */
  async openStore(create: boolean): Promise<Store> {
    const cfg = this.config();
    if (!config.providerImplemented(cfg.Provider)) {
      throw configf(
        new Error(`provider ${JSON.stringify(cfg.Provider)} is not implemented in this build`),
      );
    }
    switch (cfg.Provider) {
      case config.ProviderSQLite: {
        let path: string;
        try {
          path = config.ExpandPath(cfg.SQLite.Path);
        } catch (err) {
          throw configf(err);
        }
        this.out.debugf(`opening sqlite store at ${path}`);
        try {
          return create ? openSQLite(path) : openExistingSQLite(path);
        } catch (err) {
          // An uninitialized store is a configuration problem, and classify
          // reads the sentinel through the wrapper.
          throw providerf(err);
        }
      }
      case config.ProviderTurso: {
        // The URL names a database that already exists on the user's Turso
        // account. Nothing here creates or deletes one: `tdo init` creates
        // the schema inside it, and that is the whole of what create means
        // for a remote provider.
        const tc = { url: cfg.Turso.URL, token: cfg.Turso.Token };
        let st: Store;
        try {
          st = create ? openTurso(tc) : await openExistingTurso(tc);
        } catch (err) {
          throw providerf(err);
        }
        // describe() is the credential-free form; the configured URL is not
        // logged, because a URL is the one place a token has historically
        // been smuggled into a log line.
        this.out.debugf(`opened ${st.describe()}`);
        return st;
      }
      default:
        throw configf(new Error(`unknown provider ${JSON.stringify(cfg.Provider)}`));
    }
  }

  /**
   * providerOverride explains how the provider was selected when the choice
   * did not come from the config file, and returns the empty string when it
   * did.
   *
   * Writing to the wrong store is the failure mode that matters when a
   * provider can be switched: the tasks are not lost, but they are somewhere
   * the user is not looking. A command that writes therefore says where it
   * wrote whenever something ambient or one-off picked the store.
   */
  providerOverride(): string {
    const cfg = this.cfg;
    if (cfg === undefined) {
      return '';
    }
    const origin = cfg.Origins['provider'] ?? '';
    if (origin === '' || origin === 'default' || origin.startsWith('file:')) {
      // The configured store, chosen deliberately. Nothing to announce.
      return '';
    }
    if (origin.startsWith('flag:')) {
      return '--provider selected it for this command only';
    }

    // An environment variable that merely restates the configured provider is
    // not an override, and on a machine with no config file the environment
    // *is* the configuration. Only a disagreement is worth a line on stderr.
    const [named, ok] = cfg.FileProvider();
    if (!ok || named === cfg.Provider) {
      return '';
    }
    return `${config.EnvProvider} overrides the ${JSON.stringify(named)} named in ${cfg.Path}`;
  }

  /**
   * noticeOverriddenStore tells the user, on stderr, that this write is going
   * somewhere other than the configured store.
   */
  noticeOverriddenStore(st: Store): void {
    const why = this.providerOverride();
    if (why !== '') {
      this.out.warnf(`writing to ${st.describe()}: ${why}`);
    }
  }

  /**
   * withStore opens the store, confirms it holds the schema this binary
   * understands, runs fn and closes the store. A close failure is only
   * reported when fn itself succeeded, so the real cause is never hidden.
   *
   * The schema check is the preamble every ordinary command runs. Without it
   * a binary can query a schema it does not understand, and the failure modes
   * are a raw engine error at best and a quietly wrong answer at worst — a
   * listing missing the rows a column it has never heard of would have
   * matched. It costs nothing worth counting: the sqlite provider reads one
   * row of a one-row table, and the turso provider answers from the probe
   * openExisting already made.
   */
  withStore<T>(fn: (st: Store) => Promise<T>): Promise<T> {
    return this.withStoreOpened(false, true, fn);
  }

  /**
   * withUncheckedStore opens the store without the version check, for the two
   * commands whose job is the mismatch itself: `tdo init`, which may be
   * looking at a store that has no schema at all, and `tdo migrate`, which
   * exists precisely to fix a version the check would refuse.
   */
  withUncheckedStore<T>(fn: (st: Store) => Promise<T>): Promise<T> {
    return this.withStoreOpened(false, false, fn);
  }

  /**
   * withCreatedStore is withStore for `tdo init`, the one command that may
   * create the store it opens.
   */
  withCreatedStore<T>(fn: (st: Store) => Promise<T>): Promise<T> {
    return this.withStoreOpened(true, false, fn);
  }

  private async withStoreOpened<T>(
    create: boolean,
    check: boolean,
    fn: (st: Store) => Promise<T>,
  ): Promise<T> {
    const st = await this.openStore(create);
    if (check) {
      // A mismatch is reported before anything else happens, and the store is
      // closed rather than used: both directions are exit 3, with the advice
      // that applies — migrate, or upgrade tdo.
      try {
        await checkSchema(st);
      } catch (err) {
        await st.close();
        throw err;
      }
    }
    let result: T;
    try {
      result = await fn(st);
    } catch (runErr) {
      // Go ran the close unconditionally and reported fn's error in
      // preference to it. The same, written as a throw: close, then rethrow
      // the real cause.
      try {
        await st.close();
      } catch {
        // A close failure here would hide the reason the command failed.
      }
      throw runErr;
    }
    try {
      await st.close();
    } catch (closeErr) {
      throw providerf(closeErr);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// The dispatcher.
// ---------------------------------------------------------------------------

/**
 * Run executes the CLI against the real process streams and environment and
 * returns the process exit code. It takes the whole of `process.argv`, whose
 * first two entries are the runtime and this script where Go's os.Args had
 * one entry for the program.
 */
export function Run(argv: readonly string[]): Promise<number> {
  return RunWith({}, ['tdo', ...argv.slice(2)]);
}

/**
 * RunWith executes the CLI against env. It never throws on a command failure
 * and never calls process.exit, so a test can assert on the code it returns.
 *
 * args[0] is the program name and is ignored, as it was in Go.
 *
 * factories overrides the command table. Only a test passes it — the real
 * process takes the registry — and it takes factories rather than commands
 * because a command is built against the App this call creates.
 */
export async function RunWith(
  env: Env,
  argv: readonly string[],
  factories?: readonly CommandFactory[],
): Promise<number> {
  const a = new App(env);
  // The renderer has to know about --json before the flags are parsed,
  // because a parse failure must still produce the documented envelope.
  a.out.json = hasFlag(argv, 'json');
  a.out.debug = hasFlag(argv, 'debug');

  try {
    await dispatch(a, argv.slice(1), (factories ?? registry).map((f) => f(a)));
  } catch (err) {
    if (err instanceof SilentError) {
      return err.code;
    }
    const e = asError(err);
    const { code, jsonCode } = exit.classify(e);
    a.out.fail(jsonCode, e);
    return code;
  }
  return exit.OK;
}

/**
 * hasFlag reports whether a boolean global flag appears anywhere in args. It
 * is a pre-parse peek, used only to decide how a parse error is rendered.
 */
export function hasFlag(args: readonly string[], name: string): boolean {
  for (const arg of args) {
    if (arg === `--${name}` || arg === `-${name}`) {
      return true;
    }
    if (arg === '--') {
      return false;
    }
  }
  return false;
}

/** A command resolved out of argv, with its tokens removed. */
interface Resolved {
  /** cmd is the command to run, or undefined when none was named. */
  cmd: Command | undefined;
  /** path is the command's full name, e.g. "project ls". */
  path: string;
  /** rest is argv with the command's own name tokens removed. */
  rest: string[];
  /** help is true when --help or -h was given before `--`. */
  help: boolean;
  /** group is the group whose help to print when cmd is a group. */
  group: Command | undefined;
}

/**
 * splitName finds the next command name in args and removes it, leaving the
 * flags that were typed before it in place. The scan has to know which flags
 * take a value, or `tdo --config x ls` would read "x" as the command; known
 * is the flag set that is legal at this level.
 *
 * An unknown flag before the command name cannot be deferred to parseArgs,
 * because without a command there is no option descriptor set to parse
 * against. It is reported here, and it exits 2 like any other usage error.
 */
function splitName(
  args: readonly string[],
  known: Flags,
): { name: string | undefined; rest: string[]; help: boolean } {
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      // Everything after the separator is an argument, so there is no command
      // name left to find.
      return { name: undefined, rest: [...args], help };
    }
    if (arg === '-' || !arg.startsWith('-')) {
      return { name: arg, rest: [...args.slice(0, i), ...args.slice(i + 1)], help };
    }
    const flagName = flagNameOf(arg);
    if (flagName === 'help' || flagName === 'h') {
      help = true;
      continue;
    }
    const spec = known[flagName];
    if (spec === undefined) {
      throw usagef(`unknown flag ${arg}; run \`tdo --help\` for the list`);
    }
    if (spec.type === 'string' && !arg.includes('=')) {
      // The value is the next token, whatever it looks like.
      i++;
    }
  }
  return { name: undefined, rest: [...args], help };
}

/** flagNameOf strips the dashes and any `=value` from a flag token. */
function flagNameOf(arg: string): string {
  const bare = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
  const eq = bare.indexOf('=');
  return eq < 0 ? bare : bare.slice(0, eq);
}

/** resolve walks args down the command table, one name at a time. */
function resolve(args: readonly string[], commands: readonly Command[]): Resolved {
  let level: readonly Command[] = commands;
  let known: Flags = { ...globalFlags };
  let rest = [...args];
  let path = '';
  let help = false;
  let group: Command | undefined;

  for (;;) {
    const split = splitName(rest, known);
    help = help || split.help;
    rest = split.rest;
    if (split.name === undefined) {
      return { cmd: undefined, path, rest, help, group };
    }
    const found = level.find((c) => c.name === split.name);
    if (found === undefined) {
      // A mistyped command must say so rather than print a help topic, and it
      // exits 2 like any other mistake at the command line.
      const where = path === '' ? 'command' : `${path} subcommand`;
      throw usagef(
        `unknown ${where} ${JSON.stringify(split.name)}; run \`tdo ${path === '' ? '' : `${path} `}--help\` for the list`,
      );
    }
    path = path === '' ? found.name : `${path} ${found.name}`;
    if (found.subcommands === undefined) {
      return { cmd: found, path, rest, help, group };
    }
    // A group: keep walking, and remember it so that `tdo project --help`
    // prints the group's own help rather than the root's.
    group = found;
    level = found.subcommands;
    known = { ...globalFlags, ...(found.flags ?? {}) };
  }
}

async function dispatch(a: App, args: readonly string[], commands: readonly Command[]): Promise<void> {
  // `tdo help`, `tdo help add`: urfave shipped a help command, so the port
  // keeps one. It is handled before the table is consulted, which is also why
  // no command may be called "help".
  if (args[0] === 'help') {
    const target = resolve(args.slice(1), commands);
    writeHelp(a, target.cmd ?? target.group, commands);
    return;
  }

  const { cmd, path, rest, help, group } = resolve(args, commands);
  if (help || cmd === undefined) {
    // No command at all prints the root help and succeeds: help is not a
    // failure, and neither is an empty command line.
    writeHelp(a, cmd ?? group, commands);
    return;
  }

  const flags: Flags = { ...globalFlags, ...helpFlag, ...(cmd.flags ?? {}) };
  const { values, positionals } = parse(path, rest, flags);
  if (values['help'] === true) {
    writeHelp(a, cmd, commands);
    return;
  }

  // globals copies the global flag values onto the app, so that `tdo ls
  // --json` and `tdo --json ls` behave identically.
  a.out.json = values['json'] === true;
  a.out.debug = values['debug'] === true;
  a.configPath = typeof values['config'] === 'string' ? values['config'] : '';
  a.providerName = typeof values['provider'] === 'string' ? values['provider'] : '';

  const run = cmd.run;
  if (run === undefined) {
    throw new Error(`internal: ${path} has neither a body nor subcommands`);
  }

  if (cmd.store === undefined) {
    await run(new Context(a, path, positionals, values, undefined));
    return;
  }

  if (cmd.store === 'create') {
    // The guard sits ahead of the open so that a stray argument is refused
    // before a store is brought into being: `tdo init junk` must not leave a
    // database behind on its way to exit 2.
    if (positionals.length > 0) {
      throw usagef(`${path} takes no arguments`);
    }
    await a.withCreatedStore(async (st) => {
      a.noticeOverriddenStore(st);
      await run(new Context(a, path, positionals, values, st));
    });
    return;
  }

  const body = async (st: Store): Promise<void> => {
    if (cmd.store === 'write') {
      // Name the store first when the provider was overridden, so a stale
      // TODOCLOUD_PROVIDER or a mistyped --provider cannot quietly redirect
      // a write.
      a.noticeOverriddenStore(st);
    }
    await run(new Context(a, path, positionals, values, st));
  };
  if (cmd.store === 'unchecked') {
    await a.withUncheckedStore(body);
    return;
  }
  await a.withStore(body);
}

/**
 * parse runs parseArgs over one command's flag set.
 *
 * Every failure parseArgs reports is a mistake at the command line, so it
 * becomes a usage error naming the command: `tdo add --nope` exits 2 as
 * docs/agents.md promises, rather than 1.
 */
function parse(
  path: string,
  args: readonly string[],
  flags: Flags,
): { values: ParsedValues; positionals: string[] } {
  const options: Record<string, { type: 'boolean' | 'string'; multiple?: boolean }> = {};
  for (const [name, f] of Object.entries(flags)) {
    options[name] = f.multiple === true ? { type: f.type, multiple: true } : { type: f.type };
  }
  // -h is the one short flag the tree has, and it is handled by the scan
  // above as well as here.
  options['h'] = { type: 'boolean' };

  let parsed;
  try {
    parsed = parseArgs({
      args: joinOptionValues(args, flags),
      options,
      // strict refuses an unknown flag and a boolean given a value, which is
      // exactly the set of mistakes that must exit 2. allowPositionals is
      // what makes `--` work: everything after it lands in positionals,
      // which is how a dash-leading title reaches `tdo add`.
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw usagef(`${path}: ${parseArgsMessage(err)}`);
  }
  const values = parsed.values as ParsedValues;
  if (values['h'] === true) {
    values['help'] = true;
  }
  return { values, positionals: parsed.positionals };
}

/**
 * joinOptionValues rewrites `--flag value` as `--flag=value` for every string
 * flag, stopping at `--`.
 *
 * It exists because parseArgs refuses a value that looks like a flag: in
 * strict mode `--priority -1` is reported as ambiguous rather than read as
 * minus one, and `--where title=-x` would be too. urfave took the next token
 * whatever it looked like, which is the behaviour docs/agents.md documents and
 * which dash_args_test.go pins, so the tokens are joined before parseArgs
 * sees them. A missing value — `--due` at the end of the line — is left
 * alone, so that parseArgs still reports it.
 */
function joinOptionValues(args: readonly string[], flags: Flags): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      out.push(...args.slice(i));
      return out;
    }
    if (arg.length > 1 && arg.startsWith('-') && !arg.includes('=')) {
      const spec = flags[flagNameOf(arg)];
      if (spec?.type === 'string' && i + 1 < args.length) {
        out.push(`${arg}=${args[i + 1] ?? ''}`);
        i++;
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

/**
 * parseArgsMessage turns one of parseArgs' errors into a single sentence in
 * this CLI's voice. Node's own text names the option and then suggests the
 * `--flag=value` form, which is advice about parseArgs rather than about tdo.
 */
function parseArgsMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const message = e.message ?? String(err);
  const quoted = /'(-[^']*)'/.exec(message)?.[1];
  switch (e.code) {
    case 'ERR_PARSE_ARGS_UNKNOWN_OPTION':
      return `unknown flag ${quoted ?? ''}`.trimEnd();
    case 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE':
      // Either a value is missing or a boolean was given one; Node's first
      // line says which, and the rest is its own advice.
      return (message.split('\n')[0] ?? message).toLowerCase();
    default:
      return message.split('\n')[0] ?? message;
  }
}

// ---------------------------------------------------------------------------
// Help.
// ---------------------------------------------------------------------------

/**
 * writeHelp prints the help for one command, or the root help when cmd is
 * undefined. It goes to stdout and exits 0: help is the result the user asked
 * for, not a diagnostic about a failure.
 */
function writeHelp(a: App, cmd: Command | undefined, commands: readonly Command[]): void {
  a.out.printf(cmd === undefined ? rootHelp(commands) : commandHelp(cmd));
}

function rootHelp(commands: readonly Command[]): string {
  const lines: string[] = [
    'tdo - keep a todo list in a database you own',
    '',
    'Usage:',
    '  tdo [global flags] <command> [flags] [arguments]',
    '',
    'Commands:',
  ];
  lines.push(...commandLines(commands));
  lines.push('', 'Global flags:', ...flagLines(globalFlags));
  lines.push('', 'Run `tdo <command> --help` for a command and its flags.');
  return `${lines.join('\n')}\n`;
}

function commandHelp(cmd: Command): string {
  const args = cmd.argsUsage === undefined || cmd.argsUsage === '' ? '' : ` ${cmd.argsUsage}`;
  const lines: string[] = [
    `tdo ${cmd.name} - ${cmd.usage}`,
    '',
    'Usage:',
    `  tdo ${cmd.name} [flags]${args}`,
  ];
  if (cmd.subcommands !== undefined) {
    lines.push('', 'Subcommands:', ...commandLines(cmd.subcommands));
  }
  const own = flagLines(cmd.flags ?? {});
  if (own.length > 0) {
    lines.push('', 'Flags:', ...own);
  }
  lines.push('', 'Global flags:', ...flagLines(globalFlags));
  return `${lines.join('\n')}\n`;
}

function commandLines(commands: readonly Command[]): string[] {
  const shown = commands.filter((c) => c.hidden !== true);
  const width = shown.reduce((w, c) => Math.max(w, c.name.length), 0);
  return shown.map((c) => `  ${c.name.padEnd(width)}  ${c.usage}`);
}

function flagLines(flags: Flags): string[] {
  const shown = Object.entries(flags).filter(([, f]) => f.hidden !== true);
  const label = ([name, f]: [string, Flag]): string =>
    f.type === 'string' ? `--${name} ${f.placeholder ?? 'VALUE'}` : `--${name}`;
  const width = shown.reduce((w, e) => Math.max(w, label(e).length), 0);
  return shown.map((e) => `  ${label(e).padEnd(width)}  ${e[1].usage}`);
}

// ---------------------------------------------------------------------------
// The command table.
//
// One entry per command module, in the order it should read in `tdo --help`.
// A command module exports a factory; see THE COMMAND-REGISTRATION CONTRACT
// at the top of this file.
//
// The Go tree's order, which this list restores as each module lands:
//
//   capture and the inbox   add, inbox
//   looking at things       ls, show, next, forecast, serve
//   the mark family         done, undone, drop, hold, unhold, flag, unflag,
//                           defer, due, mv
//   editing and removal     edit, rm
//   structure               project, folder, tag
//   repetition and review   repeat, series, review, perspective
//   administration          init, migrate, config, login, doctor, export,
//                           import, version
//
// Only `show` is ported so far. The rest are being ported alongside this
// file; a module arriving adds its import above and one line here, and
// nothing else in the dispatcher changes.
// ---------------------------------------------------------------------------

/** registry is every command this build knows, in help order. */
const registry: readonly CommandFactory[] = [
  // capture and the inbox
  addCommand,
  inboxCommand,
  // looking at things
  listCommand,
  listAliasCommand, // hidden: `tdo list`
  showCommand,
  nextCommand,
  forecastCommand,
  serveCommand,
  // the mark family
  doneCommand,
  undoneCommand,
  dropCommand,
  holdCommand,
  unholdCommand,
  flagItemsCommand,
  unflagCommand,
  deferCommand,
  dueCommand,
  moveCommand,
  // editing and removal
  editCommand,
  removeCommand,
  removeAliasCommand, // hidden: `tdo remove`
  // structure
  projectCommand,
  folderCommand,
  tagCommand,
  // repetition and review
  repeatCommand,
  seriesCommand,
  reviewCommand,
  perspectiveCommand,
  // administration
  initCommand,
  migrateCommand,
  configCommand,
  loginCommand,
  doctorCommand,
  exportCommand,
  importCommand,
  versionCommand,
];

/** commandTable builds the command tree for an app. */
export function commandTable(a: App): Command[] {
  return registry.map((factory) => factory(a));
}
