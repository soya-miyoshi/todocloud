// Repetition and review: `tdo repeat`, `tdo series`, `tdo review` and
// `tdo perspective`.

import * as exit from '@todocloud/core/exit';
import * as recur from '@todocloud/core/recur';
import { KindFolder, KindProject, formatTime, parseTime } from '@todocloud/core/task';
import {
  OrderCreated,
  OrderPosition,
  type Perspective,
  type Store,
} from '@todocloud/core/store';
import { Filter, filterFromJSON, reviewDueAsOf } from '@todocloud/core/store/filter';
import { openStatuses } from '@todocloud/core/taskops/select';

import { parseArgs } from 'node:util';

import { type App, type Command, Context, type Flags, asError, usagef } from './app.ts';
import { parseRepeat } from './add.ts';
import { filterFlags, parseSelection } from './list.ts';
import { resolveContainer, resolveRef, saveListing } from './refs.ts';
import { availabilityOf, printTable, renderTask, treeError, views } from './view.ts';
import { parseReviewInterval } from './structure.ts';

export function repeatCommand(a: App): Command {
  return {
    name: 'repeat',
    usage: 'make an item repeat, or end its series',
    argsUsage: '<ref> <every>[:method] | <ref> --stop',
    store: 'write',
    flags: {
      stop: { type: 'boolean', usage: 'end the series, leaving its history in place' },
    },
    async run(ctx: Context): Promise<void> {
      const st = ctx.store();
      const args = ctx.args;
      const stop = ctx.bool('stop');
      if (stop && args.length !== 1) {
        throw usagef('repeat --stop expects exactly one item reference');
      }
      if (!stop && args.length !== 2) {
        throw usagef(
          'repeat expects an item reference and an interval, for example `tdo repeat 3 1w`',
        );
      }

      const found = await resolveRef(a, st, args[0] ?? '');
      const t = found.clone();
      if (stop) {
        // The series id stays: the instances already completed are still one
        // series, and `tdo series` must keep finding them.
        t.repeat = undefined;
      } else {
        t.repeat = parseRepeat(args[1] ?? '');
        recur.ensureSeries(t);
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
    },
  };
}

export function seriesCommand(a: App): Command {
  return {
    name: 'series',
    usage: 'list every instance of one repeating item',
    argsUsage: '<ref>',
    store: 'read',
    async run(ctx: Context): Promise<void> {
      const st = ctx.store();
      if (ctx.args.length !== 1) {
        throw usagef('series expects exactly one item reference');
      }
      const found = await resolveRef(a, st, ctx.args[0] ?? '');
      // An item that has never repeated is a series of one, which is a
      // truthful answer rather than an error.
      const seriesID = found.seriesID === '' ? found.id : found.seriesID;

      // Filter has no series key, so the instances are picked out here. They
      // are every status, including deleted: the point of looking at a series
      // is to see its history.
      const all = await st.list(new Filter({ includeDeleted: true, order: OrderCreated }));
      const instances = all.filter(
        (t) => t.seriesID === seriesID || (t.id === seriesID && t.seriesID === ''),
      );

      const av = await availabilityOf(a, st, instances);
      if (a.out.json) {
        a.out.emit({
          series_id: seriesID,
          tasks: views(instances, av),
          count: instances.length,
        });
        return;
      }
      saveListing(a, st, instances);
      printTable(a, instances, av, false);
    },
  };
}

export function reviewCommand(a: App): Command {
  return {
    name: 'review',
    usage: 'list the folders and projects due for review, or mark one reviewed',
    argsUsage: '[<ref>]',
    flags: {
      interval: {
        type: 'string',
        placeholder: 'EVERY',
        usage: 'also set the review interval to EVERY',
      },
    },
    // No store mode: a bare `tdo review` is a pure read (§4.2) and must not
    // print the override notice a write does.
    async run(ctx: Context): Promise<void> {
      const args = ctx.args;
      if (args.length > 1) {
        throw usagef('review expects at most one item reference');
      }
      if (args.length === 0) {
        if (ctx.isSet('interval')) {
          throw usagef('--interval needs the item to mark reviewed');
        }
        // With no reference this is a pure read (§4.2): it lists what is due
        // and marks nothing.
        await a.withStore((st) => reviewList(a, st));
        return;
      }
      await a.withStore(async (st) => {
        a.noticeOverriddenStore(st);
        await reviewMark(a, ctx, st, args[0] ?? '');
      });
    },
  };
}

async function reviewList(a: App, st: Store): Promise<void> {
  // reviewDueAsOf owns the window — the exclusive bound and the instant
  // next_review_at is derived at — so that `tdo project ls --needs-review`
  // answers the same question this does.
  const tasks = await st.list(
    new Filter({
      kinds: [KindFolder, KindProject],
      statuses: openStatuses(),
      order: OrderPosition,
      ...reviewDueAsOf(new Date()),
    }),
  );
  const av = await availabilityOf(a, st, tasks);
  if (a.out.json) {
    a.out.emit({ tasks: views(tasks, av), count: tasks.length });
    return;
  }
  saveListing(a, st, tasks);
  if (tasks.length === 0) {
    a.out.hintf('Nothing is due for review.');
    return;
  }
  printTable(a, tasks, av, false);
}

async function reviewMark(a: App, ctx: Context, st: Store, ref: string): Promise<void> {
  // Review is about folders and projects, so a reference here may be a title
  // as well as a number or an id prefix.
  const found = await resolveContainer(a, st, ref, KindFolder, KindProject);
  const t = found.clone();
  if (ctx.isSet('interval')) {
    t.reviewInterval = parseReviewInterval(ctx.string('interval'));
  }
  recur.markReviewed(t, new Date());
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
 * perspectiveCommand saves, lists, shows and removes saved queries. A
 * perspective is a stored Filter and nothing else (§3.6): it holds no results
 * and pins no ids, so it cannot go stale.
 */
export function perspectiveCommand(a: App): Command {
  return {
    name: 'perspective',
    usage: 'save, list, show or remove a saved query',
    argsUsage: 'save <name> -- <ls flags...> | ls | show <name> | rm <name>',
    async run(ctx: Context): Promise<void> {
      const args = ctx.args;
      if (args.length === 0) {
        throw usagef('perspective expects `save`, `ls`, `show` or `rm`');
      }
      switch (args[0]) {
        case 'save':
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await perspectiveSave(a, st, args.slice(1));
          });
          return;
        case 'ls':
        case 'list':
          if (args.length > 1) {
            throw usagef('perspective ls takes no arguments');
          }
          await a.withStore((st) => perspectiveList(a, st));
          return;
        case 'show':
          if (args.length !== 2) {
            throw usagef('perspective show expects exactly one name');
          }
          await a.withStore((st) => perspectiveShow(a, st, args[1] ?? ''));
          return;
        case 'rm':
        case 'remove':
          if (args.length !== 2) {
            throw usagef('perspective rm expects exactly one name');
          }
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await perspectiveRemove(a, st, args[1] ?? '');
          });
          return;
        default:
          throw usagef(
            `perspective expects \`save\`, \`ls\`, \`show\` or \`rm\`, got ${JSON.stringify(args[0])}`,
          );
      }
    },
  };
}

/**
 * perspectiveFlags is the `ls` flag set, which `perspective save` parses a
 * second time over the arguments after the name.
 *
 * Go built a second `ucli.Command` out of `filterFlags()` and ran it over
 * those arguments, so that a saved query can express exactly what a command
 * line can and nothing else. The dispatcher here takes no nested parser, so
 * the same thing is done directly: `node:util`'s parseArgs over the very
 * descriptors `tdo ls` declares, and a Context built from the result, which
 * is what `parseSelection` reads. Declaring the flags on this command instead
 * would have been the shorter route and the wrong one — `tdo perspective ls`
 * would then accept `--flagged` and ignore it.
 */
function perspectiveFlags(): Flags {
  return filterFlags();
}

/**
 * perspectiveSave parses the remaining arguments with the very flag set
 * `tdo ls` uses, so that a saved query can express exactly what a command
 * line can and nothing else.
 */
async function perspectiveSave(a: App, st: Store, args: readonly string[]): Promise<void> {
  if (args.length === 0) {
    throw usagef('perspective save expects a name and the `ls` flags to save');
  }
  const name = (args[0] ?? '').trim();
  if (name === '') {
    throw usagef('a perspective needs a name');
  }
  const flags = perspectiveFlags();
  const options: Record<string, { type: 'boolean' | 'string'; multiple?: boolean }> = {};
  for (const [name, f] of Object.entries(flags)) {
    options[name] = f.multiple === true ? { type: f.type, multiple: true } : { type: f.type };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: joinOptionValues(args.slice(1), flags),
      options,
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    // A bad flag here is a mistake at the command line, exactly as it is for
    // `tdo ls` itself.
    throw usagef(`perspective save: ${asError(err).message.split('\n')[0] ?? ''}`);
  }
  if (parsed.positionals.length > 0) {
    throw usagef(
      `perspective save takes flags after the name, not arguments: ${JSON.stringify(parsed.positionals[0] ?? '')}`,
    );
  }
  const saved = await parseSelection(
    a,
    new Context(a, 'perspective save', [], parsed.values as never, st),
    st,
  ).then((s) => s.selection);
  if (
    !saved.cond.empty() ||
    saved.untagged ||
    saved.maxMinutes > 0 ||
    saved.byTitle
  ) {
    // These are evaluated on the client, outside the stored Filter, so saving
    // them would produce a perspective that does not mean what it says when
    // it is run.
    throw usagef(
      '--where, --priority, --untagged, --estimate-under and --sort title cannot be saved in a perspective yet',
    );
  }

  const f = saved.filter;
  f.limit = saved.limit;
  const now = new Date();
  const p: Perspective = { name, filter: f, createdAt: now, updatedAt: now };
  await st.savePerspective(p);
  renderPerspective(a, p);
}

async function perspectiveList(a: App, st: Store): Promise<void> {
  const ps = await st.perspectives();
  if (a.out.json) {
    a.out.emit({ perspectives: ps.map(perspectiveJSON), count: ps.length });
    return;
  }
  if (ps.length === 0) {
    a.out.hintf(
      'No perspectives yet. `tdo perspective save <name> -- --flagged` saves one.',
    );
    return;
  }
  for (const p of ps) {
    a.out.printf(`${p.name}\n`);
  }
}

async function perspectiveShow(a: App, st: Store, name: string): Promise<void> {
  renderPerspective(a, await st.perspective(name.trim()));
}

async function perspectiveRemove(a: App, st: Store, name: string): Promise<void> {
  const trimmed = name.trim();
  await st.deletePerspective(trimmed);
  if (a.out.json) {
    a.out.emit({ removed: trimmed });
    return;
  }
  a.out.printf(`removed ${trimmed}\n`);
}

/**
 * perspectiveJSON writes the keys Go's struct tags wrote. The ported type is
 * a plain interface with camelCase fields and Date values, and the wire shape
 * is a documented contract (docs/agents.md), so the two are spelled out here
 * rather than left to `JSON.stringify`. `@todocloud/core/webapi` has the same function
 * for the same reason; this is the command layer's, since a module in
 * `web/` is another agent's to change.
 */
export function perspectiveJSON(p: Perspective): Record<string, unknown> {
  return {
    name: p.name,
    filter: p.filter.toJSON(),
    created_at: formatTime(p.createdAt),
    updated_at: formatTime(p.updatedAt),
  };
}

/**
 * perspectiveFromJSON reads back what perspectiveJSON wrote, for the
 * perspectives `tdo import` finds in an export file. A hand-written file need
 * not carry timestamps, so a missing one is the zero time and the caller
 * fills it in.
 */
export function perspectiveFromJSON(value: unknown): Perspective | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const name = typeof obj['name'] === 'string' ? obj['name'] : '';
  const time = (key: string): Date => {
    const raw = obj[key];
    if (typeof raw !== 'string' || raw === '') {
      return new Date(NaN);
    }
    try {
      return parseTime(raw);
    } catch {
      return new Date(NaN);
    }
  };
  return {
    name,
    filter: filterFromJSON(obj['filter'] ?? {}),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  };
}

function renderPerspective(a: App, p: Perspective): void {
  if (a.out.json) {
    a.out.emit({ perspective: perspectiveJSON(p) });
    return;
  }
  a.out.printf(`${p.name}\n`);
}

/**
 * joinOptionValues rewrites `--flag value` as `--flag=value` for every string
 * flag, stopping at `--`.
 *
 * It is the dispatcher's own helper, repeated here because `perspective save`
 * is the one place that runs parseArgs outside it: parseArgs refuses a value
 * that looks like a flag, so `--priority -1` would be reported as ambiguous
 * rather than read as minus one. The dispatcher keeps its copy private, and
 * the two must agree — a perspective has to mean what the same `tdo ls`
 * command line means.
 */
function joinOptionValues(args: readonly string[], flags: Flags): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      out.push(...args.slice(i));
      return out;
    }
    if (arg.length > 1 && arg.startsWith('-') && !arg.includes('=')) {
      const bare = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
      if (flags[bare]?.type === 'string' && i + 1 < args.length) {
        out.push(`${arg}=${args[i + 1] ?? ''}`);
        i++;
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}
