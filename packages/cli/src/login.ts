// `tdo login`: obtaining a provider's credential and putting it in the OS
// keychain.
//
// This is the most sensitive file in the CLI, and two properties shape all of
// it (CLAUDE.md §1.6, §1.7).
//
// First, a token reaches this command from stdin and from the provider's own
// CLI, and from nowhere else. There is no flag that takes it and there must
// never be one: `argv` is readable by every process on the machine through
// `ps` and is written to shell history. The same rule holds downwards — the
// only child process started from here is `stty`, whose argument is a fixed
// literal, and the Turso CLI, which is driven through
// `@todocloud/core/providercli` and hands its minted token back on stdout.
//
// Second, the value lives in a `Secret` from the moment it exists until it is
// handed to the keychain. A token that cannot be stored is discarded, never
// printed: a token on a terminal is a token in a scrollback buffer, a
// screenshot and an issue report.
//
// It must also work before the store exists — a user logs in before
// `tdo init` — so it never opens the store, and a machine with no keychain is
// not a failure: the user is told the command to run themselves and the
// command exits 0.

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import * as exit from '@todocloud/core/exit';
import * as providercli from '@todocloud/core/providercli';
import { Secret } from '@todocloud/core/secret';

import { type App, type Command, type Context, asError, usagef } from './app.ts';
import * as config from './config.ts';
import * as keyring from './keyring.ts';
import { confirm, stdinIsTerminal } from './remove.ts';

/**
 * keyringTimeoutMs bounds every keychain call this command makes. app.ts has
 * the same constant for the read path configuration takes; this one is the
 * write path's, and both exist so that a wedged helper process cannot hang
 * the command.
 */
const keyringTimeoutMs = 2_000;

// The keychain is reached through these indirections rather than called
// directly, so that a test can drive every branch of this command — a machine
// with no backend, an unwritable one, a stored token — without ever touching
// the developer's own keychain (CLAUDE.md §1.5). Go had the same five as
// package variables.
let keyringBackend: () => string = () => keyring.Backend();
let keyringAvailable: () => boolean = () => keyring.Available();
let keyringGet: (account: string) => keyring.Entry = (account) =>
  keyring.Get(account, { timeoutMs: keyringTimeoutMs });
let keyringSet: (account: string, value: Secret) => void = (account, value) =>
  keyring.Set(account, value, { timeoutMs: keyringTimeoutMs });
let keyringDelete: (account: string) => void = (account) =>
  keyring.Delete(account, { timeoutMs: keyringTimeoutMs });

/**
 * runnerInstalled records whether the provider-CLI indirections have been
 * given a real implementation.
 *
 * `@todocloud/core` ships no runner at all: it is imported by the PWA, where
 * spawning a child process is impossible, so the module refuses rather than
 * pretends (MIGRATION.md, "Package layout"). The CLI is where a runner over
 * `node:child_process` belongs, and it is installed lazily — on the first
 * command that actually consults a provider CLI — rather than as an import
 * side effect, so that merely importing this module cannot give a test the
 * power to execute the user's real `turso` binary.
 */
let runnerInstalled = false;

/**
 * ensureProviderCLI installs the `node:child_process` runner the first time a
 * command needs one. `tdo login` and `tdo doctor` are the two callers.
 *
 * The runner gives the child no stdin, as providercli documents: none of
 * these commands may prompt, and one waiting on a terminal would otherwise
 * block until the deadline. It passes no secret in argv, because none of the
 * four commands providercli runs takes one.
 */
export function ensureProviderCLI(): void {
  if (runnerInstalled) {
    return;
  }
  runnerInstalled = true;
  providercli.installRunner({
    lookPath(file: string): string {
      // `which` would be another child process to spawn before the one we
      // want; PATH is read directly instead, which is what exec.LookPath did.
      const found = lookOnPath(file);
      if (found === undefined) {
        throw new Error(`${file} is not installed`);
      }
      return found;
    },
    runner: spawnRunner,
  });
}

/**
 * Asynchronous on purpose. providercli bounds every child with a timer
 * that aborts `signal`, and a timer only runs when the event loop does:
 * under `spawnSync` the loop is blocked for as long as the child lives, so
 * a `turso` that hangs would never be cut off and `tdo login` wedged.
 */
export const spawnRunner: providercli.Runner = (signal, name, args) => {
  return new Promise<providercli.Output>((resolve) => {
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    // 'ignore' for stdin: see the note above.
    const child = spawn(name, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', (err) => {
      failure = err;
    });
    child.on('close', (code, sig) => {
      const out: providercli.Output = { stdout, stderr };
      if (failure !== undefined) {
        resolve({ ...out, err: failure });
      } else if (typeof code === 'number' && code !== 0) {
        // An ExitError rather than a plain one, because tursoLoggedIn
        // reads a non-zero exit as "not logged in" — an answer — and
        // anything else as a failure to report.
        resolve({ ...out, err: new providercli.ExitError(code) });
      } else if (sig !== null) {
        resolve({ ...out, err: new Error(`killed by ${sig}`) });
      } else {
        resolve(out);
      }
    });
  });
};

/**
 * lookOnPath resolves file against PATH, as exec.LookPath did. It returns the
 * first executable match, or undefined when there is none.
 */
function lookOnPath(file: string): string | undefined {
  if (file.includes('/')) {
    return accessible(file) ? file : undefined;
  }
  const paths = (process.env['PATH'] ?? '').split(':');
  for (const dir of paths) {
    const candidate = (dir === '' ? '.' : dir) + '/' + file;
    if (accessible(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function accessible(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** firstLine returns everything up to the first newline, exclusive. */
function firstLine(s: string): string {
  const at = s.indexOf('\n');
  return at < 0 ? s : s.slice(0, at);
}

/**
 * loginCommand stores a provider token in the OS keychain. See the note at
 * the top of this file for the two rules that shape it.
 */
export function loginCommand(a: App): Command {
  return {
    name: 'login',
    usage: "obtain the provider's credential, delegating to the provider's own CLI where it can",
    flags: {
      remove: { type: 'boolean', usage: 'delete the stored token instead of storing one' },
      show: { type: 'boolean', usage: 'report whether a token is stored, never its value' },
      // A database name is not a secret, so a flag is the right place for
      // it: it only selects which database the Turso CLI mints a token for.
      database: {
        type: 'string',
        placeholder: 'NAME',
        usage: 'the Turso database NAME to mint a token for',
      },
      // The two paths with effects a caller cannot take back — deleting a
      // stored token, and minting a new one on the user's Turso account —
      // ask first. This is the explicit opt-in, named as in
      // `tdo rm --purge --yes`.
      yes: { type: 'boolean', usage: 'skip the confirmation prompt' },
      // What tdo learns while minting — the provider and the database URL —
      // is written to the config file, so there is nothing to paste by hand.
      // A URL is not a credential, and the token is never written to a file.
      // This flag opts out.
      'no-save': {
        type: 'boolean',
        usage: 'do not write the provider and database URL to your config file',
      },
    },
    async run(ctx: Context): Promise<void> {
      await login(
        a,
        ctx.bool('remove'),
        ctx.bool('show'),
        ctx.bool('yes'),
        !ctx.bool('no-save'),
        ctx.string('database'),
      );
    },
  };
}

async function login(
  a: App,
  remove: boolean,
  show: boolean,
  yes: boolean,
  save: boolean,
  database: string,
): Promise<void> {
  if (remove && show) {
    throw usagef('--remove and --show cannot be combined');
  }

  const provider = loginProvider(a);
  if (database !== '') {
    if (provider !== config.ProviderTurso) {
      throw usagef(
        `--database applies to the turso provider only, not ${JSON.stringify(provider)}`,
      );
    }
    if (remove || show) {
      throw usagef('--database cannot be combined with --remove or --show');
    }
  }

  const account = loginAccount(provider);
  const backend = keyringBackend();

  if (show) {
    loginShow(a, provider, account, backend);
    return;
  }
  if (remove) {
    await loginRemove(a, provider, account, backend, yes);
    return;
  }
  await loginStore(a, provider, account, backend, database, yes, save);
}

/**
 * loginProvider resolves which provider's token is being managed. It reads
 * the configuration without validating it, because a user who has no token
 * yet is exactly the user running this command.
 */
function loginProvider(a: App): config.Provider {
  const name = a.providerName.trim();
  if (name !== '') {
    return name;
  }
  try {
    return loadUnvalidated(a).Provider;
  } catch (err) {
    throw exit.configf(asError(err)) as Error;
  }
}

/**
 * loadUnvalidated reads the configuration the way this command needs it: no
 * Validate call, because the missing token is the point.
 */
function loadUnvalidated(a: App): config.Config {
  const opts: config.Options = { Getenv: a.env.getenv, ConfigPath: a.configPath };
  if (a.env.keyring !== undefined) {
    opts.Keyring = a.env.keyring;
  }
  return config.Load(opts);
}

/**
 * loginAccount maps a provider onto the keychain entry that holds its token.
 * A provider that has no token is a usage error, not a silent success.
 */
function loginAccount(provider: config.Provider): string {
  switch (provider) {
    case config.ProviderTurso:
      return keyring.AccountTursoToken;
    case config.ProviderD1:
      return keyring.AccountD1Token;
    case config.ProviderSQLite:
      throw usagef(
        `provider ${JSON.stringify(provider)} needs no credential: local SQLite is a file on your disk, so there is nothing to log in to`,
      );
    case config.ProviderFirestore:
      // A removed provider is a configuration problem, exit 3, the same
      // answer every other command gives for it. An agent that branches on
      // the exit code must not see one cause reported two ways.
      throw exit.configf(
        new Error(
          `provider ${JSON.stringify(provider)} was removed and is not coming back; see docs/providers.md`,
        ),
      ) as Error;
    default:
      throw usagef(`unknown provider ${JSON.stringify(provider)}`);
  }
}

/**
 * loginShow reports presence and a hint. The value is never rendered: the
 * hint comes from Secret.hint, which is the redaction marker plus a short
 * fingerprint of the value.
 */
function loginShow(
  a: App,
  provider: config.Provider,
  account: string,
  backend: string,
): void {
  if (!keyringAvailable()) {
    loginUnavailable(a, provider, account, 'present', false);
    return;
  }
  let entry: keyring.Entry;
  try {
    entry = keyringGet(account);
  } catch (err) {
    throw exit.configf(asError(err)) as Error;
  }
  const hint = entry.value.hint();
  if (a.out.json) {
    a.out.emit({
      provider,
      account,
      backend,
      present: entry.present,
      hint,
    });
    return;
  }
  if (!entry.present) {
    a.out.printf(`no token stored for ${provider} in the ${backend}\n`);
    return;
  }
  a.out.printf(`token stored for ${provider} in the ${backend}: ${hint}\n`);
}

/**
 * loginRemove deletes the stored token. The deletion cannot be undone — the
 * token has to be re-minted or re-pasted — so it asks, in the same shape as
 * `tdo rm --purge`: on a terminal it prompts, and without one it refuses
 * rather than assuming consent.
 */
async function loginRemove(
  a: App,
  provider: config.Provider,
  account: string,
  backend: string,
  yes: boolean,
): Promise<void> {
  if (!keyringAvailable()) {
    loginUnavailable(a, provider, account, 'removed', false);
    return;
  }
  if (!yes) {
    if (!stdinIsTerminal(a)) {
      throw usagef(
        `refusing to delete the stored ${provider} token without a terminal to confirm at; pass --yes`,
      );
    }
    const ok = await confirm(
      a,
      `Delete the stored ${provider} token from the ${backend}? It cannot be recovered.`,
    );
    if (!ok) {
      // Declining is not a failure; nothing was deleted.
      a.out.hintf(`Cancelled; the stored ${provider} token was left in place.`);
      if (a.out.json) {
        a.out.emit({ provider, account, backend, stored: true, removed: false });
      }
      return;
    }
  }
  try {
    keyringDelete(account);
  } catch (err) {
    throw exit.configf(asError(err)) as Error;
  }
  if (a.out.json) {
    a.out.emit({ provider, account, backend, stored: false, removed: true });
    return;
  }
  a.out.printf(`removed the stored ${provider} token from the ${backend}\n`);
}

async function loginStore(
  a: App,
  provider: config.Provider,
  account: string,
  backend: string,
  database: string,
  yes: boolean,
  save: boolean,
): Promise<void> {
  // Delegation first: when the provider's own CLI can mint a credential, it
  // mints a better one than the user would create by hand.
  if (provider === config.ProviderTurso) {
    ensureProviderCLI();
    if (providercli.tursoAvailable()) {
      await loginTurso(a, provider, account, backend, database, yes, save);
      return;
    }
    a.out.hintf(
      'the turso CLI is not installed, so tdo cannot mint a token scoped to one database for you.',
    );
    a.out.hintf(
      '  install it with `brew install tursodatabase/tap/turso`, run `turso auth login`, then `tdo login` again.',
    );
    a.out.hintf('falling back to reading a token from stdin.');
  }

  if (!keyringAvailable()) {
    loginUnavailable(a, provider, account, 'stored', false);
    return;
  }

  if (provider === config.ProviderD1) {
    // SECURITY.md: this is a property of Cloudflare's token model, not of
    // anything tdo does, and the user should know it before they paste.
    a.out.warnf(
      'a Cloudflare API token cannot be scoped to a single D1 database: the token you are about to paste can read and modify every D1 database in that account. Use an account whose only D1 database is this one, or choose turso instead.',
    );
  }

  const token = await readToken(a, provider);
  if (token.empty()) {
    throw usagef('no token on stdin: pipe it in or run this on a terminal, never as a flag');
  }

  try {
    keyringSet(account, token);
  } catch (err) {
    // An unwritable backend is not a failure of this command: the user is
    // told what to run in their own shell, with their own argv.
    if (
      keyring.Is(err, keyring.ErrWriteUnsupported) ||
      keyring.Is(err, keyring.ErrUnavailable)
    ) {
      loginUnavailable(a, provider, account, 'stored', true);
      return;
    }
    throw exit.configf(asError(err)) as Error;
  }

  if (a.out.json) {
    a.out.emit({
      provider,
      account,
      backend,
      stored: true,
      // Every stored token reports which path produced it, so a caller can
      // tell a pasted token from one a provider CLI minted without knowing
      // which providers support delegation.
      source: providercli.SOURCE_STDIN,
    });
    return;
  }
  a.out.printf(`stored the ${provider} token in the ${backend}\n`);
  a.out.hintf(
    `tdo now reads it from the keychain; you can unset the ${tokenEnvName(provider)} environment variable.`,
  );
}

/**
 * loginUnavailable degrades honestly: it prints the command the user can run
 * themselves to stderr and exits 0, because nothing failed — the user has
 * been told what to do. field names the key the caller would have set, so
 * that --show and --remove keep their own documented shapes.
 */
function loginUnavailable(
  a: App,
  provider: config.Provider,
  account: string,
  field: string,
  hadToken: boolean,
): void {
  const instructions = keyring.ManualInstructions(account);
  if (a.out.json) {
    a.out.emit({
      provider,
      account,
      backend: keyring.BackendNone,
      [field]: false,
      instructions,
    });
    return;
  }
  if (hadToken) {
    a.out.hintf(
      'tdo will not run this for you: the keychain binary on this platform only takes a token as a command-line argument, which would expose it through `ps` and your shell history. Run it yourself, in your own shell:',
    );
  } else {
    a.out.hintf(
      'no OS keychain is available here, so tdo cannot store a token for you. To store one yourself:',
    );
  }
  a.out.hintf(`  ${instructions}`);
}

/**
 * tokenEnvName is the environment variable the user can now unset. It is
 * named, never read.
 */
function tokenEnvName(provider: config.Provider): string {
  switch (provider) {
    case config.ProviderD1:
      return config.EnvD1Token;
    default:
      return config.EnvTursoToken;
  }
}

/**
 * readToken reads the token from stdin and nowhere else. On a terminal it
 * prompts on stderr with echo disabled; otherwise it reads one line with no
 * prompt, which is the non-interactive contract.
 */
async function readToken(a: App, provider: config.Provider): Promise<Secret> {
  if (!stdinIsTerminal(a)) {
    return readTokenLine(a);
  }
  a.env.stderr.write(`Token for ${provider} (not echoed): `);
  const restore = disableEcho(a);
  try {
    return await readTokenLine(a);
  } finally {
    restore();
    // The user's newline was swallowed by the disabled echo, so the next
    // line of output would otherwise run on from the prompt.
    a.env.stderr.write('\n');
  }
}

/**
 * readTokenLine reads one line and trims only the line ending: a token is
 * used exactly as given, never silently altered.
 *
 * Go read through a bufio.Reader and treated EOF with no bytes as "no token
 * at all", which the caller turns into a usage error with advice rather than
 * an I/O failure. `Env.Reader` hands over the whole of stdin, so the
 * equivalent is the empty string.
 */
async function readTokenLine(a: App): Promise<Secret> {
  let line: string;
  try {
    line = firstLine(
      await (a.env.stdin.readLine ?? a.env.stdin.read).call(a.env.stdin),
    );
  } catch (err) {
    throw new Error(`read token from stdin: ${asError(err).message}`);
  }
  if (line.endsWith('\r')) {
    line = line.slice(0, -1);
  }
  return new Secret(line);
}

/**
 * disableEcho turns terminal echo off by executing stty, and returns the
 * function that turns it back on. Node has no way to stop echoing without
 * putting the terminal into raw mode, which would also take over Ctrl-C and
 * line editing; Go reached for stty for the same reason, and the mode is a
 * fixed literal, never anything derived from input. No secret goes near the
 * child's argv — the token is still read by this process, from stdin.
 *
 * The returned function is safe to call more than once. It is installed in a
 * finally block and also from a SIGINT handler, so a Ctrl-C at the prompt
 * cannot leave the user with an echo-less shell.
 */
function disableEcho(a: App): () => void {
  // Go asserted `a.env.Stdin.(*os.File)` and did nothing when stdin was an
  // injected reader; the same test here is whether the real process stdin is
  // a terminal. Without it a test that reports a terminal through the
  // injected `stdinIsTTY` would run stty against the test runner's own
  // terminal, and a crash between the two calls would leave the developer
  // with an echo-less shell.
  if (process.stdin.isTTY !== true) {
    return (): void => {};
  }
  if (!sttyAvailable()) {
    // Without stty the token would be echoed. Say so rather than silently
    // showing it on screen.
    a.out.warnf('stty is not available, so the token will be visible as you type');
    return (): void => {};
  }
  if (!sttyEcho('-echo')) {
    a.out.warnf('could not disable terminal echo, so the token will be visible as you type');
    return (): void => {};
  }

  let restored = false;
  const onInterrupt = (): void => {
    sttyEcho('echo');
  };
  process.once('SIGINT', onInterrupt);
  return (): void => {
    if (restored) {
      return;
    }
    restored = true;
    process.removeListener('SIGINT', onInterrupt);
    sttyEcho('echo');
  };
}

function sttyAvailable(): boolean {
  return lookOnPath('stty') !== undefined;
}

/**
 * sttyEcho runs stty against the real terminal, reporting whether it worked.
 * The mode is one of two literals.
 */
function sttyEcho(mode: '-echo' | 'echo'): boolean {
  const res = spawnSync('stty', [mode], {
    // stty reads the terminal from its own stdin, which is this process's.
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return (res.error === undefined || res.error === null) && res.status === 0;
}

/**
 * loginTurso delegates to the Turso CLI. This is the recommended path, and it
 * is also the safest one available: `turso db tokens create <database>` mints
 * a credential that reaches exactly one database, which is narrower than
 * anything a user would create in the dashboard by hand.
 *
 * The minted token lives only in a Secret between the child's stdout and the
 * keychain. If it cannot be stored it is discarded, never printed.
 */
async function loginTurso(
  a: App,
  provider: config.Provider,
  account: string,
  backend: string,
  database: string,
  yes: boolean,
  save: boolean,
): Promise<void> {
  let loggedIn: boolean;
  try {
    loggedIn = await providercli.tursoLoggedIn();
  } catch (err) {
    throw exit.configf(
      new Error(
        `could not ask the turso CLI whether you are logged in: ${asError(err).message}`,
      ),
    ) as Error;
  }
  if (!loggedIn) {
    throw exit.configf(
      new Error(
        'the turso CLI is installed but not logged in: run `turso auth login`, then `tdo login` again',
      ),
    ) as Error;
  }

  const db = await resolveTursoDatabase(a, database);

  // Minting reaches outside this machine: it creates a new token on the
  // user's Turso account. On a terminal that is confirmed first; without one
  // it is refused rather than guessed at, and in particular it does not fall
  // back to reading a token from stdin — that would silently store a
  // different credential than the caller asked for.
  if (!yes) {
    if (!stdinIsTerminal(a)) {
      throw usagef(
        `refusing to mint a new turso token for database ${JSON.stringify(db)} without a terminal to confirm at; pass --yes`,
      );
    }
    const ok = await confirm(
      a,
      `Create a new token on your Turso account for database ${JSON.stringify(db)}?`,
    );
    if (!ok) {
      // Declining is not a failure: no token was created, so there is
      // nothing to store and nothing to undo.
      a.out.hintf(
        'Cancelled; no token was created on your Turso account and nothing was stored.',
      );
      if (a.out.json) {
        a.out.emit({
          provider,
          account,
          backend,
          stored: false,
          source: providercli.SOURCE_TURSO_CLI,
          database: db,
        });
      }
      return;
    }
  }

  a.out.debugf(`minting a turso token scoped to database ${db}`);
  let token: Secret;
  try {
    token = await providercli.tursoCreateToken(db);
  } catch (err) {
    // The error carries the child's exit status and stderr only; its stdout,
    // which is the token, is dropped inside providercli.
    throw exit.configf(
      new Error(
        `mint a token for turso database ${JSON.stringify(db)}: ${asError(err).message}`,
      ),
    ) as Error;
  }

  if (!keyringAvailable()) {
    await loginTursoUnstorable(a, provider, account, db, save);
    return;
  }
  try {
    keyringSet(account, token);
  } catch (err) {
    if (
      keyring.Is(err, keyring.ErrWriteUnsupported) ||
      keyring.Is(err, keyring.ErrUnavailable)
    ) {
      await loginTursoUnstorable(a, provider, account, db, save);
      return;
    }
    throw exit.configf(asError(err)) as Error;
  }

  // The save happens before the result is rendered, because --json reports in
  // one object both what was stored and what was written.
  const written = await saveTursoConfig(a, db, save);

  if (a.out.json) {
    a.out.emit({
      provider,
      account,
      backend,
      stored: true,
      source: providercli.SOURCE_TURSO_CLI,
      database: db,
      ...configWriteJSON(written),
    });
    return;
  }
  a.out.printf(
    `minted a token for the turso database ${JSON.stringify(db)} with the turso CLI and stored it in the ${backend}\n`,
  );
}

/**
 * loginTursoUnstorable handles a token that was minted but cannot be stored.
 * It exits 0 — nothing failed, the user has been told what to do — and prints
 * no token: the one we minted is dropped, and the user mints their own.
 */
async function loginTursoUnstorable(
  a: App,
  provider: config.Provider,
  account: string,
  db: string,
  save: boolean,
): Promise<void> {
  const instructions = `turso db tokens create ${db}   # then export ${config.EnvTursoToken} with its output`;
  const written = await saveTursoConfig(a, db, save);
  if (a.out.json) {
    a.out.emit({
      provider,
      account,
      backend: keyring.BackendNone,
      stored: false,
      source: providercli.SOURCE_TURSO_CLI,
      database: db,
      instructions,
      ...configWriteJSON(written),
    });
    return;
  }
  a.out.hintf(
    'a token was minted but there is no keychain here to store it in, so it has been discarded rather than printed. Mint one yourself and put it in your environment:',
  );
  a.out.hintf(`  ${instructions}`);
}

/**
 * saveTursoConfig records what the mint just established — the provider, and
 * the database URL — in the user's config file, so that there is no line to
 * paste by hand. A URL is not a credential; the token is not written here or
 * anywhere else, and config.Set refuses the key outright.
 *
 * It returns what it wrote, or undefined when nothing was written, and never
 * fails the command: the token is already in the keychain, so a config file
 * that cannot be written is a missing convenience, not a failed login. In
 * that case the lines to paste are printed exactly as they always were.
 */
async function saveTursoConfig(
  a: App,
  db: string,
  save: boolean,
): Promise<config.WriteResult | undefined> {
  let url = '';
  try {
    url = await providercli.tursoDatabaseURL(db);
  } catch {
    url = '';
  }
  if (url === '') {
    a.out.debugf('could not read the database url from the turso CLI; skipping the config file');
    return undefined;
  }

  if (!save) {
    a.out.hintf('--no-save: not touching your config file. To configure this database by hand:');
    tursoConfigLines(a, url);
    return undefined;
  }

  let res: config.WriteResult;
  try {
    res = config.Set(
      { Getenv: a.env.getenv, ConfigPath: a.configPath },
      { Key: 'provider', Value: config.ProviderTurso },
      { Table: config.ProviderTurso, Key: 'url', Value: url },
    );
  } catch (err) {
    a.out.warnf(`the token is stored, but your config file was not updated: ${asError(err).message}`);
    a.out.hintf('add this to your config file, or set the environment variables, yourself:');
    tursoConfigLines(a, url);
    return undefined;
  }

  reportConfigWrite(a, res);
  return res;
}

/**
 * tursoConfigLines prints the config-file lines for a database. A URL is not
 * a credential, so it may be shown; it goes to stderr because it is advice,
 * not this command's result.
 */
function tursoConfigLines(a: App, url: string): void {
  a.out.hintf(`  provider = ${JSON.stringify(config.ProviderTurso)}`);
  a.out.hintf('  [turso]');
  a.out.hintf(`  url = ${JSON.stringify(url)}`);
}

/**
 * reportConfigWrite says on stderr which file was written and which keys
 * changed. A write the user did not ask for is never silent.
 */
function reportConfigWrite(a: App, res: config.WriteResult | undefined): void {
  if (res === undefined) {
    return;
  }
  const changed = res.Changes.filter((c) => c.Changed).map(
    (c) => `${c.Name} = ${JSON.stringify(c.Value)}`,
  );
  if (changed.length === 0) {
    a.out.hintf(
      `your config file ${res.Path} already said ${configKeyList(res)}; nothing was changed.`,
    );
    return;
  }
  a.out.hintf(`${res.Created ? 'created' : 'updated'} ${res.Path}: ${changed.join(', ')}`);
}

/**
 * configKeyList names the keys a write considered, for the message that says
 * nothing needed changing.
 */
function configKeyList(res: config.WriteResult): string {
  return res.Changes.map((c) => c.Name).join(' and ');
}

/**
 * configWriteJSON describes a config-file write for `tdo login --json`, or
 * reports that none happened. The keys are always present, so a caller never
 * has to branch on their absence.
 */
function configWriteJSON(res: config.WriteResult | undefined): Record<string, unknown> {
  if (res === undefined) {
    return { config_file: '', config_written: false, config_keys: [] };
  }
  return {
    config_file: res.Path,
    config_written: res.Wrote,
    config_keys: res.Changes.filter((c) => c.Changed).map((c) => c.Name),
  };
}

/**
 * resolveTursoDatabase works out which database to mint for, cheapest source
 * first: the flag, then the configured URL, then the account's database list
 * when it holds exactly one. Anything else is a usage error, because guessing
 * would mint a credential for the wrong database.
 */
async function resolveTursoDatabase(a: App, database: string): Promise<string> {
  const flag = database.trim();
  if (flag !== '') {
    return flag;
  }

  const url = configuredTursoURL(a);
  if (url !== '') {
    const [name, ok] = providercli.databaseFromURL(url);
    if (ok) {
      return name;
    }
    // The `<database>-<organization>` split is ambiguous for this host — a
    // name may itself contain dashes — so ask the CLI instead of guessing.
    let names: string[] | undefined;
    try {
      names = await providercli.tursoDatabases();
    } catch {
      names = undefined;
    }
    if (names !== undefined) {
      const [matched, matchedOK] = providercli.matchDatabaseInURL(url, names);
      if (matchedOK) {
        return matched;
      }
      if (names.length === 1) {
        return names[0] ?? '';
      }
    }
    throw usagef(
      `could not tell which turso database ${JSON.stringify(url)} refers to; pass --database NAME`,
    );
  }

  let names: string[];
  try {
    names = await providercli.tursoDatabases();
  } catch (err) {
    throw usagef(
      `could not list your turso databases (${asError(err).message}); pass --database NAME`,
    );
  }
  switch (names.length) {
    case 0:
      throw usagef(
        'the turso CLI lists no databases; create one with `turso db create NAME`, then pass --database NAME',
      );
    case 1:
      return names[0] ?? '';
    default:
      throw usagef(
        `you have ${names.length} turso databases (${names.join(', ')}); pass --database NAME to say which one this token is for`,
      );
  }
}

/**
 * configuredTursoURL reads the Turso URL without validating the rest of the
 * configuration: a user who has no token yet is exactly the user running this
 * command, so Validate would reject them.
 */
function configuredTursoURL(a: App): string {
  try {
    return loadUnvalidated(a).Turso.URL.trim();
  } catch {
    return '';
  }
}

/**
 * forTest grants a test the reach Go's tests had into the package's own
 * variables. Nothing outside a test may use it: the supported surface is
 * everything above.
 */
export const forTest = {
  /**
   * installKeychain replaces the five keychain indirections and returns the
   * function that puts them back, so that no test can read or write the
   * developer's real keychain.
   */
  installKeychain(fake: {
    backend: () => string;
    available: () => boolean;
    get: (account: string) => keyring.Entry;
    set: (account: string, value: Secret) => void;
    delete: (account: string) => void;
  }): () => void {
    const previous = {
      backend: keyringBackend,
      available: keyringAvailable,
      get: keyringGet,
      set: keyringSet,
      del: keyringDelete,
    };
    keyringBackend = fake.backend;
    keyringAvailable = fake.available;
    keyringGet = fake.get;
    keyringSet = fake.set;
    keyringDelete = fake.delete;
    return (): void => {
      keyringBackend = previous.backend;
      keyringAvailable = previous.available;
      keyringGet = previous.get;
      keyringSet = previous.set;
      keyringDelete = previous.del;
    };
  },
  /**
   * installProviderCLI marks the lazy runner as installed and hands
   * providercli the caller's fakes, so that no test can reach a real
   * provider CLI (CLAUDE.md §1.5). It returns the restore function.
   */
  installProviderCLI(opts: {
    lookPath?: providercli.LookPath | undefined;
    runner?: providercli.Runner | undefined;
  }): () => void {
    const was = runnerInstalled;
    runnerInstalled = true;
    const previous = providercli.installRunner(opts);
    return (): void => {
      runnerInstalled = was;
      providercli.installRunner(previous);
    };
  },
  tokenEnvName,
  configWriteJSON,
  resolveTursoDatabase,
};
