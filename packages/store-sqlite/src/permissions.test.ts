import assert from 'node:assert/strict';
import { chmodSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { New } from '@todocloud/core/id';

import { fileMode, MemoryPath, open, openExisting, secureFiles } from './sqlite.ts';
import { newTask, tempDir } from './testsupport.ts';

// A permission bit is a POSIX notion: on Windows the mode a stat reports has
// nothing to do with the ACL that decides access, so these assertions have
// nothing to read there. The same limit decides product behaviour in the
// config package, where a token in a file is refused rather than guarded.
const posixOnly = process.platform === 'win32' ? 'POSIX only' : false;

/** assertMode is Go's assertMode: the permission bits, and nothing else. */
function assertMode(path: string, want: number): void {
  const got = statSync(path).mode & 0o777;
  assert.equal(
    got,
    want,
    `${path} has mode ${got.toString(8).padStart(4, '0')}, want ${want.toString(8).padStart(4, '0')}`,
  );
}

/**
 * withUmask runs fn with the process umask set to mask and restores it
 * afterwards. Go's test called syscall.Umask directly; `process.umask` is the
 * same call, and the umask is per process, so a test file that sets it must
 * put it back.
 */
function withUmask(mask: number, fn: () => Promise<void>): Promise<void> {
  const old = process.umask(mask);
  return fn().finally(() => {
    process.umask(old);
  });
}

// A task list is private data, and SQLite creates its files with the process
// umask — which on a typical machine means world-readable. Everything this
// store writes has to be 0600 regardless of the umask it inherited.
//
// The Go test pinned the one umask that proves the point, 0o000. The port
// walks three, because `node:sqlite` has no mode option at all and neither
// has `fs.writeFileSync` or `openSync` — a mode passed to any of them is
// masked by the umask — so the only thing standing between a permissive umask
// and a world-readable task list is the `chmodSync` in secureFiles, which the
// umask does not touch.
for (const umask of [0o000, 0o022, 0o077]) {
  test(
    `files created under umask ${umask.toString(8).padStart(3, '0')} are not readable by others`,
    { skip: posixOnly },
    async (t) => {
      const root = tempDir(t);
      await withUmask(umask, async () => {
        const dir = join(root, 'data');
        const path = join(dir, 'tasks.db');

        const s = open(path);
        t.after(() => s.close());
        await s.init();
        // A write forces the WAL files into existence, which are the ones
        // that come and go and would otherwise be missed.
        const now = new Date();
        const tk = newTask(New(), 'private');
        tk.createdAt = now;
        tk.updatedAt = now;
        await s.add(tk);

        assertMode(dir, 0o700);
        assertMode(path, fileMode);
        for (const suffix of ['-wal', '-shm']) {
          const journal = `${path}${suffix}`;
          if (existsSync(journal)) {
            assertMode(journal, fileMode);
          }
        }
      });
    },
  );
}

// An existing database whose mode is loose gets tightened when it is opened,
// because a file that was created before this behaviour existed — or by a
// restore from a backup — is just as readable as a new one.
test('opening tightens a loose mode', { skip: posixOnly }, async (t) => {
  const path = join(tempDir(t), 'tasks.db');
  const s = open(path);
  await s.init();
  await s.close();

  chmodSync(path, 0o644);

  const reopened = openExisting(path);
  t.after(() => reopened.close());
  assertMode(path, fileMode);
});

// A mode that is already tight is left exactly as it is: secureFiles only
// touches a file that is readable or writable by someone else, so a user who
// has deliberately made their store 0400 keeps it.
test('a mode nobody else can read is left alone', { skip: posixOnly }, async (t) => {
  const path = join(tempDir(t), 'tasks.db');
  const s = open(path);
  await s.init();
  await s.close();

  chmodSync(path, 0o400);
  secureFiles(path);
  assertMode(path, 0o400);
});

// The umask masks a mode that is asked for; it cannot add bits back. This
// pins the reason secureFiles exists at all: a file written with mode 0600
// under a permissive umask is 0600, but one SQLite created is not, and only
// the chmod afterwards makes it so.
test('a mode asked for at creation time is masked, a chmod is not', { skip: posixOnly }, async (t) => {
  const dir = tempDir(t);
  await withUmask(0o077, async () => {
    const path = join(dir, 'probe');
    writeFileSync(path, 'placeholder', { mode: 0o666 });
    try {
      assert.equal(
        statSync(path).mode & 0o777,
        0o600,
        'the umask must have masked the mode writeFileSync asked for',
      );
      chmodSync(path, 0o666);
      assert.equal(
        statSync(path).mode & 0o777,
        0o666,
        'chmod is not masked by the umask, which is why secureFiles uses it',
      );
    } finally {
      rmSync(path, { force: true });
    }
  });
});

// Tightening must never be a reason to refuse: a store on a filesystem that
// does not support chmod still has to open.
test('a failed chmod does not fail the open', async (t) => {
  const path = join(tempDir(t), 'tasks.db');
  const st = open(path);
  await st.init();
  await st.close();

  // secureFiles is called on every open and ignores its failures; calling it
  // against a store whose files are gone exercises that path.
  secureFiles(join(tempDir(t), 'missing', 'tasks.db')); // must not throw

  secureFiles(MemoryPath); // must not throw, and has nothing to chmod
});
