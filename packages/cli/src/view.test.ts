// Rendering: the one JSON shape, the table, the detail block and the
// §3.3a report.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import { ErrBadParent, ErrCycle, ErrNotFound } from '@todocloud/core/store';
import { newTask, type Task } from '@todocloud/core/task';

import { App } from './app.ts';
import {
  availabilityOf,
  countLine,
  printTable,
  renderTask,
  renderTasks,
  report,
  treeError,
  views,
} from './view.ts';
import { buffer, type Harness, newHarness } from './testsupport.ts';

/** appWith builds an App whose streams are captured. */
function appWith(h: Harness): { a: App; out: buffer; err: buffer } {
  const out = new buffer();
  const err = new buffer();
  const a = new App({
    stdout: out,
    stderr: err,
    getenv: (name: string): string => h.env[name] ?? '',
  });
  return { a, out, err };
}

test('one task renders as the bulk shape with a count of one', async (t: TestContext) => {
  const h = await newHarness(t);
  const task = await h.add('Pay the invoice');
  const { a, out, err } = appWith(h);
  a.out.json = true;

  await h.withStore(async (st) => renderTask(a, st, await st.get(task.id)));

  const obj = JSON.parse(out.text) as { tasks?: unknown[]; count?: number };
  assert.equal(obj.count, 1);
  assert.equal(obj.tasks?.length, 1);
  // There is one shape, not a second {"task":{…}} for the single-item
  // commands (PLAN.md §9).
  assert.equal((obj as Record<string, unknown>)['task'], undefined);
  assert.equal(err.text, '', 'machine output puts nothing on stderr');
});

test('the human detail block names the item holding this one back', async (t: TestContext) => {
  const h = await newHarness(t);
  // A sequential project blocks every child but the first.
  const project = newTask('01J3PPPPPPPPPPPPPPPPPPPPPP', 'project', 'Invoices', new Date());
  project.sequential = true;
  const first = newTask('01J3AAAAAAAAAAAAAAAAAAAAAA', 'task', 'print it', new Date());
  first.parentID = project.id;
  first.position = 0;
  const second = newTask('01J3BBBBBBBBBBBBBBBBBBBBBB', 'task', 'post it', new Date());
  second.parentID = project.id;
  second.position = 1;
  await h.withStore(async (st) => {
    await st.add(project);
    await st.add(first);
    await st.add(second);
  });

  const { a, out } = appWith(h);
  await h.withStore(async (st) => renderTask(a, st, await st.get(second.id)));

  assert.match(out.text, /post it/);
  // The blocking sibling is fetched by id rather than inferred from what is
  // on screen, so its title is in the output.
  assert.match(out.text, /print it/);
});

test('the bulk shape carries the extra keys a command adds, under --json only', async (t: TestContext) => {
  const h = await newHarness(t);
  const one = await h.add('one');
  const { a, out } = appWith(h);
  a.out.json = true;

  await h.withStore(async (st) => {
    const tasks = [await st.get(one.id)];
    await renderTasks(a, st, tasks, { successors: ['01J3ZZZZZZZZZZZZZZZZZZZZZZ'] });
  });

  const obj = JSON.parse(out.text) as Record<string, unknown>;
  assert.equal(obj['count'], 1);
  assert.deepEqual(obj['successors'], ['01J3ZZZZZZZZZZZZZZZZZZZZZZ']);

  // Human output ignores the extra keys.
  const human = appWith(h);
  await h.withStore(async (st) => {
    const tasks = [await st.get(one.id)];
    await renderTasks(human.a, st, tasks, { successors: ['x'] });
  });
  assert.doesNotMatch(human.out.text, /successors/);
});

test('printTable indents a child only under a parent that is listed', async (t: TestContext) => {
  const h = await newHarness(t);
  const project = newTask('01J3PPPPPPPPPPPPPPPPPPPPPP', 'project', 'Invoices', new Date());
  const child = newTask('01J3AAAAAAAAAAAAAAAAAAAAAA', 'task', 'print it', new Date());
  child.parentID = project.id;
  await h.withStore(async (st) => {
    await st.add(project);
    await st.add(child);
  });

  await h.withStore(async (st) => {
    const tasks: Task[] = [await st.get(project.id), await st.get(child.id)];
    const av = await availabilityOf(new App({}), st, tasks);

    const nested = appWith(h);
    printTable(nested.a, tasks, av, true);
    const flat = appWith(h);
    printTable(flat.a, tasks, av, false);
    assert.notEqual(nested.out.text, flat.out.text, 'tree made no difference');

    // A row is never indented under something the filter hid: with only the
    // child listed, the two renderings are identical.
    const orphan = appWith(h);
    printTable(orphan.a, [tasks[1] as Task], av, true);
    const orphanFlat = appWith(h);
    printTable(orphanFlat.a, [tasks[1] as Task], av, false);
    assert.equal(orphan.out.text, orphanFlat.out.text);
  });
});

test('views reports whether availability was asked at all', async (t: TestContext) => {
  const h = await newHarness(t);
  const one = await h.add('one');
  await h.withStore(async (st) => {
    const tasks = [await st.get(one.id)];
    const asked = views(tasks, await availabilityOf(new App({}), st, tasks));
    assert.equal(asked[0]?.asked, true);
    const never = views(tasks, new Map());
    assert.equal(never[0]?.asked, false);
  });
});

test('report names the containers a write closed', async (t: TestContext) => {
  const h = await newHarness(t);
  const project = newTask('01J3PPPPPPPPPPPPPPPPPPPPPP', 'project', 'Invoices', new Date());

  // A human reads it on stderr, so it cannot be mistaken for the result.
  const human = appWith(h);
  assert.equal(report(human.a, [project], undefined), undefined);
  assert.match(human.err.text, /completed with its last action: 01J3PPPP Invoices/);
  assert.equal(human.out.text, '');

  // A machine reads it as a key of the result object.
  const machine = appWith(h);
  machine.a.out.json = true;
  const extra = report(machine.a, [project], { count: 1 });
  assert.equal(machine.err.text, '');
  assert.equal((extra?.['completed_with_last'] as unknown[]).length, 1);
  assert.equal(extra?.['count'], 1);

  // Nothing closed, nothing said.
  const quiet = appWith(h);
  assert.equal(report(quiet.a, [], undefined), undefined);
  assert.equal(quiet.err.text, '');
});

// The two tree rules of §3.1 are mistakes at the command line, not store
// failures, so §4.2 fixes them at exit 2.
test('a tree rule is a usage error', () => {
  assert.equal(exit.classify(treeError(ErrBadParent)).code, exit.Usage);
  assert.equal(exit.classify(treeError(ErrCycle)).code, exit.Usage);
  // Everything else keeps the code it had.
  assert.equal(exit.classify(treeError(ErrNotFound)).code, exit.NotFound);
  assert.equal(exit.classify(treeError(new Error('boom'))).code, exit.Error);
});

test('countLine agrees with its noun', () => {
  assert.equal(countLine(1, 'task', 'tasks'), '1 task');
  assert.equal(countLine(0, 'task', 'tasks'), '0 tasks');
  assert.equal(countLine(2, 'task', 'tasks'), '2 tasks');
});
