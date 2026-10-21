// Maps failures onto the CLI's fixed exit codes.
//
// The codes are part of the documented contract in docs/agents.md, so that an
// agent or a script can branch on a failure class without parsing prose.
// Changing one is a breaking change.
//
// Go wrapped an error with `fmt.Errorf("...: %w", err)` and unwrapped it with
// errors.Is/errors.As. Here a wrapper is `new Error('...', { cause: err })`
// and the chain is walked through `cause`, so classify is unchanged in
// behaviour: a class assigned anywhere in the chain still decides the code.

import {
  isAmbiguous,
  isNotFound,
  isNotInitialized,
} from './store/store.ts';
import { isSchemaMismatch } from './store/version.ts';
import { isInvalid } from './taskops/edit.ts';

/** Codes returned by the process. */
export const OK = 0;
// `Error` is the global's name inside this module, so the constant is written
// under a local name and exported as `Error`, keeping the surface 1:1 with
// the Go package's `exit.Error`.
const ErrorCode = 1;
export { ErrorCode as Error };
export const Usage = 2;
export const Config = 3;
export const Provider = 4;
export const NotFound = 5;
export const Ambiguous = 6;

/** Error codes used in the JSON error envelope, one per exit code. */
export const CodeError = 'error';
export const CodeUsage = 'usage';
export const CodeConfig = 'config';
export const CodeProvider = 'provider';
export const CodeNotFound = 'not_found';
export const CodeAmbiguous = 'ambiguous_id';

/** UsageError marks an error as the user's fault at the command line. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** ConfigError marks a configuration or credential problem. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** ProviderError marks a provider or network failure. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
}

/**
 * Returns an error that exits with the usage code. The message is carried
 * over, because it is what the user and the JSON error envelope show.
 */
export function usagef(err: Error | null | undefined): Error | null {
  if (err === null || err === undefined) {
    return null;
  }
  return new UsageError(err.message, { cause: err });
}

/** Returns an error that exits with the config code. */
export function configf(err: Error | null | undefined): Error | null {
  if (err === null || err === undefined) {
    return null;
  }
  return new ConfigError(err.message, { cause: err });
}

/** Returns an error that exits with the provider code. */
export function providerf(err: Error | null | undefined): Error | null {
  if (err === null || err === undefined) {
    return null;
  }
  return new ProviderError(err.message, { cause: err });
}

/** The exit code and the JSON error code for an error. */
export interface Classification {
  code: number;
  jsonCode: string;
}

/**
 * Walks the `cause` chain, outermost first, the way errors.Is does. The chain
 * is finite in practice; the visited set guards against a cycle rather than
 * expecting one.
 */
function* chain(err: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    yield cur;
    cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
  }
}

/** Reports whether err, or anything it wraps, is an instance of class c. */
function wraps<T>(err: unknown, c: new (...args: never[]) => T): boolean {
  for (const e of chain(err)) {
    if (e instanceof c) {
      return true;
    }
  }
  return false;
}

/** Returns the exit code and the JSON error code for err. */
export function classify(err: unknown): Classification {
  if (err === null || err === undefined) {
    return { code: OK, jsonCode: '' };
  }

  // The sentinel cases come first, as they do in Go, because a sentinel takes
  // precedence over the class a wrapper assigned: a not-found that a provider
  // wrapped still exits 5 rather than 4. Each predicate walks the `cause`
  // chain the way errors.Is did.

  if (isNotFound(err)) {
    return { code: NotFound, jsonCode: CodeNotFound };
  }
  if (isAmbiguous(err)) {
    return { code: Ambiguous, jsonCode: CodeAmbiguous };
  }
  if (isNotInitialized(err)) {
    return { code: Config, jsonCode: CodeConfig };
  }
  // A store at the wrong schema version is a configuration problem whichever
  // way it points: run `tdo migrate`, or upgrade tdo.
  if (isSchemaMismatch(err)) {
    return { code: Config, jsonCode: CodeConfig };
  }
  // A request the shared logic layer refused is a mistake in the request,
  // wherever it came from: exit 2, like any other usage error.
  if (isInvalid(err)) {
    return { code: Usage, jsonCode: CodeUsage };
  }

  if (wraps(err, UsageError)) {
    return { code: Usage, jsonCode: CodeUsage };
  }
  if (wraps(err, ConfigError)) {
    return { code: Config, jsonCode: CodeConfig };
  }
  if (wraps(err, ProviderError)) {
    return { code: Provider, jsonCode: CodeProvider };
  }
  return { code: ErrorCode, jsonCode: CodeError };
}
