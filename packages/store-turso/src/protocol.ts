// The libSQL remote protocol types every value that crosses the wire, in both
// directions:
//
//	{"type":"null"}
//	{"type":"integer","value":"9223372036854775807"}
//	{"type":"float","value":1.5}
//	{"type":"text","value":"hello"}
//	{"type":"blob","base64":"aGk"}
//
// An integer travels as a *decimal string* because JSON numbers are doubles
// in most readers, and this project stores int64 values. Decoding an integer
// through a double would silently round 9223372036854775807 to
// 9223372036854775808, so the string form is parsed into a `bigint` and never
// touches a float.
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - Go's int64 is a `bigint` here. `number` is the double the string form
//     exists to avoid, so an integer value decodes to a `bigint` and
//     `Value.int64` returns one. A caller that wants a `number` — a position,
//     a row count, a schema version — converts at the point of use, where the
//     range is known to be small.
//   - Go read an integer out of `json.RawMessage`, which keeps the digits the
//     server sent. `JSON.parse` has no such thing: it has already produced a
//     double by the time a reviver sees the number. `parseWire` therefore
//     parses with a reviver that keeps each number's *source text* in a
//     `RawNumber`, which is this package's `json.RawMessage` and is what makes
//     a bare JSON integer — the lenient form the protocol does not specify but
//     a server may send — survive the whole int64 range.
//   - Go's `MarshalJSON`/`UnmarshalJSON` are `Value.toJSON` and
//     `valueFromJSON`. Both still refuse every malformed shape rather than
//     producing a zero value, because a column silently read as "" would show
//     up as a task with no title rather than as a failed command.
//   - `encodeArg` has no `json.Number` case: the field decoder in turso.ts
//     yields plain numbers, so there is no deferred-number type to bind.

/** The value kinds the protocol defines. */
export const kindNull = 'null';
export const kindInteger = 'integer';
export const kindFloat = 'float';
export const kindText = 'text';
export const kindBlob = 'blob';

/** ValueKind is one of the five type tags above. */
export type ValueKind =
  | typeof kindNull
  | typeof kindInteger
  | typeof kindFloat
  | typeof kindText
  | typeof kindBlob;

/**
 * ProtoAny is the decoded form of a protocol value, matching its kind: null,
 * bigint, number, string or bytes.
 */
export type ProtoAny = null | bigint | number | string | Uint8Array;

/** The int64 range, which is the range an integer value may hold. */
const minInt64 = -(2n ** 63n);
const maxInt64 = 2n ** 63n - 1n;

/**
 * RawNumber carries the source text of a JSON number, so that an integer
 * written as a bare JSON number keeps its digits instead of being rounded
 * into a double. It is this package's `json.RawMessage`; see the port note
 * above.
 */
export class RawNumber {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
  toString(): string {
    return this.source;
  }
}

/**
 * parseWire parses a protocol document, keeping every JSON number as a
 * RawNumber. It is the only JSON reader this package points at bytes the CLI
 * did not write.
 */
export function parseWire(text: string): unknown {
  return JSON.parse(text, function (_key, v: unknown, context?: unknown) {
    if (typeof v !== 'number') {
      return v;
    }
    // `context.source` is the number exactly as the server wrote it. The
    // fallback is for a runtime without source access, where the digits
    // beyond a double's precision are already lost and nothing can bring
    // them back.
    const source =
      typeof context === 'object' &&
      context !== null &&
      'source' in context &&
      typeof (context as { source?: unknown }).source === 'string'
        ? (context as { source: string }).source
        : String(v);
    return new RawNumber(source);
  }) as unknown;
}

/** value is one typed protocol value. */
export class Value {
  readonly kind: ValueKind;
  readonly any: ProtoAny;

  constructor(kind: ValueKind, any: ProtoAny = null) {
    this.kind = kind;
    this.any = any;
  }

  /** toJSON renders a bound argument in the on-the-wire shape. */
  toJSON(): Record<string, unknown> {
    switch (this.kind) {
      case kindNull:
        return { type: kindNull };
      case kindInteger: {
        const n = typeof this.any === 'bigint' ? this.any : 0n;
        return { type: kindInteger, value: n.toString(10) };
      }
      case kindFloat: {
        const f = typeof this.any === 'number' ? this.any : 0;
        if (!Number.isFinite(f)) {
          // JSON cannot carry these, and nothing in the data model produces
          // one: parseValue refuses them on the way in.
          throw new Error(`turso: cannot send ${f} as a float value`);
        }
        return { type: kindFloat, value: f };
      }
      case kindText: {
        const s = typeof this.any === 'string' ? this.any : '';
        return { type: kindText, value: s };
      }
      case kindBlob: {
        const raw = this.any instanceof Uint8Array ? this.any : new Uint8Array();
        return { type: kindBlob, base64: encodeBase64(raw) };
      }
      default:
        throw new Error(
          `turso: unknown value kind ${JSON.stringify(this.kind as string)}`,
        );
    }
  }

  /** IsNull reports whether the column was SQL NULL. */
  isNull(): boolean {
    return this.kind === kindNull || this.any === null;
  }

  /**
   * text renders the value as the string this package stores it as, or
   * undefined when there is no sensible rendering. An integer or a float read
   * back from a text column is rendered rather than refused, because SQLite's
   * typing is per value: a column declared TEXT can hold an integer if
   * something else wrote one there.
   */
  text(): string | undefined {
    const v = this.any;
    if (typeof v === 'string') {
      return v;
    }
    if (typeof v === 'bigint') {
      return v.toString(10);
    }
    if (typeof v === 'number') {
      // Go used strconv.FormatFloat(f, 'g', -1, 64); String() is the same
      // shortest round-tripping rendering for everything a float column holds.
      return String(v);
    }
    if (v instanceof Uint8Array) {
      return new TextDecoder().decode(v);
    }
    return undefined;
  }

  /**
   * int64 reads the value as an integer, accepting the text and whole-float
   * spellings for the same reason text is tolerant. Go returned
   * `(int64, bool)`; undefined is the not-ok case.
   */
  int64(): bigint | undefined {
    const v = this.any;
    if (typeof v === 'bigint') {
      return v;
    }
    if (typeof v === 'string') {
      return parseInt64(v.trim());
    }
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) {
        return undefined;
      }
      const n = BigInt(v);
      return n < minInt64 || n > maxInt64 ? undefined : n;
    }
    return undefined;
  }
}

/** parseInt64 is strconv.ParseInt(s, 10, 64): the decimal forms, in range. */
function parseInt64(s: string): bigint | undefined {
  if (!/^[+-]?\d+$/.test(s)) {
    return undefined;
  }
  const n = BigInt(s);
  return n < minInt64 || n > maxInt64 ? undefined : n;
}

/**
 * valueFromJSON reads a returned value out of a parseWire document. Every
 * malformed shape is an error rather than a zero value, because a column
 * silently read as "" would show up as a task with no title rather than as a
 * failed command.
 */
export function valueFromJSON(data: unknown): Value {
  if (
    typeof data !== 'object' ||
    data === null ||
    Array.isArray(data) ||
    data instanceof RawNumber
  ) {
    throw new Error(
      `turso: malformed value: ${clip(renderJSON(data))} is not a value object`,
    );
  }
  const w = data as { type?: unknown; value?: unknown; base64?: unknown };
  if (w.type === undefined || w.type === '') {
    throw new Error('turso: value has no type');
  }
  if (typeof w.type !== 'string') {
    throw new Error('turso: malformed value: its type is not a string');
  }
  switch (w.type) {
    case kindNull:
      return new Value(kindNull);
    case kindInteger:
      return new Value(kindInteger, decodeInteger(w.value));
    case kindFloat:
      return new Value(kindFloat, decodeFloat(w.value));
    case kindText: {
      if (typeof w.value !== 'string') {
        throw new Error('turso: malformed text value');
      }
      return new Value(kindText, w.value);
    }
    case kindBlob: {
      if (w.base64 !== undefined && typeof w.base64 !== 'string') {
        throw new Error('turso: malformed blob value');
      }
      return new Value(kindBlob, decodeBase64(w.base64 ?? ''));
    }
    default:
      throw new Error(`turso: unknown value type ${JSON.stringify(w.type)}`);
  }
}

/**
 * decodeInteger reads the decimal string the protocol specifies, and tolerates
 * a bare JSON integer. Neither path goes through a double, so the whole int64
 * range survives.
 */
export function decodeInteger(raw: unknown): bigint {
  if (raw === undefined || raw === null) {
    throw new Error('turso: integer value has no value');
  }
  const s = raw instanceof RawNumber ? raw.source : raw;
  if (typeof s !== 'string') {
    throw new Error(`turso: malformed integer value ${clip(renderJSON(raw))}`);
  }
  const n = parseInt64(s.trim());
  if (n === undefined) {
    throw new Error(`turso: malformed integer value ${clip(s)}`);
  }
  return n;
}

/** decodeFloat accepts a JSON number, and a string for symmetry with integers. */
export function decodeFloat(raw: unknown): number {
  if (raw === undefined || raw === null) {
    throw new Error('turso: float value has no value');
  }
  const s = raw instanceof RawNumber ? raw.source : raw;
  if (typeof s !== 'string') {
    throw new Error(`turso: malformed float value ${clip(renderJSON(raw))}`);
  }
  const trimmed = s.trim();
  const f = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(f)) {
    throw new Error(`turso: malformed float value ${clip(s)}`);
  }
  return f;
}

const base64Alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * encodeBase64 renders bytes in the unpadded alphabet Go's RawStdEncoding
 * uses. It is written out rather than taken from `btoa`, because `btoa` is
 * defined over a string of code units and this takes bytes.
 */
function encodeBase64(raw: Uint8Array): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 3) {
    const a = raw[i] as number;
    const b = raw[i + 1];
    const c = raw[i + 2];
    out += base64Alphabet[a >> 2] as string;
    out += base64Alphabet[((a & 0x03) << 4) | ((b ?? 0) >> 4)] as string;
    if (b === undefined) {
      break;
    }
    out += base64Alphabet[((b & 0x0f) << 2) | ((c ?? 0) >> 6)] as string;
    if (c === undefined) {
      break;
    }
    out += base64Alphabet[c & 0x3f] as string;
  }
  return out;
}

/**
 * decodeBase64 accepts the padded and unpadded alphabets, since servers differ
 * on which they emit.
 */
export function decodeBase64(s: string): Uint8Array {
  if (s === '') {
    return new Uint8Array();
  }
  const trimmed = s.replace(/=+$/, '');
  const bits: number[] = [];
  for (const ch of trimmed) {
    const n = base64Alphabet.indexOf(ch);
    if (n < 0) {
      throw new Error('turso: malformed blob value');
    }
    bits.push(n);
  }
  // Four sextets make three bytes; a trailing group of one sextet cannot have
  // come from any byte string.
  if (bits.length % 4 === 1) {
    throw new Error('turso: malformed blob value');
  }
  const out = new Uint8Array(Math.floor((bits.length * 6) / 8));
  let at = 0;
  for (let i = 0; i < bits.length; i += 4) {
    const a = bits[i] as number;
    const b = bits[i + 1];
    const c = bits[i + 2];
    const d = bits[i + 3];
    out[at++] = ((a << 2) | ((b ?? 0) >> 4)) & 0xff;
    if (c !== undefined) {
      out[at++] = (((b as number) << 4) | (c >> 2)) & 0xff;
    }
    if (d !== undefined) {
      out[at++] = ((c as number) << 6) | (d & 0x3f);
    }
  }
  return out;
}

/**
 * encodeArg converts a value into a bound argument. Only the types this
 * package actually binds are accepted; anything else is a programming error
 * caught at the call site rather than sent as a surprise.
 */
export function encodeArg(v: unknown): Value {
  if (v === null || v === undefined) {
    return new Value(kindNull);
  }
  switch (typeof v) {
    case 'string':
      return new Value(kindText, v);
    case 'boolean':
      return new Value(kindInteger, v ? 1n : 0n);
    case 'bigint':
      if (v < minInt64 || v > maxInt64) {
        throw new Error(`turso: cannot bind the out-of-range integer ${v}`);
      }
      return new Value(kindInteger, v);
    case 'number':
      // The same rule Fields.normalize applies: a whole number that fits in
      // an int64 is an integer on both paths, so a value has the same type
      // before and after a store round trip.
      if (Number.isInteger(v)) {
        const n = BigInt(v);
        if (n >= minInt64 && n <= maxInt64) {
          return new Value(kindInteger, n);
        }
      }
      if (!Number.isFinite(v)) {
        throw new Error(`turso: cannot bind ${v}`);
      }
      return new Value(kindFloat, v);
    default:
      break;
  }
  if (v instanceof Uint8Array) {
    return new Value(kindBlob, v);
  }
  throw new Error(
    `turso: cannot bind a value of type ${describeType(v)}`,
  );
}

/** describeType names a refused argument the way Go's %T did. */
function describeType(v: unknown): string {
  if (Array.isArray(v)) {
    return 'array';
  }
  const name = (v as { constructor?: { name?: string } })?.constructor?.name;
  return name ?? typeof v;
}

/** Arg is what a call site may bind. */
export type Arg = string | number | bigint | boolean | Uint8Array | null | undefined;

/** statement is one SQL statement with its positional arguments. */
export class Statement {
  readonly sql: string;
  readonly args: Value[];
  readonly wantRows: boolean;

  constructor(sql: string, args: Value[], wantRows: boolean) {
    this.sql = sql;
    this.args = args;
    this.wantRows = wantRows;
  }

  /** toJSON writes the wire shape, whose key is want_rows. */
  toJSON(): Record<string, unknown> {
    return { sql: this.sql, args: this.args, want_rows: this.wantRows };
  }
}

/**
 * newStatement binds args to sql. wantRows asks the server for the result
 * rows; a write asks for none, which keeps the response small.
 */
export function newStatement(
  sql: string,
  wantRows: boolean,
  ...args: readonly unknown[]
): Statement {
  const bound: Value[] = [];
  for (let i = 0; i < args.length; i++) {
    try {
      bound.push(encodeArg(args[i]));
    } catch (err) {
      throw new Error(`argument ${i + 1}: ${messageOf(err)}`, { cause: err });
    }
  }
  return new Statement(sql, bound, wantRows);
}

/** column is one column of a result. */
export interface Column {
  name: string | undefined;
}

/** executeResult is one statement's outcome. */
export interface ExecuteResult {
  cols: Column[];
  rows: Value[][];
  /**
   * affectedRowCount is Go's int64 narrowed to a number: it counts rows in one
   * statement, which no store reaches 2^53 of, and every caller wants a
   * number.
   */
  affectedRowCount: number;
}

/**
 * protoError is the server's report of a failed statement. Its message is the
 * remote SQLite engine's text: it is classified in turso.ts and, for every
 * class the CLI has a sentinel for, replaced rather than passed on.
 */
export interface ProtoError {
  message: string;
  code: string;
}

/** streamResult is one entry of the positional results array. */
export interface StreamResult {
  type: string;
  result: ExecuteResult | undefined;
  error: ProtoError | undefined;
}

/**
 * pipelineResponse is the body that comes back. Results are positional: one
 * per request, in order. `error` is kept as the text the server sent, because
 * it is reported through clip rather than interpreted.
 */
export interface PipelineResponse {
  baton: string;
  results: StreamResult[];
  /** error is the raw pipeline-level error, or undefined when there is none. */
  error: string | undefined;
}

/** protoErrorText is the engine's text, or its code when it sent no text. */
export function protoErrorText(e: ProtoError | undefined): string {
  if (e === undefined) {
    return '';
  }
  if (e.message !== '') {
    return e.message;
  }
  return e.code;
}

/**
 * decodeResponse reads a parseWire document into the response shape. Go had
 * struct tags do this; written out, it is also the one place a malformed
 * reply is turned into an error rather than a surprising zero value.
 */
export function decodeResponse(data: unknown): PipelineResponse {
  if (data === null || data === undefined) {
    // Go decoded JSON null into the zero struct, which the caller reports as
    // "answered 0 statement(s)". Keep that.
    return { baton: '', results: [], error: undefined };
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(
      `the response is not a libSQL pipeline reply: ${clip(renderJSON(data))}`,
    );
  }
  const raw = data as {
    baton?: unknown;
    results?: unknown;
    error?: unknown;
  };
  const out: PipelineResponse = {
    baton: typeof raw.baton === 'string' ? raw.baton : '',
    results: [],
    error: undefined,
  };
  if (raw.error !== undefined && raw.error !== null) {
    out.error = renderJSON(raw.error);
  }
  if (raw.results !== undefined && raw.results !== null) {
    if (!Array.isArray(raw.results)) {
      throw new Error(
        'the response is not a libSQL pipeline reply: results is not an array',
      );
    }
    for (const one of raw.results as unknown[]) {
      out.results.push(decodeStreamResult(one));
    }
  }
  return out;
}

function decodeStreamResult(data: unknown): StreamResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(
      'the response is not a libSQL pipeline reply: a result is not an object',
    );
  }
  const raw = data as { type?: unknown; response?: unknown; error?: unknown };
  const out: StreamResult = {
    type: typeof raw.type === 'string' ? raw.type : '',
    result: undefined,
    error: undefined,
  };
  if (typeof raw.error === 'object' && raw.error !== null) {
    const e = raw.error as { message?: unknown; code?: unknown };
    out.error = {
      message: typeof e.message === 'string' ? e.message : '',
      code: typeof e.code === 'string' ? e.code : '',
    };
  }
  if (typeof raw.response === 'object' && raw.response !== null) {
    const resp = raw.response as { result?: unknown };
    if (typeof resp.result === 'object' && resp.result !== null) {
      out.result = decodeExecuteResult(resp.result);
    }
  }
  return out;
}

function decodeExecuteResult(data: unknown): ExecuteResult {
  const raw = data as { cols?: unknown; rows?: unknown; affected_row_count?: unknown };
  const out: ExecuteResult = { cols: [], rows: [], affectedRowCount: 0 };
  if (Array.isArray(raw.cols)) {
    for (const col of raw.cols as unknown[]) {
      const name =
        typeof col === 'object' && col !== null
          ? (col as { name?: unknown }).name
          : undefined;
      out.cols.push({ name: typeof name === 'string' ? name : undefined });
    }
  }
  if (Array.isArray(raw.rows)) {
    for (const row of raw.rows as unknown[]) {
      if (!Array.isArray(row)) {
        throw new Error(
          'the response is not a libSQL pipeline reply: a row is not an array',
        );
      }
      out.rows.push((row as unknown[]).map(valueFromJSON));
    }
  }
  if (raw.affected_row_count !== undefined && raw.affected_row_count !== null) {
    out.affectedRowCount = Number(decodeInteger(raw.affected_row_count));
  }
  return out;
}

/**
 * renderJSON turns an untrusted fragment back into text for an error message.
 * It is only ever read by clip, never parsed again.
 */
export function renderJSON(v: unknown): string {
  if (v instanceof RawNumber) {
    return v.source;
  }
  if (typeof v === 'string') {
    return v;
  }
  try {
    return JSON.stringify(v, (_k, value: unknown) =>
      value instanceof RawNumber ? value.source : value,
    ) ?? String(v);
  } catch {
    return String(v);
  }
}

/** messageOf is the message of a thrown value, whatever it is. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * clip shortens and sanitizes untrusted text before it reaches an error
 * message, so a server that answers with a megabyte of HTML does not print a
 * megabyte of HTML.
 *
 * Go measured the limit in bytes; this measures UTF-16 code units, which is
 * what `length` means here. The purpose — a bound, not an exact one — is the
 * same either way.
 */
export function clip(s: string): string {
  const max = 120;
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      out += ' ';
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    out += ch;
  }
  out = out.trim();
  if (out.length > max) {
    return JSON.stringify(out.slice(0, max)) + '…';
  }
  return JSON.stringify(out);
}
