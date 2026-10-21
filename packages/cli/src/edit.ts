// `tdo edit`: the title, the note, the estimate, the tags and the item's own
// fields.

import type { Store } from '@todocloud/core/store';
import type { Task } from '@todocloud/core/task';
import { apply } from '@todocloud/core/taskops';
import { Edit } from '@todocloud/core/taskops/edit';

import { aliasedString, fieldFlags, setFlags } from './add.ts';
import { type App, type Command, type Context, usagef } from './app.ts';
import { parseMinutes } from './list.ts';
import { resolveRef } from './refs.ts';
import { renderTask, treeError } from './view.ts';

/** editCommand is `tdo edit`. */
export function editCommand(a: App): Command {
  return {
    name: 'edit',
    usage: "change an item's title, note, estimate, tags or own fields",
    argsUsage: '<ref>',
    store: 'write',
    flags: {
      title: { type: 'string', placeholder: 'S', usage: 'replace the title with S' },
      note: { type: 'string', placeholder: 'S', usage: 'replace the note with S' },
      // Go declared `notes` as an alias of `note`; see addFlags for why the
      // second spelling is its own hidden flag here.
      notes: { type: 'string', placeholder: 'S', usage: 'replace the note with S', hidden: true },
      estimate: { type: 'string', placeholder: '25m', usage: 'how long it will take, for example 25m' },
      tag: {
        type: 'string',
        multiple: true,
        placeholder: 'TAGS',
        usage: 'replace the tags with these TAGS; may be repeated',
      },
      untag: { type: 'string', multiple: true, placeholder: 'TAG', usage: 'remove one TAG; may be repeated' },
      unset: {
        type: 'string',
        multiple: true,
        placeholder: 'KEY',
        usage: 'remove a user-defined field by KEY; may be repeated',
      },
      ...setFlags(),
    },
    async run(ctx: Context): Promise<void> {
      if (ctx.args.length !== 1) {
        throw usagef('edit expects exactly one item reference');
      }
      const st: Store = ctx.store();
      const found = await resolveRef(a, st, ctx.args[0] as string);
      const e = editFromFlags(ctx);
      // The shared layer edits a copy, so a rejected change leaves
      // the stored item exactly as it was, and what it rejects
      // classifies as a usage error (taskops.ErrInvalid).
      let res;
      try {
        res = await apply(st, [found], e, new Date());
      } catch (err) {
        throw treeError(err);
      }
      await renderTask(a, st, res.tasks[0] as Task);
    },
  };
}

/**
 * editFromFlags reads the edit flags into the shared change description, so
 * that `tdo edit` and `tdo serve` apply the same request the same way.
 */
export function editFromFlags(ctx: Context): Edit {
  const e = new Edit();
  if (ctx.isSet('title')) {
    e.title = ctx.string('title');
  }
  const note = aliasedString(ctx, 'note', 'notes');
  if (note.set) {
    e.note = note.value;
  }
  if (ctx.isSet('estimate')) {
    e.estimatedMinutes = parseMinutes(ctx.string('estimate'));
  }
  if (ctx.isSet('tag')) {
    // --tag replaces the set, which is what "these are its tags" means;
    // --untag is the way to remove one of several.
    e.tags = ctx.strings('tag');
  }
  if (ctx.isSet('untag')) {
    e.untag = ctx.strings('untag');
  }
  const { priority, set, unset } = fieldFlags(ctx);
  e.priority = priority;
  e.set = set;
  e.unset = unset;
  return e;
}
