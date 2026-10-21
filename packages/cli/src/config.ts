// Resolves the CLI's configuration and credentials.
//
// Values come from, highest priority first: environment variables, the file
// named by $TODOCLOUD_CONFIG, $XDG_CONFIG_HOME/todocloud/config.toml (default
// ~/.config/todocloud/config.toml), and finally built-in defaults. A missing
// file at the default location is not an error; a missing file the user asked
// for by name is.
//
// Credential handling rules this module exists to enforce:
//
//   - A token is resolved from, highest priority first: the environment
//     variable, the OS keychain, and finally the config file — but a file
//     token is loaded only when every guard in resolveToken holds: the file is
//     outside any git repository, it is the XDG config file or the one named
//     by $TODOCLOUD_CONFIG, and it is not group- or world-readable. A refused
//     token is not loaded, is not retained, and raises a loud warning that
//     names the file, the key, the reason and the alternatives; no warning
//     ever contains the value.
//   - Every other secret-shaped key (api_token, secret, password, key) is
//     never loaded: there is exactly one supported spelling, so a near miss is
//     reported rather than silently ignored.
//   - Every token is held in Secret, so no string coercion, no JSON encoding
//     and no error message built here can disclose it.
//   - No API in this module accepts a token as a plain string from the
//     command line; there is no flag that carries a secret.
//
// The second half of the file is the config *writer*, which was
// `internal/config/write.go`. It is here rather than in a module of its own
// because it is the other half of one contract: it writes only where the
// reader is willing to read a token from, and it refuses the reader's own
// secret-shaped key list.
//
// This module belongs to `packages/cli` rather than `packages/core`: it reads
// and writes the filesystem, so it imports `node:*`, which the PWA cannot
// resolve.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ConfigError, configf } from '@todocloud/core/exit';
import { Secret } from '@todocloud/core/secret';

import {
  AccountD1Token,
  AccountTursoToken,
  Available as keyringAvailable,
  Backend as keyringBackend,
  ErrUnavailable,
  Get as keyringGet,
  Is,
  type Entry as KeyringEntry,
} from './keyring.ts';
import {
  checkBareKey,
  kindString,
  parseTableHeader,
  parseTOML,
  TomlFile,
  type TomlValue,
} from './toml.ts';

/**
 * Provider names a storage backend. The open-ended union is how the ported
 * packages spell a Go string type whose values are known but whose zero value
 * and typos still have to flow through: an unknown name reaches Validate and
 * is reported there, not swallowed by the type system.
 */
export type Provider = 'sqlite' | 'turso' | 'firestore' | 'd1' | (string & {});

// The known providers, in roadmap order.
export const ProviderSQLite: Provider = 'sqlite';
export const ProviderTurso: Provider = 'turso';
/**
 * ProviderFirestore is recognised but not offered. A Firestore provider was
 * built and then removed (PLAN.md §2); keeping the name means a config file
 * that still says "firestore" gets told what happened instead of "unknown
 * provider".
 */
export const ProviderFirestore: Provider = 'firestore';
export const ProviderD1: Provider = 'd1';

// Environment variable names. Tokens appear here and nowhere else.
export const EnvConfig = 'TODOCLOUD_CONFIG';
export const EnvProvider = 'TODOCLOUD_PROVIDER';
export const EnvSQLitePath = 'TODOCLOUD_SQLITE_PATH';
export const EnvTursoURL = 'TODOCLOUD_TURSO_URL';
export const EnvTursoToken = 'TODOCLOUD_TURSO_TOKEN';
export const EnvD1AccountID = 'TODOCLOUD_D1_ACCOUNT_ID';
export const EnvD1DatabaseID = 'TODOCLOUD_D1_DATABASE_ID';
export const EnvD1Token = 'TODOCLOUD_D1_TOKEN';

// Unexported in Go, and package-internal here: the writer and the tests of
// both halves name them, and nothing outside `packages/cli` does.
export const envXDGConfigHome = 'XDG_CONFIG_HOME';
export const envXDGDataHome = 'XDG_DATA_HOME';
export const envHome = 'HOME';

/** Providers returns every known provider name, in roadmap order. */
export function Providers(): Provider[] {
  return [ProviderSQLite, ProviderTurso, ProviderFirestore, ProviderD1];
}

/** providerKnown reports whether p is one of the names in Providers. */
export function providerKnown(p: Provider): boolean {
  return Providers().includes(p);
}

/**
 * providerImplemented reports whether this binary can actually talk to p. In
 * v0.1 only sqlite and turso are implemented; the remaining providers are
 * accepted as names so that the error can say which version they ship in.
 */
export function providerImplemented(p: Provider): boolean {
  return p === ProviderSQLite || p === ProviderTurso;
}

/** SQLiteConfig configures the local SQLite provider. */
export interface SQLiteConfig {
  Path: string;
}

/** TursoConfig configures the Turso/libSQL provider. */
export interface TursoConfig {
  URL: string;
  Token: Secret;
}

/** D1Config configures the Cloudflare D1 provider. */
export interface D1Config {
  AccountID: string;
  DatabaseID: string;
  Token: Secret;
}

/**
 * ConfigInit is the zero-value-friendly initialiser a Go composite literal
 * gave for free. Every field is optional and falls back to the zero value the
 * Go struct had.
 */
export interface ConfigInit {
  Provider?: Provider;
  SQLite?: Partial<SQLiteConfig>;
  Turso?: Partial<TursoConfig>;
  D1?: Partial<D1Config>;
  Path?: string;
  Origins?: Record<string, string>;
  Warnings?: string[];
}

/** Config is the resolved configuration. */
export class Config {
  Provider: Provider;
  SQLite: SQLiteConfig;
  Turso: TursoConfig;
  D1: D1Config;

  /** Path is the config file that was read, or "" when none was found. */
  Path: string;

  /**
   * Origins records where each resolved value came from, keyed by a dotted
   * setting name such as "provider" or "turso.url", with values like
   * "env:TODOCLOUD_PROVIDER", "keyring:keychain", "file:/path/to/config.toml"
   * or "default". A refused file token is never recorded here: an absent
   * token has no origin at all.
   */
  Origins: Record<string, string>;

  /**
   * fileProvider is what the config file named, whether or not it won. It was
   * an unexported field in Go, which is why FileProvider below exists;
   * TypeScript has no package scope, so it is merely documented as internal.
   */
  fileProvider: Provider = '';

  /**
   * Warnings holds credential-hygiene problems worth telling the user about
   * (a group- or world-readable config file, a config file inside a git
   * repository, a refused or unsupported credential key, a keychain lookup
   * that failed). They are printed to stderr, never to stdout, and never
   * contain a credential value.
   */
  Warnings: string[];

  constructor(init: ConfigInit = {}) {
    this.Provider = init.Provider ?? '';
    this.SQLite = { Path: init.SQLite?.Path ?? '' };
    this.Turso = {
      URL: init.Turso?.URL ?? '',
      Token: init.Turso?.Token ?? new Secret(''),
    };
    this.D1 = {
      AccountID: init.D1?.AccountID ?? '',
      DatabaseID: init.D1?.DatabaseID ?? '',
      Token: init.D1?.Token ?? new Secret(''),
    };
    this.Path = init.Path ?? '';
    this.Origins = init.Origins ?? {};
    this.Warnings = init.Warnings ?? [];
  }

  /**
   * FileProvider returns the provider the config file named, and false when
   * the file named none. It is how the command layer tells an override apart
   * from an environment variable that merely restates the configured
   * provider.
   */
  FileProvider(): [provider: Provider, ok: boolean] {
    return [this.fileProvider, this.fileProvider !== ''];
  }

  /**
   * Validate checks that the selected provider has everything it needs, and
   * throws a ConfigError naming the missing environment variable when it does
   * not.
   */
  Validate(): void {
    if (!providerKnown(this.Provider)) {
      throw configFailure(
        `unknown provider ${quote(this.Provider)}; valid providers are ${providerList()} (set ${EnvProvider} or provider in the config file)`,
      );
    }
    if (!providerImplemented(this.Provider)) {
      // Two different answers, because telling someone to wait for something
      // that is never coming is worse than saying so.
      if (this.Provider === ProviderFirestore) {
        throw configFailure(
          `provider ${quote(this.Provider)} was removed and is not coming back — see docs/providers.md for why. Move your tasks with \`tdo export\` on the old store and \`tdo import\` on a ${quote(ProviderSQLite)} or ${quote(ProviderTurso)} one`,
        );
      }
      throw configFailure(
        `provider ${quote(this.Provider)} is not implemented in this build; it ships in a later version — see docs/providers.md for the roadmap. Use ${quote(ProviderSQLite)} or ${quote(ProviderTurso)} for now`,
      );
    }

    this.validateProvider();
  }

  /**
   * validateProvider checks the values the selected provider needs, without
   * the known/implemented checks Validate makes first. It is separate so that
   * the per-value rules of the providers that have not shipped yet are still
   * reachable, and testable, before they are wired up.
   *
   * It was unexported in Go and is package-internal here: the tests of those
   * unshipped providers drive it directly, and nothing else should.
   */
  validateProvider(): void {
    switch (this.Provider) {
      case ProviderSQLite: {
        // A path is always available, because there is a default; it can only
        // fail when it cannot be made absolute.
        try {
          this.SQLite.Path = ExpandPath(this.SQLite.Path);
        } catch (err) {
          throw configFailure(
            `sqlite path ${quote(this.SQLite.Path)} cannot be resolved (set ${EnvSQLitePath}): ${message(err)}`,
            err,
          );
        }
        break;
      }
      case ProviderTurso:
        if (this.Turso.URL === '') {
          throw configFailure(
            `provider turso needs a database URL: set ${EnvTursoURL} (or turso.url in the config file)`,
          );
        }
        if (this.Turso.Token.empty()) {
          throw configFailure(
            `provider turso needs an auth token: set ${EnvTursoToken}, or run \`tdo login\` to store it in the OS keychain (a token in the config file is read only from ${xdgConfigHint}, mode 600, outside any git repository)`,
          );
        }
        break;
      case ProviderD1:
        if (this.D1.AccountID === '') {
          throw configFailure(
            `provider d1 needs an account id: set ${EnvD1AccountID} (or d1.account_id in the config file)`,
          );
        }
        if (this.D1.DatabaseID === '') {
          throw configFailure(
            `provider d1 needs a database id: set ${EnvD1DatabaseID} (or d1.database_id in the config file)`,
          );
        }
        if (this.D1.Token.empty()) {
          throw configFailure(
            `provider d1 needs an API token: set ${EnvD1Token}, or run \`tdo login\` to store it in the OS keychain (a token in the config file is read only from ${xdgConfigHint}, mode 600, outside any git repository)`,
          );
        }
        break;
      default:
        break;
    }
  }

  /**
   * Describe returns a fully redacted view for `tdo config --json`. Token
   * values appear only as Secret's hint, never as the value.
   */
  Describe(): Record<string, unknown> {
    const origins: Record<string, string> = { ...this.Origins };
    const keys = Object.keys(this.Origins).sort();

    return {
      provider: this.Provider,
      implemented: providerImplemented(this.Provider),
      config_file: this.Path,
      sqlite: {
        path: this.SQLite.Path,
      },
      turso: {
        url: this.Turso.URL,
        token: this.Turso.Token.hint(),
        token_present: !this.Turso.Token.empty(),
        token_origin: this.Origins['turso.token'] ?? '',
      },
      d1: {
        account_id: this.D1.AccountID,
        database_id: this.D1.DatabaseID,
        token: this.D1.Token.hint(),
        token_present: !this.D1.Token.empty(),
        token_origin: this.Origins['d1.token'] ?? '',
      },
      keyring: {
        backend: keyringBackend(),
        available: keyringAvailable(),
      },
      origins,
      origin_order: keys,
      warnings: [...this.Warnings],
    };
  }
}

/**
 * KeyringLookup is Options.Keyring: it looks a token up in the OS keychain by
 * account name. Go returned `(secret.Secret, bool, error)`; the entry here is
 * keyring's own `{value, present}` and a failure is thrown, which is the
 * convention `keyring.ts` already follows.
 */
export type KeyringLookup = (account: string) => KeyringEntry;

/** Options controls Load. */
export interface Options {
  /** Getenv defaults to the process environment. Tests inject a fake one. */
  Getenv?: (name: string) => string;
  /**
   * ConfigPath overrides the whole config-file search when non-empty. A token
   * in a file reached this way is not loaded: see resolveToken.
   */
  ConfigPath?: string;
  /**
   * Keyring looks a token up in the OS keychain. `present` is false when
   * there is simply no entry, which is not an error. It defaults to
   * keyringLookup, a thin wrapper over keyring.Get with a short timeout;
   * tests inject a fake so that no test touches a real keychain.
   */
  Keyring?: KeyringLookup;
}

/**
 * tokenKeyNames are the config-file keys that are assumed to hold a
 * credential. Only "token", under a provider table that has one, is ever
 * loaded; every other spelling is reported and dropped.
 */
export const tokenKeyNames = ['token', 'api_token', 'secret', 'password', 'key'];

/** fileTokenKey is the one supported spelling of a token in the config file. */
const fileTokenKey = 'token';

/**
 * keyringTimeoutMs bounds the OS keychain lookup. A local keychain answers in
 * milliseconds; the timeout exists so that a hung helper process cannot wedge
 * every command.
 */
const keyringTimeoutMs = 2_000;

/** processGetenv is the default Options.Getenv: the real environment. */
function processGetenv(name: string): string {
  return process.env[name] ?? '';
}

/**
 * Load resolves the configuration from the environment, the config file and
 * the built-in defaults, in that order of priority.
 */
export function Load(opts: Options = {}): Config {
  const getenv = opts.Getenv ?? processGetenv;
  const lookup = opts.Keyring ?? defaultKeyring;

  const cfg = new Config();

  const [filePath, mustExist] = configFilePath(opts, getenv);

  let file: TomlFile | null = null;
  if (filePath !== '') {
    file = readConfigFile(cfg, filePath, mustExist);
  }
  if (file === null) {
    file = new TomlFile();
  }

  const guard = fileTokenGuard(
    cfg.Path,
    fileTokenPathAllowed(getenv, cfg.Path),
  );

  // provider: env, then file, then the built-in default. The file's own
  // answer is kept either way, so a caller can tell an environment variable
  // that agrees with the file from one that overrides it — writing to a store
  // the config file does not name is worth saying out loud.
  const fileProvider = file.string('', 'provider');
  if (fileProvider !== undefined) {
    cfg.fileProvider = fileProvider;
  }
  if (getenv(EnvProvider) !== '') {
    cfg.Provider = getenv(EnvProvider);
    cfg.Origins['provider'] = 'env:' + EnvProvider;
  } else if (cfg.fileProvider !== '') {
    cfg.Provider = cfg.fileProvider;
    cfg.Origins['provider'] = 'file:' + cfg.Path;
  } else {
    cfg.Provider = ProviderSQLite;
    cfg.Origins['provider'] = 'default';
  }

  // sqlite.path always resolves, because there is a default.
  {
    const [v, origin] = resolve(
      getenv,
      file,
      EnvSQLitePath,
      'sqlite',
      'path',
      cfg.Path,
    );
    if (v !== '') {
      cfg.SQLite.Path = v;
      cfg.Origins['sqlite.path'] = origin;
    } else {
      cfg.SQLite.Path = defaultSQLitePath(getenv);
      cfg.Origins['sqlite.path'] = 'default';
    }
  }

  for (const [env, table, key, name] of [
    [EnvTursoURL, 'turso', 'url', 'turso.url'],
    [EnvD1AccountID, 'd1', 'account_id', 'd1.account_id'],
    [EnvD1DatabaseID, 'd1', 'database_id', 'd1.database_id'],
  ] as const) {
    const [v, origin] = resolve(getenv, file, env, table, key, cfg.Path);
    if (v === '') {
      continue;
    }
    cfg.Origins[name] = origin;
    switch (name) {
      case 'turso.url':
        cfg.Turso.URL = v;
        break;
      case 'd1.account_id':
        cfg.D1.AccountID = v;
        break;
      case 'd1.database_id':
        cfg.D1.DatabaseID = v;
        break;
    }
  }

  // Tokens: the environment, then the OS keychain, then the config file if
  // every guard holds. Firestore has no token: its credentials are a file
  // path, so it is deliberately absent from this list.
  cfg.Turso.Token = resolveToken(cfg, getenv, lookup, file, guard, {
    name: 'turso.token',
    env: EnvTursoToken,
    account: AccountTursoToken,
    table: ProviderTurso,
  });
  cfg.D1.Token = resolveToken(cfg, getenv, lookup, file, guard, {
    name: 'd1.token',
    env: EnvD1Token,
    account: AccountD1Token,
    table: ProviderD1,
  });

  return cfg;
}

/**
 * tokenRequest describes one provider token: where it may come from and what
 * it is called in each of those places.
 */
interface tokenRequest {
  /** name is the dotted setting name used in Origins, e.g. "turso.token". */
  name: string;
  /** env is the environment variable that holds it. */
  env: string;
  /** account is the OS keychain account that holds it. */
  account: string;
  /** table is the config-file table it may appear in, under the key "token". */
  table: string;
}

/**
 * tokenGuard carries the verdict on loading a token from the config file: the
 * file either qualifies, or reason says in one sentence why it does not.
 */
interface tokenGuard {
  allowed: boolean;
  reason: string;
}

/** refused builds the negative verdict, which is Go's zero value plus reason. */
function refused(reason: string): tokenGuard {
  return { allowed: false, reason };
}

/**
 * xdgConfigHint names the canonical config file in advice to the user. The
 * resolved path is environment-dependent, so a message that must read well
 * everywhere uses this instead.
 */
const xdgConfigHint = '~/.config/todocloud/config.toml';

/**
 * fileTokenGuard decides whether path may supply a token at all,
 * independently of which provider asked. All three guards are about the file,
 * not the value:
 *
 *  1. a file inside a git repository is one `git add -A` away from being
 *     published, which is the whole reason tokens were kept out of files;
 *  2. only the XDG config file and $TODOCLOUD_CONFIG qualify, because an
 *     arbitrary --config path is too easily a repository-relative one;
 *  3. a group- or world-readable file is not a safe place for a credential —
 *     which only a platform with POSIX file modes can be asked; see
 *     fileTokenModeGuard.
 */
function fileTokenGuard(filePath: string, pathAllowed: boolean): tokenGuard {
  if (filePath === '') {
    return refused('');
  }
  const [dir, inRepo] = repositoryRoot(filePath);
  if (inRepo) {
    return refused(
      `the file is inside the git repository at ${dir}, and a config file that holds a token must NEVER sit in a repository: one \`git add -A\`, one pushed dotfiles repo, and the token is public forever. Move it to ${xdgConfigHint}, outside every repository, with mode 600, and treat this token as exposed — rotate it now.`,
    );
  }
  if (!pathAllowed) {
    return refused(
      `a token is read only from ${xdgConfigHint} or the file named by $${EnvConfig}, and this file is neither; an arbitrary --config path is too easily one inside a repository.`,
    );
  }
  return fileTokenModeGuard(filePath);
}

/**
 * resolveToken applies the token precedence for one provider: the environment
 * variable, the OS keychain, then the config file subject to guard. A value
 * that is not used is not retained, and no warning raised here can contain
 * it.
 */
function resolveToken(
  cfg: Config,
  getenv: (name: string) => string,
  lookup: KeyringLookup | null,
  file: TomlFile,
  guard: tokenGuard,
  req: tokenRequest,
): Secret {
  // Go kept `entry` and a separate `inFile` that it cleared for a value of
  // the wrong kind. One variable does both here, because a non-string
  // `token` is an absent token as far as everything below is concerned.
  const raw: TomlValue | undefined = file.lookup(req.table, fileTokenKey);
  const entry: TomlValue | undefined =
    raw !== undefined && raw.kind === kindString ? raw : undefined;
  const inFile = entry !== undefined;
  const line = entry?.line ?? 0;

  // 1. the environment. The keychain is not consulted at all in this case.
  const fromEnv = getenv(req.env);
  if (fromEnv !== '') {
    cfg.Origins[req.name] = 'env:' + req.env;
    if (inFile && !guard.allowed) {
      warnRefusedFileToken(cfg, req, line, guard.reason);
    }
    return new Secret(fromEnv);
  }

  // 2. the OS keychain, for the selected provider only: looking a token up
  // for a provider this command will not talk to would spend a keychain round
  // trip, and possibly an unlock prompt, on nothing. A failure other than "no
  // entry" is not fatal: it falls through to the config file with a warning
  // that names the backend.
  if (lookup !== null && req.table === cfg.Provider) {
    let found: KeyringEntry | null = null;
    try {
      found = lookup(req.account);
    } catch (err) {
      cfg.Warnings.push(
        `WARNING: looking ${req.name} up in the OS keychain (backend ${keyringBackend()}, account ${req.account}) failed: ${message(err)}. Falling back to the config file; set ${req.env} in the environment to skip the keychain entirely.`,
      );
    }
    if (found !== null && found.present && !found.value.empty()) {
      cfg.Origins[req.name] = 'keyring:' + keyringBackend();
      if (inFile && !guard.allowed) {
        warnRefusedFileToken(cfg, req, line, guard.reason);
      }
      return found.value;
    }
  }

  // 3. the config file, guarded.
  if (entry === undefined) {
    return new Secret('');
  }
  if (!guard.allowed) {
    warnRefusedFileToken(cfg, req, line, guard.reason);
    return new Secret('');
  }
  cfg.Origins[req.name] = 'file:' + cfg.Path;
  return new Secret(entry.str);
}

/**
 * warnRefusedFileToken records why a file token was not used and what to do
 * instead. The value is never read into the message.
 */
function warnRefusedFileToken(
  cfg: Config,
  req: tokenRequest,
  line: number,
  reason: string,
): void {
  cfg.Warnings.push(
    `WARNING: config file ${cfg.Path} line ${line} sets ${req.name}, which holds a credential. ` +
      `The value was NOT loaded: ${reason} ` +
      `Set ${req.env} in the environment instead, or run \`tdo login\`, which stores the token in the OS keychain.`,
  );
}

/**
 * defaultKeyring is what Load uses when Options.Keyring is undefined. It is a
 * module variable so that the tests can point it at a fake and no test can
 * reach a real keychain by forgetting to set the option — Go's TestMain did
 * exactly this, and `forTest.setDefaultKeyring` is the door.
 */
let defaultKeyring: KeyringLookup = keyringLookup;

/**
 * keyringLookup is the default Options.Keyring: keyring.Get with a short
 * timeout, so that Load needs neither a deadline of its own nor a working
 * keychain.
 */
function keyringLookup(account: string): KeyringEntry {
  if (!keyringAvailable()) {
    return { value: new Secret(''), present: false };
  }
  try {
    return keyringGet(account, { timeoutMs: keyringTimeoutMs });
  } catch (err) {
    if (Is(err, ErrUnavailable)) {
      // No keychain on this machine is an absence, not a failure.
      return { value: new Secret(''), present: false };
    }
    throw err;
  }
}

/**
 * resolve returns the value of a non-secret setting from the environment or
 * the config file, with the origin string that describes where it came from.
 */
function resolve(
  getenv: (name: string) => string,
  file: TomlFile,
  env: string,
  table: string,
  key: string,
  filePath: string,
): [value: string, origin: string] {
  const fromEnv = getenv(env);
  if (fromEnv !== '') {
    return [fromEnv, 'env:' + env];
  }
  const fromFile = file.string(table, key);
  if (fromFile !== undefined && fromFile !== '') {
    return [fromFile, 'file:' + filePath];
  }
  return ['', ''];
}

/**
 * configFilePath decides which file to read. mustExist is true when the user
 * named the file explicitly, in which case a missing file is an error.
 */
function configFilePath(
  opts: Options,
  getenv: (name: string) => string,
): [path: string, mustExist: boolean] {
  if (opts.ConfigPath !== undefined && opts.ConfigPath !== '') {
    return [opts.ConfigPath, true];
  }
  const named = getenv(EnvConfig);
  if (named !== '') {
    return [named, true];
  }
  // Without a home directory there is simply no default file to read; the
  // built-in defaults still apply.
  const [p, ok] = xdgConfigPath(getenv);
  if (!ok) {
    return ['', false];
  }
  return [p, false];
}

/**
 * xdgConfigPath returns the canonical config file path, honouring
 * XDG_CONFIG_HOME and falling back to ~/.config, and whether it could be
 * determined at all.
 */
function xdgConfigPath(
  getenv: (name: string) => string,
): [path: string, ok: boolean] {
  let dir = getenv(envXDGConfigHome);
  if (dir === '') {
    const home = homeDir(getenv);
    if (home === null) {
      return ['', false];
    }
    dir = path.join(home, '.config');
  }
  return [path.join(dir, 'todocloud', 'config.toml'), true];
}

/**
 * readConfigFile reads and parses path, recording it on cfg along with any
 * credential-hygiene warnings it raises. It returns null when a file at the
 * default location simply is not there, which is not an error.
 */
function readConfigFile(
  cfg: Config,
  filePath: string,
  mustExist: boolean,
): TomlFile | null {
  let data: string;
  try {
    data = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (isNotExist(err)) {
      if (mustExist) {
        throw configFailure(`config file ${filePath} does not exist`);
      }
      return null;
    }
    throw configFailure(
      `reading config file ${filePath}: ${message(err)}`,
      err,
    );
  }

  let file: TomlFile;
  try {
    file = parseTOML(data);
  } catch (err) {
    throw configFailure(`config file ${filePath}: ${message(err)}`, err);
  }
  cfg.Path = filePath;

  // The mode and in-a-repository checks are not warnings in their own right:
  // a tokenless config file is not a credential at rest, and warning about
  // one on every invocation is noise on stderr. They feed fileTokenGuard,
  // which refuses a token in such a file and says why.
  checkTokenKeys(cfg, file, filePath);

  return file;
}

/**
 * repositoryRoot returns the directory of the git repository path sits in, if
 * any. It walks upwards looking for a .git entry, which catches both a normal
 * repository and a worktree's .git file.
 */
function repositoryRoot(filePath: string): [dir: string, ok: boolean] {
  let dir = path.dirname(filePath);
  for (;;) {
    try {
      // lstatSync, not statSync: a .git that is a dangling symlink is still a
      // .git, exactly as Go's Lstat reported it.
      fs.lstatSync(path.join(dir, '.git'));
      return [dir, true];
    } catch {
      // Not here; keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return ['', false];
    }
    dir = parent;
  }
}

/**
 * fileTokenPathAllowed reports whether path is one of the two locations a
 * token may be read from: the XDG config file, or the file named by
 * $TODOCLOUD_CONFIG.
 */
function fileTokenPathAllowed(
  getenv: (name: string) => string,
  filePath: string,
): boolean {
  if (filePath === '') {
    return false;
  }
  const named = getenv(EnvConfig);
  if (named !== '' && samePath(named, filePath)) {
    return true;
  }
  const [def, ok] = xdgConfigPath(getenv);
  if (ok && samePath(def, filePath)) {
    return true;
  }
  return false;
}

/**
 * samePath compares two paths for the purposes of the token guard: by cleaned
 * name first, then by identity on disk, so that a symlinked temporary
 * directory or a trailing slash does not defeat the check.
 */
function samePath(a: string, b: string): boolean {
  if (cleanPath(a) === cleanPath(b)) {
    return true;
  }
  try {
    const ai = fs.statSync(a);
    const bi = fs.statSync(b);
    // os.SameFile: the same device and inode. On Windows these are synthetic
    // but still equal for the same file, which is as much as the comparison
    // needs.
    return ai.dev === bi.dev && ai.ino === bi.ino;
  } catch {
    return false;
  }
}

/**
 * cleanPath is filepath.Clean: node's normalize keeps a trailing separator,
 * which Go's Clean removes, so it is stripped here.
 */
function cleanPath(p: string): string {
  const normalized = path.normalize(p);
  if (normalized.length > 1 && normalized.endsWith(path.sep)) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * checkTokenKeys warns about config-file keys that look like credentials. The
 * value is not loaded and never appears in the warning.
 */
function checkTokenKeys(cfg: Config, file: TomlFile, filePath: string): void {
  for (const e of file.entries) {
    if (!isTokenKey(e.key)) {
      continue;
    }
    if (e.key === fileTokenKey && providerHasToken(e.table)) {
      // The one supported spelling, under a provider that has a token:
      // resolveToken either loads it or refuses it with its own warning.
      continue;
    }
    let name = e.key;
    if (e.table !== '') {
      name = e.table + '.' + e.key;
    }
    const env = tokenEnvHint(e.table);
    cfg.Warnings.push(
      `WARNING: config file ${filePath} line ${e.value.line} sets ${quote(name)}, which looks like a credential. ` +
        `The value was NOT loaded: there is exactly one supported spelling, ${quote(fileTokenKey)} under [turso] or [d1]. ` +
        `Set ${env} in the environment, or run \`tdo login\` to store the token in the OS keychain, then delete the line — ` +
        `the file may now hold a credential at rest, so treat that credential as exposed and consider rotating it.`,
    );
  }
}

/** providerHasToken reports whether p takes a bearer token. */
function providerHasToken(p: Provider): boolean {
  return p === ProviderTurso || p === ProviderD1;
}

/**
 * isTokenKey reports whether key is one of the names assumed to hold a
 * secret. Unexported in Go; package-internal here, because both halves of
 * the file and their tests ask it.
 */
export function isTokenKey(key: string): boolean {
  return tokenKeyNames.includes(key.toLowerCase());
}

/**
 * tokenEnvHint names the environment variable a token in the given table
 * belongs in.
 */
function tokenEnvHint(table: string): string {
  switch (table) {
    case ProviderTurso:
      return EnvTursoToken;
    case ProviderD1:
      return EnvD1Token;
    default:
      return 'an environment variable';
  }
}

/** providerList renders the valid provider names for an error message. */
function providerList(): string {
  return Providers().join(', ');
}

/**
 * DefaultSQLitePath returns the default local database path, honouring
 * XDG_DATA_HOME and falling back to ~/.local/share/todocloud/tasks.db.
 */
export function DefaultSQLitePath(): string {
  return defaultSQLitePath(processGetenv);
}

/** defaultSQLitePath is DefaultSQLitePath with an injectable environment. */
function defaultSQLitePath(getenv: (name: string) => string): string {
  let dir = getenv(envXDGDataHome);
  if (dir === '') {
    const home = homeDir(getenv);
    if (home === null) {
      // Last resort: a relative path in the working directory. Validate turns
      // it into an absolute one.
      return path.join('todocloud', 'tasks.db');
    }
    dir = path.join(home, '.local', 'share');
  }
  return path.join(dir, 'todocloud', 'tasks.db');
}

/**
 * ExpandPath expands a leading "~" and returns an absolute path. Go returned
 * an error; this throws one.
 */
export function ExpandPath(p: string): string {
  if (p === '') {
    throw new Error('empty path');
  }
  let expanded = p;
  if (p === '~' || p.startsWith('~/')) {
    const home = homeDir(processGetenv);
    if (home === null) {
      throw new Error('cannot determine the home directory');
    }
    expanded = path.join(home, stripPrefix(stripPrefix(p, '~'), '/'));
  } else if (p.startsWith('~')) {
    throw new Error(`cannot expand ${quote(p)}: ~user paths are not supported`);
  }
  return path.resolve(expanded);
}

/** stripPrefix is strings.TrimPrefix. */
function stripPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

/**
 * homeDir returns the user's home directory, preferring HOME so that a test
 * can point it at a temporary directory, and null when there is none to be
 * had.
 */
function homeDir(getenv: (name: string) => string): string | null {
  const h = getenv(envHome);
  if (h !== '') {
    return h;
  }
  try {
    const home = os.homedir();
    return home === '' ? null : home;
  } catch {
    return null;
  }
}

// --- the per-platform file-token guard ---------------------------------
//
// Go chose between `filetoken_unix.go` and `filetoken_other.go` with build
// tags. There are no build tags here, so both branches live below and
// `fileTokenPlatformIsPOSIX` dispatches on `process.platform` at runtime —
// the pattern `keyring.ts` already uses, including the test-only override, so
// that a test run on any one machine can still reach both branches.

/**
 * platformOverride stands in for Go's build tags. Without it, one of the two
 * branches below is unreachable from a test run on any one machine, which is
 * the one thing the build-tagged Go files got for free.
 */
let platformOverride: string | null = null;

function currentPlatform(): string {
  return platformOverride ?? process.platform;
}

/**
 * fileTokenPlatformIsPOSIX reports whether this platform has POSIX file
 * modes. Go's `unix` build tag excluded windows (and plan9, which Node does
 * not run on), so win32 is the one branch without them.
 */
function fileTokenPlatformIsPOSIX(): boolean {
  return currentPlatform() !== 'win32';
}

/**
 * FileTokensSupported reports whether a token in the config file can be used
 * on this platform at all. It is true where a POSIX mode says plainly who may
 * read the file, so that the guard in fileTokenModeGuard can be asked and
 * answered, and false elsewhere — which is a decision rather than an
 * oversight: see fileTokenModeGuard.
 *
 * Go exported this as a compile-time constant. It is a function here because
 * the platform is resolved at runtime and is injectable for the tests.
 */
export function FileTokensSupported(): boolean {
  return fileTokenPlatformIsPOSIX();
}

/**
 * fileTokenModeGuard refuses a file a user other than the owner can read. The
 * check is the whole reason a file token is allowed anywhere: a credential in
 * a world-readable file is a credential every account on the machine has.
 *
 * On a platform without POSIX file modes it refuses every file token.
 * Windows expresses "only the owner may read this" in an ACL, and the mode
 * reported for such a file is 0666 whatever the ACL says — so the question
 * the guard exists to ask, is this credential readable by another account,
 * cannot be answered there. Loading the token anyway would mean dropping the
 * one check that makes a token in a file defensible, so the token stays
 * unread and the two paths that are as safe there as anywhere — the
 * environment and the OS keychain — are what the warning points at.
 */
function fileTokenModeGuard(filePath: string): tokenGuard {
  if (!fileTokenPlatformIsPOSIX()) {
    return refused(
      `a token in a config file is not read on ${currentPlatform()}: the owner-only check the guard requires is a POSIX file mode, which this platform does not have, so tdo cannot tell whether another account on this machine can read ${filePath}.`,
    );
  }
  const perm = filePerm(filePath);
  if (perm !== null && (perm & 0o077) !== 0) {
    return refused(
      `the file is readable by group or others (mode ${octal(perm)}); run: chmod 600 ${filePath}`,
    );
  }
  return { allowed: true, reason: '' };
}

/**
 * filePerm returns the permission bits of path, and null when they could not
 * be read at all. `mode & 0o777` is Go's `Mode().Perm()`.
 */
function filePerm(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
}

/** octal renders a mode the way Go's `%04o` did. */
function octal(mode: number): string {
  return mode.toString(8).padStart(4, '0');
}

// --- the writer --------------------------------------------------------
//
// This half was `internal/config/write.go`: a writer that edits the user's
// config file in place.
//
// Three properties shape it, and each one is a guard rather than a
// convention:
//
//   - It never writes a credential. A key named "token" — or any of the other
//     secret-shaped spellings the reader already refuses — is rejected inside
//     the writer, not at the call site, so a future caller cannot reach disk
//     with one by mistake. Tokens live in the OS keychain or the environment.
//   - It writes only where the reader is willing to read a token from: the
//     XDG config file or $TODOCLOUD_CONFIG, and never inside a git
//     repository. Writing a path into a repository is how a config file gets
//     committed.
//   - It preserves the file. Comments, blank lines, key order, spacing and
//     every table or key it was not asked about come through byte for byte: a
//     writer that reformats someone's file is a writer they turn off.

/**
 * fileHeader is written at the top of a config file this module creates. It
 * is never added to a file that already exists.
 */
const fileHeader = `# todocloud configuration.
# Written by tdo; your own comments, spacing and key order are preserved.
# Never move this file inside a git repository, and never put a token here:
# \`tdo login\` stores tokens in the OS keychain.
`;

/**
 * ErrSecretKey is the sentinel for a caller asking the writer to store a key
 * that is assumed to hold a credential. It is a programming error as much as
 * a user error, which is why it is checked here and not only in the CLI.
 *
 * It follows keyring.ts's convention: a sentinel Error instance, set as the
 * `cause` of the thrown error, recognised with that module's `Is`.
 */
export const ErrSecretKey = new Error(
  'refusing to write a credential to the config file',
);

/**
 * RefusedError reports that the writer declined to touch a path. Reason is
 * one sentence naming the guard that refused and what to do instead.
 */
export class RefusedError extends Error {
  override readonly name = 'RefusedError';
  readonly Path: string;
  readonly Reason: string;

  constructor(filePath: string, reason: string) {
    super(
      filePath === ''
        ? 'refusing to write the config file: ' + reason
        : `refusing to write config file ${filePath}: ${reason}`,
    );
    this.Path = filePath;
    this.Reason = reason;
  }
}

/**
 * Setting is one key to write. Table is absent or "" for a top-level key.
 * Only string values are written: every setting the CLI owns is a string, and
 * a writer that cannot be asked for other kinds cannot get their quoting
 * wrong.
 */
export interface Setting {
  Table?: string;
  Key: string;
  Value: string;
}

/**
 * settingName renders the setting as the dotted name used in messages and in
 * Config.Origins, e.g. "turso.url". It was Setting.Name in Go.
 */
export function settingName(s: Setting): string {
  const table = s.Table ?? '';
  if (table === '') {
    return s.Key;
  }
  return table + '.' + s.Key;
}

/** Change is what one Setting did to the file. */
export interface Change {
  /** Name is the dotted setting name, e.g. "turso.url". */
  Name: string;
  /** Value is what the key now holds. */
  Value: string;
  /** Previous is what it held before, empty when the key was added. */
  Previous: string;
  /** Added is true when the key was not in the file at all. */
  Added: boolean;
  /** Changed is false when the file already said exactly this. */
  Changed: boolean;
}

/** WriteResult describes a completed write. */
export interface WriteResult {
  /** Path is the file that was written. */
  Path: string;
  /** Created is true when the file did not exist beforehand. */
  Created: boolean;
  /** Changes is one entry per requested setting, in the order requested. */
  Changes: Change[];
  /**
   * Wrote is false when every setting already held the requested value, in
   * which case the file was left exactly as it was.
   */
  Wrote: boolean;
}

/** WriteOptions controls Set. */
export interface WriteOptions {
  /**
   * Getenv defaults to the process environment. Tests inject a fake one.
   *
   * Unlike the reader, the writer has no fallback to the process-wide home
   * directory: when the injected environment names neither XDG_CONFIG_HOME
   * nor HOME, there is no file to write and Set refuses. A writer that could
   * reach a real home directory from a fake environment is one a test can
   * point at the developer's own configuration.
   */
  Getenv?: (name: string) => string;
  /**
   * ConfigPath mirrors the --config flag. It is honoured only when it names
   * the same file the reader would accept a token from; anything else is
   * refused, for the same reason the reader refuses it.
   */
  ConfigPath?: string;
}

/**
 * Set writes settings into the user's config file, creating it when it does
 * not exist, and returns what it did. The file is replaced atomically: the
 * new contents are written to a temporary file in the same directory and
 * renamed over the target, so an interrupted write cannot truncate the old
 * one.
 */
export function Set(
  opts: WriteOptions,
  ...settings: Setting[]
): WriteResult {
  const getenv = opts.Getenv ?? processGetenv;
  if (settings.length === 0) {
    throw new Error('no settings to write');
  }
  for (const s of settings) {
    checkWritableSetting(s);
  }

  const filePath = writablePath(getenv, opts.ConfigPath ?? '');

  let data: string;
  let created = false;
  try {
    data = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (!isNotExist(err)) {
      throw new Error(`reading config file ${filePath}: ${message(err)}`, {
        cause: err,
      });
    }
    created = true;
    data = fileHeader;
  }

  // A file this writer cannot read, it must not rewrite: reformatting the
  // unparsed remains of a file the user hand-edited would lose it.
  if (!created) {
    try {
      parseTOML(data);
    } catch (err) {
      throw new RefusedError(
        filePath,
        `it does not parse (${message(err)}), and rewriting a file this reader does not understand would lose what is in it; fix the file by hand`,
      );
    }
  }

  let out: string;
  let changes: Change[];
  try {
    [out, changes] = applySettings(data, settings);
  } catch (err) {
    throw new Error(`editing config file ${filePath}: ${message(err)}`, {
      cause: err,
    });
  }

  // Belt and braces: the edited file must still parse, and must read back
  // exactly what was asked for. A quoting bug here would otherwise reach the
  // user's disk.
  try {
    verify(out, settings);
  } catch (err) {
    throw new Error(
      `editing config file ${filePath} would have produced a file tdo cannot read back: ${message(err)}`,
      { cause: err },
    );
  }

  const result: WriteResult = {
    Path: filePath,
    Created: created,
    Changes: changes,
    Wrote: false,
  };
  if (!created && !anyChanged(changes)) {
    // Nothing to do, so nothing is touched: no rename, no new mtime.
    return result;
  }
  writeFileAtomic(filePath, out);
  result.Wrote = true;
  return result;
}

/** anyChanged reports whether any requested setting actually changed the file. */
function anyChanged(changes: Change[]): boolean {
  return changes.some((c) => c.Changed);
}

/**
 * checkWritableSetting applies the two rules that hold whatever the caller
 * intended: the names must be bare keys this reader can read back, and the
 * key must not be one that holds a credential.
 */
function checkWritableSetting(s: Setting): void {
  const table = s.Table ?? '';
  if (table !== '') {
    if (checkBareKey(table, 0) !== null) {
      throw new Error(`invalid table name ${quote(table)}`);
    }
  }
  if (checkBareKey(s.Key, 0) !== null) {
    throw new Error(`invalid key ${quote(s.Key)}`);
  }
  if (isTokenKey(s.Key)) {
    throw new Error(
      `${ErrSecretKey.message}: ${quote(settingName(s))} holds a credential, and tdo never writes one to a file. Run \`tdo login\`, which stores the token in the OS keychain, or set ${tokenEnvHint(table)} in the environment`,
      { cause: ErrSecretKey },
    );
  }
}

/**
 * ParseKey splits a dotted setting name into a table and a key. A bare name
 * is a top-level key; anything deeper than one level is rejected, because the
 * file format is one level of tables.
 */
export function ParseKey(name: string): [table: string, key: string] {
  const trimmed = name.trim();
  const dots = trimmed.split('.').length - 1;
  let table = '';
  let key = '';
  switch (dots) {
    case 0:
      key = trimmed;
      break;
    case 1: {
      const i = trimmed.indexOf('.');
      table = trimmed.slice(0, i);
      key = trimmed.slice(i + 1);
      break;
    }
    default:
      throw new Error(
        `invalid key ${quote(trimmed)}: tables are one level deep, so a key is either \`key\` or \`table.key\``,
      );
  }
  if (key === '' || (trimmed.includes('.') && table === '')) {
    throw new Error(
      `invalid key ${quote(trimmed)}: expected \`key\` or \`table.key\``,
    );
  }
  if (table !== '' && checkBareKey(table, 0) !== null) {
    throw new Error(
      `invalid table name ${quote(table)} in key ${quote(trimmed)}: tables are bare words`,
    );
  }
  if (checkBareKey(key, 0) !== null) {
    throw new Error(`invalid key ${quote(trimmed)}: keys are bare words`);
  }
  return [table, key];
}

/**
 * writablePath decides which file to write, and refuses the paths the reader
 * would refuse a token from. The guards are deliberately the reader's: a file
 * good enough to hold a token is the only file tdo will maintain, because
 * anywhere else is somewhere a config file ends up committed.
 */
function writablePath(
  getenv: (name: string) => string,
  override: string,
): string {
  let p = override.trim();
  if (p === '') {
    p = getenv(EnvConfig).trim();
  }
  if (p === '') {
    const [fromXDG, ok] = writerXDGPath(getenv);
    if (!ok) {
      throw new RefusedError(
        '',
        `neither $${envXDGConfigHome} nor $${envHome} nor $${EnvConfig} is set, so there is no config file to write; set one and try again`,
      );
    }
    p = fromXDG;
  }

  const abs = path.resolve(p);

  const [dir, inRepo] = repositoryRoot(abs);
  if (inRepo) {
    throw new RefusedError(
      abs,
      `it is inside the git repository at ${dir}, and a config file must NEVER sit in a repository: one \`git add -A\` and it is published. Keep it at ${xdgConfigHint}, outside every repository`,
    );
  }
  if (!writerPathAllowed(getenv, abs)) {
    throw new RefusedError(
      abs,
      `tdo writes only ${xdgConfigHint} or the file named by $${EnvConfig}, and this file is neither; an arbitrary --config path is too easily one inside a repository`,
    );
  }
  return abs;
}

/**
 * writerXDGPath is xdgConfigPath without the fallback to the process-wide
 * home directory. See WriteOptions.Getenv for why the writer may not have
 * one.
 */
function writerXDGPath(
  getenv: (name: string) => string,
): [path: string, ok: boolean] {
  let dir = getenv(envXDGConfigHome);
  if (dir === '') {
    dir = getenv(envHome);
    if (dir === '') {
      return ['', false];
    }
    dir = path.join(dir, '.config');
  }
  return [path.join(dir, 'todocloud', 'config.toml'), true];
}

/**
 * writerPathAllowed is fileTokenPathAllowed for a file that may not exist
 * yet, so it compares cleaned names before falling back to identity on disk.
 */
function writerPathAllowed(
  getenv: (name: string) => string,
  filePath: string,
): boolean {
  const named = getenv(EnvConfig).trim();
  if (named !== '' && samePath(path.resolve(named), filePath)) {
    return true;
  }
  const [def, ok] = writerXDGPath(getenv);
  if (ok && samePath(def, filePath)) {
    return true;
  }
  return false;
}

/**
 * verify re-reads an edited document and checks that every setting reads back
 * as the string that was asked for.
 */
function verify(src: string, settings: Setting[]): void {
  const f = parseTOML(src);
  for (const s of settings) {
    const got = f.string(s.Table ?? '', s.Key);
    if (got === undefined) {
      throw new Error(`${settingName(s)} is missing after the edit`);
    }
    if (got !== s.Value) {
      throw new Error(`${settingName(s)} reads back differently after the edit`);
    }
  }
}

/**
 * applySettings edits src, one setting at a time, and returns the new
 * document together with what each setting did. Every line it was not asked
 * about is copied through unchanged.
 */
function applySettings(
  src: string,
  settings: Setting[],
): [out: string, changes: Change[]] {
  let [lines, trailingNewline] = splitLines(src);
  const changes: Change[] = [];
  for (const s of settings) {
    const [next, c] = applySetting(lines, s);
    lines = next;
    changes.push(c);
  }
  let out = lines.join('\n');
  if (trailingNewline) {
    out += '\n';
  }
  return [out, changes];
}

/**
 * splitLines splits a document into lines, remembering whether it ended with
 * a newline so that joining restores the file exactly. An empty document is
 * treated as ending with one, because every file this writer produces does.
 */
function splitLines(src: string): [lines: string[], trailingNewline: boolean] {
  if (src === '') {
    return [[], true];
  }
  const trailingNewline = src.endsWith('\n');
  const body = trailingNewline ? src.slice(0, -1) : src;
  return [body.split('\n'), trailingNewline];
}

/** applySetting replaces, inserts or appends one key. */
function applySetting(
  lines: string[],
  s: Setting,
): [lines: string[], change: Change] {
  const table = s.Table ?? '';
  let rendered: string;
  try {
    rendered = renderString(s.Value);
  } catch (err) {
    throw new Error(`${settingName(s)}: ${message(err)}`, { cause: err });
  }

  const loc = locate(lines, table, s.Key);
  if (loc.keyLine >= 0) {
    const line = lines[loc.keyLine] ?? '';
    const span = valueSpan(line, loc.eq);
    if (span === null) {
      throw new Error(
        `${settingName(s)}: line ${loc.keyLine + 1} could not be re-read`,
      );
    }
    const previous = loc.previous;
    if (loc.previousOK && previous === s.Value) {
      // Already exactly right. Leaving the line alone keeps whatever quoting
      // style the user chose for it.
      return [
        lines,
        {
          Name: settingName(s),
          Value: s.Value,
          Previous: previous,
          Added: false,
          Changed: false,
        },
      ];
    }
    const out = [...lines];
    out[loc.keyLine] =
      line.slice(0, span.start) + rendered + line.slice(span.end);
    return [
      out,
      {
        Name: settingName(s),
        Value: s.Value,
        Previous: previous,
        Added: false,
        Changed: true,
      },
    ];
  }

  if (loc.insertAt >= 0) {
    const out = insertAt(lines, loc.insertAt, s.Key + ' = ' + rendered);
    return [
      out,
      {
        Name: settingName(s),
        Value: s.Value,
        Previous: '',
        Added: true,
        Changed: true,
      },
    ];
  }

  // The table does not exist: append it, separated by a blank line from
  // whatever came before so the file stays readable.
  const out = [...lines];
  if (out.length > 0 && (out[out.length - 1] ?? '').trim() !== '') {
    out.push('');
  }
  out.push('[' + table + ']', s.Key + ' = ' + rendered);
  return [
    out,
    {
      Name: settingName(s),
      Value: s.Value,
      Previous: '',
      Added: true,
      Changed: true,
    },
  ];
}

/** location says where a key is, or where it would go. */
interface location {
  /** keyLine is the index of the line that sets the key, or -1. */
  keyLine: number;
  /** eq is the index of the '=' on that line. */
  eq: number;
  /**
   * previous is the string the key already held, and previousOK says it was a
   * string at all: a key that holds an integer or a boolean is always
   * rewritten, never compared.
   */
  previous: string;
  previousOK: boolean;
  /**
   * insertAt is where a new key belongs when the table exists but the key
   * does not, or -1 when the table does not exist either.
   */
  insertAt: number;
}

/**
 * locate walks the document tracking the current table, exactly as the reader
 * does, and reports where table.key is or should be written.
 */
function locate(lines: string[], table: string, key: string): location {
  const loc: location = {
    keyLine: -1,
    eq: -1,
    previous: '',
    previousOK: false,
    insertAt: -1,
  };
  let inTable = table === ''; // the root table is open from the first line
  // lastInTable is where a new key would go: after the last key of the target
  // table, so it joins the keys it belongs to rather than landing after the
  // comment that introduces the next table. Before the table's first key, the
  // comment and blank lines that introduce it count too, so that a key added
  // to a freshly created file lands under its header comment rather than
  // above it.
  let lastInTable = -1;
  let seenKey = false;
  if (inTable) {
    lastInTable = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const text = raw.replace(/\r+$/u, '').trim();
    if (text.startsWith('[')) {
      let name: string;
      try {
        name = parseTableHeader(text, i + 1);
      } catch {
        // The document parsed before this ran, so this cannot happen;
        // stopping is still safer than guessing at the table.
        break;
      }
      if (name === table) {
        inTable = true;
        lastInTable = i + 1;
        seenKey = false;
      } else {
        inTable = false;
      }
      continue;
    }
    if (text === '' || text.startsWith('#')) {
      if (inTable && !seenKey) {
        lastInTable = i + 1;
      }
      continue;
    }
    const eq = text.indexOf('=');
    if (eq < 0) {
      continue;
    }
    if (!inTable) {
      continue;
    }
    lastInTable = i + 1;
    seenKey = true;
    if (text.slice(0, eq).trim() !== key) {
      continue;
    }
    // Found it. The offsets have to be in the raw line, not the trimmed one,
    // so that the original indentation survives.
    const rawEq = raw.indexOf('=');
    loc.keyLine = i;
    loc.eq = rawEq;
    const read = readValue(raw, rawEq);
    if (read !== null) {
      loc.previous = read.value;
      loc.previousOK = isQuoted(raw, rawEq);
    }
    return loc;
  }

  if (lastInTable >= 0) {
    loc.insertAt = lastInTable;
  }
  return loc;
}

/** insertAt splices a line into the document at index i. */
function insertAt(lines: string[], i: number, line: string): string[] {
  return [...lines.slice(0, i), line, ...lines.slice(i)];
}

/** span is a half-open range within a line. */
interface span {
  start: number;
  end: number;
}

/**
 * valueSpan returns the half-open range of the value on a key line, so that a
 * replacement can keep the indentation, the key, the spacing around '=' and
 * any trailing comment exactly as they were.
 */
function valueSpan(line: string, eq: number): span | null {
  if (eq < 0 || eq >= line.length) {
    return null;
  }
  const read = readValue(line, eq);
  return read === null ? null : read.span;
}

/**
 * readValue reads the value that follows the '=' at eq, returning its decoded
 * string form (empty for a non-string) and the range it occupies, or null
 * when the line cannot be read.
 */
function readValue(
  line: string,
  eq: number,
): { value: string; span: span } | null {
  if (eq < 0 || eq + 1 > line.length) {
    return null;
  }
  let i = eq + 1;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    i++;
  }
  const start = i;
  if (i >= line.length) {
    return { value: '', span: { start, end: start } };
  }

  const q = line[i];
  if (q === '"' || q === "'") {
    let b = '';
    for (let j = i + 1; j < line.length; j++) {
      const c = line[j];
      if (q === '"' && c === '\\' && j + 1 < line.length) {
        j++;
        switch (line[j]) {
          case 'n':
            b += '\n';
            break;
          case 't':
            b += '\t';
            break;
          case 'r':
            b += '\r';
            break;
          default:
            b += line[j] ?? '';
            break;
        }
        continue;
      }
      if (c === q) {
        return { value: b, span: { start, end: j + 1 } };
      }
      b += c;
    }
    return null;
  }

  // A bare value ends at a comment, and trailing spaces belong to the
  // comment's padding rather than to the value.
  let end = line.length;
  const hash = line.indexOf('#', i);
  if (hash >= 0) {
    end = hash;
  }
  while (
    end > start &&
    (line[end - 1] === ' ' || line[end - 1] === '\t' || line[end - 1] === '\r')
  ) {
    end--;
  }
  return { value: '', span: { start, end } };
}

/** isQuoted reports whether the value after the '=' at eq is a quoted string. */
function isQuoted(line: string, eq: number): boolean {
  for (let i = eq + 1; i < line.length; i++) {
    switch (line[i]) {
      case ' ':
      case '\t':
        continue;
      case '"':
      case "'":
        return true;
      default:
        return false;
    }
  }
  return false;
}

/**
 * renderString quotes a value as a basic TOML string. Only the escapes the
 * reader understands are produced, and a value holding any other control
 * character is refused rather than written in a form that cannot be read
 * back.
 */
function renderString(v: string): string {
  let b = '"';
  for (let i = 0; i < v.length; i++) {
    const c = v[i] ?? '';
    switch (c) {
      case '"':
        b += '\\"';
        continue;
      case '\\':
        b += '\\\\';
        continue;
      case '\n':
        b += '\\n';
        continue;
      case '\t':
        b += '\\t';
        continue;
      case '\r':
        b += '\\r';
        continue;
      default:
        break;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        `the value holds a control character (0x${code.toString(16).padStart(2, '0')}) that this file format cannot represent`,
      );
    }
    b += c;
  }
  return b + '"';
}

/**
 * writeFileAtomic writes data to path through a temporary file in the same
 * directory, renamed into place. The file is mode 0600 and the directory 0700
 * whatever umask the process inherited, matching what the store does: a
 * config file is not a credential, but it names where one is used.
 *
 * `fs.writeFileSync`'s own `mode` option is masked by the umask, so every
 * mode here is set with an explicit chmod after the fact.
 */
function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  let info: fs.Stats | null = null;
  try {
    info = fs.statSync(dir);
  } catch (err) {
    if (!isNotExist(err)) {
      throw new Error(`reading ${dir}: ${message(err)}`, { cause: err });
    }
  }
  if (info !== null) {
    // An existing directory is tightened when it is readable by group or
    // others, and otherwise left alone: a user who chose 0500 chose it, and
    // widening someone's permissions is not this function's business.
    if ((info.mode & 0o077) !== 0) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch (err) {
        throw new Error(`securing ${dir}: ${message(err)}`, { cause: err });
      }
    }
  } else {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new Error(`creating ${dir}: ${message(err)}`, { cause: err });
    }
    // mkdir applies the umask, so the mode is set explicitly: a directory tdo
    // creates is 0700 whatever the process inherited.
    try {
      fs.chmodSync(dir, 0o700);
    } catch (err) {
      throw new Error(`securing ${dir}: ${message(err)}`, { cause: err });
    }
  }

  const [tmpName, fd] = createTemp(dir);
  try {
    // Explicitly, because the umask applied to the mode the file was created
    // with.
    try {
      fs.fchmodSync(fd, 0o600);
    } catch (err) {
      throw new Error(`securing ${tmpName}: ${message(err)}`, { cause: err });
    }
    try {
      fs.writeFileSync(fd, data, 'utf8');
    } catch (err) {
      throw new Error(`writing ${tmpName}: ${message(err)}`, { cause: err });
    }
    // The rename is only atomic with respect to a crash if the contents are
    // on disk first; otherwise the user can be left with an empty file.
    try {
      fs.fsyncSync(fd);
    } catch (err) {
      throw new Error(`writing ${tmpName}: ${message(err)}`, { cause: err });
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // A close that fails after a successful fsync has nothing left to lose.
    }
  }

  try {
    fs.renameSync(tmpName, filePath);
  } catch (err) {
    // Harmless once the rename succeeded: the name is gone by then. Here it
    // did not, so the debris is removed rather than left for the next run.
    try {
      fs.unlinkSync(tmpName);
    } catch {
      // Already gone.
    }
    throw new Error(`replacing ${filePath}: ${message(err)}`, { cause: err });
  }
}

/**
 * createTemp is os.CreateTemp: a file nobody else holds, created in dir with
 * a name no other process can have guessed. 'wx' fails rather than truncates
 * if the name is somehow taken, and the loop then tries another.
 */
function createTemp(dir: string): [name: string, fd: number] {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const name = path.join(
      dir,
      '.config.toml.' + Math.floor(Math.random() * 0x100000000).toString(36),
    );
    try {
      return [name, fs.openSync(name, 'wx', 0o600)];
    } catch (err) {
      if (isExist(err)) {
        lastErr = err;
        continue;
      }
      throw new Error(
        `creating a temporary file in ${dir}: ${message(err)}`,
        { cause: err },
      );
    }
  }
  throw new Error(
    `creating a temporary file in ${dir}: ${message(lastErr)}`,
    lastErr === null ? {} : { cause: lastErr },
  );
}

// --- shared helpers ----------------------------------------------------

/**
 * configFailure wraps a message as the ConfigError exit.classify maps onto
 * exit code 3. `configf` returns null only for a null error, which this never
 * passes it.
 */
function configFailure(msg: string, cause?: unknown): Error {
  const err = cause === undefined ? new Error(msg) : new Error(msg, { cause });
  return configf(err) ?? new ConfigError(msg);
}

/** message is `%v` on an error: whatever it says, without its stack. */
function message(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** quote renders a value the way Go's `%q` did. */
function quote(s: string): string {
  return JSON.stringify(s);
}

/** isNotExist is errors.Is(err, os.ErrNotExist). */
function isNotExist(err: unknown): boolean {
  return hasCode(err, 'ENOENT');
}

/** isExist is errors.Is(err, os.ErrExist). */
function isExist(err: unknown): boolean {
  return hasCode(err, 'EEXIST');
}

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * forTest is the one thing this module exports that the Go package did not.
 * Go's tests lived inside the package and reached its unexported variables
 * directly; a test file here is a separate module, so the same reach has to
 * be granted explicitly. Nothing outside a test may use it.
 */
export const forTest = {
  /**
   * setDefaultKeyring replaces the lookup Load uses when Options.Keyring is
   * absent; null restores the real one. This is Go's TestMain assigning
   * `defaultKeyring = noKeyring`, and it exists so that no test can reach a
   * real keychain by forgetting an option.
   */
  setDefaultKeyring(fn: KeyringLookup | null): void {
    defaultKeyring = fn ?? keyringLookup;
  },
  /**
   * setPlatform forces one platform's file-token branch; null restores the
   * real one. It stands in for Go's build tags, exactly as the same hook in
   * keyring.ts does.
   */
  setPlatform(platform: string | null): void {
    platformOverride = platform;
  },
  currentPlatform,
  fileTokenGuard,
  renderString,
};
