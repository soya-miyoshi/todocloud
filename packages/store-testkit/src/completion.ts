// The "complete with last action" rule, which is shared domain logic
// (`autoComplete`) and must therefore behave identically on every provider.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  Filter,
  KindFolder,
  KindProject,
  KindTask,
  RepeatFixed,
  RepeatFromCompletion,
  type Status,
  StatusActive,
  StatusDone,
  StatusDropped,
  StatusOnHold,
  type Task,
} from '@todocloud/core';

import {
  at,
  type Fixture,
  hour,
  type Mutator,
  timeAt,
  under,
} from './storetest.ts';

/**
 * withLastChild marks a container as "complete with last action" — the
 * completed_by_children field of PLAN.md §3.2.
 */
export const withLastChild: Mutator = (t) => {
  t.completedByChildren = true;
};

/**
 * closeIt closes a stored task at `when`, the way `tdo done` and `tdo drop`
 * do. Go had it as a method on the fixture; it is a free function here so
 * that the fixture stays the store and nothing else.
 */
async function closeIt(
  f: Fixture,
  t: Task,
  status: Status,
  when: Date,
): Promise<void> {
  const stored = await f.get(t.id);
  stored.setStatus(status, when);
  await f.update(stored);
}

/** requireStatus fails naming the rule, not just the values. */
async function requireStatus(
  f: Fixture,
  rule: string,
  taskID: string,
  want: Status,
): Promise<void> {
  const got = (await f.get(taskID)).status;
  if (got !== want) {
    assert.fail(
      `${rule}\n  ${taskID} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
    );
  }
}

/**
 * testCompletedByChildren is the "complete with last action" rule: when the
 * last child of a container whose completed_by_children is set is finished,
 * the container is finished too.
 *
 * Each case needs its own tree but not its own store, so they are `t.test`
 * cases over the one fixture, exactly as Go's `t.Run` cases were. The
 * fixture is rebound to the case's own TestContext through `with`, so a
 * failure is reported against the case that caused it.
 */
export async function testCompletedByChildren(
  t: TestContext,
  parent: Fixture,
): Promise<void> {
  const later = timeAt(parent.now, hour);

  await t.test(
    'the last child completing completes its container',
    async (t) => {
      const f = parent.with(t);
      const project = await f.add(
        KindProject,
        'tidy the garage',
        withLastChild,
      );
      const first = await f.add(
        KindTask,
        'empty the shelves',
        under(project),
        at(1),
      );
      const second = await f.add(KindTask, 'sweep', under(project), at(2));

      await closeIt(f, first, StatusDone, later);
      await requireStatus(
        f,
        'a container whose completed_by_children is set must not complete while a child is still open',
        project.id,
        StatusActive,
      );

      await closeIt(f, second, StatusDone, later);
      await requireStatus(
        f,
        'completing the last child of a completed_by_children container must complete the container',
        project.id,
        StatusDone,
      );

      const done = await f.get(project.id);
      if (
        done.completedAt === undefined ||
        done.completedAt.getTime() !== later.getTime()
      ) {
        assert.fail(
          `a container completed by its last child must record when it happened, which is the moment of that completion\n  completed_at is ${String(done.completedAt)}, expected ${later.toISOString()}`,
        );
      }
    },
  );

  await t.test(
    'a container without the flag is never completed by its children',
    async (t) => {
      const f = parent.with(t);
      const project = await f.add(KindProject, 'ordinary project');
      const only = await f.add(KindTask, 'the only action', under(project));

      await closeIt(f, only, StatusDone, later);
      await requireStatus(
        f,
        'completed_by_children is opt-in: a container without it stays open when its last child is done',
        project.id,
        StatusActive,
      );
    },
  );

  await t.test(
    'a dropped child counts as finished, exactly as the sequential rule treats it',
    async (t) => {
      const f = parent.with(t);
      const project = await f.add(
        KindProject,
        'half abandoned',
        withLastChild,
      );
      const kept = await f.add(
        KindTask,
        'the one I did',
        under(project),
        at(1),
      );
      const abandoned = await f.add(
        KindTask,
        'the one I decided against',
        under(project),
        at(2),
      );

      await closeIt(f, kept, StatusDone, later);
      await closeIt(f, abandoned, StatusDropped, later);
      await requireStatus(
        f,
        'dropping a child finishes it as surely as doing it, so the last child dropped must complete the container (PLAN.md §3.3 rule 4 skips dropped siblings for the same reason)',
        project.id,
        StatusDone,
      );
    },
  );

  await t.test(
    'a tombstoned child is skipped rather than waited for',
    async (t) => {
      const f = parent.with(t);
      const project = await f.add(
        KindProject,
        'with a deleted action',
        withLastChild,
      );
      const live = await f.add(
        KindTask,
        'the live action',
        under(project),
        at(1),
      );
      const removed = await f.add(
        KindTask,
        'the removed action',
        under(project),
        at(2),
      );

      const stored = await f.get(removed.id);
      stored.deletedAt = later;
      await f.update(stored);
      await requireStatus(
        f,
        'a tombstone is not a completion: removing an open child must not by itself complete the container',
        project.id,
        StatusActive,
      );

      await closeIt(f, live, StatusDone, later);
      await requireStatus(
        f,
        'a tombstoned child must be skipped, not waited for, so that a tombstone cannot stall a container forever (PLAN.md §3.3 rule 4 skips deleted siblings)',
        project.id,
        StatusDone,
      );
    },
  );

  await t.test(
    'a container left with no children at all is not completed',
    async (t) => {
      const f = parent.with(t);
      const project = await f.add(
        KindProject,
        'emptied, not finished',
        withLastChild,
      );
      const only = await f.add(KindTask, 'the only action', under(project));

      const stored = await f.get(only.id);
      stored.deletedAt = later;
      await f.update(stored);
      await requireStatus(
        f,
        'completing nothing is not completing something: a container with no live children left must stay open',
        project.id,
        StatusActive,
      );
    },
  );

  await t.test(
    'the rule walks up through every container that asks for it',
    async (t) => {
      const f = parent.with(t);
      const folder = await f.add(
        KindFolder,
        'a folder that asks too',
        withLastChild,
      );
      const project = await f.add(
        KindProject,
        'the outcome',
        under(folder),
        withLastChild,
      );
      const outer = await f.add(
        KindTask,
        'the outer group',
        under(project),
        withLastChild,
      );
      const inner = await f.add(
        KindTask,
        'the inner group',
        under(outer),
        withLastChild,
      );
      const leaf = await f.add(KindTask, 'the only action', under(inner));

      await closeIt(f, leaf, StatusDone, later);
      for (const container of [inner, outer, project]) {
        await requireStatus(
          f,
          'the rule cascades: a container that completes may itself be the last child of its parent, so the whole chain above the last action must complete',
          container.id,
          StatusDone,
        );
      }
      await requireStatus(
        f,
        'a folder is organisation and is never completed (PLAN.md §3.1), whatever completed_by_children says',
        folder.id,
        StatusActive,
      );
    },
  );

  await t.test(
    'the cascade stops at a container that still has an open child',
    async (t) => {
      const f = parent.with(t);
      const outer = await f.add(KindProject, 'the outcome', withLastChild);
      const group = await f.add(
        KindTask,
        'the group',
        under(outer),
        withLastChild,
        at(1),
      );
      const sibling = await f.add(
        KindTask,
        'the unrelated action',
        under(outer),
        at(2),
      );
      const leaf = await f.add(
        KindTask,
        'the action in the group',
        under(group),
      );

      await closeIt(f, leaf, StatusDone, later);
      await requireStatus(
        f,
        "the group's last child completed, so the group completes",
        group.id,
        StatusDone,
      );
      await requireStatus(
        f,
        'the cascade must stop at the first container that still has an open child',
        outer.id,
        StatusActive,
      );

      await closeIt(f, sibling, StatusDone, later);
      await requireStatus(
        f,
        'a container that is itself a container counts as an ordinary child: once both are closed the parent completes',
        outer.id,
        StatusDone,
      );
    },
  );

  await t.test(
    'a repeating container is left for an explicit done',
    async (t) => {
      const f = parent.with(t);
      const folder = await f.add(KindFolder, 'routines');
      const weekly = await f.add(
        KindProject,
        'the weekly review',
        under(folder),
        withLastChild,
        (x) => {
          x.repeat = { method: RepeatFromCompletion, every: '1w' };
          x.seriesID = 'series';
        },
      );
      const step = await f.add(KindTask, 'the only step', under(weekly));

      const before = (await f.list(new Filter({ includeDeleted: true })))
        .length;
      await closeIt(f, step, StatusDone, later);
      await requireStatus(
        f,
        'a repeating container must not be auto-completed: PLAN.md §3.4 says an instance is created only as the direct result of an explicit `tdo done`, and completing the container here would either kill the series or manufacture a row',
        weekly.id,
        StatusActive,
      );
      const after = (await f.list(new Filter({ includeDeleted: true }))).length;
      if (after !== before) {
        assert.fail(
          `this rule never creates a row (PLAN.md §3.4)\n  the store held ${before} task(s) and now holds ${after}`,
        );
      }
    },
  );

  await t.test(
    'an auto-completed container never generates a successor',
    async (t) => {
      const f = parent.with(t);
      const project = await f.add(
        KindProject,
        'no rows from here',
        withLastChild,
      );
      const only = await f.add(
        KindTask,
        'the repeating action',
        under(project),
        (x) => {
          x.repeat = { method: RepeatFixed, every: '1d' };
        },
      );

      const before = (await f.list(new Filter({ includeDeleted: true })))
        .length;
      await closeIt(f, only, StatusDone, later);
      await requireStatus(
        f,
        'a repeating child is an ordinary child: closing it completes its container',
        project.id,
        StatusDone,
      );
      const after = (await f.list(new Filter({ includeDeleted: true }))).length;
      if (after !== before) {
        assert.fail(
          `nothing but an explicit \`tdo done\` generates a row (PLAN.md §3.4), and the store generates none at all\n  the store held ${before} task(s) and now holds ${after}`,
        );
      }
    },
  );

  await t.test('reopening a child does not reopen the container', async (t) => {
    const f = parent.with(t);
    const project = await f.add(KindProject, 'reopened', withLastChild);
    const only = await f.add(KindTask, 'the only action', under(project));

    await closeIt(f, only, StatusDone, later);
    await requireStatus(
      f,
      'the last child completing completes the container',
      project.id,
      StatusDone,
    );

    const stored = await f.get(only.id);
    stored.setStatus(StatusActive, timeAt(later, hour));
    await f.update(stored);
    await requireStatus(
      f,
      'the rule only ever closes: nothing records whether a container was completed by the rule or by the user, so `tdo undone` on a child must not reopen the container — the user reopens it themselves',
      project.id,
      StatusDone,
    );
  });

  await t.test(
    'a container that is already closed is left exactly as it is',
    async (t) => {
      const f = parent.with(t);
      const dropped = await f.add(
        KindProject,
        'abandoned outcome',
        withLastChild,
        (x) => {
          x.status = StatusDropped;
          x.droppedAt = new Date(f.now.getTime());
        },
      );
      const leftover = await f.add(
        KindTask,
        'an action nobody removed',
        under(dropped),
      );

      await closeIt(f, leftover, StatusDone, later);
      await requireStatus(
        f,
        'a container that is already done or dropped is not revisited: the rule must not turn a dropped outcome into a completed one',
        dropped.id,
        StatusDropped,
      );
    },
  );

  await t.test(
    'a container on hold is completed when its work is',
    async (t) => {
      const f = parent.with(t);
      const project = await f.add(
        KindProject,
        'paused outcome',
        withLastChild,
        (x) => {
          x.status = StatusOnHold;
        },
      );
      const only = await f.add(KindTask, 'the only action', under(project));

      await closeIt(f, only, StatusDone, later);
      await requireStatus(
        f,
        'the work a held container held is finished, and leaving it on hold would keep a container nobody can act on in the tree forever',
        project.id,
        StatusDone,
      );
    },
  );
}
