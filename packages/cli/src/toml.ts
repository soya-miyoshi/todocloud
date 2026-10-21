// A deliberately tiny TOML reader.
//
// The project's dependency policy (CLAUDE.md §3, MIGRATION.md) does not allow
// a TOML library, and the configuration file the CLI reads is a flat list of
// string, integer and boolean settings in at most one level of tables. So
// instead of a general-purpose parser this is a line-based reader for exactly
// that subset, which rejects everything else with a line number. It is not a
// TOML API and must not grow into one.
//
// The Go file was `internal/config/toml.go` and everything in it was
// unexported: the parser and the writer lived in the same package, so neither
// the accessors nor `checkBareKey` had to be visible. A module here is not a
// package, so the names `config.ts` needs are exported — and nothing outside
// `packages/cli` imports this module.
//
// Where Go sliced bytes this port slices UTF-16 code units. The syntax is
// delimited entirely by ASCII, so every index agrees; a non-ASCII value is
// copied through either way.

/**
 * ValueKind names the three scalar kinds the subset accepts. The numbering
 * matters only because a rejection says "unknown kind %d", exactly as the Go
 * `valueKind` constants did.
 */
export type ValueKind = 0 | 1 | 2;

export const kindString: ValueKind = 0;
export const kindInt: ValueKind = 1;
export const kindBool: ValueKind = 2;

/**
 * TomlValue is one scalar setting together with the line it came from, so
 * that a warning or an error can point the user at the right place.
 *
 * Every field is always present, as the fields of a Go struct are: an
 * absent value is reported by the accessors returning undefined, never by a
 * half-filled value. `num` is a bigint because Go parsed an int64 and
 * rejected anything outside its range, which a JS number cannot represent.
 */
export interface TomlValue {
  kind: ValueKind;
  str: string;
  num: bigint;
  flag: boolean;
  line: number;
}

/**
 * TomlEntry is a key/value pair with the table it belongs to. The root table
 * is named "".
 */
export interface TomlEntry {
  table: string;
  key: string;
  value: TomlValue;
}

/** emptyValue is the zero value of TomlValue, for the non-string kinds. */
function emptyValue(line: number): TomlValue {
  return { kind: kindString, str: '', num: 0n, flag: false, line };
}

/**
 * TomlFile is the parsed document. Entries are kept in file order so that
 * anything derived from them (such as the token-shaped-key warnings) is
 * deterministic.
 */
export class TomlFile {
  readonly entries: TomlEntry[] = [];

  /**
   * string returns the string value of table.key, or undefined when it was
   * not present as a string. A value of another kind is reported as absent by
   * this accessor. The empty string is a value, not an absence, which is why
   * undefined rather than "" is the sentinel.
   */
  string(table: string, key: string): string | undefined {
    const v = this.lookup(table, key);
    if (v === undefined || v.kind !== kindString) {
      return undefined;
    }
    return v.str;
  }

  /** lookup returns the raw value of table.key. */
  lookup(table: string, key: string): TomlValue | undefined {
    for (const e of this.entries) {
      if (e.table === table && e.key === key) {
        return e.value;
      }
    }
    return undefined;
  }
}

/**
 * subsetNote is appended to every rejection, so the user understands that the
 * file is not being read by a full TOML implementation.
 */
export const subsetNote =
  'this file format is a subset of TOML: comments, [table] headers one level deep, and string, integer and boolean values';

/**
 * quote renders a value the way Go's `%q` did, so the messages here read as
 * they did in the Go tree. JSON's string escapes are not Go's for every
 * exotic rune, but they agree on everything a config file holds and both are
 * unambiguous.
 */
function quote(s: string): string {
  return JSON.stringify(s);
}

/**
 * parseTOML reads the supported subset of TOML from src. It throws an Error
 * whose message begins "line N:" for anything outside the subset — Go
 * returned that error, and the one invariant the fuzz target pins is that a
 * malformed file always produces a located rejection and never a panic.
 */
export function parseTOML(src: string): TomlFile {
  const f = new TomlFile();
  const seen = new Set<string>();
  let table = '';

  const raws = src.split('\n');
  for (let i = 0; i < raws.length; i++) {
    const line = i + 1;
    // Go trimmed "\r" from the right, then all surrounding space; TrimSpace
    // would have removed the carriage return anyway, and both are kept so
    // that the two implementations stay line for line.
    const text = trimRightCR(raws[i] ?? '').trim();
    if (text === '' || text.startsWith('#')) {
      continue;
    }

    if (text.startsWith('[')) {
      table = parseTableHeader(text, line);
      continue;
    }

    const eq = text.indexOf('=');
    if (eq < 0) {
      throw new Error(
        `line ${line}: expected a comment, a [table] header or a key = value pair; ${subsetNote}`,
      );
    }
    const key = text.slice(0, eq).trim();
    const keyErr = checkBareKey(key, line);
    if (keyErr !== null) {
      throw keyErr;
    }
    const value = parseValue(text.slice(eq + 1).trim(), line);

    const qualified = table + '.' + key;
    if (seen.has(qualified)) {
      throw new Error(
        `line ${line}: duplicate key ${quote(key)} in table ${tableLabel(table)}`,
      );
    }
    seen.add(qualified);
    f.entries.push({ table, key, value });
  }
  return f;
}

/** trimRightCR is strings.TrimRight(raw, "\r"). */
function trimRightCR(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '\r') {
    end--;
  }
  return raw.slice(0, end);
}

/**
 * tableLabel renders a table name for a message, naming the root table in
 * words because it has no header.
 */
export function tableLabel(table: string): string {
  if (table === '') {
    return 'the top level';
  }
  return '[' + table + ']';
}

/**
 * parseTableHeader reads a "[name]" line and returns the table name. Nested
 * headers are rejected.
 */
export function parseTableHeader(text: string, line: number): string {
  if (text.startsWith('[[')) {
    throw new Error(
      `line ${line}: array-of-tables headers are not supported; ${subsetNote}`,
    );
  }
  const end = text.indexOf(']');
  if (end < 0) {
    throw new Error(
      `line ${line}: unterminated table header, expected a closing ]`,
    );
  }
  const rest = text.slice(end + 1).trim();
  if (rest !== '' && !rest.startsWith('#')) {
    throw new Error(
      `line ${line}: unexpected text after the table header: ${quote(rest)}`,
    );
  }
  const name = text.slice(1, end).trim();
  if (name.includes('.')) {
    throw new Error(
      `line ${line}: nested table header [${name}] is not supported, tables are one level deep; ${subsetNote}`,
    );
  }
  const err = checkBareKey(name, line);
  if (err !== null) {
    throw err;
  }
  return name;
}

/**
 * checkBareKey rejects anything but a bare key, which is all the subset uses.
 * It returns the error rather than throwing it, because the writer asks the
 * same question about a caller-supplied name and reports it differently — Go
 * returned an error here for exactly that reason.
 */
export function checkBareKey(key: string, line: number): Error | null {
  if (key === '') {
    return new Error(`line ${line}: empty key; ${subsetNote}`);
  }
  // Iterating with for..of walks code points, as Go's `for range` over a
  // string walks runes, so a non-ASCII character is reported whole.
  for (const r of key) {
    if (
      (r >= 'a' && r <= 'z') ||
      (r >= 'A' && r <= 'Z') ||
      (r >= '0' && r <= '9') ||
      r === '_' ||
      r === '-'
    ) {
      continue;
    }
    return new Error(
      `line ${line}: invalid character ${quote(r)} in key ${quote(key)}, keys are bare words; ${subsetNote}`,
    );
  }
  return null;
}

/** The inclusive bounds of a Go int64, which is what a bare number parsed as. */
const int64Min = -(2n ** 63n);
const int64Max = 2n ** 63n - 1n;

/** parseValue reads one scalar value, which may be followed by a comment. */
function parseValue(text: string, line: number): TomlValue {
  if (text === '') {
    throw new Error(`line ${line}: missing value after =`);
  }
  switch (text[0]) {
    case '"':
    case "'":
      return parseStringValue(text, line);
    case '[':
      throw new Error(
        `line ${line}: array values are not supported; ${subsetNote}`,
      );
    case '{':
      throw new Error(
        `line ${line}: inline table values are not supported; ${subsetNote}`,
      );
    default:
      break;
  }

  // A bare value ends at a comment.
  let bare = text;
  const hash = bare.indexOf('#');
  if (hash >= 0) {
    bare = bare.slice(0, hash);
  }
  bare = bare.trim();
  if (bare === 'true') {
    return { ...emptyValue(line), kind: kindBool, flag: true };
  }
  if (bare === 'false') {
    return { ...emptyValue(line), kind: kindBool, flag: false };
  }
  // strconv.ParseInt(bare, 10, 64): an optional sign, decimal digits, and a
  // value that fits in an int64. Anything else — a float, a hex literal, an
  // underscore separator, 2**63 — is not an integer here.
  if (/^[+-]?[0-9]+$/.test(bare)) {
    const n = BigInt(bare);
    if (n >= int64Min && n <= int64Max) {
      return { ...emptyValue(line), kind: kindInt, num: n };
    }
  }
  throw new Error(
    `line ${line}: unsupported value ${quote(bare)}, expected a quoted string, an integer or true/false; ${subsetNote}`,
  );
}

/**
 * parseStringValue reads a basic ("...") or literal ('...') string. A # inside
 * the quotes is a literal character, not the start of a comment.
 */
function parseStringValue(text: string, line: number): TomlValue {
  const quoteChar = text[0];
  let b = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (quoteChar === '"' && c === '\\') {
      if (i + 1 >= text.length) {
        throw new Error(`line ${line}: unterminated string`);
      }
      i++;
      // The index is in range — the length was checked above — but
      // noUncheckedIndexedAccess cannot see that, and a default of "" would
      // be reported as an unsupported escape rather than crash.
      const esc = text[i] ?? '';
      switch (esc) {
        case 'n':
          b += '\n';
          break;
        case 't':
          b += '\t';
          break;
        case 'r':
          b += '\r';
          break;
        case '"':
          b += '"';
          break;
        case '\\':
          b += '\\';
          break;
        default:
          throw new Error(
            `line ${line}: unsupported escape ${quote('\\' + esc)} in string; ${subsetNote}`,
          );
      }
      continue;
    }
    if (c === quoteChar) {
      const rest = text.slice(i + 1).trim();
      if (rest !== '' && !rest.startsWith('#')) {
        throw new Error(
          `line ${line}: unexpected text after the value: ${quote(rest)}`,
        );
      }
      return { ...emptyValue(line), kind: kindString, str: b };
    }
    b += c;
  }
  throw new Error(
    `line ${line}: unterminated string, expected a closing ${quoteChar}`,
  );
}
