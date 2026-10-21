// `tdo export` and `tdo import`: the backup and the way a list moves to
// another provider (§10).

import * as fs from 'node:fs';

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import {
  type Perspective,
  OrderCreated,
  type Store,
  isNotFound,
} from '@todocloud/core/store';
import { Filter } from '@todocloud/core/store/filter';
import {
  Fields,
  type JSONValue,
  KeyCompletedAt,
  KeyCompletedByChildren,
  KeyCreatedAt,
  KeyDeferAt,
  KeyDeletedAt,
  KeyDone,
  KeyDroppedAt,
  KeyDueAt,
  KeyEstimatedMinutes,
  KeyFlagged,
  KeyID,
  KeyKind,
  KeyLastReviewedAt,
  KeyNote,
  KeyParentID,
  KeyPosition,
  KeyRepeat,
  KeyReviewInterval,
  KeySequential,
  KeySeriesID,
  KeyStatus,
  KeyTags,
  KeyTitle,
  KeyUpdatedAt,
  StatusDone,
  type Task,
  formatTime,
  isZeroTime,
  taskFromJSON,
} from '@todocloud/core/task';
import type { Writer } from '@todocloud/core/output';

import { type App, type Command, type Context, asError, usagef } from './app.ts';
import { parseTags } from './add.ts';
import { perspectiveFromJSON, perspectiveJSON } from './repeat.ts';
import { treeError } from './view.ts';

/** bom is the byte-order mark a spreadsheet may prepend to a CSV file. */
const bom = '﻿';

/**
 * exportVersion is the version of the export envelope, not of the binary. It
 * changes when the envelope's shape does, so that a file says which shape it
 * is in rather than leaving a reader to sniff it.
 */
const exportVersion = 1;

/**
 * csvHeader is the column order of `tdo export --csv`. Every required field
 * of §3.2 has a column and every user-defined field lives in the single
 * trailing `fields` column, so the flexible half of the model survives a
 * round trip through a spreadsheet.
 */
const csvHeader: readonly string[] = [
  KeyID,
  KeyKind,
  KeyTitle,
  KeyParentID,
  KeyPosition,
  KeyStatus,
  KeyFlagged,
  KeySequential,
  KeyCompletedByChildren,
  KeyDeferAt,
  KeyDueAt,
  KeyEstimatedMinutes,
  KeyNote,
  KeyRepeat,
  KeySeriesID,
  KeyReviewInterval,
  KeyLastReviewedAt,
  KeyCreatedAt,
  KeyUpdatedAt,
  KeyCompletedAt,
  KeyDroppedAt,
  KeyDeletedAt,
  KeyTags,
  'fields',
];

/**
 * csvBoolColumns, csvIntColumns and csvJSONColumns say how a cell is typed on
 * the way back in; everything else is a string or a JSON document.
 */
const csvBoolColumns: ReadonlySet<string> = new Set([
  KeyFlagged,
  KeySequential,
  KeyCompletedByChildren,
]);

const csvIntColumns: ReadonlySet<string> = new Set([KeyPosition, KeyEstimatedMinutes]);

const csvJSONColumns: ReadonlySet<string> = new Set([KeyRepeat, KeyReviewInterval]);

export function exportCommand(a: App): Command {
  return {
    name: 'export',
    usage: 'write every item to stdout for backup or for another provider',
    store: 'read',
    flags: {
      csv: { type: 'boolean', usage: 'write CSV instead of JSON' },
      all: { type: 'boolean', usage: 'include the items `tdo rm` tombstoned' },
    },
    async run(ctx: Context): Promise<void> {
      if (ctx.args.length > 0) {
        throw usagef('export takes no arguments');
      }
      const st = ctx.store();
      // A backup is everything, whatever its status: filtering a backup is
      // how a restore quietly loses the history. --all adds the tombstones,
      // which are the only rows left out by default.
      const tasks = await st.list(
        new Filter({ includeDeleted: ctx.bool('all'), order: OrderCreated }),
      );
      // Export does not touch the short-number cache. Its output is machine
      // data — a JSON envelope or CSV, whether or not --json was passed — so
      // nobody reads numbers off it, and renumbering the list while taking a
      // backup would change what `tdo done 2` means for whoever is reading
      // the terminal. It generates nothing either: export is a pure read
      // (§3.4).

      // A perspective is a saved query, and §3.7 calls an export a backup
      // while §10 makes export/import the way to move a list to another
      // provider. Leaving the saved queries out of both would lose them
      // silently. Reading them is a pure read like the rest of export.
      const perspectives = await st.perspectives();

      if (ctx.bool('csv')) {
        // CSV is a task table: a saved query has no row in it, and inventing
        // one would make the file no longer a task table. The note goes to
        // stderr, because stdout is the CSV.
        if (perspectives.length > 0) {
          a.out.hintf(
            `tdo: note: ${perspectives.length} saved perspective(s) are not in a CSV export; use the JSON form to back them up`,
          );
        }
        writeCSV(a.out.out, tasks);
        return;
      }
      // Export is machine output by nature, so it is JSON whether or not
      // --json was given.
      a.out.emit({
        version: exportVersion,
        exported_at: formatTime(new Date()),
        // Where the tasks came from, so an archive read months later says
        // which store it is a copy of. It is a description, not a credential:
        // Store.describe never returns a secret.
        store: st.describe(),
        tasks: tasks.map((t) => t.toJSON()),
        // count is the number of tasks and nothing else, which is what
        // `count` means beside a `tasks` array in every other command's
        // --json. A second array gets a second count rather than being
        // folded into this one.
        count: tasks.length,
        perspectives: perspectives.map(perspectiveJSON),
        perspective_count: perspectives.length,
      });
    },
  };
}

/**
 * writeCSV writes the rows by rendering each task and reading the columns
 * back out of the result, so the CSV and the JSON can never disagree about
 * what a field holds.
 */
function writeCSV(w: Writer, tasks: readonly Task[]): void {
  const lines: string[] = [csvRecord(csvHeader)];
  for (const t of tasks) {
    const obj = t.toJSON();
    const record = csvHeader.map((column) => {
      switch (column) {
        case 'fields':
          return JSON.stringify(t.fields);
        case KeyTags:
          return t.tags.join(',');
        default:
          return csvCell(obj[column]);
      }
    });
    lines.push(csvRecord(record));
  }
  // Go's encoding/csv ends every record, the last one included, with CRLF.
  w.write(lines.map((line) => line + '\r\n').join(''));
}

/** csvRecord renders one row with the quoting encoding/csv applies. */
function csvRecord(fields: readonly string[]): string {
  return fields.map(csvField).join(',');
}

/**
 * csvField quotes a field exactly when encoding/csv would: when it holds a
 * comma, a quote, a newline or a leading space, which is the set of values a
 * bare field would be read back as something else.
 */
function csvField(value: string): string {
  if (!/[",\r\n]/.test(value) && !value.startsWith(' ')) {
    return value;
  }
  return '"' + value.split('"').join('""') + '"';
}

/**
 * csvCell renders one JSON value as a cell: an absent or null value is empty,
 * a string loses its quotes, and anything structured keeps its JSON so the
 * round trip is lossless.
 */
function csvCell(raw: JSONValue | undefined): string {
  if (raw === undefined || raw === null) {
    return '';
  }
  if (typeof raw === 'string') {
    return raw;
  }
  return JSON.stringify(raw);
}

export function importCommand(a: App): Command {
  return {
    name: 'import',
    usage: 'add tasks from a file written by `tdo export`',
    argsUsage: '<file>',
    store: 'write',
    flags: {
      'new-ids': {
        type: 'boolean',
        usage: 'assign fresh ids instead of keeping the ones in the file',
      },
    },
    async run(ctx: Context): Promise<void> {
      const st = ctx.store();
      if (ctx.args.length !== 1) {
        throw usagef('import expects exactly one file');
      }
      let data: string;
      try {
        data = fs.readFileSync(ctx.args[0] ?? '', 'utf8');
      } catch (err) {
        throw exit.usagef(asError(err)) as Error;
      }
      let file: ImportFile;
      try {
        file = decodeImport(data);
      } catch (err) {
        throw exit.usagef(asError(err)) as Error;
      }
      const decoded = file.tasks;

      const newIDs = ctx.bool('new-ids');

      // The whole file is checked before anything is written. An import file
      // is untrusted input, and rejecting it halfway through would leave the
      // store holding part of it with no record of which part.
      prepareImport(decoded, newIDs);
      preparePerspectives(file.perspectives, new Date());
      // A child cannot be stored before its parent, because the store checks
      // the containment rules of §3.1 as it writes. The file's own order is
      // kept otherwise, so an export imports exactly as it was taken.
      const tasks = orderForImport(decoded);

      let imported = 0;
      let skipped = 0;
      for (const t of tasks) {
        let taken = true;
        try {
          await st.get(t.id);
        } catch (err) {
          if (!isNotFound(err)) {
            throw err;
          }
          taken = false;
        }
        if (taken) {
          // An id that is already there is the same task: importing the same
          // file twice must not duplicate anything.
          skipped++;
          continue;
        }
        try {
          await st.add(t);
        } catch (err) {
          throw treeError(err);
        }
        imported++;
      }

      // A perspective is restored only when its name is free. This is what
      // `import` already does with a task whose id is taken: an import adds,
      // it never overwrites. Silently replacing a saved query the user is
      // still using would be the worse failure, and the count says it
      // happened.
      let savedP = 0;
      let skippedP = 0;
      for (const p of file.perspectives) {
        let taken = true;
        try {
          await st.perspective(p.name);
        } catch (err) {
          if (!isNotFound(err)) {
            throw err;
          }
          taken = false;
        }
        if (taken) {
          skippedP++;
          continue;
        }
        await st.savePerspective(p);
        savedP++;
      }

      if (a.out.json) {
        a.out.emit({
          imported,
          skipped,
          perspectives_imported: savedP,
          perspectives_skipped: skippedP,
        });
        return;
      }
      a.out.printf(`imported ${imported} task(s), skipped ${skipped}\n`);
      if (savedP + skippedP > 0) {
        a.out.printf(`imported ${savedP} perspective(s), skipped ${skippedP}\n`);
      }
    },
  };
}

/**
 * prepareImport validates and normalises every task before the first write.
 * It throws a usage error naming the offending task, so a bad file is
 * rejected as a whole rather than applied up to the point where it breaks.
 */
function prepareImport(tasks: readonly (Task | undefined)[], newIDs: boolean): void {
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    // A JSON null in the tasks array decodes to nothing. Reading a field off
    // it would throw from inside the loop, which for an import means a stack
    // trace on stderr and a half-written store.
    if (t === undefined) {
      throw exit.usagef(new Error(`task ${i + 1} is null`)) as Error;
    }

    // An id has to be a real ULID. The CLI resolves references by prefix and
    // relies on ids sorting into creation order, and `tdo export` is a file a
    // user can edit by hand or a program can generate, so a made-up id is
    // rejected rather than stored. --new-ids is the way in for data from
    // another tool.
    if (newIDs) {
      t.id = id.New();
    } else {
      // Base32 is case-insensitive, so a lower-cased id is a real id written
      // differently. Storing it verbatim would make it unreachable, because
      // every lookup normalises first.
      t.id = id.Normalize(t.id);
      if (!id.Valid(t.id)) {
        throw exit.usagef(
          new Error(
            `task ${i + 1} has the id ${JSON.stringify(t.id)}, which is not a ULID; re-run with --new-ids to assign fresh ids`,
          ),
        ) as Error;
      }
    }
    const invalid = t.validate();
    if (invalid !== undefined) {
      throw exit.usagef(
        new Error(`task ${i + 1} (${t.id}): ${invalid.message}`),
      ) as Error;
    }
  }
}

/**
 * ImportFile is what an import file holds: the tasks, and the saved queries
 * the JSON envelope carries alongside them. The CSV form and a bare array
 * have no place for a perspective, so they leave it empty.
 */
interface ImportFile {
  tasks: (Task | undefined)[];
  perspectives: Perspective[];
}

/**
 * decodeImport accepts everything `tdo export` can produce: the JSON
 * envelope, a bare JSON array of tasks, and the CSV form. Unknown
 * user-defined fields are preserved, because every path ends in
 * `taskFromJSON`.
 */
function decodeImport(data: string): ImportFile {
  const withoutBOM = data.startsWith(bom) ? data.slice(bom.length) : data;
  const trimmed = withoutBOM.replace(/^[ \t\r\n]+/, '');
  if (trimmed === '') {
    throw new Error('the file is empty');
  }

  switch (trimmed[0]) {
    case '[': {
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`read tasks: ${asError(err).message}`);
      }
      return { tasks: readTasks(raw), perspectives: [] };
    }
    case '{': {
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`read tasks: ${asError(err).message}`);
      }
      const envelope = raw as Record<string, unknown>;
      if (!Array.isArray(envelope['tasks'])) {
        throw new Error('no `tasks` array in the file');
      }
      return {
        tasks: readTasks(envelope['tasks']),
        perspectives: readPerspectives(envelope['perspectives']),
      };
    }
    default:
      return { tasks: decodeCSV(trimmed), perspectives: [] };
  }
}

/** readTasks turns the decoded array into tasks, keeping a null as a hole. */
function readTasks(raw: unknown): (Task | undefined)[] {
  if (!Array.isArray(raw)) {
    throw new Error('read tasks: the `tasks` value is not an array');
  }
  return raw.map((entry) => {
    if (entry === null) {
      return undefined;
    }
    try {
      return taskFromJSON(entry);
    } catch (err) {
      throw new Error(`read tasks: ${asError(err).message}`);
    }
  });
}

/** readPerspectives turns the decoded array into perspectives. */
function readPerspectives(raw: unknown): Perspective[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error('read tasks: the `perspectives` value is not an array');
  }
  return raw.map((entry, i) => {
    const p = perspectiveFromJSON(entry);
    if (p === undefined) {
      // A null or a scalar, which preparePerspectives reports by position.
      throw exit.usagef(new Error(`perspective ${i + 1} is null`)) as Error;
    }
    return p;
  });
}

/**
 * preparePerspectives validates every saved query before the first write, for
 * the same reason prepareImport does it for tasks: a file rejected halfway
 * through would leave the store holding part of it. It also refuses a name
 * repeated inside one file, so that one file cannot both create and overwrite
 * the same perspective.
 */
function preparePerspectives(ps: readonly Perspective[], now: Date): void {
  const seen = new Set<string>();
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p === undefined) {
      throw exit.usagef(new Error(`perspective ${i + 1} is null`)) as Error;
    }
    p.name = p.name.trim();
    if (p.name === '') {
      throw exit.usagef(new Error(`perspective ${i + 1} has no name`)) as Error;
    }
    // Names are compared case-insensitively everywhere else, so two
    // spellings of one name in a file are one perspective.
    const key = p.name.toLowerCase();
    if (seen.has(key)) {
      throw exit.usagef(
        new Error(`perspective ${i + 1} (${p.name}) is in the file twice`),
      ) as Error;
    }
    seen.add(key);
    const invalid = p.filter.validate();
    if (invalid !== undefined) {
      throw exit.usagef(
        new Error(`perspective ${i + 1} (${p.name}): ${invalid.message}`),
      ) as Error;
    }
    // A hand-written file need not carry timestamps; a stored perspective
    // always has them.
    if (isZeroTime(p.updatedAt)) {
      p.updatedAt = now;
    }
    if (isZeroTime(p.createdAt)) {
      p.createdAt = p.updatedAt;
    }
  }
}

function decodeCSV(text: string): (Task | undefined)[] {
  const records = readCSV(text);
  if (records.length === 0) {
    throw new Error('the csv file has no header');
  }

  const first = records[0] ?? [];
  const header = first.map((name) => name.trim());
  const seen = new Set(header);
  for (const required of [KeyID, KeyTitle, KeyCreatedAt, KeyUpdatedAt]) {
    if (!seen.has(required)) {
      throw new Error(`the csv file has no ${JSON.stringify(required)} column`);
    }
  }

  const tasks: Task[] = [];
  for (let lineno = 1; lineno < records.length; lineno++) {
    const record = records[lineno] ?? [];
    // Rebuilding the JSON object and handing it to the task package keeps one
    // parser for both formats, so a field imports identically either way.
    const obj: Record<string, JSONValue> = {};
    for (let i = 0; i < header.length; i++) {
      const column = header[i] ?? '';
      if (column === '' || i >= record.length) {
        continue;
      }
      let value: JSONValue | undefined;
      try {
        value = csvValue(column, record[i] ?? '');
      } catch (err) {
        throw new Error(`csv line ${lineno + 1}: ${column}: ${asError(err).message}`);
      }
      if (column === KeyDone) {
        // The pre-GTD export carried a derived `done` column. It is read so
        // an older file still imports, and turned into the status the model
        // actually stores.
        if (value === true && !Object.hasOwn(obj, KeyStatus)) {
          obj[KeyStatus] = StatusDone;
        }
        continue;
      }
      if (value === undefined) {
        continue;
      }
      if (column === 'fields') {
        for (const [k, v] of Object.entries(value as Record<string, JSONValue>)) {
          if (!Object.hasOwn(obj, k)) {
            obj[k] = v;
          }
        }
        continue;
      }
      obj[column] = value;
    }

    try {
      tasks.push(taskFromJSON(obj));
    } catch (err) {
      throw new Error(`csv line ${lineno + 1}: ${asError(err).message}`);
    }
  }
  return tasks;
}

/**
 * readCSV is `encoding/csv`'s reader for the one dialect this CLI writes:
 * comma-separated, double-quote-escaped fields, with a newline inside a
 * quoted field kept as part of the value.
 */
function readCSV(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = (): void => {
    record.push(field);
    field = '';
    started = true;
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
          continue;
        }
        quoted = false;
        continue;
      }
      field += ch;
      continue;
    }
    switch (ch) {
      case '"':
        quoted = true;
        continue;
      case ',':
        endField();
        continue;
      case '\r':
        // A bare CR is a line ending too, and CRLF is one ending, not two.
        if (text[i + 1] === '\n') {
          i++;
        }
        endRecord();
        continue;
      case '\n':
        endRecord();
        continue;
      default:
        field += ch;
        started = true;
        continue;
    }
  }
  if (quoted) {
    throw new Error('read csv: a quoted field is never closed');
  }
  if (field !== '' || started || record.length > 0) {
    endRecord();
  }
  return records;
}

/**
 * csvValue types one cell by its column. An empty cell is absent rather than
 * zero, so a column the writer left blank does not overwrite a default.
 */
function csvValue(column: string, cell: string): JSONValue | undefined {
  const trimmed = cell.trim();
  if (column === 'fields') {
    if (trimmed === '') {
      return undefined;
    }
    const obj: unknown = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new Error('the fields column is not a JSON object');
    }
    return obj as JSONValue;
  }
  if (column === KeyTags) {
    const tags = parseTags([cell]);
    return tags.length === 0 ? undefined : tags;
  }
  if (column === KeyDone || csvBoolColumns.has(column)) {
    if (trimmed === '') {
      return undefined;
    }
    return parseBool(trimmed);
  }
  if (csvIntColumns.has(column)) {
    if (trimmed === '') {
      return undefined;
    }
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(`${JSON.stringify(trimmed)} is not a whole number`);
    }
    return Number(trimmed);
  }
  if (csvJSONColumns.has(column)) {
    if (trimmed === '') {
      return undefined;
    }
    return JSON.parse(trimmed) as JSONValue;
  }
  if (trimmed === '') {
    return undefined;
  }
  return cell;
}

/** parseBool is `strconv.ParseBool`: the spellings Go accepted and no others. */
function parseBool(text: string): boolean {
  switch (text) {
    case '1':
    case 't':
    case 'T':
    case 'true':
    case 'TRUE':
    case 'True':
      return true;
    case '0':
    case 'f':
    case 'F':
    case 'false':
    case 'FALSE':
    case 'False':
      return false;
    default:
      throw new Error(`${JSON.stringify(text)} is not a boolean`);
  }
}

/**
 * orderForImport puts parents before their children while keeping the file's
 * order otherwise. A parent that is not in the file is left to the store,
 * which refuses an unknown one.
 */
function orderForImport(tasks: readonly (Task | undefined)[]): Task[] {
  const present = tasks.filter((t): t is Task => t !== undefined);
  // The index is by position, not by id: the same id may appear twice in one
  // file, and the duplicate must survive this far so that `import` can count
  // it as skipped rather than lose it silently.
  const first = new Map<string, number>();
  for (let i = 0; i < present.length; i++) {
    const t = present[i];
    if (t !== undefined && !first.has(t.id)) {
      first.set(t.id, i);
    }
  }
  const out: Task[] = [];
  const placed: boolean[] = new Array<boolean>(present.length).fill(false);

  const isPlaced = (i: number): boolean => placed[i] === true;
  const place = (i: number, seen: Set<number>): void => {
    if (isPlaced(i) || seen.has(i)) {
      // seen guards against a parent cycle in a hand-written file: the store
      // rejects it, and this must not loop first.
      return;
    }
    seen.add(i);
    const t = present[i];
    if (t === undefined) {
      return;
    }
    const parent = first.get(t.parentID);
    if (parent !== undefined && t.parentID !== t.id) {
      place(parent, seen);
    }
    // The recursion above may have placed this one already, through a
    // parent that is also its descendant in a hand-written file.
    if (isPlaced(i)) {
      return;
    }
    placed[i] = true;
    out.push(t);
  };
  for (let i = 0; i < present.length; i++) {
    place(i, new Set<number>());
  }
  return out;
}

/** forTest exposes the two decoders the Go tests drove directly. */
export const forTest = {
  decodeImport,
  readCSV,
  csvHeader,
  writeCSV,
  fieldsOf: (t: Task): Fields => t.fields,
};
