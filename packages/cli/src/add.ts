// `tdo add`, and the flags every creating command shares.
//
// Go attached `newItem` to the `*app` receiver without using it; see the note
// in app.ts for why the port passes what it needs as parameters instead.

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import type { Store } from '@todocloud/core/store';
import {
  type JSONValue,
  type Kind,
  KindProject,
  KindTask,
  type Repeat,
  type Task,
  parseDue,
  parseValue,
} from '@todocloud/core/task';
import { Draft, parseRepeat as taskopsParseRepeat, normalizeTags } from '@todocloud/core/taskops/edit';

import { type App, asError, type Command, type Context, type Flags, usagef } from './app.ts';
import { parseMinutes } from './list.ts';
import { resolveContainer, resolveEvent, resolveRef } from './refs.ts';
import { renderTask, treeError } from './view.ts';

/**
 * setFlags are the flags that write user-defined fields. Everything the GTD
 * model names is a required field with a flag of its own; --set is what is
 * left, and it is stored in the open map untouched.
 */
export function setFlags(): Flags {
  return {
    priority: {
      type: 'string',
      placeholder: 'N',
      usage: 'priority from 0 (none) to 3 (high)',
    },
    set: {
      type: 'string',
      multiple: true,
      placeholder: 'KEY=VALUE',
      usage: 'set a user-defined field, KEY=VALUE; may be repeated',
    },
  };
}

/** addFlags are the flags `tdo add` takes beyond the shared ones. */
export function addFlags(): Flags {
  return {
    project: { type: 'string', placeholder: 'P', usage: 'put the task in project P' },
    parent: { type: 'string', placeholder: 'REF', usage: 'put the task under REF, making an action group' },
    inbox: { type: 'boolean', usage: 'capture to the inbox, which is the default' },
    defer: { type: 'string', placeholder: 'D', usage: 'not available before D' },
    due: { type: 'string', placeholder: 'D', usage: 'due date, YYYY-MM-DD or RFC 3339' },
    flag: { type: 'boolean', usage: 'flag the new item' },
    tag: { type: 'string', multiple: true, placeholder: 'TAGS', usage: 'comma-separated TAGS; may be repeated' },
    note: { type: 'string', placeholder: 'S', usage: 'free-form note' },
    // Go declared `notes` as an alias of `note`; the dispatcher has no alias
    // mechanism, so the second spelling is its own hidden flag and
    // `aliasedString` reads whichever was given.
    notes: { type: 'string', placeholder: 'S', usage: 'free-form note', hidden: true },
    estimate: { type: 'string', placeholder: '25m', usage: 'how long it will take, for example 25m' },
    'wait-on': {
      type: 'string',
      multiple: true,
      placeholder: 'EVENT',
      usage: 'hold the task until EVENT has occurred; may be repeated',
    },
    repeat: {
      type: 'string',
      placeholder: 'EVERY[:method]',
      usage: 'repeat EVERY[:method], for example 1w or 1mo:last-friday:fixed',
    },
    ...setFlags(),
  };
}

/**
 * aliasedString reads a string flag that Go declared under two names. It
 * returns the value and whether either spelling appeared, which is the
 * difference between `--note ""`, which clears the note, and no --note at
 * all, which leaves it alone.
 */
export function aliasedString(ctx: Context, name: string, alias: string): { value: string; set: boolean } {
  if (ctx.isSet(name)) {
    return { value: ctx.string(name), set: true };
  }
  if (ctx.isSet(alias)) {
    return { value: ctx.string(alias), set: true };
  }
  return { value: '', set: false };
}

/**
 * intFlag reads a flag Go declared as an `IntFlag`. The dispatcher has no
 * number type on purpose — a numeric flag has to report its own bad input as
 * a usage error anyway — so the parsing urfave did is done here, and it
 * reports the same exit 2 urfave's parse failure did.
 */
export function intFlag(ctx: Context, name: string): number {
  if (!ctx.isSet(name)) {
    return 0;
  }
  const raw = ctx.string(name).trim();
  if (!/^[+-]?\d+$/.test(raw)) {
    throw usagef(`--${name} expects a whole number, got ${JSON.stringify(ctx.string(name))}`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * fieldFlags reads --priority, --set and --unset into the three arguments
 * the shared layer takes. Parsing the spelling is this package's job; what a
 * reserved name means is not, so that `tdo serve` cannot accept a field
 * `tdo add` refuses.
 */
export function fieldFlags(ctx: Context): {
  priority: number | undefined;
  set: Record<string, JSONValue>;
  unset: string[];
} {
  let priority: number | undefined;
  if (ctx.isSet('priority')) {
    priority = intFlag(ctx, 'priority');
  }
  const set: Record<string, JSONValue> = {};
  for (const raw of ctx.strings('set')) {
    const eq = raw.indexOf('=');
    const key = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    if (eq < 0 || key === '') {
      throw usagef(`--set expects KEY=VALUE, got ${JSON.stringify(raw)}`);
    }
    set[key] = parseValue(raw.slice(eq + 1));
  }
  // `tdo add` does not declare --unset; an undeclared flag reads as empty,
  // exactly as urfave's StringSlice did.
  const unset = [...ctx.strings('unset')];
  return { priority, set, unset };
}

/**
 * parseTags splits the comma-separated lists a repeated --tag builds up. The
 * normalization — blanks, duplicates, case — is the shared layer's.
 */
export function parseTags(values: readonly string[]): string[] {
  return normalizeTags(values);
}

/**
 * parseRepeat reads the --repeat value. What the spelling means is the
 * shared layer's, so `tdo add --repeat` and the API accept the same one.
 */
export function parseRepeat(raw: string): Repeat {
  try {
    return taskopsParseRepeat(raw);
  } catch (err) {
    throw exit.usagef(asError(err)) as Error;
  }
}

/**
 * newItem builds a task from the flags every creating command shares, and
 * places it under the parent the flags name. parent is undefined at the top
 * level, which for a task means the inbox.
 *
 * The flags are read here and the item is assembled by the shared layer, so
 * that an item created through `tdo serve` is the same row as one created
 * here.
 */
export function newItem(ctx: Context, kind: Kind, title: string, parent: Task | undefined): Task {
  const d = new Draft({ kind, title });
  if (parent !== undefined) {
    d.parentID = parent.id;
  }
  if (ctx.isSet('flag')) {
    d.flagged = ctx.bool('flag');
  }
  if (ctx.isSet('tag')) {
    d.tags = parseTags(ctx.strings('tag'));
  }
  const note = aliasedString(ctx, 'note', 'notes');
  if (note.set) {
    d.note = note.value;
  }
  if (ctx.isSet('defer')) {
    d.deferAt = parseInstant(ctx.string('defer'));
  }
  if (ctx.isSet('due')) {
    d.dueAt = parseInstant(ctx.string('due'));
  }
  if (ctx.isSet('estimate')) {
    d.estimatedMinutes = parseMinutes(ctx.string('estimate'));
  }
  if (ctx.isSet('repeat')) {
    d.repeat = parseRepeat(ctx.string('repeat'));
  }
  const { priority, set, unset } = fieldFlags(ctx);
  if (unset.length > 0) {
    throw usagef('--unset removes a field from an existing item; a new one has none');
  }
  d.priority = priority;
  d.set = set;

  return d.build(id.New(), new Date());
}

/**
 * parseInstant reads a --defer / --due value. A plain date means that day at
 * midnight UTC, which is what task.parseDue returns.
 */
export function parseInstant(raw: string): Date | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    return parseDue(trimmed);
  } catch (err) {
    throw exit.usagef(asError(err)) as Error;
  }
}

/** addCommand is `tdo add`: capture, to the inbox unless given a home. */
export function addCommand(a: App): Command {
  return {
    name: 'add',
    usage: 'capture a task, to the inbox unless it is given a home',
    argsUsage: '<title...>',
    flags: addFlags(),
    store: 'write',
    async run(ctx: Context): Promise<void> {
      const title = ctx.args.join(' ').trim();
      if (title === '') {
        throw usagef('expected a task title');
      }
      const st: Store = ctx.store();
      const parent = await addParent(a, ctx, st);
      const t = newItem(ctx, KindTask, title, parent);
      // The events are resolved before the task is written, so a reference
      // that means nothing leaves nothing behind.
      const events = await waitOn(st, ctx);
      try {
        await st.add(t);
      } catch (err) {
        throw treeError(err);
      }
      if (events.length > 0) {
        await st.setWaits(t.id, events);
      }
      await renderTask(a, st, t);
    },
  };
}

/**
 * waitOn reads --wait-on: the events a new item is held for, as ids. It lives
 * here because `tdo project add` takes the same flag.
 */
export async function waitOn(st: Store, ctx: Context): Promise<string[]> {
  const out: string[] = [];
  for (const ref of ctx.strings('wait-on')) {
    const e = await resolveEvent(st, ref);
    if (!out.includes(e.id)) {
      out.push(e.id);
    }
  }
  return out;
}

/**
 * addParent resolves where a new task goes. With neither --project nor
 * --parent it goes to the inbox, because the cost of filing must not be
 * charged at the moment of capture (§4.1).
 */
export async function addParent(a: App, ctx: Context, st: Store): Promise<Task | undefined> {
  const project = ctx.string('project').trim();
  const parent = ctx.string('parent').trim();
  const inbox = ctx.bool('inbox');

  if (project !== '' && parent !== '') {
    throw usagef('--project and --parent both choose where the task goes; pass only one');
  }
  if (inbox && (project !== '' || parent !== '')) {
    throw usagef('--inbox means no parent, so it contradicts --project and --parent');
  }
  if (project !== '') {
    return resolveContainer(a, st, project, KindProject);
  }
  if (parent !== '') {
    return resolveRef(a, st, parent);
  }
  return undefined;
}
