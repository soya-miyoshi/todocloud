// `tdo project` and `tdo folder`: the two containers of §3.1.
//
// Both take a verb as their first argument rather than a dispatcher
// subcommand, because `tdo project <ref>` has to be told apart from
// `tdo project ls` at the same position. Dispatching here keeps that one
// decision in one place, and keeps every mistake at the command line an
// ordinary usage error.

import * as exit from '@todocloud/core/exit';
import * as id from '@todocloud/core/id';
import * as recur from '@todocloud/core/recur';
import { OrderPosition, type Store } from '@todocloud/core/store';
import { Filter, type FilterInit, reviewDueAsOf } from '@todocloud/core/store/filter';
import {
  type Kind,
  KindFolder,
  KindProject,
  type ReviewInterval,
  type Task,
} from '@todocloud/core/task';
import { openStatuses } from '@todocloud/core/taskops/select';

import { type App, type Command, type Context, type Flags, asError, usagef } from './app.ts';
import { newItem, setFlags } from './add.ts';
import { parseStatuses } from './list.ts';
import { resolveContainer, saveListing } from './refs.ts';
import { availabilityOf, printTable, renderTask, treeError, views } from './view.ts';

/** The flags both container commands share with the creating commands. */
const sharedContainerFlags: Flags = {
  review: { type: 'string', placeholder: 'EVERY', usage: 'review it every EVERY, for example 1w' },
  note: { type: 'string', usage: 'free-form note' },
  notes: { type: 'string', hidden: true, usage: 'the older spelling of --note' },
  flag: { type: 'boolean', usage: 'flag it' },
  tag: {
    type: 'string',
    multiple: true,
    placeholder: 'TAGS',
    usage: 'comma-separated TAGS; may be repeated',
  },
  status: {
    type: 'string',
    multiple: true,
    placeholder: 'STATUS',
    usage: 'keep one STATUS; may be repeated',
  },
};

export function projectCommand(a: App): Command {
  return {
    name: 'project',
    usage: 'add, list or reshape a project',
    argsUsage: 'add <title...> | ls | <ref>',
    flags: {
      folder: { type: 'string', placeholder: 'F', usage: 'put the project in folder F' },
      sequential: { type: 'boolean', usage: 'its children must be done in order' },
      parallel: { type: 'boolean', usage: 'its children may be done in any order' },
      'complete-with-last': {
        type: 'boolean',
        usage: 'complete the project when its last child is done',
      },
      'needs-review': { type: 'boolean', usage: 'list only the projects due for review' },
      defer: { type: 'string', placeholder: 'D', usage: 'not available before D' },
      due: { type: 'string', placeholder: 'YYYY-MM-DD', usage: 'due date, YYYY-MM-DD or RFC 3339' },
      estimate: {
        type: 'string',
        placeholder: '25m',
        usage: 'how long it will take, for example 25m',
      },
      ...sharedContainerFlags,
      ...setFlags(),
    },
    // No store mode: each verb opens the store itself, because `add` and a
    // reshape write while `ls` and a bare `<ref>` only read, and the override
    // notice of a write must not appear on a read (§4.2).
    async run(ctx: Context): Promise<void> {
      const args = ctx.args;
      if (args.length === 0) {
        throw usagef('project expects `add <title...>`, `ls` or an item reference');
      }
      switch (args[0]) {
        case 'add':
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await containerAdd(a, ctx, st, KindProject, args.slice(1));
          });
          return;
        case 'ls':
        case 'list':
          if (args.length > 1) {
            throw usagef('project ls takes no arguments');
          }
          await a.withStore((st) =>
            containerList(a, ctx, st, KindProject, ctx.bool('needs-review')),
          );
          return;
        default:
          if (args.length > 1) {
            throw usagef('project expects exactly one item reference');
          }
          await a.withStore((st) => projectReshape(a, ctx, st, args[0] ?? ''));
          return;
      }
    },
  };
}

export function folderCommand(a: App): Command {
  return {
    name: 'folder',
    usage: 'add or list folders',
    argsUsage: 'add <title...> | ls',
    flags: {
      folder: { type: 'string', placeholder: 'F', usage: 'put the folder inside folder F' },
      ...sharedContainerFlags,
      ...setFlags(),
    },
    async run(ctx: Context): Promise<void> {
      const args = ctx.args;
      if (args.length === 0) {
        throw usagef('folder expects `add <title...>` or `ls`');
      }
      switch (args[0]) {
        case 'add':
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await containerAdd(a, ctx, st, KindFolder, args.slice(1));
          });
          return;
        case 'ls':
        case 'list':
          if (args.length > 1) {
            throw usagef('folder ls takes no arguments');
          }
          await a.withStore((st) => containerList(a, ctx, st, KindFolder, false));
          return;
        default:
          throw usagef('folder expects `add <title...>` or `ls`');
      }
    },
  };
}

/**
 * containerAdd creates a folder or a project. Both may only sit at the top
 * level or inside a folder, so they share one parent flag and the store's
 * containment check does the rest.
 */
async function containerAdd(
  a: App,
  ctx: Context,
  st: Store,
  kind: Kind,
  args: readonly string[],
): Promise<void> {
  const title = args.join(' ').trim();
  if (title === '') {
    throw usagef(`expected a ${kind} title`);
  }

  let parent: Task | undefined;
  const ref = ctx.string('folder').trim();
  if (ref !== '') {
    parent = await resolveContainer(a, st, ref, KindFolder);
  }

  const t = newItem(ctx, kind, title, parent);
  if (ctx.bool('sequential') && ctx.bool('parallel')) {
    throw usagef('--sequential and --parallel ask for opposite things');
  }
  t.sequential = ctx.bool('sequential');
  t.completedByChildren = ctx.bool('complete-with-last');
  if (ctx.isSet('review')) {
    t.reviewInterval = parseReviewInterval(ctx.string('review'));
  }
  const invalid = t.validate();
  if (invalid !== undefined) {
    throw exit.usagef(invalid) as Error;
  }
  try {
    await st.add(t);
  } catch (err) {
    throw treeError(err);
  }
  await renderTask(a, st, t);
}

/**
 * parseReviewInterval reads --review / --interval. The spelling is the one
 * `recur` parses, and it is checked here so that an unreadable interval is a
 * usage error rather than a project that silently never comes up for review.
 */
export function parseReviewInterval(raw: string): ReviewInterval {
  const every = raw.trim();
  if (every === '') {
    throw usagef('a review interval must say how often, for example 1w');
  }
  try {
    recur.parseEvery(every);
  } catch (err) {
    throw exit.usagef(asError(err)) as Error;
  }
  return { every };
}

/**
 * containerList lists folders or projects. Availability is not a filter here:
 * the question "what projects are there" includes the ones on hold, which is
 * exactly what a weekly review is for.
 */
async function containerList(
  a: App,
  ctx: Context,
  st: Store,
  kind: Kind,
  needsReview: boolean,
): Promise<void> {
  let statuses = parseStatuses(ctx.strings('status'));
  if (statuses.length === 0) {
    statuses = openStatuses();
  }
  const init: FilterInit = {
    kinds: [kind],
    statuses,
    order: OrderPosition,
  };
  if (needsReview) {
    // The same review window `tdo review` uses, from the same helper, so the
    // two cannot disagree about what "due for review" means.
    Object.assign(init, reviewDueAsOf(new Date()));
  }
  const tasks = await st.list(new Filter(init));
  const av = await availabilityOf(a, st, tasks);
  if (a.out.json) {
    a.out.emit({ tasks: views(tasks, av), count: tasks.length });
    return;
  }
  saveListing(a, st, tasks);
  if (tasks.length === 0) {
    a.out.hintf(`No ${kind}s yet. \`tdo ${kind} add <title>\` creates one.`);
    return;
  }
  printTable(a, tasks, av, false);
}

/**
 * reshapeFlags are the flags `tdo project <ref>` applies. Everything else the
 * command declares belongs to `project add` or `project ls`, and a flag that
 * is set but not applied is a usage error rather than a silent no-op: exit 0
 * with nothing changed is the worst of the three possible answers.
 */
const reshapeFlags: ReadonlySet<string> = new Set([
  'sequential',
  'parallel',
  'complete-with-last',
  'review',
  'folder',
]);

/**
 * elsewhere says where a flag `tdo project <ref>` does not apply does work,
 * so the error is a redirection and not just a refusal.
 */
const elsewhere: Readonly<Record<string, string>> = {
  'needs-review': '`tdo project ls --needs-review`',
  status: '`tdo project ls --status` and `tdo edit <ref> --status`',
  note: '`tdo project add --note` and `tdo edit <ref> --note`',
  notes: '`tdo project add --note` and `tdo edit <ref> --note`',
  tag: '`tdo project add --tag` and `tdo edit <ref> --tag`',
  defer: '`tdo project add --defer` and `tdo defer <ref> <date>`',
  due: '`tdo project add --due` and `tdo due <ref> <date>`',
  flag: '`tdo project add --flag` and `tdo flag <ref>`',
  estimate: '`tdo project add --estimate` and `tdo edit <ref> --estimate`',
  priority: '`tdo project add --priority` and `tdo edit <ref> --priority`',
  set: '`tdo project add --set` and `tdo edit <ref> --set`',
};

/**
 * rejectUnappliedFlags refuses a command line that asks for something this
 * code path does not do. It exists because every flag the command declares is
 * visible in `--help` at every position, and a user who reads it there has no
 * way to know which ones this verb reads.
 *
 * The flags are named rather than read off the context, because a context
 * also carries the global ones — `--json` is set far more often than any of
 * these and applies everywhere. A flag added to `tdo project` and listed in
 * neither table fails the test that walks the command's own flag set, instead
 * of being quietly ignored here.
 */
export function rejectUnappliedFlags(ctx: Context, applied: ReadonlySet<string>): void {
  for (const name of Object.keys(elsewhere).sort()) {
    if (applied.has(name) || !ctx.isSet(name)) {
      continue;
    }
    throw usagef(
      `\`tdo project <ref>\` does not apply --${name}; it is set by ${elsewhere[name] ?? ''}`,
    );
  }
}

/**
 * projectReshape is `tdo project <ref>`: with no flags it shows the project,
 * and with them it changes how its children behave and which folder it is in.
 *
 * The reference must name a project. It used to accept a folder as well,
 * which meant `tdo project 1 --sequential` run after `tdo folder ls` made a
 * *folder* sequential and said nothing about it — the numbers are the last
 * listing's, so the same `1` means different things at different moments
 * (§3.7). A reference that resolves to the wrong kind is now an error, and a
 * change that goes through says what it resolved to.
 */
async function projectReshape(a: App, ctx: Context, st: Store, ref: string): Promise<void> {
  let found = await resolveContainer(a, st, ref, KindProject);
  rejectUnappliedFlags(ctx, reshapeFlags);
  const changed =
    ctx.isSet('sequential') ||
    ctx.isSet('parallel') ||
    ctx.isSet('complete-with-last') ||
    ctx.isSet('review') ||
    ctx.isSet('folder');
  if (!changed) {
    await renderTask(a, st, found);
    return;
  }
  if (ctx.bool('sequential') && ctx.bool('parallel')) {
    throw usagef('--sequential and --parallel ask for opposite things');
  }

  // Both references are resolved before anything is written, so a reshape
  // that cannot be carried out changes nothing and says nothing.
  let folder: Task | undefined;
  if (ctx.isSet('folder')) {
    folder = await resolveFolder(a, ctx, st, found);
  }

  a.noticeOverriddenStore(st);
  // A number is read off whichever listing came last, so a reshape says which
  // item it landed on before it changes anything.
  a.out.hintf(`${ref} → ${resolvedName(found)}`);
  if (ctx.isSet('folder')) {
    await moveToFolder(st, found, folder);
    found = await st.get(found.id);
  }
  const t = found.clone();
  if (ctx.isSet('sequential')) {
    t.sequential = ctx.bool('sequential');
  } else if (ctx.isSet('parallel')) {
    t.sequential = !ctx.bool('parallel');
  }
  if (ctx.isSet('complete-with-last')) {
    t.completedByChildren = ctx.bool('complete-with-last');
  }
  if (ctx.isSet('review')) {
    t.reviewInterval = parseReviewInterval(ctx.string('review'));
  }
  t.updatedAt = new Date();
  const invalid = t.validate();
  if (invalid !== undefined) {
    throw exit.usagef(invalid) as Error;
  }
  try {
    await st.update(t);
  } catch (err) {
    throw treeError(err);
  }
  await renderTask(a, st, t);
}

/**
 * resolveFolder reads --folder: the folder a project is being filed into, or
 * undefined for an empty value, which is the top level.
 */
async function resolveFolder(
  a: App,
  ctx: Context,
  st: Store,
  t: Task,
): Promise<Task | undefined> {
  const ref = ctx.string('folder').trim();
  if (ref === '') {
    return undefined;
  }
  const folder = await resolveContainer(a, st, ref, KindFolder);
  if (folder.id === t.id) {
    throw usagef('a project cannot be put inside itself');
  }
  return folder;
}

/**
 * moveToFolder is `tdo project <ref> --folder F`: filing an existing project
 * into a folder, or out to the top level with an empty --folder. It was
 * accepted and silently ignored before, which is why it is a move and not an
 * error: the flag is on the command, so it has to mean something.
 */
async function moveToFolder(st: Store, t: Task, folder: Task | undefined): Promise<void> {
  const parentID = folder === undefined ? '' : folder.id;
  if (parentID === t.parentID) {
    return;
  }
  try {
    await st.move(t.id, parentID, t.position, new Date());
  } catch (err) {
    throw treeError(err);
  }
}

/**
 * resolvedName renders what a reference turned out to mean, for the line a
 * reshape prints before it writes: the kind, the title and a short id, which
 * is enough to tell two similarly numbered items apart.
 */
export function resolvedName(t: Task): string {
  const short = t.id.length > 8 ? t.id.slice(0, 8) : t.id;
  return `${t.kind} ${JSON.stringify(t.title)} (${short})`;
}
