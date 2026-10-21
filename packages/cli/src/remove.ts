// `tdo rm`: the tombstone, and the one irreversible path in the CLI.
//
// Go attached all of this to the `*app` receiver; see the note in app.ts for
// why the port passes the app as the first parameter instead.

import { isNotEmpty, type Store } from '@todocloud/core/store';
import type { Task } from '@todocloud/core/task';
import { tombstone as taskopsTombstone } from '@todocloud/core/taskops';

import { type App, type Command, type Context, usagef } from './app.ts';
import { resolveRefs } from './refs.ts';
import { renderTasks, report } from './view.ts';

/** removeCommand is `tdo rm`. */
export function removeCommand(a: App): Command {
  return {
    name: 'rm',
    usage: 'remove items, writing a tombstone unless --purge is given',
    argsUsage: '<ref...>',
    store: 'write',
    flags: {
      recursive: { type: 'boolean', usage: 'mean it for a container that still holds items' },
      purge: { type: 'boolean', usage: 'delete irreversibly instead of writing a tombstone' },
      yes: { type: 'boolean', usage: 'skip the confirmation prompt for --purge' },
    },
    async run(ctx: Context): Promise<void> {
      const st: Store = ctx.store();
      const tasks = await resolveRefs(a, st, ctx.args);
      if (ctx.bool('purge')) {
        await purge(a, st, tasks, ctx.bool('recursive'), ctx.bool('yes'));
        return;
      }
      await tombstone(a, st, tasks);
    },
  };
}

/**
 * removeAliasCommand is `tdo remove`, the alias Go declared on the `rm`
 * command. The dispatcher resolves a command by its name alone, so the alias
 * is a hidden entry of its own rather than a second name on one entry; it
 * shares the body, so the two cannot drift apart.
 */
export function removeAliasCommand(a: App): Command {
  return { ...removeCommand(a), name: 'remove', hidden: true };
}

/**
 * tombstone is the ordinary removal: the item stays in the store with a
 * deleted_at stamp, so that a second device can learn about the deletion
 * instead of silently resurrecting it.
 *
 * Removing a container takes its subtree with it. Leaving the children behind
 * would make them orphans, which §3.3 refuses to call available — so they
 * would vanish from every listing while still being there.
 */
export async function tombstone(a: App, st: Store, tasks: readonly Task[]): Promise<void> {
  const res = await taskopsTombstone(st, tasks, new Date());
  await renderTasks(a, st, res.tasks, report(a, res.autoCompleted, undefined));
}

/**
 * purge is the only irreversible path in the CLI, so it is the only one that
 * asks. On a TTY it prompts; without one it refuses rather than assuming
 * --yes, because a script or an agent must say so explicitly.
 */
export async function purge(
  a: App,
  st: Store,
  tasks: readonly Task[],
  recursive: boolean,
  yes: boolean,
): Promise<void> {
  // What is about to go is counted before anything is asked, so the prompt
  // and the refusal both name the real number of rows.
  let going = 0;
  for (const t of tasks) {
    const subtree = await st.subtree(t.id);
    if (!recursive && subtree.length > 1) {
      throw usagef(`${t.id} still holds ${subtree.length - 1} item(s); pass --recursive to purge them too`);
    }
    going += recursive ? subtree.length : 1;
  }

  if (!yes) {
    if (!stdinIsTerminal(a)) {
      throw usagef(
        `refusing to purge ${going} item(s) from ${st.describe()} without a terminal to confirm at; pass --yes`,
      );
    }
    // The prompt names the store: when a provider override is in play,
    // the items about to go are not necessarily the ones on screen a
    // moment ago.
    const ok = await confirm(
      a,
      `Permanently delete ${going} item(s) from ${st.describe()}? This cannot be undone.`,
    );
    if (!ok) {
      // Declining is not a failure; nothing was changed.
      a.out.hintf('Cancelled; nothing was purged.');
      if (a.out.json) {
        a.out.emit({ purged: [], count: 0 });
      }
      return;
    }
  }

  const purged: string[] = [];
  for (const t of tasks) {
    if (recursive) {
      const subtree = await st.subtree(t.id);
      await st.purgeSubtree(t.id);
      for (const node of subtree) {
        purged.push(node.id);
      }
      continue;
    }
    try {
      await st.purge(t.id);
    } catch (err) {
      if (isNotEmpty(err)) {
        // A child added between the count above and this call.
        throw usagef(`${t.id} is not empty; pass --recursive to purge what is inside it`);
      }
      throw err;
    }
    purged.push(t.id);
  }

  if (a.out.json) {
    a.out.emit({ purged, count: purged.length });
    return;
  }
  for (const taskID of purged) {
    a.out.printf(`purged ${taskID}\n`);
  }
}

/**
 * confirm asks on stderr and reads the answer from stdin, so that a prompt
 * never lands in piped machine output.
 *
 * Go read one line through a bufio.Reader. Env.Reader hands over the whole of
 * stdin in one call — the honest shape for a promise — so the answer is the
 * first line of it.
 */
export async function confirm(a: App, question: string): Promise<boolean> {
  a.env.stderr.write(`${question} [y/N] `);
  let text: string;
  try {
    text = await a.env.stdin.read();
  } catch {
    // Go returned (false, nil) when the read failed with nothing read: an
    // unreadable stdin is a "no", not a failure of the command.
    return false;
  }
  const answer = (text.split('\n')[0] ?? '').trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/**
 * stdinIsTerminal reports whether there is a user at stdin to answer a
 * prompt. A character-device check is not enough — /dev/null is one — so the
 * question goes to `node:tty`'s isatty, through the injected seam, which is
 * what lets the tests drive both directions.
 */
export function stdinIsTerminal(a: App): boolean {
  return a.env.stdinIsTTY();
}
