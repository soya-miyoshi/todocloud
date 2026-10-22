// The real stdin reader, driven through a real child process.
//
// A terminal's Enter is not an end of input: the pipe stays open after the
// user answers. `tdo login` once read stdin to EOF for its "[y/N]" prompt and
// sat there until Ctrl-D, which no test caught because every test handed the
// command a reader that had already ended. These tests keep the pipe open.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const script = `
import { processStdin } from ${JSON.stringify(new URL('./app.ts', import.meta.url).href)};
const line = await processStdin.readLine();
process.stdout.write(JSON.stringify(line) + '\\n');
`;

/**
 * readLineFrom runs processStdin.readLine in a child whose stdin is a pipe
 * that this test writes to and does not close, as a terminal's would be.
 * Rejects if the child has not answered within the deadline, which is the
 * hang this file exists to catch.
 */
function readLineFrom(
  write: string,
  closeAfter: boolean,
): Promise<{ line: string; stillOpen: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    // The answer is the first line on stdout. The child is not waited on to
    // exit: whether a paused pipe lets a process end is the runtime's affair,
    // and `main` ends the real process itself.
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      out += c;
      if (out.includes('\n')) {
        clearTimeout(deadline);
        child.kill('SIGKILL');
        resolve({ line: JSON.parse(out) as string, stillOpen: !closeAfter });
      }
    });
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('readLine did not return while stdin was still open'));
    }, 5_000);
    child.stdin.write(write);
    if (closeAfter) {
      child.stdin.end();
    }
  });
}

test('readLine returns at the newline while stdin stays open', async () => {
  const got = await readLineFrom('y\nsecond line\n', false);
  assert.equal(got.line, 'y\n');
  assert.ok(got.stillOpen);
});

test('readLine returns what arrived when the input ends without a newline', async () => {
  const got = await readLineFrom('yes', true);
  assert.equal(got.line, 'yes');
});

test('readLine on an empty input returns the empty string', async () => {
  const got = await readLineFrom('', true);
  assert.equal(got.line, '');
});
