// `--watch`: a listing that redraws itself until Ctrl-C.
//
// This is the one thing a terminal cannot be given from outside. `watch -n5
// tdo ls` already redraws, and it is nearly right — what it cannot do is the
// short numbers. Every frame here calls the command's own body, which writes
// the listing cache as it prints (see refs.saveListing), so the `3` on screen
// is the `3` that `tdo done 3` means in another window. Through `watch(1)`
// the numbers would be rewritten by a process that exits between frames, the
// provider would be reopened every time, and a Turso round trip would be paid
// for the connection as well as the query.
//
// What a frame is, exactly: the command's whole human output, drawn into the
// alternate screen. The screen is cleared and the body runs again — no
// diffing, no partial update. A listing is small, a terminal write is cheap,
// and a redraw that can disagree with itself is worse than a flicker.
//
// Three refusals, all of them exit 2 (§4.2), all of them at the start rather
// than after the first frame:
//
//   --watch --json     — the shapes in docs/agents.md are one object on
//                        stdout, and a caller that pipes `--json` to `jq`
//                        gets a parse error, not a stream. A watching agent
//                        polls the command instead; that is what exit codes
//                        and one-line JSON are for.
//   stdout not a tty   — otherwise the escape sequences land in the file.
//   --interval alone   — a pace for something that is not redrawing is a
//                        mistake worth naming.

import { parseDurationMs } from '@todocloud/core/taskops/edit';

import { type App, type Context, type Flags, type Ticker, usagef } from './app.ts';
import { ProviderSQLite } from './config.ts';

/** WatchMinInterval is the fastest redraw on offer. */
export const WatchMinInterval = 1_000;

/** WatchMaxInterval is the slowest. Past an hour, this is not a watch. */
export const WatchMaxInterval = 3_600_000;

/**
 * WatchLocalInterval is the default pace against a store on this machine: a
 * SQLite read costs a page cache hit, so the only real cost of a frame is the
 * redraw.
 */
export const WatchLocalInterval = 2_000;

/**
 * WatchRemoteInterval is the default against a provider over the network.
 * Every frame is a round trip the user pays for in latency and, on a hosted
 * plan, in rows read; two seconds of that is 1,800 queries an hour for a list
 * that changes a few times a day.
 */
export const WatchRemoteInterval = 10_000;

/** The escape sequences. Each is written once, from here. */
const enterAltScreen = '\x1b[?1049h';
const leaveAltScreen = '\x1b[?1049l';
const hideCursor = '\x1b[?25l';
const showCursor = '\x1b[?25h';
const clearScreen = '\x1b[H\x1b[2J';

/**
 * watchFlags are the two flags a redrawing command declares. They are shared
 * rather than retyped so that `--interval` means the same thing on every
 * command that offers it.
 */
export function watchFlags(): Flags {
  return {
    watch: {
      type: 'boolean',
      usage: 'redraw the listing until Ctrl-C, keeping the row numbers current',
    },
    interval: {
      type: 'string',
      placeholder: 'D',
      usage: 'how long to wait between redraws, for example 10s; needs --watch',
    },
  };
}

/**
 * watching runs `draw` once, or over and over when --watch was given. A
 * command's body becomes a watching one by moving its reads and its printing
 * into `draw` and leaving its flag validation outside: a mistake at the
 * command line is reported once, before the screen is taken over, and not
 * once a second underneath a listing.
 *
 * `draw` is called again from scratch every frame, so a command must not
 * assume its own output is cumulative.
 */
export async function watching(a: App, ctx: Context, draw: () => Promise<void>): Promise<void> {
  const interval = watchInterval(a, ctx);
  if (interval === undefined) {
    await draw();
    return;
  }

  const ticker = a.env.ticker ?? processTicker();
  const out = a.out.out;
  out.write(enterAltScreen + hideCursor);
  try {
    for (;;) {
      out.write(clearScreen);
      await draw();
      // The pace is on stderr with everything else that is not the listing,
      // and it is at the bottom because that is where the cursor is: a
      // header scrolls off a frame longer than the window, a footer does not.
      a.out.hintf(`watching every ${describe(interval)} — Ctrl-C to stop`);
      if (!(await ticker.wait(interval))) {
        return;
      }
    }
  } finally {
    // A thrown provider error leaves the loop through here too: the terminal
    // is handed back before the error envelope is printed, or the message
    // would be written onto a screen that is about to be discarded.
    out.write(showCursor + leaveAltScreen);
  }
}

/**
 * watchInterval validates the pair of flags and returns the pace, or
 * undefined when the command is not watching at all.
 */
function watchInterval(a: App, ctx: Context): number | undefined {
  const watch = ctx.bool('watch');
  // isSet rather than a non-empty value: `--interval ""` is a mistake, and
  // silently reading it as "the default" would hide a shell variable that
  // expanded to nothing.
  const given = ctx.isSet('interval');
  const raw = ctx.string('interval').trim();
  if (!watch) {
    if (given) {
      throw usagef('--interval paces the redrawing, so it needs --watch');
    }
    return undefined;
  }
  if (a.out.json) {
    throw usagef(
      '--watch redraws a screen and --json is one object on stdout; run the command again to poll it',
    );
  }
  if (!a.env.stdoutIsTTY()) {
    throw usagef('--watch needs a terminal on stdout; without one, run the command again to poll it');
  }
  if (!given) {
    return defaultInterval(a);
  }
  const ms = parseDurationMs(raw.toLowerCase());
  if (ms === undefined || ms <= 0) {
    throw usagef(`--interval takes a duration, for example 10s, not ${JSON.stringify(raw)}`);
  }
  if (ms < WatchMinInterval || ms > WatchMaxInterval) {
    throw usagef(
      `--interval must be between ${describe(WatchMinInterval)} and ${describe(WatchMaxInterval)}, not ${describe(ms)}`,
    );
  }
  return ms;
}

/**
 * defaultInterval picks the pace from where the tasks are. The configuration
 * is already resolved by the time a command body runs — the store was opened
 * out of it — so this costs nothing.
 */
function defaultInterval(a: App): number {
  try {
    return a.config().Provider === ProviderSQLite ? WatchLocalInterval : WatchRemoteInterval;
  } catch {
    // A command cannot reach this without an open store, but a pace is no
    // reason to turn a working listing into a configuration error.
    return WatchRemoteInterval;
  }
}

/** describe renders a duration the way the flag accepts it back. */
function describe(ms: number): string {
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`;
  }
  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  if (ms % 1_000 === 0) {
    return `${ms / 1_000}s`;
  }
  return `${ms}ms`;
}

/**
 * processTicker is the real ticker: a timer, stopped by Ctrl-C.
 *
 * SIGINT is handled rather than left to kill the process, because the
 * alternate screen has to be given back. The handler is removed as soon as
 * the wait ends, so nothing of this outlives the loop — a later Ctrl-C, at a
 * prompt this process no longer owns, must mean what it always meant.
 */
function processTicker(): Ticker {
  return {
    wait(ms: number): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const stop = (): void => {
          clearTimeout(timer);
          process.off('SIGINT', stop);
          resolve(false);
        };
        const timer = setTimeout(() => {
          process.off('SIGINT', stop);
          resolve(true);
        }, ms);
        process.on('SIGINT', stop);
      });
    },
  };
}
