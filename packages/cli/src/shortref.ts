// Module shortref remembers the ids of the last listing, so that the short
// numbers `tdo ls` prints can be typed at the next command.
//
// Typing a 26-character ULID is not a user interface, and an id prefix still
// means reading one off the screen. So `tdo ls` numbers its rows and the
// numbers are resolved here, out of a small file in the user's state
// directory. The file records which store the listing came from, because a
// number that means "pay the invoice" on one provider must never resolve to
// something else on another.
//
// Nothing in this module is allowed to be fatal on the read side. A missing,
// truncated or unreadable cache is an ordinary cache miss: the caller falls
// back to an id prefix or reports a clear not-found error — which is the
// difference between exit code 5 and exit code 6 at the command layer.
//
// This is the one part of `core` that touches the filesystem, so it is the one
// part that imports `node:*`. It is a cache of what a terminal last printed;
// the PWA has no state directory and never imports it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** FileName is the name of the cache file inside the state directory. */
export const FileName = "lastlist.json";

/** Listing is the on-disk form. */
interface Listing {
  /** key identifies the store the ids came from. */
  key: string;
  /**
   * ids are the task ids in the order they were printed; the short number of
   * an id is its index plus one.
   */
  ids: string[];
}

/**
 * homeDir mirrors Go's os.UserHomeDir rather than node's os.homedir: Go reads
 * USERPROFILE on windows and HOME elsewhere and fails when the variable is
 * unset, while node falls back to the password database. The failing case is
 * the one `Path` has a branch for, so it has to be reachable.
 */
function homeDir(): string | undefined {
  const name = os.platform() === "win32" ? "USERPROFILE" : "HOME";
  const dir = process.env[name];
  return dir === undefined || dir === "" ? undefined : dir;
}

/**
 * Path returns the file the cache is kept in. It honours TODOCLOUD_STATE_DIR
 * first, so a test (or a user with several profiles) can redirect it, then
 * XDG_STATE_HOME, and finally the XDG default.
 */
export function Path(): string {
  const stateDir = process.env["TODOCLOUD_STATE_DIR"];
  if (stateDir !== undefined && stateDir !== "") {
    return path.join(stateDir, FileName);
  }
  const xdg = process.env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg !== "") {
    return path.join(xdg, "todocloud", FileName);
  }
  const home = homeDir();
  if (home === undefined) {
    // Without a home directory there is nowhere sensible to put the cache;
    // the relative path keeps Save's error local and harmless.
    return path.join(".todocloud", FileName);
  }
  return path.join(home, ".local", "state", "todocloud", FileName);
}

/**
 * Save records ids as the listing produced by the store named key. The file is
 * written with mode 0600 in the user's own state directory; it holds task ids,
 * never a credential.
 *
 * Where Go returns an error, this throws: the caller is allowed to ignore it
 * either way, since a cache that could not be written is only a cache miss at
 * the next command.
 */
export function Save(key: string, ids: readonly string[] | null | undefined): void {
  const listing: Listing = { key, ids: ids === null || ids === undefined ? [] : [...ids] };
  const data = JSON.stringify(listing);

  const target = Path();
  const dir = path.dirname(target);
  if (dir !== "") {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Write through a temporary file so an interrupted write cannot leave a
  // half-written listing behind.
  const tmp = path.join(dir, `${FileName}.${process.pid}.${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, `${data}\n`, { mode: 0o600 });
    // chmod explicitly: the mode above is masked by the process umask, and
    // the owner-only bit is the whole point of writing it here.
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing can be done about a temporary file that will not go away.
    }
    throw err;
  }
}

/**
 * Lookup returns the id the store named key printed as number n, or undefined.
 * It misses for a number out of range, for a listing from a different store,
 * and for every kind of unreadable or corrupt file.
 */
export function Lookup(key: string, n: number): string | undefined {
  if (!Number.isInteger(n) || n < 1) {
    return undefined;
  }
  let data: string;
  try {
    data = fs.readFileSync(Path(), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  // A well-formed JSON document of the wrong shape — an array, a number, a
  // null `ids` — is as much a miss as a truncated one.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const listing = parsed as { key?: unknown; ids?: unknown };
  if (listing.key !== key || !Array.isArray(listing.ids) || n > listing.ids.length) {
    return undefined;
  }
  const id: unknown = listing.ids[n - 1];
  if (typeof id !== "string" || id === "") {
    return undefined;
  }
  return id;
}
