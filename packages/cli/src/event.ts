// `tdo event`: things that happen outside the list, and the items waiting for
// them.
//
// An event is not a task. A task is something you do and complete; an event
// is something you wait for, and it *occurs*. It has a table of its own and
// three states — pending, occurred, cancelled — so none of `done`, `hold`,
// `drop` or `defer` applies to it, and this command has verbs of its own.
//
// An item waits for events by being linked to them (`event link`, or
// `--wait-on` when it is created). While an event it waits for has not
// occurred the item is blocked — rule `event`, or `ancestor_event` for what is
// inside a waiting project — and the moment the event occurs it is available
// again. Nothing is pushed to the waiting items, because availability is
// computed whenever it is asked for: changing the event *is* the callback.
// What this command adds is saying so. `occur` reports which items that
// released and `reopen` which it held again, because "what did that change?"
// is the question the person (or agent) saying it will ask next.
//
// One shape for events, the way there is one for tasks:
//
//     {"events":[{…, "waiting":["<task id>", …]}], "count":n}
//
// where `waiting` is the open items that wait for the event. `show` adds
// `tasks`, those items in full, and `occur` / `cancel` / `reopen` add
// `released` and `held`, task objects like any other. `link` and `unlink`
// change tasks, so they answer with the tasks: {"tasks":[…],"count":n}.

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import type { Availability, Store } from '@todocloud/core/store';
import {
  EventCancelled,
  type EventItem,
  EventOccurred,
  EventPending,
  type EventStatus,
  newEvent,
} from '@todocloud/core/store/event';
import { KindProject, type Task } from '@todocloud/core/task';
import { availabilityOf as taskopsAvailabilityOf } from '@todocloud/core/taskops';

import { parseInstant } from './add.ts';
import { type App, asError, type Command, type Context, type Flags, usagef } from './app.ts';
import { eventJSON, printEvents, projectEvents, projectTitles, stillWaiting, waitingFor } from './eventview.ts';
import { resolveContainer, resolveEvent, resolveRefs } from './refs.ts';
import { printTable, renderTasks, views } from './view.ts';

/** The verbs, for the usage line and for the error that names them. */
const verbs = 'add, ls, show, edit, occur, cancel, reopen, rm, link, unlink';

/**
 * eventFlags are every flag any verb reads. The dispatcher declares flags per
 * command and not per verb, so a flag that belongs to one verb is refused on
 * the others (`rejectForeignFlags`) rather than ignored: exit 0 with nothing
 * changed is the worst of the available answers.
 */
function eventFlags(): Flags {
  return {
    project: {
      type: 'string',
      placeholder: 'P',
      usage: 'add, edit, ls: the project the event belongs to (edit: empty takes it out of its project)',
    },
    expected: {
      type: 'string',
      placeholder: 'D',
      usage: 'add, edit: when it is expected, YYYY-MM-DD or RFC 3339 (empty clears it)',
    },
    note: { type: 'string', placeholder: 'S', usage: 'add, edit: free-form note' },
    title: { type: 'string', placeholder: 'S', usage: 'edit: a new title' },
    for: {
      type: 'string',
      multiple: true,
      placeholder: 'REF',
      usage: 'add: items that wait for this event; may be repeated',
    },
    status: {
      type: 'string',
      multiple: true,
      placeholder: 'STATUS',
      usage: 'ls: keep one of pending, occurred or cancelled; may be repeated',
    },
    all: { type: 'boolean', usage: 'ls: every event, whatever its status' },
  };
}

/** The flags each verb applies; anything else that is set is refused. */
const verbFlags: Readonly<Record<string, ReadonlySet<string>>> = {
  add: new Set(['project', 'expected', 'note', 'for']),
  ls: new Set(['project', 'status', 'all']),
  show: new Set(),
  edit: new Set(['project', 'expected', 'note', 'title']),
  occur: new Set(),
  cancel: new Set(),
  reopen: new Set(),
  rm: new Set(),
  link: new Set(),
  unlink: new Set(),
};

function rejectForeignFlags(ctx: Context, verb: string): void {
  const applied = verbFlags[verb] ?? new Set<string>();
  for (const name of Object.keys(eventFlags()).sort()) {
    if (ctx.isSet(name) && !applied.has(name)) {
      throw usagef(`\`tdo event ${verb}\` does not apply --${name}`);
    }
  }
}

/** eventCommand is `tdo event`. */
export function eventCommand(a: App): Command {
  return {
    name: 'event',
    usage: 'things that happen outside the list, and the items waiting for them',
    argsUsage: '<verb> [arguments]',
    details: `Verbs:
  add <title...>           add an event that has not happened yet (--project P files it)
  ls                       list events; the pending ones unless --status or --all
                           (--project P: only that project's)
  show <event>             one event, and the items waiting for it
  edit <event>             change its title, note, expected date or project
  occur <event...>         it happened: releases what waited for it, and says what
  cancel <event...>        it will not happen: what waits for it stays blocked
  reopen <event...>        it has not happened after all: holds its items again
  rm <event...>            forget it; whatever waited for it is free
  link <event> <ref...>    make these items wait for the event
  unlink <event> <ref...>  stop them waiting

An event may belong to a project (--project P); \`tdo show <project>\` then lists
it, and \`edit --project ""\` unfiles it. An <event> is named by id prefix or by
title, in any case. An item (<ref>) is a
task or a project, named by short number or id prefix; --for and --wait-on set
the link when the event or the item is created. While an event an item waits
for has not occurred, the item is blocked and left out of \`tdo ls\`; once it
has, the item is available again. An event is not a task: done, hold and drop
do not apply to it. --json answers {"events":[…],"count":n}, and occur and
reopen add "released" and "held".

Example:
  tdo event add "Vendor reply" --expected 2026-11-05
  tdo add "Send the order" --wait-on "Vendor reply"
  tdo event occur "Vendor reply"`,
    flags: eventFlags(),
    // No store mode: each verb opens the store itself, because `ls` and
    // `show` only read and the override notice of a write must not appear on
    // a read (§4.2).
    async run(ctx: Context): Promise<void> {
      const [verb, ...rest] = ctx.args;
      if (verb === undefined) {
        throw usagef(`event expects one of: ${verbs}`);
      }
      const name = verb === 'list' ? 'ls' : verb === 'remove' ? 'rm' : verb;
      if (!(name in verbFlags)) {
        throw usagef(`unknown event verb ${JSON.stringify(verb)}; expected one of: ${verbs}`);
      }
      rejectForeignFlags(ctx, name);
      switch (name) {
        case 'add':
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await eventAdd(a, ctx, st, rest);
          });
          return;
        case 'ls':
          if (rest.length > 0) {
            throw usagef('event ls takes no arguments');
          }
          await a.withStore((st) => eventList(a, ctx, st));
          return;
        case 'show':
          if (rest.length !== 1) {
            throw usagef('event show expects exactly one event');
          }
          await a.withStore((st) => eventShow(a, st, rest[0] ?? ''));
          return;
        case 'edit':
          if (rest.length !== 1) {
            throw usagef('event edit expects exactly one event');
          }
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await eventEdit(a, ctx, st, rest[0] ?? '');
          });
          return;
        case 'occur':
        case 'cancel':
        case 'reopen':
          if (rest.length === 0) {
            throw usagef(`event ${name} expects one or more events`);
          }
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await eventMark(a, st, name, rest);
          });
          return;
        case 'rm':
          if (rest.length === 0) {
            throw usagef('event rm expects one or more events');
          }
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await eventRemove(a, st, rest);
          });
          return;
        default: {
          // link and unlink
          if (rest.length < 2) {
            throw usagef(`event ${name} expects an event and one or more items`);
          }
          const [ref, ...items] = rest;
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await eventLink(a, st, ref ?? '', items, name === 'link');
          });
        }
      }
    },
  };
}

function checked(e: EventItem): void {
  const invalid = e.validate();
  if (invalid !== undefined) {
    throw exit.usagef(invalid) as Error;
  }
}

async function eventAdd(a: App, ctx: Context, st: Store, args: readonly string[]): Promise<void> {
  const title = args.join(' ').trim();
  if (title === '') {
    throw usagef('expected an event title');
  }
  // Resolved before anything is written, so a reference that means nothing
  // leaves no event behind.
  const forRefs = ctx.strings('for');
  const waiters = forRefs.length === 0 ? [] : await resolveRefs(a, st, forRefs);

  const e = newEvent(id.New(), title, new Date());
  const projectRef = ctx.string('project').trim();
  if (projectRef !== '') {
    e.projectID = (await resolveContainer(a, st, projectRef, KindProject)).id;
  }
  if (ctx.isSet('note')) {
    e.note = ctx.string('note');
  }
  if (ctx.isSet('expected')) {
    e.expectedAt = parseInstant(ctx.string('expected'));
  }
  checked(e);
  try {
    await st.addEvent(e);
  } catch (err) {
    throw exit.usagef(asError(err)) as Error;
  }
  if (waiters.length > 0) {
    const links = await st.waits();
    for (const w of waiters) {
      const have = links.filter((l) => l.taskID === w.id).map((l) => l.eventID);
      await st.setWaits(w.id, [...have, e.id]);
    }
    if (!a.out.json) {
      a.out.hintf(`${waiters.length} item${waiters.length === 1 ? '' : 's'} now wait for it`);
    }
  }
  await renderEvents(a, st, [e]);
}

async function eventList(a: App, ctx: Context, st: Store): Promise<void> {
  if (ctx.bool('all') && ctx.isSet('status')) {
    throw usagef('--all already includes every status; --status narrows it');
  }
  let want: EventStatus[] = [EventPending];
  if (ctx.isSet('status')) {
    want = [];
    for (const raw of ctx.strings('status')) {
      for (const part of raw.split(',')) {
        const s = part.trim();
        if (s !== EventPending && s !== EventOccurred && s !== EventCancelled) {
          throw usagef(`status ${JSON.stringify(s)} is not one of pending, occurred or cancelled`);
        }
        want.push(s);
      }
    }
  }
  // --project means the project's events in the sense its own view uses:
  // filed there, or waited for by something inside it.
  let inProject: Set<string> | undefined;
  if (ctx.isSet('project')) {
    const project = await resolveContainer(a, st, ctx.string('project').trim(), KindProject);
    inProject = new Set((await projectEvents(st, project)).map((e) => e.id));
  }
  const events = (await st.events()).filter(
    (e) => (ctx.bool('all') || want.includes(e.status)) && (inProject === undefined || inProject.has(e.id)),
  );
  const waiting = await waitingFor(st);
  if (a.out.json) {
    a.out.emit({ events: events.map((e) => eventJSON(e, waiting)), count: events.length });
    return;
  }
  if (events.length === 0) {
    a.out.hintf('No events. `tdo event add <title>` creates one.');
    return;
  }
  printEvents(a, events, waiting, await projectTitles(st, events));
}

async function renderEvents(a: App, st: Store, events: readonly EventItem[]): Promise<void> {
  const waiting = await waitingFor(st);
  if (a.out.json) {
    a.out.emit({ events: events.map((e) => eventJSON(e, waiting)), count: events.length });
    return;
  }
  printEvents(a, events, waiting, await projectTitles(st, events));
}

async function eventShow(a: App, st: Store, ref: string): Promise<void> {
  const e = await resolveEvent(st, ref);
  const waiting = await waitingFor(st);
  const tasks = stillWaiting(e, waiting);
  const av = await taskopsAvailabilityOf(st, tasks, new Date());
  if (a.out.json) {
    a.out.emit({
      events: [eventJSON(e, waiting)],
      count: 1,
      tasks: views(tasks, av),
    });
    return;
  }
  printEvents(a, [e], waiting, await projectTitles(st, [e]));
  if (e.note !== '') {
    a.out.printf(`\n${e.note}\n`);
  }
  if (tasks.length === 0) {
    a.out.hintf('nothing is waiting for it');
    return;
  }
  a.out.printf('\nwaiting for it:\n');
  printTable(a, tasks, av, false);
}

async function eventEdit(a: App, ctx: Context, st: Store, ref: string): Promise<void> {
  if (!ctx.isSet('title') && !ctx.isSet('note') && !ctx.isSet('expected') && !ctx.isSet('project')) {
    throw usagef('event edit expects --title, --note, --expected or --project');
  }
  const e = (await resolveEvent(st, ref)).clone();
  if (ctx.isSet('title')) {
    e.title = ctx.string('title');
  }
  if (ctx.isSet('note')) {
    e.note = ctx.string('note');
  }
  if (ctx.isSet('expected')) {
    e.expectedAt = parseInstant(ctx.string('expected'));
  }
  if (ctx.isSet('project')) {
    const ref = ctx.string('project').trim();
    e.projectID = ref === '' ? '' : (await resolveContainer(a, st, ref, KindProject)).id;
  }
  e.updatedAt = new Date();
  checked(e);
  await st.updateEvent(e);
  await renderEvents(a, st, [e]);
}

const targetOf: Readonly<Record<'occur' | 'cancel' | 'reopen', EventStatus>> = {
  occur: EventOccurred,
  cancel: EventCancelled,
  reopen: EventPending,
};

/**
 * eventMark is `occur`, `cancel` and `reopen`. It is the one that matters:
 * it reports which of the items waiting for the events were released (or held
 * again), because that is the answer to "what did that change".
 */
async function eventMark(
  a: App,
  st: Store,
  verb: 'occur' | 'cancel' | 'reopen',
  refs: readonly string[],
): Promise<void> {
  const events: EventItem[] = [];
  for (const ref of refs) {
    events.push(await resolveEvent(st, ref));
  }
  const waiting = await waitingFor(st);
  const waiters = new Map<string, Task>();
  for (const e of events) {
    for (const t of waiting.get(e.id) ?? []) {
      waiters.set(t.id, t);
    }
  }
  const list = [...waiters.values()];
  const before = await taskopsAvailabilityOf(st, list, new Date());

  const now = new Date();
  const updated: EventItem[] = [];
  for (const e of events) {
    const next = e.clone();
    next.setStatus(targetOf[verb], now);
    await st.updateEvent(next);
    updated.push(next);
  }

  const after = await taskopsAvailabilityOf(st, list, new Date());
  const ok = (m: Map<string, Availability>, t: Task): boolean => m.get(t.id)?.available === true;
  const released = verb === 'occur' ? list.filter((t) => !ok(before, t) && ok(after, t)) : [];
  const held = verb === 'reopen' ? list.filter((t) => ok(before, t) && !ok(after, t)) : [];

  if (!a.out.json) {
    for (const t of released) {
      a.out.hintf(`now available: ${t.title}`);
    }
    for (const t of held) {
      a.out.hintf(`held again: ${t.title}`);
    }
  }
  const waitingNow = await waitingFor(st);
  if (a.out.json) {
    const av = await taskopsAvailabilityOf(st, [...released, ...held], new Date());
    a.out.emit({
      events: updated.map((e) => eventJSON(e, waitingNow)),
      count: updated.length,
      released: views(released, av),
      held: views(held, av),
    });
    return;
  }
  printEvents(a, updated, waitingNow, await projectTitles(st, updated));
}

async function eventRemove(a: App, st: Store, refs: readonly string[]): Promise<void> {
  const events: EventItem[] = [];
  for (const ref of refs) {
    events.push(await resolveEvent(st, ref));
  }
  const waiting = await waitingFor(st);
  const removed: Record<string, unknown>[] = [];
  let freed = 0;
  for (const e of events) {
    const row = eventJSON(e, waiting);
    freed += await st.removeEvent(e.id);
    removed.push(row);
  }
  if (a.out.json) {
    a.out.emit({ events: removed, count: removed.length, unlinked: freed });
    return;
  }
  a.out.hintf(`removed ${removed.length} event(s); ${freed} item(s) no longer wait for them`);
}

/** eventLink is `link` and `unlink`: whether the items wait for the event. */
async function eventLink(
  a: App,
  st: Store,
  ref: string,
  itemRefs: readonly string[],
  link: boolean,
): Promise<void> {
  const event = await resolveEvent(st, ref);
  const items = await resolveRefs(a, st, itemRefs);
  const links = await st.waits();
  for (const item of items) {
    if (item.kind === 'folder') {
      throw usagef(`${item.id} is a folder; a folder organises, so there is nothing for it to wait for`);
    }
  }
  for (const item of items) {
    const have = links.filter((l) => l.taskID === item.id).map((l) => l.eventID);
    const next = link
      ? have.includes(event.id)
        ? have
        : [...have, event.id]
      : have.filter((e) => e !== event.id);
    try {
      await st.setWaits(item.id, next);
    } catch (err) {
      throw exit.usagef(asError(err)) as Error;
    }
  }
  await renderTasks(a, st, items.map((t) => t), undefined);
}
