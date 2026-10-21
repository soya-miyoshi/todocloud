// The administrative commands: `tdo version`, `init`, `migrate`, `config`
// (and `config set`) and `doctor`.
//
// Two of them are the reason the store can be opened without the schema check
// (`migrate`) or created (`init`), and one of them — `doctor` — is a
// diagnostic that must leave nothing behind, not a directory and not a backup
// file.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as exit from '@todocloud/core/exit';
import * as providercli from '@todocloud/core/providercli';
import { type Store, isNotInitialized } from '@todocloud/core/store';
import * as schema from '@todocloud/core/store/schema';
import { type MigrationPlan, planMigration } from '@todocloud/core/store/version';

import { SilentError, type App, type Command, type Context, asError, usagef } from './app.ts';
import * as config from './config.ts';
import { ensureProviderCLI } from './login.ts';
import { confirm, stdinIsTerminal } from './remove.ts';
import { resolveBundled } from './respath.ts';

/**
 * manifestPath is this package's own `package.json`.
 *
 * It is one directory up from `src/` in a checkout, in an npm install and in
 * the Node single executable, and beside the entry in a Bun executable;
 * `resolveBundled` holds the four layouts and why the path differs, and
 * src/web/web.ts finds the viewer assets through the same resolver rather
 * than a second mechanism.
 *
 * The probe is deferred and memoised, because `tdo --help` must not pay a
 * `stat` for a file `tdo version` is the only caller of (MIGRATION.md records
 * the 84 ms budget against a 42 ms floor).
 */
let manifestPathCache: string | undefined;

function manifestPath(): string {
  manifestPathCache ??= resolveBundled(import.meta.dirname, '..', 'package.json');
  return manifestPathCache;
}

/**
 * version is the released version.
 *
 * Go overrode it at link time with `-ldflags -X`. A TypeScript build has no
 * linker, and for a while the release faked one twice: the SEA job rewrote
 * the generated boot shim to assign `process.env.TODOCLOUD_VERSION` (and had
 * to convert the shim's static import to a dynamic one, because ESM
 * evaluates imports before the importing body, so the assignment would
 * otherwise have run too late), while scripts/pack-npm.mjs regex-patched the
 * emitted `admin.js` to replace this function's default, a tarball having no
 * shim to edit. Two mechanisms for one fact, one of them editing compiled
 * output.
 *
 * Both are gone. A Node package's version lives in its manifest, so that is
 * where this reads it from, and the release writes the tag into the shipped
 * `packages/*\/package.json` once, before anything is built — so the single
 * executable (which copies `version` into the manifest it stages into the
 * VFS) and the tarballs pick up the same number from the same place.
 *
 * TODOCLOUD_VERSION still wins, so a developer can force a value without a
 * build. A missing or unreadable manifest is not a crash: `tdo version` is
 * often the first thing run against a broken install, and it reports
 * `0.0.0-unknown` — honest about knowing nothing rather than inventing a
 * number or pretending to be a release.
 */
function readVersion(): string {
  const forced = process.env['TODOCLOUD_VERSION'];
  if (forced !== undefined && forced !== '') return forced;
  try {
    const found: unknown = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))?.version;
    if (typeof found === 'string' && found !== '') return found;
  } catch {
    // Unreadable, absent or not JSON: fall through to the honest answer.
  }
  return '0.0.0-unknown';
}

/**
 * runtimeName describes the engine, for `tdo version`.
 *
 * Bun and Deno both implement enough of Node to run this tree, and Bun
 * advertises a Node version in `process.versions.node`, so that field names
 * the compatibility target rather than the engine. Reading the engine's own
 * key first is what keeps the answer true.
 *
 * The separator is a comma rather than nested parentheses, because the human
 * line is `tdo <version> (<runtime>)` and `(bun 1.4.3 (node 26.3.0))` reads
 * badly.
 */
function runtimeName(): string {
  const bun = process.versions['bun'];
  if (bun !== undefined && bun !== '') {
    return `bun ${bun}, node ${process.versions.node}`;
  }
  const deno = process.versions['deno'];
  if (deno !== undefined && deno !== '') {
    return `deno ${deno}, node ${process.versions.node}`;
  }
  return `node ${process.versions.node}`;
}

/**
 * commit is the source revision. It has no manifest home — a git SHA is not a
 * package's business, and npm would neither carry nor validate one — so this
 * one fact stays an environment variable rather than being dragged along with
 * the version.
 *
 * Nothing bakes it in any more: the release used to set it in the boot shim
 * it rewrote, and that shim is gone, so a released executable reports an
 * empty commit exactly as an npm install always did. That is deliberate. The
 * tag is the identifier a release promises, the GitHub release records which
 * commit it was cut from, and bringing the SHA back belongs in a generated
 * source file written before the build — not in an edit to compiled output.
 * It is empty in a plain checkout, and reported as the empty string rather
 * than invented.
 */
const commit = process.env['TODOCLOUD_COMMIT'] ?? '';

export function versionCommand(a: App): Command {
  return {
    name: 'version',
    usage: 'print the version of this binary',
    run(ctx: Context): Promise<void> {
      if (ctx.args.length > 0) {
        throw usagef('version takes no arguments');
      }
      // Go reported runtime.Version(); the equivalent fact about this build
      // is the engine that is running it. The JSON key is `runtime` rather
      // than the Go tree's `go`: the value has always named the runtime, and
      // `go` was vocabulary left over from a tree that no longer exists.
      //
      // `process.versions.node` alone would be a lie in the shipped binary.
      // Bun sets it to the Node version it claims compatibility with — 26.3.0
      // at the time of writing — so a `bun build --compile` executable would
      // report "node 26.3.0" while being Bun. The whole reason to print this
      // is a bug report, where the engine is the first thing worth knowing,
      // so it is named first and the compatibility level follows in
      // parentheses for the cases where that is what actually matters.
      const runtime = runtimeName();
      const version = readVersion();
      if (a.out.json) {
        a.out.emit({ version, commit, runtime });
        return Promise.resolve();
      }
      a.out.printf(
        commit === ''
          ? `tdo ${version} (${runtime})\n`
          : `tdo ${version} (${commit}, ${runtime})\n`,
      );
      return Promise.resolve();
    },
  };
}

export function initCommand(a: App): Command {
  return {
    name: 'init',
    usage: 'create the schema in the configured provider',
    // 'create' is the one mode that may bring the store into being, and the
    // dispatcher refuses a stray argument before it does: `tdo init junk`
    // must not leave a database behind on its way to exit 2.
    store: 'create',
    async run(ctx: Context): Promise<void> {
      const st = ctx.store();
      const cfg = a.config();
      // Whether this run brought the store into being has to be decided
      // before init, which is idempotent and afterwards looks the same either
      // way. A caller needs the difference: "I just made an empty list" is
      // not "the list was already here".
      let created = false;
      try {
        await st.schemaVersion();
      } catch (err) {
        if (!isNotInitialized(err)) {
          throw err;
        }
        created = true;
      }
      await st.init();
      // Named recorded, not schema: the schema module is in scope here and a
      // shadow would be a trap for the next edit.
      const recorded = await st.schemaVersion();
      if (a.out.json) {
        a.out.emit({
          provider: cfg.Provider,
          schema_version: recorded,
          initialized: true,
          created,
        });
        return;
      }
      a.out.printf(
        created
          ? `created ${st.describe()} at schema version ${recorded}\n`
          : `${st.describe()} is already initialized at schema version ${recorded}\n`,
      );
    },
  };
}

export function migrateCommand(a: App): Command {
  return {
    name: 'migrate',
    usage: "upgrade the store's schema to this binary's version",
    flags: {
      yes: { type: 'boolean', usage: 'confirm a migration of a store that cannot be backed up' },
    },
    // No `store: 'unchecked'`, although that mode exists for this command:
    // the stray-argument guard has to run before the store is opened, the
    // same way `init`'s does, and the dispatcher only offers that ordering
    // for 'create'. The open itself is withUncheckedStore, which is what the
    // mode would have done — a version this binary refuses to read is
    // exactly the state this command is here to fix.
    async run(ctx: Context): Promise<void> {
      if (ctx.args.length > 0) {
        throw usagef('migrate takes no arguments');
      }
      await a.withUncheckedStore(async (st) => {
        a.noticeOverriddenStore(st);
        await migrate(a, st, ctx.bool('yes'));
      });
    },
  };
}

/**
 * migrate plans the upgrade, says what was saved and what is about to happen,
 * asks when there is nothing to fall back on, and only then changes the
 * store.
 *
 * The order matters more than it looks. The backup is taken by the plan,
 * before any statement runs, so the path can be printed while the data is
 * still as it was; a user watching the next step fail has already been told
 * where the copy is.
 */
async function migrate(a: App, st: Store, yes: boolean): Promise<void> {
  // A store written by a newer binary arrives here as a VersionError, which
  // is exit 3 and says to upgrade tdo.
  const plan = await planMigration(st);

  // The backup exists whether or not the rest of this succeeds, so it is
  // reported before anything else, including before the no-op case can
  // return.
  if (plan.backupPath !== '') {
    a.out.hintf(`Backed up ${plan.store} to ${plan.backupPath} before migrating.`);
  }

  if (plan.upToDate) {
    if (a.out.json) {
      a.out.emit(migrateJSON(plan, plan.from));
      return;
    }
    a.out.printf(`already at schema version ${plan.from}\n`);
    return;
  }

  if (plan.confirm && !yes) {
    // No backup could be taken, and a migration cannot be undone. This is the
    // one administrative command with consequences, so it follows
    // `tdo rm --purge`: it prompts a user and refuses a script rather than
    // assuming consent nobody gave.
    if (!stdinIsTerminal(a)) {
      throw usagef(
        `refusing to migrate ${plan.store} from schema version ${plan.from} to ${plan.to} without a terminal to confirm at: ${plan.warning}; pass --yes`,
      );
    }
    a.out.warnf(plan.warning);
    const ok = await confirm(
      a,
      `Migrate ${plan.store} from schema version ${plan.from} to ${plan.to}?`,
    );
    if (!ok) {
      // Declining is not a failure; the store was not touched.
      a.out.hintf(`Cancelled; ${plan.store} was not migrated.`);
      if (a.out.json) {
        a.out.emit(migrateJSON(plan, plan.from));
      }
      return;
    }
  }

  await st.migrate();

  // What the store says afterwards, not what the plan hoped for: a migration
  // that reported success without arriving at the version this binary writes
  // would hand every later command a schema it does not understand.
  const reached = await st.schemaVersion();
  if (reached !== plan.to) {
    throw new Error(
      `${plan.store} is at schema version ${reached} after migrating rather than ${plan.to}; it was not left in the state this tdo expects`,
    );
  }

  if (a.out.json) {
    a.out.emit(migrateJSON(plan, reached));
    return;
  }
  a.out.printf(`migrated from schema version ${plan.from} to ${reached}\n`);
}

/**
 * migrateJSON renders the documented shape. from, to and migrated are the
 * original three keys and keep their meaning; backup_path and steps were
 * added with the migration machinery and are always present, empty when there
 * is no backup and no step to run.
 */
function migrateJSON(plan: MigrationPlan, reached: number): Record<string, unknown> {
  return {
    from: plan.from,
    to: reached,
    migrated: reached !== plan.from,
    backup_path: plan.backupPath,
    steps: stepNames(plan.steps),
  };
}

/**
 * stepNames renders a possibly absent list as a JSON array rather than null,
 * so a caller can iterate it without a null check.
 */
function stepNames(steps: readonly string[] | undefined): string[] {
  return steps === undefined ? [] : [...steps];
}

export function configCommand(a: App): Command {
  return {
    name: 'config',
    usage: 'print the resolved configuration, with every secret redacted',
    argsUsage: '[set <key> <value>]',
    // `set` is a verb in the argument list rather than a dispatcher
    // subcommand, the way `tdo project add` and `tdo perspective save` are.
    // Go could give one urfave command both an Action and a Commands list;
    // the dispatcher here treats a command with subcommands as a group with
    // no body of its own, and `tdo config` on its own has to keep printing
    // the configuration. Dispatching on the first argument keeps both
    // behaviours and keeps every mistake at the command line an ordinary
    // usage error.
    run(ctx: Context): Promise<void> {
      if (ctx.args[0] === 'set') {
        return configSet(a, ctx.args.slice(1));
      }
      if (ctx.args.length > 0) {
        throw usagef('config takes no arguments, or `config set <key> <value>`');
      }
      const cfg = a.config();
      // Describe is the only rendering of a Config there is: it is redacted by
      // construction, and the object itself must never be formatted into
      // output (CLAUDE.md §1.7).
      const described = cfg.Describe();
      if (a.out.json) {
        a.out.emit(described);
        return Promise.resolve();
      }
      for (const k of Object.keys(described).sort()) {
        a.out.printf(`${k} = ${describeValue(described[k])}\n`);
      }
      return Promise.resolve();
    },
  };
}

/**
 * describeValue renders one line of `tdo config`. Go's `%v` printed a map and
 * a slice in its own notation; JSON is the closer thing here, and every value
 * Describe produces is already redacted.
 */
function describeValue(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return JSON.stringify(v) ?? '';
}

/**
 * configSet writes one setting into the user's config file.
 *
 * It is the general answer to "tdo told me a line to paste": tdo maintains the
 * file itself. What it will not do is write a credential — a key named
 * `token`, or any of the other secret-shaped spellings, is refused here and
 * again inside the writer, because a token belongs in the OS keychain where
 * `tdo login` puts it (CLAUDE.md §1.6).
 */
function configSet(a: App, args: readonly string[]): Promise<void> {
  {
    {
      if (args.length !== 2) {
        throw usagef(
          'config set takes exactly two arguments, a key and a value: `tdo config set turso.url libsql://example.turso.io`',
        );
      }
      let table: string;
      let key: string;
      try {
        [table, key] = config.ParseKey(args[0] ?? '');
      } catch (err) {
        throw exit.usagef(asError(err)) as Error;
      }
      const setting: config.Setting = { Table: table, Key: key, Value: args[1] ?? '' };

      let res: config.WriteResult;
      try {
        res = config.Set(
          { Getenv: a.env.getenv, ConfigPath: a.configPath },
          setting,
        );
      } catch (err) {
        // A credential is the user's mistake at the command line, so it exits
        // 2 with the command that does the right thing; everything else the
        // writer refuses is a configuration problem, exit 3.
        if (err === config.ErrSecretKey || asError(err).cause === config.ErrSecretKey) {
          throw exit.usagef(
            new Error(`${asError(err).message}; run \`tdo login\` instead`),
          ) as Error;
        }
        throw exit.configf(asError(err)) as Error;
      }

      if (a.out.json) {
        a.out.emit(configSetJSON(res));
        return Promise.resolve();
      }
      for (const c of res.Changes) {
        if (!c.Changed) {
          a.out.printf(`${c.Name} already set to ${JSON.stringify(c.Value)} in ${res.Path}\n`);
        } else if (c.Added) {
          a.out.printf(`set ${c.Name} = ${JSON.stringify(c.Value)} in ${res.Path} (added)\n`);
        } else {
          a.out.printf(
            `set ${c.Name} = ${JSON.stringify(c.Value)} in ${res.Path} (was ${JSON.stringify(c.Previous)})\n`,
          );
        }
      }
      if (res.Created) {
        a.out.hintf(
          `created ${res.Path}; keep it out of every git repository, and keep tokens in the OS keychain with \`tdo login\`.`,
        );
      }
      return Promise.resolve();
    }
  }
}

/** configSetJSON is the documented shape of `tdo config set --json`. */
function configSetJSON(res: config.WriteResult): Record<string, unknown> {
  return {
    config_file: res.Path,
    created: res.Created,
    wrote: res.Wrote,
    changes: res.Changes.map((c) => ({
      key: c.Name,
      value: c.Value,
      previous: c.Previous,
      added: c.Added,
      changed: c.Changed,
    })),
  };
}

/**
 * xdgConfigHint names the canonical config file in help text. config has its
 * own copy for its messages; this one is the command layer's, because the
 * command layer must not reach into that module for a string.
 */
export const xdgConfigHint = '~/.config/todocloud/config.toml';

/** Check is one line of `tdo doctor` output. */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function doctorCommand(a: App): Command {
  return {
    name: 'doctor',
    usage: 'check the configuration and the provider, printing nothing secret',
    // No store mode: diagnose opens the store itself, because a failure to
    // open is one of the answers rather than a reason not to report.
    async run(ctx: Context): Promise<void> {
      if (ctx.args.length > 0) {
        throw usagef('doctor takes no arguments');
      }
      const { checks, state } = await diagnose(a);

      const ok = checks.every((c) => c.ok);

      if (a.out.json) {
        a.out.emit({
          ok,
          checks,
          // The same four keys `tdo migrate` reports, so that a caller can
          // read the schema state from either command without a second shape
          // to learn. backup_path is always empty here: planning a migration
          // takes the backup, and a diagnostic must write nothing.
          from: state.from,
          to: state.to,
          backup_path: '',
          steps: stepNames(state.steps),
        });
      } else {
        for (const c of checks) {
          const mark = c.ok ? 'ok  ' : 'FAIL';
          a.out.printf(`${mark} ${c.name.padEnd(20)} ${c.detail}\n`);
        }
      }
      if (!ok) {
        // The report is the output; an error envelope on top of it would
        // contradict the documented shape, so only the exit code carries the
        // failure.
        throw new SilentError(exit.Error);
      }
    },
  };
}

/**
 * SchemaState is what `tdo doctor` reports about the schema: the version the
 * store is at, the version this binary writes, and the steps still owed. It
 * is the readable half of a MigrationPlan.
 *
 * It is computed here rather than by calling planMigration, because planning
 * takes a backup — which is right for `tdo migrate` and wrong for a
 * diagnostic. `tdo doctor` creates nothing, a backup file included.
 */
interface SchemaState {
  /**
   * from is the version recorded in the store, or 0 when it could not be read
   * at all. to is the version this binary writes.
   */
  from: number;
  to: number;
  /** steps names the migrations `tdo migrate` would run, in order. */
  steps: string[];
}

/** pending reports whether `tdo migrate` has work to do. */
function pending(s: SchemaState): boolean {
  return s.from !== s.to;
}

/**
 * diagnose runs the checks in order and stops as soon as one makes the next
 * one meaningless. Nothing it returns may contain a credential: a token is
 * reported only through Secret.hint.
 */
async function diagnose(a: App): Promise<{ checks: Check[]; state: SchemaState }> {
  const state: SchemaState = { from: 0, to: schema.Version, steps: [] };
  let cfg: config.Config;
  try {
    cfg = a.config();
  } catch (err) {
    return {
      checks: [{ name: 'config', ok: false, detail: asError(err).message }],
      state,
    };
  }
  // a.config() prints the warnings itself, on stderr, where advice belongs.

  const source =
    cfg.Path === '' ? 'no config file; using defaults and the environment' : cfg.Path;
  const checks: Check[] = [{ name: 'config', ok: true, detail: source }];

  if (!config.providerImplemented(cfg.Provider)) {
    checks.push({
      name: 'provider',
      ok: false,
      detail: `provider ${JSON.stringify(cfg.Provider)} is not implemented in this build`,
    });
    return { checks, state };
  }
  checks.push({
    name: 'provider',
    ok: true,
    detail: `provider ${JSON.stringify(cfg.Provider)}`,
  });

  let credentialFailed = false;
  const credential = credentialCheck(cfg);
  if (credential !== undefined) {
    checks.push(credential);
    credentialFailed = !credential.ok;
  }

  // The provider CLI check comes next, and it runs even when the credential
  // check failed: "install the turso CLI and log in" is exactly the advice a
  // user with no token needs.
  checks.push(await providerCLICheck(cfg.Provider));
  if (credentialFailed) {
    return { checks, state };
  }

  if (cfg.Provider === config.ProviderSQLite) {
    const c = directoryCheck(cfg);
    checks.push(c);
    if (!c.ok) {
      return { checks, state };
    }
  }

  let st: Store;
  try {
    st = await a.openStore(false);
  } catch (err) {
    // Go got this sentence for free from `%w`; the ported error carries
    // ErrNotInitialized as its cause instead, so the advice is spelled out.
    const detail = isNotInitialized(err)
      ? 'not initialized; run `tdo init`'
      : asError(err).message;
    checks.push({ name: 'ping', ok: false, detail });
    return { checks, state };
  }

  try {
    try {
      await st.ping();
    } catch (err) {
      const detail = isNotInitialized(err)
        ? 'not initialized; run `tdo init`'
        : asError(err).message;
      checks.push({ name: 'ping', ok: false, detail });
      return { checks, state };
    }
    checks.push({ name: 'ping', ok: true, detail: st.describe() });

    let found: number;
    try {
      found = await st.schemaVersion();
    } catch (err) {
      checks.push({ name: 'schema', ok: false, detail: asError(err).message });
      return { checks, state };
    }
    state.from = found;
    for (const step of schema.pending(found)) {
      state.steps.push(step.name);
    }
    if (!pending(state)) {
      checks.push({
        name: 'schema',
        ok: true,
        detail: `version ${found}; no migration pending`,
      });
    } else if (found < state.to) {
      checks.push({
        name: 'schema',
        ok: false,
        detail: `store is at version ${found}, this binary expects ${state.to}; a migration is pending, run \`tdo migrate\``,
      });
    } else {
      checks.push({
        name: 'schema',
        ok: false,
        detail: `store is at version ${found}, newer than this binary's ${state.to}; upgrade tdo`,
      });
    }
    return { checks, state };
  } finally {
    try {
      await st.close();
    } catch {
      // A diagnostic that failed to close the store it opened has still
      // produced its report, which is the output that matters.
    }
  }
}

/**
 * credentialCheck reports whether the provider's token is present, and
 * nothing more about it. It returns undefined for a provider that needs no
 * credential.
 */
function credentialCheck(cfg: config.Config): Check | undefined {
  switch (cfg.Provider) {
    case config.ProviderTurso: {
      const hint = cfg.Turso.Token.hint();
      if (hint === '') {
        return {
          name: 'credential',
          ok: false,
          detail: `no token; set ${config.EnvTursoToken}`,
        };
      }
      return { name: 'credential', ok: true, detail: 'token present ' + hint };
    }
    case config.ProviderD1: {
      const hint = cfg.D1.Token.hint();
      if (hint === '') {
        return { name: 'credential', ok: false, detail: `no token; set ${config.EnvD1Token}` };
      }
      return { name: 'credential', ok: true, detail: 'token present ' + hint };
    }
    default:
      return undefined;
  }
}

/**
 * providerCLICheck reports what is known about the provider's own CLI, and
 * only non-secret facts: whether a binary is installed, whether a session
 * exists, and where a credentials file lives. It never runs wrangler —
 * CLAUDE.md §1.4 forbids it, and a wrangler OAuth token cannot be used by
 * this tool anyway — and it never prints a token. A missing CLI is a failed
 * check with advice, not a crash.
 */
export async function providerCLICheck(provider: config.Provider): Promise<Check> {
  const name = 'provider_cli';
  switch (provider) {
    case config.ProviderTurso: {
      ensureProviderCLI();
      if (!providercli.tursoAvailable()) {
        return {
          name,
          ok: false,
          detail: `the turso CLI is not installed; install it and run \`turso auth login\`, or set ${config.EnvTursoToken} yourself`,
        };
      }
      let loggedIn: boolean;
      try {
        loggedIn = await providercli.tursoLoggedIn();
      } catch (err) {
        return {
          name,
          ok: false,
          detail:
            'the turso CLI is installed but could not be asked about its session: ' +
            asError(err).message,
        };
      }
      if (!loggedIn) {
        return {
          name,
          ok: false,
          detail: 'the turso CLI is installed but not logged in; run `turso auth login`',
        };
      }
      return { name, ok: true, detail: 'the turso CLI is installed and logged in' };
    }
    case config.ProviderD1:
      return {
        name,
        ok: true,
        detail: `no provider CLI is involved; D1 uses the API token from ${config.EnvD1Token}`,
      };
    default:
      return {
        name,
        ok: true,
        detail: 'no provider CLI is involved; local SQLite is a file on your disk',
      };
  }
}

/**
 * directoryCheck confirms the database file's directory can be written to,
 * which is the failure a local user actually hits.
 *
 * It creates nothing. `tdo doctor` is a diagnostic, and a diagnostic that
 * leaves directories behind is how a mistyped path quietly becomes real — so
 * when the directory does not exist yet, the nearest existing ancestor is
 * probed instead and the check says `tdo init` would create the rest.
 */
function directoryCheck(cfg: config.Config): Check {
  const name = 'database_directory';
  let dbPath: string;
  try {
    dbPath = config.ExpandPath(cfg.SQLite.Path);
  } catch (err) {
    return { name, ok: false, detail: asError(err).message };
  }
  if (dbPath === ':memory:') {
    return { name, ok: true, detail: 'in-memory database' };
  }

  const dir = path.dirname(dbPath);
  const { existing, missing } = nearestExistingDir(dir);
  if (existing === '') {
    return { name, ok: false, detail: `no existing directory above ${dir}` };
  }

  // The probe is removed again in every case, so the diagnostic leaves the
  // directory exactly as it found it.
  const probe = path.join(existing, `.tdo-write-check-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    return { name, ok: false, detail: `${existing} is not writable: ${asError(err).message}` };
  }
  try {
    fs.rmSync(probe, { force: true });
  } catch {
    // Nothing to report: the write is what was being tested.
  }

  if (missing) {
    return { name, ok: true, detail: `${existing} is writable; \`tdo init\` will create ${dir}` };
  }
  return { name, ok: true, detail: dir + ' is writable' };
}

/**
 * nearestExistingDir walks up from dir to the first directory that exists,
 * reporting whether anything below it is missing. existing is the empty
 * string when it runs out of ancestors, which means the path is not usable at
 * all.
 */
function nearestExistingDir(dir: string): { existing: string; missing: boolean } {
  let current = dir;
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) {
        return { existing: current, missing: current !== dir };
      }
    } catch {
      // Not there, or not readable: keep walking up.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return { existing: '', missing: true };
    }
    current = parent;
  }
}

/** forTest exposes what the Go tests reached inside the package for. */
export const forTest = {
  diagnose,
  // `migrate` is here for one test the Go suite had and nothing else: the
  // refusal to migrate a store that cannot be backed up, with no terminal to
  // confirm at. Go built an `app` and called `a.migrate` with a wrapper that
  // hid the `Backupper` interface. `migrateCommand` opens the store through
  // the configured provider, which will always produce a `Backupper`, so
  // without this seam the refusal path has no way to be reached from a test.
  migrate,
  credentialCheck,
  directoryCheck,
  nearestExistingDir,
  migrateJSON,
  configSetJSON,
  stepNames,
  tmpdir: os.tmpdir,
  // The version resolution, so the tests can assert that the manifest is the
  // source and that TODOCLOUD_VERSION still overrides it. Both used to be
  // untestable: the value was frozen into a module-level constant at import.
  readVersion,
  // A getter, so that reading it from a test still goes through the same
  // deferred probe the command does rather than resolving at import time.
  get manifestPath(): string {
    return manifestPath();
  },
};
