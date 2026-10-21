// The mark family: the commands that only move an item between statuses, set
// the flag, write a date or change where it sits in the tree.
//
// Go attached all of this to the `*app` receiver; see the note in app.ts for
// why the port passes the app as the first parameter instead.

import * as id from '@todocloud/core/id';
import { KindFolder, KindProject, KindTask, type Status, StatusActive, StatusDropped, StatusOnHold } from '@todocloud/core/task';
import type { Store } from '@todocloud/core/store';
import {
  After,
  Before,
  type DateField,
  DeferDate,
  DueDate,
  type Placement,
  complete,
  moveTo,
  reorder as taskopsReorder,
  setDate,
  setFlagged,
  setStatus,
} from '@todocloud/core/taskops';

import { parseInstant } from './add.ts';
import { type App, type Command, type CommandFactory, type Context, usagef } from './app.ts';
import { resolveContainer, resolveRef, resolveRefs } from './refs.ts';
import { availabilityOf, renderTasks, report, treeError, views } from './view.ts';

/** doneCommand is `tdo done`: completion, and the successor of a repeat. */
export function doneCommand(a: App): Command {
  return {
    name: 'done',
    usage: 'complete items, creating the successor of a repeating one',
    argsUsage: '<ref...>',
    store: 'write',
    flags: {
      'no-repeat': { type: 'boolean', usage: 'complete without creating the next instance' },
    },
    async run(ctx: Context): Promise<void> {
      const st: Store = ctx.store();
      const tasks = await resolveRefs(a, st, ctx.args);
      const noRepeat = ctx.bool('no-repeat');

      let res;
      try {
        res = await complete(st, tasks, new Date(), noRepeat, id.New);
      } catch (err) {
        throw treeError(err);
      }
      const successors = res.successors;

      if (!a.out.json && successors.length > 0) {
        // "says so" of §4.1: a successor appearing is the point of a
        // repeat, so it is never silent.
        for (const next of successors) {
          a.out.hintf(`repeats: ${id.Short(next.id, 8)} is next`);
        }
      }
      const av = await availabilityOf(a, st, successors);
      await renderTasks(
        a,
        st,
        res.tasks,
        report(a, res.autoCompleted, { repeated: views(successors, av) }),
      );
    },
  };
}

/**
 * statusCommand builds the commands that only move an item between the four
 * statuses. They are one function because the difference between them is one
 * value, and a hold that behaved unlike a drop would be a bug.
 */
export function statusCommand(a: App, name: string, usage: string, status: Status): Command {
  return {
    name,
    usage,
    argsUsage: '<ref...>',
    store: 'write',
    async run(ctx: Context): Promise<void> {
      const st: Store = ctx.store();
      const tasks = await resolveRefs(a, st, ctx.args);
      const res = await setStatus(st, tasks, status, new Date());
      await renderTasks(a, st, res.tasks, report(a, res.autoCompleted, undefined));
    },
  };
}

/** flagCommand builds `tdo flag` and `tdo unflag`. */
export function flagCommand(a: App, name: string, usage: string, flagged: boolean): Command {
  return {
    name,
    usage,
    argsUsage: '<ref...>',
    store: 'write',
    async run(ctx: Context): Promise<void> {
      const st: Store = ctx.store();
      const tasks = await resolveRefs(a, st, ctx.args);
      const res = await setFlagged(st, tasks, flagged, new Date());
      await renderTasks(a, st, res.tasks, undefined);
    },
  };
}

/**
 * dateCommand builds `tdo defer` and `tdo due`, which differ only in which
 * date they write. The date is the last argument, so that several items can
 * be given one date in one command; --clear takes its place.
 */
export function dateCommand(a: App, name: string, usage: string, field: DateField): Command {
  return {
    name,
    usage,
    argsUsage: '<ref...> <when|--clear>',
    store: 'write',
    flags: {
      clear: { type: 'boolean', usage: 'remove the date instead of setting one' },
    },
    async run(ctx: Context): Promise<void> {
      const st: Store = ctx.store();
      let args: readonly string[] = ctx.args;
      const clear = ctx.bool('clear');

      let at: Date | undefined;
      if (!clear) {
        if (args.length < 2) {
          throw usagef(`${name} expects one or more references and a date, or --clear`);
        }
        at = parseInstant(args[args.length - 1] as string);
        args = args.slice(0, args.length - 1);
      }

      const tasks = await resolveRefs(a, st, args);
      const res = await setDate(st, tasks, field, at, new Date());
      await renderTasks(a, st, res.tasks, undefined);
    },
  };
}

/** moveCommand is `tdo mv`. */
export function moveCommand(a: App): Command {
  return {
    name: 'mv',
    usage: 'reparent or reorder items; a move that would make a cycle is refused',
    argsUsage: '<ref...> <parent-ref|--inbox|--top|--before R|--after R>',
    store: 'write',
    flags: {
      inbox: { type: 'boolean', usage: 'move tasks to the inbox, which is the absence of a parent' },
      top: { type: 'boolean', usage: 'move folders and projects to the top level' },
      before: { type: 'string', placeholder: 'R', usage: 'put the items immediately before item R' },
      after: { type: 'string', placeholder: 'R', usage: 'put the items immediately after item R' },
    },
    async run(ctx: Context): Promise<void> {
      const st: Store = ctx.store();
      let args: readonly string[] = ctx.args;
      // --inbox and --top are the same destination — no parent — under
      // the two names the tree gives it, so one item can be moved out
      // of its container whatever kind it is.
      const toTop = ctx.bool('inbox') || ctx.bool('top');
      if (ctx.isSet('before') || ctx.isSet('after')) {
        await reorder(a, ctx, st, args, toTop);
        return;
      }

      let parentID = '';
      if (!toTop) {
        if (args.length < 2) {
          throw usagef('mv expects one or more references and a destination, or --inbox / --top');
        }
        // The destination is a container by definition, so it is
        // resolved the way every other container reference is: a
        // number, an id prefix, or a title. Accepting a title for
        // `tdo add --project` but not for the command that files an
        // item afterwards is an asymmetry with nothing behind it.
        // The title is still tried last, so a number never changes
        // meaning, and two containers sharing one exit 6.
        const parent = await resolveContainer(
          a,
          st,
          args[args.length - 1] as string,
          KindFolder,
          KindProject,
          KindTask,
        );
        parentID = parent.id;
        args = args.slice(0, args.length - 1);
      }

      const tasks = await resolveRefs(a, st, args);
      let res;
      try {
        res = await moveTo(st, tasks, parentID, new Date());
      } catch (err) {
        throw treeError(err);
      }
      await renderTasks(a, st, res.tasks, undefined);
    },
  };
}

/**
 * reorder is `tdo mv <ref...> --before R` / `--after R`: the one way to say
 * where an item sits among its siblings.
 *
 * In a sequential project the order of the children is the order they become
 * available (§3.3), so this is not cosmetic — without it, "do this one last"
 * means deleting the action and adding it again, which loses its id, its
 * note and its history.
 */
export async function reorder(
  a: App,
  ctx: Context,
  st: Store,
  args: readonly string[],
  toTop: boolean,
): Promise<void> {
  if (ctx.isSet('before') && ctx.isSet('after')) {
    throw usagef('--before and --after ask for opposite things');
  }
  if (toTop) {
    throw usagef(
      '--before and --after place an item among its siblings; --inbox and --top take it out of its container',
    );
  }
  let where: Placement = Before;
  let ref = ctx.string('before').trim();
  if (ctx.isSet('after')) {
    where = After;
    ref = ctx.string('after').trim();
  }
  if (ref === '') {
    throw usagef('--before and --after need the item to place these ones next to');
  }
  if (args.length === 0) {
    throw usagef('mv expects one or more references to move');
  }

  // The anchor is resolved first, so a reorder against a reference that
  // means nothing changes nothing.
  const anchor = await resolveRef(a, st, ref);
  const tasks = await resolveRefs(a, st, args);
  let res;
  try {
    res = await taskopsReorder(st, tasks, anchor, where, new Date());
  } catch (err) {
    throw treeError(err);
  }
  await renderTasks(a, st, res.tasks, undefined);
}

// The ten factories the registry holds. Go built these inline inside
// markCommands; the dispatcher registers a factory per command, so each one
// is named here and markCommands is the list of them.

/** undoneCommand puts completed items back to active. */
export const undoneCommand: CommandFactory = (a) =>
  statusCommand(a, 'undone', 'put completed items back to active', StatusActive);

/** dropCommand decides against items without deleting them. */
export const dropCommand: CommandFactory = (a) =>
  statusCommand(a, 'drop', 'decide against items without deleting them', StatusDropped);

/** holdCommand puts items on hold, with everything inside them. */
export const holdCommand: CommandFactory = (a) =>
  statusCommand(a, 'hold', 'put items on hold, with everything inside them', StatusOnHold);

/** unholdCommand takes items off hold. */
export const unholdCommand: CommandFactory = (a) =>
  statusCommand(a, 'unhold', 'take items off hold', StatusActive);

/** flagItemsCommand is `tdo flag`. */
export const flagItemsCommand: CommandFactory = (a) => flagCommand(a, 'flag', 'flag items', true);

/** unflagCommand is `tdo unflag`. */
export const unflagCommand: CommandFactory = (a) =>
  flagCommand(a, 'unflag', 'remove the flag from items', false);

/** deferCommand is `tdo defer`. */
export const deferCommand: CommandFactory = (a) =>
  dateCommand(a, 'defer', 'set or clear the date before which items are not available', DeferDate);

/** dueCommand is `tdo due`. */
export const dueCommand: CommandFactory = (a) =>
  dateCommand(a, 'due', 'set or clear the date items are due', DueDate);

/**
 * markCommands returns the commands that only change a status, plus the two
 * that only change the flag, the two that write a date and `tdo mv`.
 */
export function markCommands(a: App): Command[] {
  return [
    doneCommand(a),
    undoneCommand(a),
    dropCommand(a),
    holdCommand(a),
    unholdCommand(a),
    flagItemsCommand(a),
    unflagCommand(a),
    deferCommand(a),
    dueCommand(a),
    moveCommand(a),
  ];
}
