import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FileName, Lookup, Path, Save } from "./shortref.ts";

/**
 * setEnv is `t.Setenv`: it sets a variable for the duration of one test and
 * restores it afterwards. An empty string is set rather than deleted, because
 * the Go tests use `t.Setenv(name, "")` to mean "present but empty" and the
 * code under test treats that as unset.
 */
function setEnv(t: { after: (fn: () => void) => void }, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
}

/** tempDir is `t.TempDir`: a fresh directory removed when the test ends. */
function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shortref-"));
  t.after(() => {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Already gone, or never ours to change.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** isWindows guards the subtests whose question only POSIX can answer. */
const isWindows = os.platform() === "win32";

/** isRoot guards the subtests that permission bits do not constrain. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("Save and Lookup", (t) => {
  const dir = tempDir(t);
  setEnv(t, "TODOCLOUD_STATE_DIR", dir);

  const ids = ["01AAA", "01BBB", "01CCC"];
  Save("sqlite: /tmp/tasks.db", ids);

  for (const [i, want] of ids.entries()) {
    const got = Lookup("sqlite: /tmp/tasks.db", i + 1);
    assert.equal(got, want, `number ${i + 1}: got ${got}, want ${want}`);
  }
  assert.equal(
    Lookup("sqlite: /tmp/tasks.db", 4),
    undefined,
    "a number past the end of the listing must miss",
  );
  assert.equal(Lookup("sqlite: /tmp/tasks.db", 0), undefined, "numbering starts at one");
});

// Lookup is scoped to one store: that is the point of the key. A number read
// off a listing of one provider must never resolve against another.
test("Lookup is scoped to one store", (t) => {
  setEnv(t, "TODOCLOUD_STATE_DIR", tempDir(t));
  Save("sqlite: /tmp/one.db", ["01AAA"]);
  assert.equal(
    Lookup("sqlite: /tmp/two.db", 1),
    undefined,
    "a listing from another store must not resolve",
  );
});

test("Save uses owner-only permissions", { skip: isWindows }, (t) => {
  // A permission bit is a POSIX notion: on windows the reported mode says
  // nothing about the ACL, so this assertion has nothing to read there. The
  // same limit decides product behaviour in the file-token guard, where a
  // token in a file is refused rather than guarded.
  const dir = tempDir(t);
  setEnv(t, "TODOCLOUD_STATE_DIR", path.join(dir, "state"));
  Save("sqlite: /tmp/tasks.db", ["01AAA"]);

  const perm = fs.statSync(Path()).mode & 0o777;
  assert.equal(perm, 0o600, `file mode ${perm.toString(8)}, want 600`);
  const dirPerm = fs.statSync(path.dirname(Path())).mode & 0o777;
  assert.equal(dirPerm, 0o700, `directory mode ${dirPerm.toString(8)}, want 700`);
});

// Lookup never fails: every way the cache can be unusable comes back as a
// miss. Nothing here may throw.
test("Lookup never fails", (t) => {
  const dir = tempDir(t);
  setEnv(t, "TODOCLOUD_STATE_DIR", dir);

  assert.equal(Lookup("key", 1), undefined, "a missing file should miss");
  for (const content of ["", "{not json", "[]", '{"key":"key","ids":null}', '{"key":"key","ids":[""]}']) {
    fs.writeFileSync(Path(), content, { mode: 0o600 });
    assert.equal(Lookup("key", 1), undefined, `content ${content} should miss`);
  }
});

test("Path honours the state directory", (t) => {
  setEnv(t, "TODOCLOUD_STATE_DIR", "/tmp/explicit");
  assert.equal(Path(), path.join("/tmp/explicit", FileName));

  process.env["TODOCLOUD_STATE_DIR"] = "";
  setEnv(t, "XDG_STATE_HOME", "/tmp/xdg");
  assert.equal(Path(), path.join("/tmp/xdg", "todocloud", FileName));
});

// Path precedence pins the whole search order, including the home-relative
// default and the degraded case where there is no home directory at all. The
// default matters because it is the only branch a real user takes.
test("Path precedence", async (t) => {
  await t.test("state dir wins over XDG", (t) => {
    setEnv(t, "TODOCLOUD_STATE_DIR", "/tmp/state-dir");
    setEnv(t, "XDG_STATE_HOME", "/tmp/xdg");
    assert.equal(Path(), path.join("/tmp/state-dir", FileName));
  });

  await t.test("home relative default", (t) => {
    const home = tempDir(t);
    setEnv(t, "TODOCLOUD_STATE_DIR", "");
    setEnv(t, "XDG_STATE_HOME", "");
    setEnv(t, "HOME", home);
    // The home directory is read from USERPROFILE on windows and HOME
    // elsewhere, so both are pointed at the same directory and the subtest
    // asks the same question on every platform.
    setEnv(t, "USERPROFILE", home);
    assert.equal(Path(), path.join(home, ".local", "state", "todocloud", FileName));
  });

  await t.test("no home directory at all", { skip: isWindows }, (t) => {
    setEnv(t, "TODOCLOUD_STATE_DIR", "");
    setEnv(t, "XDG_STATE_HOME", "");
    setEnv(t, "HOME", "");
    // Without a home directory the path stays relative, which keeps a Save
    // failure local and harmless instead of writing somewhere odd.
    assert.equal(Path(), path.join(".todocloud", FileName));
  });
});

// Save replaces a file with loose modes: this records what actually happens to
// a cache file that already exists with group- and world-readable modes. The
// write goes through, and the replacement file carries the owner-only mode,
// because Save renames a fresh temporary file over it rather than writing in
// place.
test("Save replaces a file with loose modes", { skip: isWindows }, (t) => {
  const dir = tempDir(t);
  setEnv(t, "TODOCLOUD_STATE_DIR", dir);

  fs.writeFileSync(Path(), '{"key":"old","ids":["01OLD"]}', { mode: 0o666 });
  fs.chmodSync(Path(), 0o666);
  Save("sqlite: /tmp/new.db", ["01NEW"]);

  const perm = fs.statSync(Path()).mode & 0o777;
  assert.equal(perm, 0o600, `file mode ${perm.toString(8)} after replacing a 0666 file, want 600`);
  assert.equal(Lookup("sqlite: /tmp/new.db", 1), "01NEW");
  assert.equal(Lookup("old", 1), undefined, "the replaced listing is still resolving");
});

// Save reports a directory in the way without crashing. This is the one case
// where Save cannot do its job; the caller is allowed to ignore the failure,
// so the only requirement is that it is a thrown error and that Lookup still
// misses.
test("Save reports a directory in the way", (t) => {
  const dir = tempDir(t);
  setEnv(t, "TODOCLOUD_STATE_DIR", dir);

  // A directory where the cache file belongs, with something inside it so
  // that no platform can rename over it.
  fs.mkdirSync(Path(), { mode: 0o700 });
  fs.writeFileSync(path.join(Path(), "occupied"), "x", { mode: 0o600 });

  assert.throws(
    () => Save("key", ["01AAA"]),
    "Save reported success although the path is a non-empty directory",
  );
  // And the caller that ignores that error must still get a plain miss.
  assert.equal(Lookup("key", 1), undefined, "Lookup resolved against a directory");
});

// Save of an empty listing covers the absent slice: it is a legitimate listing
// of nothing, not an error, and it must clear whatever was cached before.
test("Save of an empty listing", (t) => {
  setEnv(t, "TODOCLOUD_STATE_DIR", tempDir(t));
  Save("key", ["01AAA"]);
  Save("key", null);
  assert.equal(Lookup("key", 1), undefined, "a number resolved against an empty listing");
  assert.equal(fs.readFileSync(Path(), "utf8"), '{"key":"key","ids":[]}\n');
});

// Save reports an unusable state directory: the two failures that happen
// before any byte is written — the directory cannot be created, and it cannot
// be written to. Neither may crash.
test("Save reports an unusable state directory", { skip: isWindows }, async (t) => {
  await t.test("a file where the directory belongs", (t) => {
    const dir = tempDir(t);
    const blocker = path.join(dir, "state");
    fs.writeFileSync(blocker, "not a directory", { mode: 0o600 });
    setEnv(t, "TODOCLOUD_STATE_DIR", blocker);
    assert.throws(
      () => Save("key", ["01AAA"]),
      "Save reported success although the state directory is a file",
    );
  });

  await t.test("an unwritable directory", { skip: isRoot }, (t) => {
    const dir = tempDir(t);
    const state = path.join(dir, "state");
    fs.mkdirSync(state, { mode: 0o500 });
    t.after(() => {
      // Make it removable again. The temporary directory's own cleanup may
      // already have taken it, since these hooks run in the order they were
      // registered rather than in reverse.
      try {
        fs.chmodSync(state, 0o700);
      } catch {
        // Already gone.
      }
    });
    setEnv(t, "TODOCLOUD_STATE_DIR", state);
    assert.throws(
      () => Save("key", ["01AAA"]),
      "Save reported success although the state directory is read-only",
    );
  });
});

// Lookup never fails on hostile input either: this extends the corruption
// table above with the cases that come from the filesystem rather than the
// file's bytes.
test("Lookup never fails on hostile input", async (t) => {
  await t.test("truncated json", (t) => {
    setEnv(t, "TODOCLOUD_STATE_DIR", tempDir(t));
    fs.writeFileSync(Path(), '{"key":"k","ids":["01AAA","01BB', { mode: 0o600 });
    assert.equal(Lookup("k", 1), undefined, "a truncated listing resolved");
  });

  await t.test("empty file", (t) => {
    setEnv(t, "TODOCLOUD_STATE_DIR", tempDir(t));
    fs.writeFileSync(Path(), "", { mode: 0o600 });
    assert.equal(Lookup("k", 1), undefined, "an empty file resolved");
  });

  await t.test("directory in place of the file", (t) => {
    setEnv(t, "TODOCLOUD_STATE_DIR", tempDir(t));
    fs.mkdirSync(Path(), { mode: 0o700 });
    assert.equal(Lookup("k", 1), undefined, "a directory resolved");
  });

  await t.test("unreadable file", { skip: isWindows || isRoot }, (t) => {
    setEnv(t, "TODOCLOUD_STATE_DIR", tempDir(t));
    fs.writeFileSync(Path(), '{"key":"k","ids":["01AAA"]}');
    fs.chmodSync(Path(), 0o000);
    assert.equal(Lookup("k", 1), undefined, "an unreadable file resolved");
  });

  await t.test("a very long listing", (t) => {
    setEnv(t, "TODOCLOUD_STATE_DIR", tempDir(t));
    const count = 100_000;
    const ids = Array.from({ length: count }, (_unused, i) => `01${i}`);
    Save("big", ids);
    assert.equal(Lookup("big", count), ids[count - 1], `the last of ${count} ids`);
    assert.equal(
      Lookup("big", count + 1),
      undefined,
      "a number past the end of a long listing resolved",
    );
  });
});

// Concurrent Save and Lookup runs the cache the way two shells sharing a state
// directory would. Save writes a temporary file and renames it over the
// target, so a reader must see one whole listing or none — never a
// half-written one.
//
// Go runs the writers as goroutines; here they are interleaved async tasks,
// because the filesystem calls are synchronous and JavaScript has no second
// thread to put them on. What the test still covers is the invariant the Go
// test ends on: whatever is left on disk is one complete listing, and no
// temporary file survives a finished Save.
test("concurrent Save and Lookup", async (t) => {
  const dir = tempDir(t);
  setEnv(t, "TODOCLOUD_STATE_DIR", dir);

  const rounds = 200;
  const keys = ["sqlite: /tmp/one.db", "sqlite: /tmp/two.db"];

  const writers = keys.map(async (key, w) => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      const ids = [`01WRITER${w}ITEM${i}`, "01SECOND"];
      try {
        // A failure is allowed — two writers may collide — but it must never
        // leave a partial file behind.
        Save(key, ids);
      } catch {
        // Ignored, exactly as the caller ignores it.
      }
    }
  });

  const reader = (async () => {
    for (let i = 0; i < rounds * 2; i++) {
      await Promise.resolve();
      for (const key of keys) {
        // Either a hit or a miss is correct; only a crash is not.
        Lookup(key, 1);
      }
    }
  })();

  await Promise.all([...writers, reader]);

  // Whatever is on disk at the end must parse: either nothing, or one
  // complete listing from one of the writers.
  let data: string;
  try {
    data = fs.readFileSync(Path(), "utf8");
  } catch (err) {
    assert.equal(
      (err as { code?: string }).code,
      "ENOENT",
      `reading the cache after concurrent writes: ${String(err)}`,
    );
    return;
  }
  const listing = JSON.parse(data) as { key?: unknown; ids?: unknown };
  assert.ok(
    keys.includes(listing.key as string),
    `the cache names a store no writer used: ${String(listing.key)}`,
  );
  assert.ok(Array.isArray(listing.ids), `the cache holds no listing: ${data}`);
  assert.equal(listing.ids.length, 2, `the cache holds a partial listing: ${data}`);
  assert.equal(listing.ids[1], "01SECOND", `the cache holds a partial listing: ${data}`);

  // No temporary file may be left behind by a completed Save.
  for (const entry of fs.readdirSync(dir)) {
    assert.equal(entry, FileName, `Save left ${entry} behind in the state directory`);
  }
});
