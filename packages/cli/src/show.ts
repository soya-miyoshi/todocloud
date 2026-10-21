import type { Store } from '@todocloud/core/store';

import { type App, type Command, type Context, usagef } from './app.ts';
import { resolveRef } from './refs.ts';
import { renderTask } from './view.ts';

/** showCommand is `tdo show`: one item in full. */
export function showCommand(a: App): Command {
  return {
    name: 'show',
    usage: 'show one item in full, including why it is blocked',
    argsUsage: '<ref>',
    store: 'read',
    async run(ctx: Context): Promise<void> {
      if (ctx.args.length !== 1) {
        throw usagef('show expects exactly one item reference');
      }
      const st: Store = ctx.store();
      const t = await resolveRef(a, st, ctx.args[0] ?? '');
      // A pure read: show never files, never repeats and never refreshes the
      // short numbers (§4.2).
      await renderTask(a, st, t);
    },
  };
}
