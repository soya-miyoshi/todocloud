// The real `security` and `secret-tool` binaries are never executed by
// anything in this file. Instead a shell script of that name is put at the
// front of PATH, so the module's own spawns reach a stand-in whose output each
// test chooses. That is what makes the read, write and delete paths testable
// at all: the developer's keychain is neither read nor written, which
// CLAUDE.md §1.5 requires, and the results do not depend on what is in it.
//
// The Go tests got one platform per run from the build tags. The port
// dispatches on `process.platform` instead, so `forTest.setPlatform` picks the
// branch and every test here runs on macOS and on Linux alike.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { REDACTED, Secret } from "@todocloud/core/secret";
import {
  AccountD1Token,
  AccountTursoToken,
  Available,
  Backend,
  BackendKeychain,
  BackendNone,
  BackendSecretTool,
  Delete,
  ErrUnavailable,
  ErrWriteUnsupported,
  Get,
  Is,
  ManualInstructions,
  Placeholder,
  Service,
  Set as Store,
  forTest,
} from "./keyring.ts";

/**
 * sentinelKeyringToken is the fake credential these tests feed through the
 * module. It is obviously not a real token, and no error message, no argv
 * element and no instruction string may ever contain it.
 */
const sentinelKeyringToken = "TOKEN_GOES_HERE_keyring_7f3a";

/**
 * fakeToken is what the argv and helper tests store or inspect. It is
 * obviously not a credential.
 */
const fakeToken = "FAKE-TOKEN-not-a-real-credential-0000";

/** Hooks is the slice of node:test's context these helpers need. */
interface Hooks {
  after: (fn: () => void) => void;
}

/** scripted is one stand-in child's behaviour, and where it records itself. */
interface Scripted {
  /** stdout and stderr are what the child writes on each stream. */
  stdout?: string;
  stderr?: string;
  /** exitCode is the status it exits with. */
  exitCode?: number;
}

/** Fake is an installed stand-in: the files it records into. */
interface Fake {
  /** argv returns the arguments the child was given, one per line. */
  argv(): string[] | null;
  /** stdin returns everything written to the child's standard input. */
  stdin(): string;
}

/**
 * isWindows guards the tests that run the stand-in child.
 *
 * The stand-in is a `#!/bin/sh` script put at the front of PATH, which is
 * what makes the read, write and delete paths testable without touching
 * anybody's keychain. Windows has no `/bin/sh` and does not take a script as
 * an executable, so those spawns are an ENOENT there and the test fails for a
 * reason that is not about this module. There is nothing lost: the keyring's
 * Windows branch has no backend at all — `Backend()` is `BackendNone` and
 * `Available()` is false — and the tests that assert exactly that do not
 * spawn anything and run everywhere.
 */
const isWindows = process.platform === "win32";

/** shellTest is `test`, skipped where the stand-in child cannot run. */
function shellTest(name: string, fn: (t: Hooks & TestContext) => void): void {
  test(
    name,
    { skip: isWindows ? "the stand-in child is a /bin/sh script" : false },
    fn,
  );
}

/**
 * installFake writes the script for `bin`, puts its directory at the front of
 * PATH and forces `platform`, restoring both when the test ends.
 */
function installFake(
  t: Hooks,
  platform: string,
  bin: string,
  scripted: Scripted = {},
): Fake {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyring-"));
  const argvPath = path.join(dir, "argv");
  const stdinPath = path.join(dir, "stdin");
  const stdout = scripted.stdout ?? "";
  const stderr = scripted.stderr ?? "";

  // Single-quoted shell literals, so nothing in the scripted output is
  // re-interpreted. None of the fixtures contains a quote.
  for (const s of [stdout, stderr]) {
    assert.ok(
      !s.includes("'"),
      `a fixture with a single quote cannot be embedded in the script: ${JSON.stringify(s)}`,
    );
  }
  const script =
    "#!/bin/sh\n" +
    `for arg in "$@"; do printf '%s\\n' "$arg" >> '${argvPath}'; done\n` +
    `cat >> '${stdinPath}' 2>/dev/null\n` +
    `printf '%s' '${stdout}'\n` +
    `printf '%s' '${stderr}' >&2\n` +
    `exit ${scripted.exitCode ?? 0}\n`;
  fs.writeFileSync(path.join(dir, bin), script, { mode: 0o700 });

  usePath(t, dir + path.delimiter + (process.env["PATH"] ?? ""));
  usePlatform(t, platform);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return {
    argv(): string[] | null {
      return readLines(argvPath);
    },
    stdin(): string {
      try {
        return fs.readFileSync(stdinPath, "utf8");
      } catch {
        return "";
      }
    },
  };
}

function readLines(file: string): string[] | null {
  let data: string;
  try {
    data = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = data.replace(/\n$/u, "").split("\n");
  if (lines.length === 1 && lines[0] === "") {
    return null;
  }
  return lines;
}

/** usePath sets PATH for the duration of one test, as `t.Setenv` would. */
function usePath(t: Hooks, value: string): void {
  const previous = process.env["PATH"];
  process.env["PATH"] = value;
  t.after(() => {
    if (previous === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = previous;
    }
  });
}

/** usePlatform forces one platform's branch for the duration of one test. */
function usePlatform(t: Hooks, platform: string): void {
  forTest.setPlatform(platform);
  t.after(() => forTest.setPlatform(null));
}

/**
 * looksGenerated approximates "this could be mistaken for a real token": long,
 * and mixing cases with digits the way an issued credential does. Command
 * names and flags do not.
 */
function looksGenerated(field: string): boolean {
  if (field.length < 16) {
    return false;
  }
  return /[A-Z]/u.test(field) && /[a-z]/u.test(field) && /[0-9]/u.test(field);
}

// --- the platform-independent helpers ----------------------------------

test("trimOneNewline removes exactly one terminator", () => {
  const cases: Array<[name: string, input: string, want: string]> = [
    ["unix terminator", "abc\n", "abc"],
    ["windows terminator", "abc\r\n", "abc"],
    ["only one of two", "abc\n\n", "abc\n"],
    ["no terminator", "abc", "abc"],
    ["trailing space is part of the value", "abc \n", "abc "],
    ["leading space is part of the value", " abc\n", " abc"],
    ["interior newline survives", "a\nb\n", "a\nb"],
    ["empty", "", ""],
    ["just a terminator", "\n", ""],
  ];
  for (const [name, input, want] of cases) {
    assert.equal(forTest.trimOneNewline(input), want, name);
  }
});

test("the not-found status cannot be mistaken for an ordinary failure", () => {
  // The not-found code is 44 on macOS and is never produced by a plain
  // failure, which exits 1.
  assert.notEqual(
    forTest.notFoundExitCode,
    1,
    "the not-found code must not collide with an ordinary failure",
  );
});

test("childError never carries the child's stdout", () => {
  // The child's stdout holds the token on a read, so childError takes only
  // stderr. Feeding it the token as stderr proves the scrubbed path is the
  // only way a value could appear, and that this call site cannot.
  const ran = {
    code: 1,
    stdout: sentinelKeyringToken,
    stderr: "the item could not be read",
    error: undefined,
  };
  const got = forTest.childError("security", ran, ran.stderr).message;
  assert.ok(!got.includes(sentinelKeyringToken), got);
  assert.match(got, /status 1/u);

  // A child that never ran reports the start failure instead of a status.
  const never = {
    code: -1,
    stdout: sentinelKeyringToken,
    stderr: "",
    error: new Error("spawn ENOENT"),
  };
  const startFailure = forTest.childError("security", never, "").message;
  assert.ok(!startFailure.includes(sentinelKeyringToken), startFailure);
  assert.match(startFailure, /security: spawn ENOENT/u);
});

test("scrub removes the value from diagnostics", () => {
  const got = forTest.scrub(
    `security: bad value ${sentinelKeyringToken} rejected`,
    new Secret(sentinelKeyringToken),
  );
  assert.ok(!got.includes(sentinelKeyringToken), got);
  assert.ok(got.includes(REDACTED), got);
  assert.equal(forTest.scrub("unchanged", new Secret("")), "unchanged");
});

test("lexicallySafe rejects anything needing quoting", () => {
  // A real Turso token is a JWT, so the characters one is made of have to
  // pass: dots, dashes, underscores and the base64url padding set. The
  // fixture spells them out instead of looking like a token, because an
  // obviously fake placeholder is what CLAUDE.md §1.3 requires and what
  // keeps a credential scanner from flagging this file.
  for (const v of [
    "abc123",
    "TOKEN_GOES_HERE.part-two_three.sig-_~+/=",
    "libsql:token",
  ]) {
    assert.ok(forTest.lexicallySafe(v), v);
  }
  for (const v of [
    "",
    "has space",
    'quote"d',
    "back\\slash",
    "new\nline",
    "semi;colon",
    "tab\there",
    "dollar$sign",
    "'quoted'",
  ]) {
    assert.ok(!forTest.lexicallySafe(v), JSON.stringify(v));
  }
});

test("Is walks the cause chain the way errors.Is did", () => {
  assert.ok(Is(ErrUnavailable, ErrUnavailable));
  assert.ok(
    Is(new Error("wrapped", { cause: ErrWriteUnsupported }), ErrWriteUnsupported),
  );
  assert.ok(!Is(new Error("unrelated"), ErrUnavailable));
  assert.ok(!Is(ErrUnavailable, ErrWriteUnsupported));
  assert.ok(!Is(undefined, ErrUnavailable));
});

// --- the rule this module exists for -----------------------------------

test("no token reaches argv, on either writable platform", () => {
  const value = new Secret(fakeToken);
  for (const platform of ["darwin", "linux"]) {
    for (const account of [AccountTursoToken, AccountD1Token]) {
      const cmd = forTest.setCommand(platform, account, value);
      const joined = [cmd.bin, ...cmd.args].join(" ");
      assert.ok(!joined.includes(fakeToken), `the token reached argv: ${joined}`);
      for (const arg of cmd.args) {
        assert.ok(!arg.includes(fakeToken), `the token reached argv element ${arg}`);
      }
      assert.ok(
        cmd.stdin !== undefined && cmd.stdin.includes(fakeToken),
        "the token did not reach the child's stdin, so it would be stored empty",
      );
    }
  }
});

// TestDarwinSetExecsSecurityInteractively records the finding this platform's
// implementation rests on: the write goes through `security -i`, whose argv is
// only the two fixed arguments, because add-generic-password takes the
// password from -w or /dev/tty and ignores piped stdin.
test("the darwin write execs security interactively", () => {
  const cmd = forTest.setCommand("darwin", AccountTursoToken, new Secret(fakeToken));
  assert.equal([cmd.bin, ...cmd.args].join(" "), "security -i");
  assert.ok(
    cmd.stdin?.startsWith(
      `add-generic-password -s ${Service} -a ${AccountTursoToken} -U -w `,
    ),
    `unexpected stdin script: ${forTest.scrub(cmd.stdin ?? "", new Secret(fakeToken))}`,
  );
});

// TestLinuxSetPassesTheSecretOnStdinOnly pins the one property that makes
// secret-tool usable: it takes the secret from stdin, so argv holds only the
// attribute names.
test("the linux write passes the secret on stdin only", () => {
  const cmd = forTest.setCommand("linux", AccountD1Token, new Secret(fakeToken));
  const joined = [cmd.bin, ...cmd.args].join(" ");
  assert.ok(!joined.includes(fakeToken), `the token reached argv: ${joined}`);
  assert.ok(joined.includes("store") && joined.includes(AccountD1Token), joined);
  assert.equal(
    cmd.stdin,
    fakeToken,
    "the secret written to stdin is not the token as given",
  );
});

// --- the shared front door ---------------------------------------------

shellTest("an unknown account is rejected before any child runs", (t) => {
  const fake = installFake(t, "darwin", forTest.securityBin);
  // An account name shaped like a flag must never reach a child's argv.
  const hostile = "-w";
  assert.throws(() => Get(hostile), /unknown keyring account/u);
  assert.throws(() => Store(hostile, new Secret(fakeToken)), /unknown keyring account/u);
  assert.throws(() => Delete(hostile), /unknown keyring account/u);
  assert.equal(fake.argv(), null, "a rejected account still ran a child");
});

shellTest("Set refuses an empty token", (t) => {
  installFake(t, "darwin", forTest.securityBin);
  assert.throws(
    () => Store(AccountTursoToken, new Secret("")),
    /refusing to store an empty token/u,
  );
});

test("the backend is none when the binary is absent", (t) => {
  forTest.setLookPath(() => null);
  t.after(() => forTest.setLookPath(null));

  for (const platform of ["darwin", "linux"]) {
    usePlatform(t, platform);
    assert.equal(Backend(), BackendNone, platform);
    assert.equal(Available(), false, platform);

    for (const call of [
      () => Get(AccountTursoToken),
      () => Store(AccountTursoToken, new Secret(fakeToken)),
      () => Delete(AccountTursoToken),
    ]) {
      assert.throws(call, (err: unknown) => Is(err, ErrUnavailable), platform);
    }
  }
});

test("the backend matches the platform", () => {
  const want = { darwin: BackendKeychain, linux: BackendSecretTool }[
    process.platform as string
  ];
  if (want === undefined) {
    assert.equal(Backend(), BackendNone);
    return;
  }
  if (!Available()) {
    // No keychain binary on this machine, which is not a failure.
    return;
  }
  assert.equal(Backend(), want);
});

test("the manual instructions hold a placeholder and no realistic token", () => {
  for (const platform of ["darwin", "linux", "win32", "freebsd"]) {
    for (const account of [AccountTursoToken, AccountD1Token]) {
      const got = forTest.manualInstructionsFor(platform, account);
      assert.ok(got.includes(Placeholder), `${platform}: ${got}`);
      assert.ok(got.includes(account), `${platform}: ${got}`);
      assert.ok(!got.includes(sentinelKeyringToken), `${platform}: ${got}`);
      // A placeholder has to be unmistakable, so nothing else in the string
      // may look like a generated credential.
      for (const field of got.split(/\s+/u)) {
        assert.ok(
          field === Placeholder || !looksGenerated(field),
          `instructions contain a realistic-looking token ${field}: ${got}`,
        );
      }
    }
  }
});

test("ManualInstructions answers for the running platform", (t) => {
  usePlatform(t, "darwin");
  assert.match(ManualInstructions(AccountTursoToken), /^security add-generic-password/u);
  forTest.setPlatform("linux");
  assert.match(ManualInstructions(AccountTursoToken), /secret-tool store/u);
  forTest.setPlatform("win32");
  assert.match(ManualInstructions(AccountTursoToken), /no OS keychain is available/u);
});

// --- darwin, against a fake `security` ---------------------------------

shellTest("Get reads the value the child prints", (t) => {
  const cases: Array<[name: string, stdout: string, want: string]> = [
    ["unix terminator", `${sentinelKeyringToken}\n`, sentinelKeyringToken],
    ["windows terminator", `${sentinelKeyringToken}\r\n`, sentinelKeyringToken],
    ["no terminator", sentinelKeyringToken, sentinelKeyringToken],
    [
      "two terminators keep one",
      `${sentinelKeyringToken}\n\n`,
      `${sentinelKeyringToken}\n`,
    ],
    // A stored value that happens to be the redaction marker is still a
    // value: it must come back as it was stored, and still be unprintable.
    ["the redaction marker itself", `${REDACTED}\n`, REDACTED],
  ];
  for (const [name, stdout, want] of cases) {
    t.test(name, (sub) => {
      installFake(sub, "darwin", forTest.securityBin, { stdout });
      const { value, present } = Get(AccountTursoToken);
      assert.ok(present, "Get reported no entry although the child printed one");
      assert.equal(value.reveal(), want);
      // Whatever the value is, rendering it must not disclose it.
      assert.equal(String(value), REDACTED);
    });
  }
});

shellTest("the read argv never carries a secret", (t) => {
  const fake = installFake(t, "darwin", forTest.securityBin, {
    stdout: `${sentinelKeyringToken}\n`,
  });
  Get(AccountD1Token);
  assert.deepEqual(fake.argv(), [
    "find-generic-password",
    "-s",
    Service,
    "-a",
    AccountD1Token,
    "-w",
  ]);
});

shellTest("Get reports a missing entry as an absence", (t) => {
  const cases: Array<[name: string, scripted: Scripted]> = [
    ["the documented not-found status", { exitCode: forTest.notFoundExitCode }],
    // An item that exists with an empty password is not a usable credential;
    // reporting it as present would hide the real problem.
    ["an entry with an empty password", { stdout: "\n" }],
    ["no output at all", {}],
  ];
  for (const [name, scripted] of cases) {
    t.test(name, (sub) => {
      installFake(sub, "darwin", forTest.securityBin, scripted);
      const { value, present } = Get(AccountTursoToken);
      assert.equal(present, false, "a missing entry was reported as present");
      assert.ok(value.empty(), "a missing entry produced a non-empty secret");
    });
  }
});

// This is the test that matters most here: on a read the child's stdout *is*
// the token, so an error built from a failed read may report the status and
// stderr and nothing else.
shellTest("a genuine read failure is reported without the child's stdout", (t) => {
  installFake(t, "darwin", forTest.securityBin, {
    stdout: sentinelKeyringToken,
    stderr: "SecKeychainSearchCopyNext: the keychain is locked",
    exitCode: 1,
  });
  assert.throws(
    () => Get(AccountTursoToken),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(!message.includes(sentinelKeyringToken), message);
      assert.match(message, /status 1/u);
      assert.match(message, /the keychain is locked/u);
      return true;
    },
    "a locked keychain was reported as a plain absence",
  );
});

// This test and the next cover the two remaining shapes of a child failure:
// one that says nothing, and one that never ran at all. Neither may fall back
// to quoting stdout.
shellTest("a read failure without stderr still reports the status", (t) => {
  installFake(t, "darwin", forTest.securityBin, {
    stdout: sentinelKeyringToken,
    exitCode: 2,
  });
  assert.throws(() => Get(AccountTursoToken), (err: unknown) => {
    const message = (err as Error).message;
    assert.ok(!message.includes(sentinelKeyringToken), message);
    assert.match(message, /status 2/u);
    return true;
  });
});

test("a read failure when the binary cannot be executed", (t) => {
  // A `security` on PATH that the kernel cannot execute: the backend is
  // detected, but the child never starts, so the failure is not an exit
  // status. PATH is replaced rather than prepended, so that no fallback to
  // the machine's real `security` is possible.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyring-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, forTest.securityBin), "\x00\x01 not a program\n", {
    mode: 0o755,
  });
  usePath(t, dir);
  usePlatform(t, "darwin");

  assert.throws(
    () => Get(AccountTursoToken),
    (err: unknown) => {
      assert.match((err as Error).message, new RegExp(forTest.securityBin, "u"));
      return true;
    },
    "an unexecutable binary was reported as an absence",
  );
});

shellTest("Set sends the secret on stdin and not in argv", (t) => {
  const fake = installFake(t, "darwin", forTest.securityBin);
  Store(AccountTursoToken, new Secret(sentinelKeyringToken));

  const argv = fake.argv();
  assert.deepEqual(argv, ["-i"], "argv must be just -i");
  for (const arg of argv ?? []) {
    assert.ok(!arg.includes(sentinelKeyringToken), `the token reached argv element ${arg}`);
  }
  const stdin = fake.stdin();
  assert.ok(
    stdin.includes(sentinelKeyringToken),
    "the token did not reach the child's stdin, so it would be stored empty",
  );
  assert.ok(
    stdin.startsWith(
      `add-generic-password -s ${Service} -a ${AccountTursoToken} -U -w `,
    ),
    `unexpected stdin script: ${forTest.scrub(stdin, new Secret(sentinelKeyringToken))}`,
  );
});

shellTest("Set refuses a value it cannot pass safely", (t) => {
  const fake = installFake(t, "darwin", forTest.securityBin);
  assert.throws(
    () => Store(AccountTursoToken, new Secret("TOKEN GOES HERE with spaces")),
    (err: unknown) => {
      assert.ok(Is(err, ErrWriteUnsupported), String(err));
      assert.ok(!(err as Error).message.includes("with spaces"), "the error quoted the value");
      return true;
    },
  );
  assert.equal(fake.argv(), null, "a refused value still ran a child");
});

// A child that echoes its input back on stderr is the one way a write could
// disclose the token through an error.
shellTest("Set scrubs the value out of a failed child's diagnostics", (t) => {
  installFake(t, "darwin", forTest.securityBin, {
    stderr: `add-generic-password: rejected ${sentinelKeyringToken}`,
    exitCode: 1,
  });
  assert.throws(
    () => Store(AccountD1Token, new Secret(sentinelKeyringToken)),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(!message.includes(sentinelKeyringToken), message);
      assert.ok(message.includes(REDACTED), message);
      return true;
    },
    "a failed child was reported as a successful write",
  );
});

shellTest("Delete outcomes", (t) => {
  t.test("success", (sub) => {
    const fake = installFake(sub, "darwin", forTest.securityBin);
    Delete(AccountTursoToken);
    assert.deepEqual(fake.argv(), [
      "delete-generic-password",
      "-s",
      Service,
      "-a",
      AccountTursoToken,
    ]);
  });

  t.test("a missing entry is not an error", (sub) => {
    installFake(sub, "darwin", forTest.securityBin, {
      exitCode: forTest.notFoundExitCode,
    });
    Delete(AccountD1Token);
  });

  t.test("a genuine failure is reported", (sub) => {
    installFake(sub, "darwin", forTest.securityBin, {
      stdout: sentinelKeyringToken,
      stderr: "the keychain is locked",
      exitCode: 1,
    });
    assert.throws(
      () => Delete(AccountTursoToken),
      (err: unknown) => {
        assert.ok(!(err as Error).message.includes(sentinelKeyringToken), "stdout leaked");
        return true;
      },
      "a locked keychain was reported as a successful delete",
    );
  });
});

shellTest("the keychain backend is detected from PATH", (t) => {
  installFake(t, "darwin", forTest.securityBin);
  assert.equal(Backend(), BackendKeychain);
  assert.ok(Available());
});

// --- linux, against a fake `secret-tool` -------------------------------

shellTest("the secret-tool backend is detected from PATH", (t) => {
  installFake(t, "linux", forTest.secretToolBin);
  assert.equal(Backend(), BackendSecretTool);
  assert.ok(Available());
});

shellTest("the linux read returns the looked-up value", (t) => {
  const fake = installFake(t, "linux", forTest.secretToolBin, {
    stdout: `${sentinelKeyringToken}\n`,
  });
  const { value, present } = Get(AccountTursoToken);
  assert.ok(present);
  assert.equal(value.reveal(), sentinelKeyringToken);
  assert.deepEqual(fake.argv(), [
    "lookup",
    "service",
    Service,
    "account",
    AccountTursoToken,
  ]);
});

// `secret-tool lookup` reports a missing item with a non-zero status and
// nothing on either stream, which only linuxGet distinguishes. The Go suite
// could never reach this branch from a macOS run.
shellTest("the linux read reads a silent non-zero exit as an absence", (t) => {
  installFake(t, "linux", forTest.secretToolBin, { exitCode: 1 });
  const { value, present } = Get(AccountD1Token);
  assert.equal(present, false);
  assert.ok(value.empty());
});

shellTest("the linux read reports a failure that says something on stderr", (t) => {
  installFake(t, "linux", forTest.secretToolBin, {
    stdout: sentinelKeyringToken,
    stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY",
    exitCode: 1,
  });
  assert.throws(
    () => Get(AccountTursoToken),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(!message.includes(sentinelKeyringToken), message);
      assert.match(message, /D-Bus/u);
      return true;
    },
  );
});

shellTest("the linux write sends the secret on stdin and not in argv", (t) => {
  const fake = installFake(t, "linux", forTest.secretToolBin);
  Store(AccountD1Token, new Secret(sentinelKeyringToken));

  const argv = fake.argv() ?? [];
  for (const arg of argv) {
    assert.ok(!arg.includes(sentinelKeyringToken), `the token reached argv element ${arg}`);
  }
  assert.deepEqual(argv, [
    "store",
    `--label=${Service} ${AccountD1Token}`,
    "service",
    Service,
    "account",
    AccountD1Token,
  ]);
  // secret-tool stops at the first newline, so the value is written alone.
  assert.equal(fake.stdin(), sentinelKeyringToken);
});

shellTest("the linux write scrubs a failed child's diagnostics", (t) => {
  installFake(t, "linux", forTest.secretToolBin, {
    stderr: `secret-tool: rejected ${sentinelKeyringToken}`,
    exitCode: 1,
  });
  assert.throws(
    () => Store(AccountTursoToken, new Secret(sentinelKeyringToken)),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(!message.includes(sentinelKeyringToken), message);
      assert.ok(message.includes(REDACTED), message);
      return true;
    },
  );
});

shellTest("the linux delete clears whether or not anything matched", (t) => {
  const fake = installFake(t, "linux", forTest.secretToolBin);
  Delete(AccountTursoToken);
  assert.deepEqual(fake.argv(), [
    "clear",
    "service",
    Service,
    "account",
    AccountTursoToken,
  ]);
});

// --- every other platform ----------------------------------------------

// This is the whole contract there: detect, report unavailable, and never
// fail a command because of it.
test("an unsupported platform has no backend", (t) => {
  for (const platform of ["win32", "aix", "sunos"]) {
    usePlatform(t, platform);
    assert.equal(Available(), false, platform);
    assert.equal(Backend(), BackendNone, platform);
    for (const call of [
      () => Get(AccountTursoToken),
      () => Store(AccountTursoToken, new Secret(fakeToken)),
      () => Delete(AccountTursoToken),
    ]) {
      assert.throws(call, (err: unknown) => Is(err, ErrUnavailable), platform);
    }
    assert.ok(ManualInstructions(AccountTursoToken).includes(Placeholder), platform);
  }
});
