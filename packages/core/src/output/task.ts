// The human-readable renderings of a task: the numbered listing table, the
// labelled detail block behind `tdo show`, and the one clause that explains
// why an item is not available.
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - Go aligned its columns with `text/tabwriter`. There is no such thing in
//     Node, so `tabwrite` below is a port of the one configuration this
//     package used, and the column rules it reproduces are written out there.
//   - Go measured a cell in runes (`utf8.RuneCountInString`). A JavaScript
//     string is UTF-16, so `String.length` would count an astral character
//     twice; every width here goes through `runeLength`, which counts code
//     points exactly as Go counted runes.
//   - Go returned an `error` from `Table` and `Detail`, which was only ever
//     the writer's. A failing writer throws here instead.

import { nextReviewAt } from '../recur.ts';
import {
  Availability,
  RuleAncestorDeferred,
  RuleAncestorDeleted,
  RuleAncestorSequential,
  RuleAncestorStatus,
  RuleAncestorTagStatus,
  RuleDeferred,
  RuleDeleted,
  RuleMissingParent,
  RuleNone,
  RuleNotActionable,
  RuleSequential,
  RuleStatus,
  RuleTagStatus,
} from '../store/store.ts';
import type { JSONValue, Task } from '../task.ts';
import {
  Fields,
  KindFolder,
  KindProject,
  StatusDone,
  StatusDropped,
  StatusOnHold,
  formatTime,
} from '../task.ts';
import type { Writer } from './output.ts';

/**
 * titleWidth is the longest title the table prints before truncating it. The
 * other columns add up to about 32 characters, which keeps the whole row
 * inside an 80-column terminal. A tree row spends part of it on indentation,
 * so the column width is the same either way and the indent eats into the
 * title rather than into the terminal.
 */
const titleWidth = 34;

/** tagsWidth is the same idea for the tag column. */
const tagsWidth = 16;

/**
 * indentWidth is how far one level of the tree shifts a title. Two spaces is
 * enough to read the nesting and cheap enough that a deep branch still leaves
 * room for a title.
 */
const indentWidth = 2;

/** RowInit is the field set of a Row; see the fields themselves. */
export interface RowInit {
  task: Task;
  depth?: number | undefined;
  availability?: Availability | undefined;
  asked?: boolean | undefined;
}

/**
 * Row is one line of a listing: the task, how deep it sits in the tree when
 * the listing is printed as one, and what §3.3 says about it. Availability
 * travels with the row because the reason an item is blocked lives above it
 * in the tree, where the renderer cannot see.
 *
 * It is a class with an init object rather than a bare interface so that Go's
 * `Row{Task: t}` — every other field at its zero value — ports as
 * `new Row({ task: t })` instead of spelling the zero values out at every
 * call site.
 */
export class Row {
  task: Task;
  depth = 0;
  /**
   * availability is the answer for this task. The zero value — not
   * available, no rule — is what a caller passes when it did not ask, and
   * renders as an ordinary row.
   */
  availability: Availability = new Availability();
  /**
   * asked records that availability was computed. Without it a zero value
   * would be indistinguishable from "blocked for no stated reason".
   */
  asked = false;

  constructor(init: RowInit) {
    this.task = init.task;
    if (init.depth !== undefined) {
      this.depth = init.depth;
    }
    if (init.availability !== undefined) {
      this.availability = init.availability;
    }
    if (init.asked !== undefined) {
      this.asked = init.asked;
    }
  }
}

/**
 * Rows pairs tasks with no availability, for the listings where it is not the
 * question being asked.
 */
export function Rows(tasks: Task[]): Row[] {
  return tasks.map((t) => new Row({ task: t }));
}

/**
 * Table writes rows as a numbered table. The number in the first column is
 * the short reference the next command accepts, so it must match the order
 * the ids were cached in.
 *
 * `start` is how many rows of that cached listing came before these, which is
 * what `tdo forecast --week` needs: it writes one table per day out of a
 * single listing, and a second table that began again at 1 would print a
 * number that means a different task than the one on the row.
 *
 * Rows are written through a tabwriter and then stripped of trailing spaces:
 * an empty last column would otherwise pad every row to the same width, which
 * shows up as noise when the output is diffed or pasted.
 */
export function Table(w: Writer, rows: readonly Row[], start = 0): void {
  const cells: string[][] = [['#', 'S', 'K', 'DUE', 'TITLE', 'TAGS']];
  rows.forEach((r, i) => {
    cells.push([
      String(start + i + 1),
      stateMarker(r),
      kindMarker(r.task),
      dueCell(r.task),
      indented(r),
      truncate(sanitize(r.task.tags.join(',')), tagsWidth),
    ]);
  });
  for (const line of tabwrite(cells)) {
    w.write(trimRight(line) + '\n');
  }
}

/**
 * indented renders the title at its depth in the tree, truncating what is
 * left of the column rather than the column itself, so the table keeps its
 * width however deep the branch goes.
 */
function indented(r: Row): string {
  const title = sanitize(r.task.title);
  if (r.depth <= 0) {
    return truncate(title, titleWidth);
  }
  let pad = r.depth * indentWidth;
  if (pad > titleWidth - 4) {
    // Past this the title would be all indentation; stop moving right.
    pad = titleWidth - 4;
  }
  return ' '.repeat(pad) + truncate(title, titleWidth - pad);
}

/**
 * stateMarker is two characters: where the item stands, and whether it is
 * flagged. A blocked-but-active item is marked so that `--all` and
 * `--blocked` listings do not look like `tdo ls`.
 */
function stateMarker(r: Row): string {
  const t = r.task;
  let state = ' ';
  if (t.deleted()) {
    state = '-';
  } else if (t.status === StatusDone) {
    state = 'x';
  } else if (t.status === StatusDropped) {
    state = '~';
  } else if (t.status === StatusOnHold) {
    state = 'h';
  } else if (r.asked && !r.availability.available && t.actionable()) {
    state = '!';
  }
  if (t.flagged) {
    return state + '*';
  }
  return state;
}

/**
 * kindMarker is one character per kind, so a tree of folders, projects and
 * actions reads without a legend: f, p, and a blank for an ordinary action.
 */
function kindMarker(t: Task): string {
  switch (t.kind) {
    case KindFolder:
      return 'f';
    case KindProject:
      return 'p';
    default:
      return '';
  }
}

function dueCell(t: Task): string {
  if (t.dueAt === undefined) {
    return '';
  }
  // Go formatted the UTC instant with task.DueDateFormat, the date-only form.
  // `toISOString` is already UTC, so the date is its first ten characters.
  return t.dueAt.toISOString().slice(0, 10);
}

/**
 * sanitize makes a stored string safe to write to a terminal.
 *
 * A title is user data, and user data reaches this renderer unchanged: a value
 * holding an ANSI escape would colour the rest of the display, a carriage
 * return would overwrite the row above it, and a NUL or a backspace would make
 * the output lie about what is stored. Control characters are therefore
 * rendered the way Go would quote them, which keeps the row readable and keeps
 * `tdo show` an honest view of the data. Machine output is untouched: JSON
 * escapes these characters itself.
 */
export function sanitize(s: string): string {
  let needed = false;
  for (const r of s) {
    if (isControl(r)) {
      needed = true;
      break;
    }
  }
  if (!needed) {
    return s;
  }
  let b = '';
  for (const r of s) {
    if (!isControl(r)) {
      b += r;
    } else if (r === '\t') {
      b += '\\t';
    } else if (r === '\n') {
      b += '\\n';
    } else if (r === '\r') {
      b += '\\r';
    } else if (r === '\x1b') {
      b += '\\e';
    } else {
      // Every remaining control rune is below 0x100 — C0, DEL and C1 — so a
      // two-digit escape covers them all.
      b += '\\x' + (r.codePointAt(0) ?? 0).toString(16).padStart(2, '0');
    }
  }
  return b;
}

/**
 * isControl reports whether r — one code point — is a C0 or C1 control
 * character, or DEL.
 */
function isControl(r: string): boolean {
  const c = r.codePointAt(0) ?? 0;
  return c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f);
}

/**
 * truncate shortens s to at most n characters, marking the cut with an
 * ellipsis so a clipped title is never mistaken for the whole one.
 *
 * `n` counts code points, as Go's rune count did: cutting a UTF-16 string by
 * `length` would split a surrogate pair and produce a replacement character.
 */
function truncate(s: string, n: number): string {
  if (n <= 0) {
    return '';
  }
  const runes = Array.from(s);
  if (runes.length <= n) {
    return s;
  }
  return runes.slice(0, n - 1).join('') + '…';
}

/**
 * Detail writes one task as a block of labelled lines, for `tdo show` and for
 * the human-readable form of the commands that change one task.
 *
 * blockedBy, when given, is the task named in the availability answer. It is
 * passed in rather than looked up because the renderer has no store: the whole
 * point of `tdo show` on a blocked item is to name the project or the sibling
 * that is holding it, and that may be nowhere near the item.
 */
export function Detail(w: Writer, r: Row, blockedBy: Task | undefined): void {
  const lines: string[][] = [];
  const t = r.task;

  lines.push(['id', sanitize(t.id)]);
  lines.push(['kind', t.kind]);
  lines.push(['title', sanitize(t.title)]);

  let status: string = t.status;
  if (t.deleted()) {
    status += ' (deleted)';
  }
  lines.push(['status', status]);

  if (r.asked) {
    if (r.availability.available) {
      lines.push(['available', 'yes']);
    } else {
      lines.push(['available', `no (${BlockedReason(r.availability, blockedBy)})`]);
    }
  }
  if (t.parentID !== '') {
    lines.push(['parent', sanitize(t.parentID)]);
  } else if (t.inbox()) {
    lines.push(['parent', 'inbox']);
  }
  if (t.position !== 0) {
    lines.push(['position', String(t.position)]);
  }
  if (t.flagged) {
    lines.push(['flagged', 'yes']);
  }
  if (t.sequential) {
    lines.push(['sequential', 'yes']);
  }
  if (t.completedByChildren) {
    lines.push(['completes with last child', 'yes']);
  }
  if (t.deferAt !== undefined) {
    lines.push(['defer', formatTime(t.deferAt)]);
  }
  if (t.dueAt !== undefined) {
    lines.push(['due', formatTime(t.dueAt)]);
  }
  if (t.estimatedMinutes > 0) {
    lines.push(['estimate', `${t.estimatedMinutes}m`]);
  }
  if (t.tags.length > 0) {
    lines.push(['tags', sanitize(t.tags.join(','))]);
  }
  if (t.repeat !== undefined) {
    lines.push(['repeat', `${sanitize(t.repeat.every)} (${t.repeat.method})`]);
  }
  if (t.seriesID !== '') {
    lines.push(['series', sanitize(t.seriesID)]);
  }
  if (t.reviewInterval !== undefined) {
    lines.push(['review every', sanitize(t.reviewInterval.every)]);
    const next = nextReviewAt(t, nowOf(t));
    if (next !== undefined) {
      lines.push(['next review', formatTime(next)]);
    }
  }
  if (t.lastReviewedAt !== undefined) {
    lines.push(['last reviewed', formatTime(t.lastReviewedAt)]);
  }
  if (t.note !== '') {
    lines.push(['note', sanitize(t.note)]);
  }
  lines.push(['created', formatTime(t.createdAt)]);
  lines.push(['updated', formatTime(t.updatedAt)]);
  if (t.completedAt !== undefined) {
    lines.push(['completed', formatTime(t.completedAt)]);
  }
  if (t.droppedAt !== undefined) {
    lines.push(['dropped', formatTime(t.droppedAt)]);
  }
  if (t.deletedAt !== undefined) {
    lines.push(['deleted', formatTime(t.deletedAt)]);
  }
  for (const key of Fields.keys(t.fields)) {
    lines.push([sanitize(key), sanitize(fieldText(t.fields[key] ?? null))]);
  }
  // Detail does not strip the padding Table strips: every line here has a
  // label and a value, so there is no empty trailing column to pad.
  for (const line of tabwrite(lines)) {
    w.write(line + '\n');
  }
}

/**
 * nowOf is the instant a derived review date is rendered against. A task that
 * has never been reviewed is due now, and "now" for a rendering is the
 * task's own updated_at: using the wall clock here would make the same task
 * print differently on two consecutive runs.
 */
function nowOf(t: Task): Date {
  return t.updatedAt;
}

/**
 * BlockedReason puts an availability answer into one clause a person can act
 * on. The blocking item is named by title when the caller could fetch it,
 * because an id is not an answer to "why can I not do this".
 */
export function BlockedReason(a: Availability, by: Task | undefined): string {
  let name = a.blockedBy;
  if (by !== undefined) {
    name = quote(sanitize(by.title));
  } else if (name === '') {
    name = 'an item that is not in this store';
  }
  switch (a.rule) {
    case RuleNone:
      return 'nothing is blocking it';
    case RuleNotActionable:
      return 'a folder organises; it is not something to do';
    case RuleDeleted:
      return 'it has been removed';
    case RuleStatus:
      return 'its own status is not active';
    case RuleDeferred:
      return 'it is deferred until later';
    case RuleSequential:
      return `${name} comes first in this sequential list`;
    case RuleMissingParent:
      return `its parent ${a.blockedBy} is not in this store`;
    case RuleAncestorDeleted:
      return `${name}, which contains it, has been removed`;
    case RuleAncestorStatus:
      return `${name}, which contains it, is not active`;
    case RuleAncestorDeferred:
      return `${name}, which contains it, is deferred until later`;
    case RuleAncestorSequential:
      return `${name} has not come up yet in its sequential list`;
    case RuleTagStatus:
      return `its tag ${quote(sanitize(a.tag))} is not active`;
    case RuleAncestorTagStatus:
      return `${name}, which contains it, has the tag ${quote(sanitize(a.tag))}, which is not active`;
    default:
      return a.rule;
  }
}

/**
 * quote is Go's `%q` over a string that has already been through sanitize:
 * double quotes around it, with a backslash and a quote escaped. sanitize has
 * already turned every control character into an escape of its own, so those
 * are the only two characters left that `%q` would have touched — bar the
 * non-ASCII non-printables (a zero-width space, say), which Go escaped and
 * which are left alone here rather than carrying a Unicode table into `core`.
 */
function quote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * fieldText renders a user-defined value for a human. A list becomes a
 * comma-separated line; anything structured falls back to the runtime's own
 * rendering, which is enough for a value the user put there themselves.
 *
 * It is exported because its Go counterpart was unexported and tested from
 * inside the package; nothing else calls it.
 */
export function fieldText(v: JSONValue): string {
  if (typeof v === 'string') {
    return v;
  }
  if (Array.isArray(v)) {
    // Go had a case for []string and another for []any. There is one array
    // type here, so the two collapse: each element is rendered as Go's
    // fmt.Sprint would render it, which for a string is the string itself.
    return v.map((e) => scalarText(e)).join(',');
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort(compareStrings);
    return '{' + keys.map((k) => `${k}=${scalarText(v[k] ?? null)}`).join(' ') + '}';
  }
  return scalarText(v);
}

/**
 * scalarText is Go's `fmt.Sprint` for the values that reach it here: a
 * number, a boolean, a string, or a nested value. Go printed a nil as
 * `<nil>`; a JSON null is spelled `null`, which is what the user wrote.
 */
function scalarText(v: JSONValue): string {
  if (typeof v === 'string') {
    return v;
  }
  if (v === null) {
    return 'null';
  }
  if (typeof v === 'object') {
    return fieldText(v);
  }
  return String(v);
}

// Go's sort.Strings orders by byte value, which `<` reproduces for every key
// the model uses; see the same comment in task.ts.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** runeLength counts code points, which is what Go's rune count counted. */
function runeLength(s: string): number {
  let n = 0;
  for (const _ of s) {
    void _;
    n++;
  }
  return n;
}

function trimRight(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/**
 * tabwrite aligns rows of cells into columns, reproducing the one
 * `text/tabwriter` configuration this package used: minwidth 0, tabwidth 0,
 * padding 2, a space as the pad character and no flags.
 *
 * The two rules that matter, both of them tabwriter's:
 *
 *   - A column is as wide as its widest cell plus the padding. Width is
 *     measured in code points, as tabwriter measured runes.
 *   - The last cell of a line is not part of a column. tabwriter only aligns
 *     tab-terminated cells, and the text after the final tab is written as
 *     it is — which is why an empty last column costs nothing and why a line
 *     with fewer cells than its neighbours ends the column block rather than
 *     widening it.
 */
function tabwrite(rows: readonly string[][], padding = 2): string[] {
  const widths = rows.map(() => new Map<number, number>());
  const maxCells = rows.reduce((n, r) => Math.max(n, r.length), 0);

  for (let col = 0; col + 1 < maxCells; col++) {
    let i = 0;
    while (i < rows.length) {
      // A line whose cell in this column is its last one is not in the block.
      if ((rows[i]?.length ?? 0) <= col + 1) {
        i++;
        continue;
      }
      let end = i;
      let widest = 0;
      while (end < rows.length && (rows[end]?.length ?? 0) > col + 1) {
        widest = Math.max(widest, runeLength(rows[end]?.[col] ?? ''));
        end++;
      }
      const target = widest + padding;
      for (let k = i; k < end; k++) {
        widths[k]?.set(col, target);
      }
      i = end;
    }
  }

  return rows.map((cells, i) =>
    cells
      .map((cell, col) => {
        const target = widths[i]?.get(col);
        if (target === undefined) {
          return cell;
        }
        return cell + ' '.repeat(Math.max(0, target - runeLength(cell)));
      })
      .join(''),
  );
}
