// Module output renders everything the CLI prints.
//
// It exists to keep one rule in one place: machine output goes to stdout and
// everything else goes to stderr, so that `tdo ls --json | jq` is always safe.
// A Printer holds the two writers and whether --json was asked for; no command
// writes to a stream directly.
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - Go's `io.Writer` is the `Writer` interface below. `core` may not import
//     `node:*` (CLAUDE.md §3), so the streams are supplied by the caller —
//     `process.stdout` in the CLI, a collecting buffer in a test, a DOM node
//     in the PWA — and nothing here reaches for a global.
//   - Go's `Printf`-style methods took a format string and arguments. There is
//     no `fmt` here and a hand-rolled `%s` expander would be a second, worse
//     one, so each method takes the finished message and callers use a
//     template literal. The names keep the Go spelling so the surface stays
//     1:1 with the Go package.
//   - Go returned an `error` from `Emit`; a failure to render is thrown here,
//     because a caller cannot carry on with a value that did not serialise.

/**
 * Writer is the sink a Printer writes to: Go's `io.Writer`, narrowed to the
 * one call this module makes. A Node stream satisfies it as-is (its `write`
 * returns a boolean, which is why the return type is `unknown`).
 */
export interface Writer {
  write(s: string): unknown;
}

/** PrinterInit is the field set of a Printer; see the fields themselves. */
export interface PrinterInit {
  out: Writer;
  err: Writer;
  json?: boolean | undefined;
  debug?: boolean | undefined;
}

/** Printer writes a command's result. */
export class Printer {
  /**
   * out receives machine output: JSON, CSV and the human-readable result of
   * a command. Nothing else may be written to it.
   */
  out: Writer;
  /** err receives warnings, hints, prompts and debug logging. */
  err: Writer;
  /** json reports whether --json was given. */
  json = false;
  /**
   * debug reports whether --debug was given. Debug output is held to the
   * same no-credentials standard as everything else.
   */
  debug = false;

  constructor(init: PrinterInit) {
    this.out = init.out;
    this.err = init.err;
    if (init.json !== undefined) {
      this.json = init.json;
    }
    if (init.debug !== undefined) {
      this.debug = init.debug;
    }
  }

  /**
   * emit writes v to stdout as a single line of JSON. It is the only way a
   * command produces --json output.
   */
  emit(v: unknown): void {
    let data: string;
    try {
      data = JSON.stringify(v);
    } catch (err) {
      throw new Error('render json', { cause: err });
    }
    if (data === undefined) {
      // JSON.stringify answers `undefined` rather than throwing for a value
      // with no JSON form, where Go's json.Marshal returned an error.
      throw new Error('render json: value has no JSON form');
    }
    this.out.write(data + '\n');
  }

  /**
   * printf writes human-readable result text to stdout. Callers must not use
   * it while this.json is set. Unlike the other methods it adds no newline,
   * because Go's `Printf` did not.
   */
  printf(text: string): void {
    this.out.write(text);
  }

  /** warnf writes a warning to stderr. */
  warnf(text: string): void {
    this.err.write(`tdo: warning: ${text}\n`);
  }

  /**
   * hintf writes an advisory note to stderr. An empty listing, for instance,
   * is not an error and must not put anything on stdout.
   */
  hintf(text: string): void {
    this.err.write(`${text}\n`);
  }

  /**
   * debugf writes a diagnostic to stderr when --debug is set. It must never
   * be handed a config object, a request header or a URL with a query string.
   */
  debugf(text: string): void {
    if (!this.debug) {
      return;
    }
    this.err.write(`tdo: debug: ${text}\n`);
  }

  /**
   * fail reports err. Under --json the documented envelope goes to stdout, so
   * a caller that parses stdout sees the failure in the same place as a
   * success; otherwise the message goes to stderr prefixed with the program
   * name.
   */
  fail(code: string, err: Error): void {
    const message = flatten(err);
    if (this.json) {
      // A rendering failure here would leave the caller with nothing on
      // stdout, so fall back to a hand-built envelope.
      try {
        this.emit(errorEnvelope(code, message));
      } catch {
        this.out.write(`{"error":{"code":${JSON.stringify(code)},"message":""}}\n`);
      }
      return;
    }
    this.err.write(`tdo: ${message}\n`);
  }
}

/**
 * flatten renders an error the way Go's `%w` chain read when it was printed.
 *
 * Go wrapped with `fmt.Errorf("sqlite: %s: %w", path, store.ErrNotInitialized)`,
 * and printing the result gave the wrapper and the sentinel in one line:
 * "sqlite: /path/tasks.db: store is not initialized; run `tdo init`". The port
 * carries a sentinel as `cause` instead, so `err.message` alone is the wrapper
 * only — which silently dropped the half that tells the user what to do. The
 * advice is promised in docs/agents.md, so it is restored here rather than at
 * every throw site.
 *
 * A cause whose text the wrapper already contains is skipped: some wrappers in
 * this tree follow Go's other habit and interpolate the cause's message into
 * their own, and joining both would print it twice. Depth is bounded and seen
 * errors are tracked, because a `cause` may be a cycle.
 */
export function flatten(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < 16 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const text = current instanceof Error ? current.message : String(current);
    if (text !== '' && !parts.some((p) => p.includes(text))) {
      parts.push(text);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ');
}

/**
 * errorEnvelope is the documented --json failure shape. Go had it as a pair
 * of structs; the key order is the struct's either way, since Go leaves a
 * struct's own field order alone.
 */
function errorEnvelope(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
