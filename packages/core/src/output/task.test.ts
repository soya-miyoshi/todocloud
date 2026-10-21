// Ported from internal/output/output_test.go (the Table, Detail and fieldText
// cases) and internal/output/task_table_test.go, which pins the table layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { JSONValue } from '../task.ts';
import { KeyPriority, KindFolder, KindTask, StatusActive, StatusDone, Task } from '../task.ts';
import { Detail, Row, Rows, Table, fieldText, sanitize } from './task.ts';

/** buffer collects what the renderers write, standing in for a bytes.Buffer. */
class buffer {
  text = '';
  write(s: string): void {
    this.text += s;
  }
}

function sampleTask(): Task {
  const now = new Date('2026-10-20T04:11:00Z');
  const due = new Date('2026-11-01T00:00:00Z');
  const t = new Task();
  t.id = '01J3ZQK8V9XW5S6R7T8Y9Z0A1B';
  t.kind = KindTask;
  t.title = 'Pay the invoice';
  t.status = StatusActive;
  t.dueAt = due;
  t.createdAt = now;
  t.updatedAt = now;
  t.fields = { [KeyPriority]: 2, client: 'acme' };
  t.setTags(['finance', 'ops']);
  return t;
}

test('the table stays within eighty columns', () => {
  const long = sampleTask();
  long.title = 'a very long title '.repeat(10);
  long.setTags(['one', 'two', 'three', 'four', 'five', 'six']);

  const buf = new buffer();
  Table(buf, Rows([sampleTask(), long]));

  const lines = buf.text.replace(/\n+$/, '').split('\n');
  assert.equal(lines.length, 3, `expected a header and two rows: ${buf.text}`);
  assert.ok(lines[0]?.includes('TITLE'), `header: ${lines[0]}`);
  assert.ok(lines[1]?.startsWith('1 '), `the first column is the short number: ${lines[1]}`);
  for (const line of lines) {
    // Go counted runes; Array.from counts code points, so an ellipsis or an
    // astral character is one column and not two.
    const n = Array.from(line).length;
    assert.ok(n <= 80, `line is ${n} columns wide: ${line}`);
  }
  assert.ok(lines[1]?.includes('2026-11-01'), `row is missing the due date: ${lines[1]}`);
  assert.ok(lines[1]?.includes('finance'), `row is missing the tags: ${lines[1]}`);
});

test('the table marks done and deleted', () => {
  const done = sampleTask();
  done.status = StatusDone;
  const deleted = sampleTask();
  deleted.deletedAt = new Date();

  const buf = new buffer();
  Table(buf, Rows([done, deleted]));

  const lines = buf.text.replace(/\n+$/, '').split('\n');
  assert.ok(lines[1]?.startsWith('1  x'), `a completed task is marked x: ${lines[1]}`);
  assert.ok(lines[2]?.startsWith('2  -'), `a tombstone is marked -: ${lines[2]}`);
});

// An empty trailing column must not pad the row: the padding would show up as
// noise whenever the table is diffed, pasted or snapshotted.
test('the table has no trailing whitespace', () => {
  const at = new Date('2026-10-20T04:11:00Z');
  const due = new Date('2026-11-01T00:00:00Z');

  const first = new Task();
  first.id = '01J3ZQK8V9XW5S6R7T8Y9Z0A1B';
  first.kind = KindTask;
  first.title = 'Pay the invoice';
  first.status = StatusActive;
  first.dueAt = due;
  first.tags = ['finance'];
  first.createdAt = at;
  first.updatedAt = at;
  first.fields = { [KeyPriority]: 2 };

  // No due date, no tags, no flag: every optional column is empty.
  const second = new Task();
  second.id = '01J3ZQK8V9XW5S6R7T8Y9Z0A1C';
  second.kind = KindTask;
  second.title = 'Buy milk';
  second.status = StatusActive;
  second.createdAt = at;
  second.updatedAt = at;
  second.fields = {};

  const tasks = [first, second];
  const buf = new buffer();
  Table(buf, Rows(tasks));

  const out = buf.text;
  assert.ok(out.endsWith('\n'), 'the table does not end with a newline');
  out
    .replace(/\n$/, '')
    .split('\n')
    .forEach((line, i) => {
      assert.equal(
        line,
        line.replace(/[ \t]+$/, ''),
        `line ${i + 1} has trailing whitespace: ${JSON.stringify(line)}`,
      );
    });
  const lines = out.split('\n').length - 1;
  assert.equal(
    lines,
    tasks.length + 1,
    `table has ${lines} lines, want ${tasks.length + 1} (one header plus one row per task)`,
  );
});

test('a table with no tasks prints only the header', () => {
  const buf = new buffer();
  Table(buf, []);
  const got = buf.text.split('\n').length - 1;
  assert.equal(got, 1, `empty table has ${got} lines, want 1`);
});

test('detail lists every field', () => {
  const buf = new buffer();
  Detail(buf, new Row({ task: sampleTask() }), undefined);
  for (const want of [
    '01J3ZQK8V9XW5S6R7T8Y9Z0A1B',
    'Pay the invoice',
    'active',
    'client',
    'acme',
    'finance,ops',
  ]) {
    assert.ok(buf.text.includes(want), `detail is missing ${want}: ${buf.text}`);
  }
});

test('fieldText renders structured values', () => {
  const cases: Array<[string, JSONValue]> = [
    ['acme', 'acme'],
    ['1,2', [1, 2]],
    ['a,b', ['a', 'b']],
    ['{k=1 owner=a}', { owner: 'a', k: 1 }],
    ['3', 3],
  ];
  for (const [want, value] of cases) {
    const got = fieldText(value);
    assert.equal(got, want, `fieldText(${JSON.stringify(value)}) = ${got}, want ${want}`);
  }
});

// The layout itself, which the Go tests pinned only loosely: Go aligned these
// columns with text/tabwriter and this package carries its own port of it, so
// the exact bytes of a row are worth pinning rather than its width alone.
test('the table aligns every column to its widest cell plus two', () => {
  const at = new Date('2026-10-20T04:11:00Z');
  const t = sampleTask();
  t.flagged = true;
  const folder = new Task();
  folder.id = '01J3ZQK8V9XW5S6R7T8Y9Z0A1D';
  folder.kind = KindFolder;
  folder.title = 'Admin';
  folder.status = StatusActive;
  folder.createdAt = at;
  folder.updatedAt = at;

  const buf = new buffer();
  Table(buf, Rows([t, folder]));
  assert.equal(
    buf.text,
    '#  S   K  DUE         TITLE            TAGS\n' +
      '1   *     2026-11-01  Pay the invoice  finance,ops\n' +
      '2      f              Admin\n',
  );
});

test('a tree row indents the title out of its own column', () => {
  const deep = sampleTask();
  deep.title = 'Pay the invoice';
  const buf = new buffer();
  Table(buf, [new Row({ task: deep, depth: 2 })]);
  const row = buf.text.split('\n')[1] ?? '';
  // Two levels is four spaces of indent, and the title column is still 34
  // wide: the indent eats into the title, not into the terminal.
  assert.ok(row.includes('    Pay the invoice'), JSON.stringify(row));
});

test('a title longer than the column is cut with an ellipsis', () => {
  const long = sampleTask();
  long.title = 'x'.repeat(60);
  long.setTags([]);
  const buf = new buffer();
  Table(buf, Rows([long]));
  const row = buf.text.split('\n')[1] ?? '';
  // 34 columns: 33 characters and the ellipsis, which is one column wide.
  assert.ok(row.endsWith('x'.repeat(33) + '…'), JSON.stringify(row));
  assert.equal(Array.from(row.split('  ').pop() ?? '').length, 34);
});

// A title is user data. An escape sequence in it would colour the rest of the
// terminal and a carriage return would overwrite the row above.
test('control characters are escaped, and an astral title is one column per rune', () => {
  assert.equal(sanitize('ok'), 'ok');
  assert.equal(sanitize('a\tb\nc\rd\x1be\x00f\x7fg\x85h'), 'a\\tb\\nc\\rd\\ee\\x00f\\x7fg\\x85h');

  const astral = sampleTask();
  // Four code points, eight UTF-16 code units: counting units would make the
  // title column look twice as wide as it prints.
  astral.title = '\u{1f600}\u{1f600}\u{1f600}\u{1f600}';
  astral.setTags([]);
  const buf = new buffer();
  Table(buf, Rows([astral]));
  const row = buf.text.split('\n')[1] ?? '';
  assert.ok(row.endsWith('\u{1f600}\u{1f600}\u{1f600}\u{1f600}'), JSON.stringify(row));
});
