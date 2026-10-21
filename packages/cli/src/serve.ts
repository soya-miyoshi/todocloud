// `tdo serve`: the browser viewer, bound to this machine.

import * as exit from '@todocloud/core/exit';
import type { Store } from '@todocloud/core/store';

import { type App, type Command, type Context, asError, usagef } from './app.ts';
import * as web from './web/web.ts';

/**
 * defaultServePort is the port `tdo serve` takes when none is given. It is in
 * the unassigned range and unlikely to collide with a development server the
 * user already has running.
 */
export const defaultServePort = 7373;

/**
 * loopback is the default host. Serving only to this machine is the whole
 * difference between a viewer and a service: the project has no backend
 * (PLAN.md §1), and a listener anyone can reach would be one.
 */
const loopback = '127.0.0.1';

export function serveCommand(a: App): Command {
  return {
    name: 'serve',
    usage: 'serve a browser viewer for this store on a local port',
    store: 'read',
    flags: {
      port: {
        type: 'string',
        placeholder: 'PORT',
        usage: `listen on PORT (default ${defaultServePort}); 0 picks a free one and prints it`,
      },
      addr: {
        type: 'string',
        placeholder: 'ADDR',
        usage:
          'listen on ADDR instead of 127.0.0.1, for example 0.0.0.0 to reach it from the network',
      },
    },
    async run(ctx: Context): Promise<void> {
      if (ctx.args.length > 0) {
        throw usagef('serve takes no arguments; pass --port or --addr');
      }
      // Go had an IntFlag with a default; the dispatcher here has no number
      // type on purpose (see the flag contract in app.ts), so the parse and
      // its usage error live in this command.
      const port = parsePort(ctx.isSet('port') ? ctx.string('port') : '');
      const addr = serveAddr(ctx.string('addr'), port);
      await serve(a, ctx.store(), addr, exposed(ctx.string('addr')));
    },
  };
}

/**
 * parsePort reads --port. An unreadable value is a usage error rather than a
 * silently defaulted port: a typo must not quietly serve somewhere else.
 */
function parsePort(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return defaultServePort;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    throw usagef(`--port expects a number, got ${JSON.stringify(raw)}`);
  }
  return Number(trimmed);
}

/**
 * serveAddr builds the listen address from --addr and --port. A host:port in
 * --addr carries its own port, so passing --port as well would be two answers
 * to one question.
 */
export function serveAddr(addr: string, port: number): string {
  if (port < 0 || port > 65535) {
    throw usagef(`--port must be between 0 and 65535, got ${port}`);
  }
  const host = addr.trim();
  if (host === '') {
    return joinHostPort(loopback, String(port));
  }
  const split = splitHostPort(host);
  if (split !== undefined) {
    if (split.port !== '' && port !== defaultServePort) {
      throw usagef(`--addr already names port ${split.port}; drop --port`);
    }
    return joinHostPort(split.host, split.port);
  }
  return joinHostPort(host, String(port));
}

/**
 * exposed reports whether --addr asks for a listener this machine is not the
 * only one that can reach. It is used for the warning, not for a refusal: the
 * user asked, and PLAN.md's rule is that the default is loopback, not that
 * the network is forbidden.
 */
export function exposed(addr: string): boolean {
  let host = addr.trim();
  if (host === '') {
    return false;
  }
  const split = splitHostPort(host);
  if (split !== undefined) {
    host = split.host;
  }
  switch (host) {
    case '':
    case loopback:
    case 'localhost':
    case '::1':
    case '[::1]':
      return false;
    default:
      break;
  }
  const ip = parseIP(host.replace(/^\[|\]$/g, ''));
  if (ip !== undefined) {
    return !ip.loopback;
  }
  // A name this module cannot resolve to a loopback address is treated as
  // reachable, because the warning costs the user a line and the silence
  // could cost them their list.
  return true;
}

/**
 * splitHostPort is `net.SplitHostPort`: it returns undefined where Go
 * returned an error, which is the only thing the two callers look at. An
 * unbracketed host holding a colon of its own — `::1` — has no port, exactly
 * as Go's "too many colons" error said.
 */
function splitHostPort(addr: string): { host: string; port: string } | undefined {
  if (addr.startsWith('[')) {
    const close = addr.indexOf(']');
    if (close < 0) {
      return undefined;
    }
    const rest = addr.slice(close + 1);
    if (!rest.startsWith(':')) {
      return undefined;
    }
    return { host: addr.slice(1, close), port: rest.slice(1) };
  }
  const at = addr.indexOf(':');
  if (at < 0 || addr.indexOf(':', at + 1) >= 0) {
    return undefined;
  }
  return { host: addr.slice(0, at), port: addr.slice(at + 1) };
}

/**
 * joinHostPort is `net.JoinHostPort`: it brackets a host that holds a colon,
 * so the result is a usable authority in a URL.
 */
function joinHostPort(host: string, port: string): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * parseIP recognises the two address families and reports whether the address
 * is a loopback one. It stands in for `net.ParseIP` plus `IP.IsLoopback`, and
 * only those two answers are needed here.
 */
function parseIP(text: string): { loopback: boolean } | undefined {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4 !== null) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) {
      return undefined;
    }
    // 127.0.0.0/8, as Go's IsLoopback has it.
    return { loopback: octets[0] === 127 };
  }
  if (!text.includes(':')) {
    return undefined;
  }
  // An IPv6 literal: enough of a check to tell an address from a hostname,
  // which is all `exposed` asks. The one loopback address is ::1, in any of
  // its zero-compressed spellings, so the groups are expanded and compared.
  if (!/^[0-9A-Fa-f:]+$/.test(text)) {
    return undefined;
  }
  const groups = expandIPv6(text);
  if (groups === undefined) {
    return undefined;
  }
  return { loopback: groups.every((g, i) => g === (i === 7 ? 1 : 0)) };
}

/**
 * expandIPv6 turns an address into its eight groups, filling in the run `::`
 * stands for, or undefined when the text is not one address.
 */
function expandIPv6(text: string): number[] | undefined {
  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const parse = (part: string): number[] | undefined => {
    if (part === '') {
      return [];
    }
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (group === '' || group.length > 4) {
        return undefined;
      }
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === undefined || tail === undefined) {
    return undefined;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : undefined;
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 1) {
    return undefined;
  }
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

async function serve(a: App, st: Store, addr: string, isExposed: boolean): Promise<void> {
  const srv = web.New(st);
  let ln: web.Listener;
  try {
    ln = await web.Listen(addr);
  } catch (err) {
    // A port already in use is the common case here, and it is the user's to
    // fix with --port rather than a provider failure.
    throw exit.usagef(
      new Error(`could not listen on ${addr}: ${asError(err).message}`),
    ) as Error;
  }

  try {
    const bound = ln.addr();
    const url = `http://${bound}/`;
    if (a.out.json) {
      // One object, written as soon as the listener is up, so a script can
      // learn the port that was chosen before the first request.
      a.out.emit({ url, addr: bound, store: st.describe() });
    } else {
      a.out.printf(`${url}\n`);
    }
    a.out.warnf(`serving ${st.describe()}; press Ctrl-C to stop`);
    if (isExposed) {
      a.out.warnf(
        'this listener is reachable from the network: anyone who can load the page can change this list',
      );
    }

    // Ctrl-C stops the listener rather than the process, so the store is
    // closed the way every other command closes it. Go used
    // signal.NotifyContext; the TypeScript server takes an AbortSignal, and
    // the handlers are removed when this returns so that a test — or a second
    // `serve` in one process — does not leave one installed.
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await srv.serve(ln, controller.signal);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    await ln.close();
  }
}
