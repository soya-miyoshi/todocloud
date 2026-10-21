// `tdo tag`: the promoted tag — a tag with a status of its own.
//
// Go attached all of this to the `*app` receiver; see the note in app.ts for
// why the port passes the app as the first parameter instead.

import { type Status, StatusActive, StatusDropped, StatusOnHold } from '@todocloud/core/task';
import { type Store, type Tag, tagKey, validTagStatus } from '@todocloud/core/store';

import { type App, type Command, type Context, usagef } from './app.ts';
import { parseStatuses } from './list.ts';

/**
 * tagCommand lists tags and changes what a tag is, rather than which tasks
 * carry it: `tdo add --tag` and `tdo edit --tag` do the latter.
 *
 * A tag has a status of its own, and a tag that is not active holds back
 * every item filed under it (§3.3). That is what a context nobody can act in
 * is for — the errands that cannot happen until the car is back are not
 * deferred to a date and not on hold one by one; the context is.
 *
 * Tags are named, never numbered. The short numbers of a listing belong to
 * the last listing of *items* (§3.7), and giving tags a second, parallel set
 * of numbers is how `tdo project 1` came to mean a folder: a tag is unique by
 * name, so the name is the reference.
 */
export function tagCommand(a: App): Command {
  return {
    name: 'tag',
    usage: 'list tags, or put one on hold, drop it, rename it or remove it',
    argsUsage: 'ls | hold <tag...> | unhold <tag...> | drop <tag...> | rename <old> <new> | rm <tag...>',
    flags: {
      status: { type: 'string', multiple: true, placeholder: 'STATUS', usage: 'keep one STATUS; may be repeated' },
      unused: { type: 'boolean', usage: 'list only the tags no live task carries' },
    },
    async run(ctx: Context): Promise<void> {
      const args = ctx.args;
      if (args.length === 0) {
        throw usagef('tag expects `ls`, `hold`, `unhold`, `drop`, `rename` or `rm`');
      }
      const verb = args[0] as string;
      const rest = args.slice(1);
      if (verb !== 'ls' && verb !== 'list') {
        if (ctx.isSet('status')) {
          throw usagef(
            '--status filters `tdo tag ls`; `tdo tag hold`, `unhold` and `drop` set the status',
          );
        }
        if (ctx.isSet('unused')) {
          throw usagef('--unused filters `tdo tag ls`');
        }
      }
      switch (verb) {
        case 'ls':
        case 'list':
          if (rest.length > 0) {
            throw usagef('tag ls takes no arguments');
          }
          await a.withStore(async (st) => {
            await tagList(a, ctx, st);
          });
          return;
        case 'hold':
          await tagSetStatus(a, rest, StatusOnHold);
          return;
        case 'unhold':
        case 'activate':
          await tagSetStatus(a, rest, StatusActive);
          return;
        case 'drop':
          await tagSetStatus(a, rest, StatusDropped);
          return;
        case 'rename': {
          if (rest.length !== 2) {
            throw usagef('tag rename expects the old name and the new one');
          }
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await tagRename(a, st, rest[0] as string, rest[1] as string);
          });
          return;
        }
        case 'rm':
        case 'remove':
          if (rest.length === 0) {
            throw usagef('tag rm expects at least one tag');
          }
          await a.withStore(async (st) => {
            a.noticeOverriddenStore(st);
            await tagRemove(a, st, rest);
          });
          return;
        default:
          throw usagef(
            `tag expects \`ls\`, \`hold\`, \`unhold\`, \`drop\`, \`rename\` or \`rm\`, got ${JSON.stringify(verb)}`,
          );
      }
    },
  };
}

/**
 * tagList is `tdo tag ls`: every tag, its status and how many live tasks
 * carry it. A tag with a status of its own is listed at zero as well, because
 * a context put on hold must not disappear when its last task is finished.
 */
export async function tagList(a: App, ctx: Context, st: Store): Promise<void> {
  const statuses = parseStatuses(ctx.strings('status'));
  for (const s of statuses) {
    if (!validTagStatus(s)) {
      throw usagef(`a tag is never ${s}; its status is active, on_hold or dropped`);
    }
  }
  const tags = await st.tags();
  const kept: Tag[] = [];
  for (const tag of tags) {
    if (statuses.length > 0 && !containsStatus(statuses, tag.status)) {
      continue;
    }
    if (ctx.bool('unused') && tag.count > 0) {
      continue;
    }
    kept.push(tag);
  }
  renderTags(a, kept, undefined);
}

/**
 * tagSetStatus is `tdo tag hold|unhold|drop`. The tags need not be in use:
 * putting a context on hold before filing anything under it is ordinary, and
 * the row that holds the status is created on demand.
 */
export async function tagSetStatus(a: App, names: readonly string[], status: Status): Promise<void> {
  if (names.length === 0) {
    throw usagef('expected at least one tag');
  }
  const wanted = tagNames(names);
  await a.withStore(async (st) => {
    a.noticeOverriddenStore(st);
    const now = new Date();
    for (const name of wanted) {
      await st.setTagStatus(name, status, now);
    }
    await renderTagsNamed(a, st, wanted, undefined);
  });
}

/**
 * tagRename moves every task from one tag to another. The destination keeps
 * its own status when it already has one.
 */
export async function tagRename(a: App, st: Store, from: string, to: string): Promise<void> {
  const names = tagNames([from, to]);
  if (names.length !== 2) {
    throw usagef('tag rename expects two different names, or one name in another spelling');
  }
  await st.renameTag(names[0] as string, names[1] as string, new Date());
  await renderTagsNamed(a, st, names.slice(1), undefined);
}

/**
 * tagRemove takes tags off every task that carries them. The tasks keep
 * everything else; a tag is a label, so there is nothing to tombstone.
 */
export async function tagRemove(a: App, st: Store, names: readonly string[]): Promise<void> {
  const wanted = tagNames(names);
  let untagged = 0;
  for (const name of wanted) {
    untagged += await st.removeTag(name);
  }
  if (a.out.json) {
    a.out.emit({ removed: wanted, count: wanted.length, untagged });
    return;
  }
  // Go wrote this line without a trailing newline, and the port keeps the
  // byte-for-byte output rather than quietly changing it.
  // Go's Printf appends no newline (unlike Warnf), and these two call sites
  // passed no "\n", so `tdo tag ls` ran every row onto one line and this
  // line ran into the shell prompt. That is a bug rather than a format this
  // port has to preserve: it is human output, not the documented --json
  // shape, so the newline is added here. See also renderTags below.
  a.out.printf(`removed ${wanted.join(', ')} from ${untagged} task(s)\n`);
}

/**
 * renderTagsNamed reports the tags whose names were just written, read back
 * from the store so the output is what is stored and not what was asked for.
 */
export async function renderTagsNamed(
  a: App,
  st: Store,
  names: readonly string[],
  extra: Record<string, unknown> | undefined,
): Promise<void> {
  const all = await st.tags();
  const wanted = new Set<string>();
  for (const name of names) {
    wanted.add(tagKey(name));
  }
  const kept: Tag[] = [];
  for (const tag of all) {
    if (wanted.has(tagKey(tag.name))) {
      kept.push(tag);
    }
  }
  renderTags(a, kept, extra);
}

/**
 * renderTags writes the tag listing shape, {"tags":[…],"count":n}, or a small
 * table. The shape is the tags' own: a tag is not a task and does not pretend
 * to be one.
 */
export function renderTags(
  a: App,
  tags: readonly Tag[],
  extra: Record<string, unknown> | undefined,
): void {
  if (a.out.json) {
    a.out.emit({ tags, count: tags.length, ...(extra ?? {}) });
    return;
  }
  if (tags.length === 0) {
    a.out.hintf('No tags yet. `tdo add <title> --tag home` creates one.');
    return;
  }
  for (const tag of tags) {
    let status = '';
    if (tag.status !== StatusActive) {
      status = `  [${tag.status}]`;
    }
    // Go's format string was "%-24s %4d%s", and — like the line in tagRemove
    // — it carried no newline. Kept as it was, so the port changes no bytes.
    a.out.printf(`${tag.name.padEnd(24)} ${String(tag.count).padStart(4)}${status}\n`);
  }
}

/**
 * tagNames trims and de-duplicates the tags named on the command line,
 * keeping the spelling the user typed. A tag may not be a comma-separated
 * list here: `tdo tag hold home,errand` would otherwise put a single tag
 * called "home,errand" on hold, which is not what anyone means.
 */
export function tagNames(args: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of args) {
    const name = raw.trim();
    if (name === '') {
      throw usagef('a tag must have a name');
    }
    if (name.includes(',')) {
      throw usagef(`name one tag at a time: ${JSON.stringify(name)} looks like a list`);
    }
    const key = tagKey(name);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(name);
  }
  if (out.length === 0) {
    throw usagef('expected at least one tag');
  }
  return out;
}

/** containsStatus reports whether s is one of statuses. */
export function containsStatus(statuses: readonly Status[], s: Status): boolean {
  return statuses.includes(s);
}
