// The reads: `tdo ls`, `tdo next` and `tdo inbox`, and the filter flags they
// and a saved perspective share.
//
// Go attached the helpers here to the `*app` receiver; see the note in app.ts
// for why the port passes the app as the first parameter instead.

import * as exit from '@todocloud/core/exit';
import {
  AvailabilityAvailable,
  AvailabilityAny,
  AvailabilityBlocked,
  AvailabilityDeferred,
  Condition,
  type Order,
  OrderCreated,
  OrderDefer,
  OrderDue,
  OrderPosition,
  OrderUpdated,
  Scope,
  type Store,
} from '@todocloud/core/store';
import { Filter } from '@todocloud/core/store/filter';
import {
  DueDateFormat,
  type Kind,
  KindProject,
  KindTask,
  type Status,
  StatusActive,
  kindValid,
  parseDue,
  statusValid,
} from '@todocloud/core/task';
import { parseMinutes as taskopsParseMinutes } from '@todocloud/core/taskops/edit';
import { Selection as RunSelection, openStatuses, run } from '@todocloud/core/taskops/select';
import type { Task } from '@todocloud/core/task';

import { intFlag, parseTags } from './add.ts';
import { type App, asError, type Command, type Context, type Flags, usagef } from './app.ts';
import { resolveContainer, resolveRef, saveListing } from './refs.ts';
import { availabilityOf, countLine, printTable, renderTask, treeError, views } from './view.ts';

/**
 * filterFlags are the selection flags of `tdo ls`. They are a function rather
 * than a variable because a perspective parses the same set a second time,
 * and a flag value must not be shared between the two parses.
 */
export function filterFlags(): Flags {
  return {
    available: { type: 'boolean', usage: 'keep only items that can be worked on now (the default)' },
    blocked: { type: 'boolean', usage: 'keep only items something is holding back' },
    deferred: { type: 'boolean', usage: 'keep only items waiting for a defer date' },
    all: { type: 'boolean', usage: 'no availability or status filter: everything but tombstones' },
    deleted: { type: 'boolean', usage: 'list the items `tdo rm` tombstoned' },
    inbox: { type: 'boolean', usage: 'keep only loose actions: tasks with no parent' },
    flagged: { type: 'boolean', usage: 'keep only flagged items' },
    project: { type: 'string', placeholder: 'P', usage: 'keep what is inside project P' },
    under: { type: 'string', placeholder: 'REF', usage: 'keep what is inside REF, at any depth' },
    kind: { type: 'string', placeholder: 'KIND', usage: 'keep one KIND: folder, project or task' },
    status: {
      type: 'string',
      multiple: true,
      placeholder: 'STATUS',
      usage: 'keep one STATUS: active, on_hold, done or dropped; may be repeated',
    },
    tag: { type: 'string', multiple: true, placeholder: 'TAGS', usage: 'require these TAGS; may be repeated' },
    untagged: { type: 'boolean', usage: 'keep only items carrying no tag' },
    'due-before': { type: 'string', placeholder: 'D', usage: 'keep items due before D' },
    'defer-before': { type: 'string', placeholder: 'D', usage: 'keep items deferred until before D' },
    'estimate-under': {
      type: 'string',
      placeholder: 'D',
      usage: 'keep items estimated under D, for example 30m',
    },
    priority: { type: 'string', placeholder: 'N', usage: 'keep items at or above this priority N' },
    where: {
      type: 'string',
      multiple: true,
      placeholder: 'KEY=VALUE',
      usage: 'require a field to equal a value, KEY=VALUE; may be repeated',
    },
    limit: { type: 'string', placeholder: 'N', usage: 'stop after N matching items' },
    sort: { type: 'string', usage: 'sort by position, created, updated, due, defer or title' },
  };
}

/**
 * filterFlagNames are the names a saved perspective already decides. Passing
 * one alongside --perspective is a usage error rather than a silent merge:
 * running a perspective is meant to be exactly equivalent to typing its
 * filter, and a half-overridden filter is neither.
 */
export const filterFlagNames: readonly string[] = [
  'available',
  'blocked',
  'deferred',
  'all',
  'deleted',
  'inbox',
  'flagged',
  'project',
  'under',
  'kind',
  'status',
  'tag',
  'untagged',
  'due-before',
  'defer-before',
  'estimate-under',
  'priority',
  'where',
];

/**
 * Selection is a listing request plus the one thing the shared layer has no
 * business knowing: whether the table shows the nesting.
 *
 * Go embedded `taskops.Selection`. TypeScript has no embedding, so the shared
 * part is a field and the one local flag sits beside it.
 */
export interface Selection {
  /** selection is the request the shared layer runs. */
  selection: RunSelection;
  /** tree asks the human table to indent each item under its parent. */
  tree: boolean;
}

/**
 * parseSelection reads the filter flags. It resolves --project and --under
 * against the store, which is why it needs one.
 */
export async function parseSelection(a: App, ctx: Context, st: Store): Promise<Selection> {
  const s: Selection = { selection: new RunSelection(), tree: ctx.bool('tree') };
  const f = new Filter();

  let chosen = 0;
  for (const name of ['available', 'blocked', 'deferred', 'all']) {
    if (ctx.bool(name)) {
      chosen++;
    }
  }
  if (chosen > 1) {
    throw usagef('--available, --blocked, --deferred and --all select different sets; pass only one');
  }

  const statuses = parseStatuses(ctx.strings('status'));

  if (ctx.bool('all')) {
    // Everything: `--all` is the escape hatch from every default.
  } else if (ctx.bool('blocked')) {
    f.availability = AvailabilityBlocked;
    f.statuses = openStatuses();
  } else if (ctx.bool('deferred')) {
    f.availability = AvailabilityDeferred;
    f.statuses = openStatuses();
  } else if (statuses.length > 0) {
    // An explicit status is an explicit question — "what did I drop?" —
    // and answering it with the availability default would return
    // nothing, since a dropped item is never available.
    f.statuses = statuses;
    if (ctx.bool('available')) {
      f.availability = AvailabilityAvailable;
    }
  } else {
    // The default of §4.1: what can be worked on now. The command layer
    // decides this, not the store.
    f.availability = AvailabilityAvailable;
    f.statuses = openStatuses();
  }
  if (statuses.length > 0) {
    f.statuses = statuses;
  }

  if (ctx.bool('deleted')) {
    // A tombstone is never available, so asking for both would always be
    // empty; --deleted therefore drops the availability default too.
    f.onlyDeleted = true;
    f.availability = AvailabilityAny;
    if (statuses.length === 0) {
      f.statuses = [];
    }
  }

  if (ctx.isSet('kind')) {
    const kind: Kind = ctx.string('kind').trim();
    if (!kindValid(kind)) {
      throw usagef(`--kind expects folder, project or task, got ${JSON.stringify(ctx.string('kind'))}`);
    }
    f.kinds = [kind];
  }
  if (ctx.bool('flagged')) {
    f.flagged = true;
  }
  if (ctx.bool('inbox')) {
    f.scope.inbox = true;
  }

  if (ctx.isSet('project') && ctx.isSet('under')) {
    throw usagef('--project and --under both choose a subtree; pass only one');
  }
  const projectRef = ctx.string('project').trim();
  if (projectRef !== '') {
    const p = await resolveContainer(a, st, projectRef, KindProject);
    f.scope.subtree = p.id;
  }
  const underRef = ctx.string('under').trim();
  if (underRef !== '') {
    const under = await resolveRef(a, st, underRef);
    f.scope.subtree = under.id;
  }

  f.tags = parseTags(ctx.strings('tag'));
  s.selection.untagged = ctx.bool('untagged');
  if (s.selection.untagged && f.tags.length > 0) {
    throw usagef('--untagged and --tag ask for opposite things');
  }

  if (ctx.isSet('due-before')) {
    f.dueBefore = parseBound(ctx.string('due-before'));
  }
  if (ctx.isSet('defer-before')) {
    f.deferBefore = parseBound(ctx.string('defer-before'));
  }
  if (ctx.isSet('estimate-under')) {
    const minutes = parseMinutes(ctx.string('estimate-under'));
    if (minutes <= 0) {
      throw usagef('--estimate-under expects a positive duration, for example 30m');
    }
    s.selection.maxMinutes = minutes;
  }

  const [order, byTitle] = parseOrder(ctx.string('sort'));
  f.order = order;
  s.selection.byTitle = byTitle;

  s.selection.cond = listCondition(ctx);

  const limit = intFlag(ctx, 'limit');
  if (limit < 0) {
    throw usagef('--limit must not be negative');
  }
  s.selection.limit = limit;

  const invalid = f.validate();
  if (invalid !== undefined) {
    throw exit.usagef(invalid) as Error;
  }
  s.selection.filter = f;
  return s;
}

/** parseStatuses reads the repeated --status flag. */
export function parseStatuses(values: readonly string[]): Status[] {
  const out: Status[] = [];
  const seen = new Set<Status>();
  for (const value of values) {
    for (const part of value.split(',')) {
      const s: Status = part.trim();
      if (s === '') {
        continue;
      }
      if (!statusValid(s)) {
        throw usagef(`--status expects active, on_hold, done or dropped, got ${JSON.stringify(part)}`);
      }
      if (seen.has(s)) {
        continue;
      }
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * parseBound reads a --due-before / --defer-before value. A date-only bound
 * means the whole of that day is still in range, so `--due-before 2026-11-01`
 * does not drop what is due on the first.
 */
export function parseBound(raw: string): Date {
  const trimmed = raw.trim();
  let at: Date;
  try {
    at = parseDue(trimmed);
  } catch (err) {
    throw exit.usagef(asError(err)) as Error;
  }
  if (trimmed.length === DueDateFormat.length) {
    return new Date(at.getTime() + 24 * 60 * 60 * 1000);
  }
  return at;
}

/**
 * parseOrder maps --sort onto a store order. Title is sorted here instead,
 * because a collation is not something every provider would agree on.
 */
export function parseOrder(value: string): [Order, boolean] {
  switch (value.trim()) {
    case '':
    case 'position':
      return [OrderPosition, false];
    case 'created':
      return [OrderCreated, false];
    case 'updated':
      return [OrderUpdated, false];
    case 'due':
      return [OrderDue, false];
    case 'defer':
      return [OrderDefer, false];
    case 'title':
      return [OrderPosition, true];
    default:
      throw usagef(
        `--sort expects position, created, updated, due, defer or title, got ${JSON.stringify(value)}`,
      );
  }
}

/**
 * parseMinutes reads a duration in the spelling the flags accept. The
 * spelling is the shared layer's, so --estimate and the API agree.
 */
export function parseMinutes(raw: string): number {
  try {
    return taskopsParseMinutes(raw);
  } catch (err) {
    throw exit.usagef(asError(err)) as Error;
  }
}

/**
 * listCondition builds the client-side filter over the user-defined fields.
 * These cannot go into store.Filter: a provider that would need a composite
 * index for them must still behave exactly like SQLite.
 */
export function listCondition(ctx: Context): Condition {
  const c = new Condition();
  if (ctx.isSet('priority')) {
    const p = intFlag(ctx, 'priority');
    if (p < 0 || p > 3) {
      throw usagef(`--priority must be between 0 and 3, got ${p}`);
    }
    c.minPriority = p;
  }
  for (const raw of ctx.strings('where')) {
    const eq = raw.indexOf('=');
    const key = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    if (eq < 0 || key === '') {
      throw usagef(`--where expects KEY=VALUE, got ${JSON.stringify(raw)}`);
    }
    c.match[key] = raw.slice(eq + 1);
  }
  return c;
}

/**
 * runSelection executes a selection through the shared layer, so that a
 * listing is the same answer whichever front end asked for it.
 */
export function runSelection(_a: App, st: Store, s: Selection): Promise<Task[]> {
  return run(st, s.selection);
}

/** listCommand is `tdo ls`. */
export function listCommand(a: App): Command {
  return {
    name: 'ls',
    usage: 'list items, by default the ones that can be worked on now',
    store: 'read',
    flags: {
      ...filterFlags(),
      perspective: { type: 'string', placeholder: 'NAME', usage: 'run the saved query NAME instead of these flags' },
      tree: { type: 'boolean', usage: 'show the nesting by indenting each item under its parent' },
    },
    async run(ctx: Context): Promise<void> {
      if (ctx.args.length > 0) {
        throw usagef('ls takes no arguments; did you mean a filter flag?');
      }
      const st: Store = ctx.store();

      const s = await selectionOrPerspective(a, ctx, st);
      const tasks = await runSelection(a, st, s);
      const av = await availabilityOf(a, st, tasks);

      if (a.out.json) {
        // Machine output never refreshes the short-number cache; see
        // saveListing.
        a.out.emit({ tasks: views(tasks, av), count: tasks.length });
        return;
      }
      // The numbers printed below are only usable because the ids are
      // cached here, in the same order.
      saveListing(a, st, tasks);
      if (tasks.length === 0) {
        // An empty list is not an error, and stdout stays empty.
        a.out.hintf('Nothing to do here. `tdo ls --all` shows everything, `tdo add <title>` adds one.');
        return;
      }
      printTable(a, tasks, av, s.tree);
    },
  };
}

/**
 * listAliasCommand is `tdo list`, the alias Go declared on the `ls` command.
 * The dispatcher resolves a command by its name alone, so the alias is a
 * hidden entry of its own rather than a second name on one entry; it shares
 * the body, so the two cannot drift apart.
 */
export function listAliasCommand(a: App): Command {
  return { ...listCommand(a), name: 'list', hidden: true };
}

/**
 * selectionOrPerspective reads either the filter flags or a saved query. A
 * perspective *is* a stored filter (§3.6), so running one is exactly
 * equivalent to typing it — which is why mixing the two is refused.
 */
export async function selectionOrPerspective(a: App, ctx: Context, st: Store): Promise<Selection> {
  const name = ctx.string('perspective').trim();
  if (name === '') {
    return parseSelection(a, ctx, st);
  }
  for (const flag of filterFlagNames) {
    if (ctx.isSet(flag)) {
      throw usagef(`--perspective ${name} already decides the filter; --${flag} would contradict it`);
    }
  }
  const p = await st.perspective(name);
  const f = p.filter;
  const invalid = f.validate();
  if (invalid !== undefined) {
    // A perspective saved by a newer binary, or edited by hand, is a
    // usage error at the point it is read rather than a listing that
    // quietly means something else.
    throw exit.usagef(
      new Error(`perspective ${JSON.stringify(name)}: ${invalid.message}`, { cause: invalid }),
    ) as Error;
  }
  const limit = intFlag(ctx, 'limit');
  if (limit < 0) {
    throw usagef('--limit must not be negative');
  }
  const s: Selection = {
    selection: new RunSelection({ filter: f, limit }),
    tree: ctx.bool('tree'),
  };
  const [order, byTitle] = parseOrder(ctx.string('sort'));
  if (ctx.isSet('sort')) {
    s.selection.filter.order = order;
    s.selection.byTitle = byTitle;
  }
  return s;
}

/** nextCommand is `tdo next`: the first action that can be worked on. */
export function nextCommand(a: App): Command {
  return {
    name: 'next',
    usage: 'print the first action that can be worked on',
    store: 'read',
    flags: {
      project: { type: 'string', placeholder: 'P', usage: 'look only inside project P' },
    },
    async run(ctx: Context): Promise<void> {
      if (ctx.args.length > 0) {
        throw usagef('next takes no arguments; pass --project to narrow it');
      }
      const st: Store = ctx.store();
      const f = new Filter({
        kinds: [KindTask],
        statuses: [StatusActive],
        availability: AvailabilityAvailable,
        order: OrderPosition,
        limit: 1,
      });
      const ref = ctx.string('project').trim();
      if (ref !== '') {
        const p = await resolveContainer(a, st, ref, KindProject);
        f.scope.subtree = p.id;
      }
      const tasks = await st.list(f);
      if (tasks.length === 0) {
        if (a.out.json) {
          // The same shape as a listing that found something, so a caller
          // reads `.tasks[0]` either way rather than having to tell null
          // from an object.
          a.out.emit({ tasks: [], count: 0 });
          return;
        }
        a.out.hintf('Nothing is available. `tdo ls --blocked` says what is in the way.');
        return;
      }
      await renderTask(a, st, tasks[0] as Task);
    },
  };
}

/** inboxCommand is `tdo inbox`, and `tdo inbox process <ref>`. */
export function inboxCommand(a: App): Command {
  return {
    name: 'inbox',
    usage: 'list the tasks that have not been filed anywhere',
    argsUsage: '[process <ref> --project P]',
    flags: {
      count: { type: 'boolean', usage: 'print only how many items are waiting' },
      project: { type: 'string', placeholder: 'P', usage: 'file the item into project P' },
      parent: { type: 'string', placeholder: 'REF', usage: 'file the item under REF' },
    },
    async run(ctx: Context): Promise<void> {
      const args = ctx.args;
      if (args.length > 0 && args[0] === 'process') {
        await a.withStore(async (st) => {
          a.noticeOverriddenStore(st);
          await inboxProcess(a, ctx, st, args.slice(1));
        });
        return;
      }
      if (args.length > 0) {
        throw usagef('inbox takes no arguments, or `inbox process <ref> --project P`');
      }
      await a.withStore(async (st) => {
        await inboxList(a, ctx, st);
      });
    },
  };
}

/**
 * inboxList is a pure read: the inbox is the absence of a container, so it
 * has nothing to create and nothing to refresh.
 */
export async function inboxList(a: App, ctx: Context, st: Store): Promise<void> {
  if (ctx.isSet('project') || ctx.isSet('parent')) {
    throw usagef('--project and --parent belong to `tdo inbox process <ref>`');
  }
  // Availability is not the question here: an inbox item is unfiled
  // whether or not it is deferred, and hiding it would hide the work.
  const tasks = await st.list(
    new Filter({
      scope: new Scope({ inbox: true }),
      statuses: openStatuses(),
      order: OrderPosition,
    }),
  );
  if (ctx.bool('count')) {
    if (a.out.json) {
      a.out.emit({ count: tasks.length });
      return;
    }
    a.out.printf(`${countLine(tasks.length, 'item in the inbox', 'items in the inbox')}\n`);
    return;
  }
  const av = await availabilityOf(a, st, tasks);
  if (a.out.json) {
    a.out.emit({ tasks: views(tasks, av), count: tasks.length });
    return;
  }
  saveListing(a, st, tasks);
  if (tasks.length === 0) {
    a.out.hintf('The inbox is empty.');
    return;
  }
  printTable(a, tasks, av, false);
}

/**
 * inboxProcess files one captured item, which is the one write `tdo inbox`
 * has. Filing is deliberately a separate command from capture: the cost of
 * deciding where something goes must not be charged at the moment of capture
 * (§4.1).
 */
export async function inboxProcess(
  a: App,
  ctx: Context,
  st: Store,
  args: readonly string[],
): Promise<void> {
  if (args.length !== 1) {
    throw usagef('inbox process expects exactly one item reference');
  }
  if (ctx.bool('count')) {
    throw usagef('--count belongs to `tdo inbox`, not to `tdo inbox process`');
  }
  const project = ctx.string('project').trim();
  const parent = ctx.string('parent').trim();
  if ((project === '') === (parent === '')) {
    throw usagef('inbox process expects exactly one of --project or --parent');
  }
  const t = await resolveRef(a, st, args[0] as string);

  const target =
    project !== ''
      ? await resolveContainer(a, st, project, KindProject)
      : await resolveRef(a, st, parent);
  try {
    await st.move(t.id, target.id, t.position, new Date());
  } catch (err) {
    throw treeError(err);
  }
  const moved = await st.get(t.id);
  await renderTask(a, st, moved);
}
