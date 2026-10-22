// The API half of the viewer: one function per endpoint, and the request
// decoding the endpoints share.
//
// It lives in `core`, and that is the point of it. There are two front ends
// over this API — the local viewer `tdo serve` puts on a port
// (`packages/cli/src/web/web.ts`) and the standalone PWA (`packages/pwa`) —
// and for a while there were two copies of this file, one per front end,
// because `@todocloud/cli` exports nothing that reaches into `src/web/` and
// a relative path across the package boundary would have made the PWA depend
// on `@todocloud/store-sqlite`, which imports `node:sqlite`. A copy that
// drifts is precisely the two-implementations problem this project was
// rewritten to be rid of, so the module moved here instead: `core` is the
// one package both front ends already depend on, and this file imports
// nothing but its siblings, so it resolves in a browser unchanged. Nothing
// under `packages/core/src` may import `node:*`; `browser-safe.test.ts`
// enforces it.
//
// What a front end still owns is the transport: `web.ts` reads a body off a
// socket, checks the per-process write token and writes a `ServerResponse`;
// `packages/pwa/src/router.ts` builds the `Req` in the tab and returns a
// `Response`. Both reach this module through `@todocloud/core/webapi`, and
// the pieces they share besides the handlers — the error-to-status mapping,
// the error envelope, the mutex and the two path matchers — are in
// `./http.ts`.
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - Go had `errUsage`, `usagef` and `decode` in `web.go` and the handlers
//     in `api.go`, one package, so either file could reach the other. Two
//     modules cannot do that without an import cycle, so the request-level
//     primitives live here, with the handlers that are their only callers,
//     and `http.ts` imports them. `statusOf` reads `isUsage` for the same
//     reason it read `errors.Is(err, errUsage)`.
//   - Every `Store` method but `describe` is a promise, so every handler is
//     `async` and every store call is awaited. `context.Context` is gone;
//     see the note at the top of `./taskops/taskops.ts`.
//   - Go read the body off the socket inside the handler, through
//     `json.NewDecoder(io.LimitReader(r.Body, …))`. The front end reads it
//     first and hands the handler a `Req` holding the text, because a Node
//     handler cannot read a body without awaiting and the mutex must not be
//     held across a read from a socket. What the handler sees is the same
//     bytes, truncated at the same cap.
//   - `json.Decoder.DisallowUnknownFields` has no equivalent, so each body
//     names the keys it knows and `body()` refuses the rest. The refusal is
//     the point: an ignored key would be a silent half-applied edit, and the
//     browser would report success for a change that never happened.
//   - Go's struct tags did the type checking. The readers below do it by
//     hand, and refuse the same requests `encoding/json` refused — a string
//     where a bool belongs, a fraction where an int belongs.

import type { Perspective, Store, Tag } from '../store/store.ts';
import { Availability, OrderPosition, tagKey } from '../store/store.ts';
import { Filter, filterFromJSON } from '../store/filter.ts';
import * as id from '../id.ts';
import { NewTaskView, Views } from '../output/view.ts';
import * as taskops from '../taskops/taskops.ts';
import { Draft, Edit, parseMinutes, parseRepeat } from '../taskops/edit.ts';
import { Selection, run as runSelection } from '../taskops/select.ts';
import {
  type JSONObject,
  type JSONValue,
  KindTask,
  type Kind,
  type Status,
  StatusDone,
  type Task,
  formatTime,
  kindValid,
  parseDue,
  parseValue,
  statusValid,
} from '../task.ts';

/**
 * maxBodyBytes caps a request body. Nothing the API accepts is large, and an
 * unbounded read is an easy way to make a local process eat memory.
 */
export const maxBodyBytes = 1 << 20;

/**
 * Req is what a handler is given: the path parameters the router matched, the
 * declared length of the body and the body itself.
 *
 * Go read these three off `*http.Request`. They are a value here so that a
 * handler is a function of its request and nothing else — it cannot reach the
 * socket, which is `web.ts`'s business, and a test can call one directly.
 */
export interface Req {
  /** params holds the route's `{id}`, the way `r.PathValue("id")` did. */
  readonly params: Readonly<Record<string, string>>;
  /**
   * contentLength is the `Content-Length` header as a number, or -1 when the
   * request did not declare one. Go's `r.ContentLength` had the same two
   * meanings, and `decodeOptional` turns on the difference.
   */
  readonly contentLength: number;
  /** body is the request body, already read and truncated at maxBodyBytes. */
  readonly body: string;
}

/** A handler is one API endpoint: it returns the payload to encode, or throws. */
export type Handler = (r: Req) => Promise<unknown>;

/**
 * ErrUsage marks a request this module itself refused, before the shared
 * layer saw it: a malformed body, a missing field. Go had an `errUsage`
 * sentinel and `errors.Is`; the sentinel is carried as a thrown error's
 * `cause` here, which is the convention the rest of the tree uses.
 */
export const ErrUsage = new Error('bad request');

/** Reports whether err, or anything it wraps, is ErrUsage. */
export function isUsage(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    if (cur === ErrUsage) {
      return true;
    }
    seen.add(cur);
    cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
  }
  return false;
}

/**
 * usagef builds an ErrUsage with its own wording. The message is what
 * `fmt.Errorf("%w: %s", errUsage, …)` produced: the sentinel's text, a colon,
 * then the detail.
 */
export function usagef(message: string): Error {
  return new Error(`${ErrUsage.message}: ${message}`, { cause: ErrUsage });
}

/** quote renders a value the way Go's `%q` did, for an error message. */
function quote(s: string): string {
  return JSON.stringify(s);
}

/** messageOf reads the text of a thrown value, whatever it is. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * body decodes a JSON request body, refusing a key it does not know. An
 * ignored key would be a silent half-applied edit: the browser would report
 * success for a change that never happened.
 */
function body(r: Req, known: readonly string[]): JSONObject {
  let raw: unknown;
  try {
    raw = JSON.parse(r.body);
  } catch (err) {
    return abort(`could not read the request: ${messageOf(err)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return abort('could not read the request: the body must be a JSON object');
  }
  const o = raw as JSONObject;
  for (const key of Object.keys(o)) {
    if (!known.includes(key)) {
      return abort(`could not read the request: unknown field ${quote(key)}`);
    }
  }
  return o;
}

/**
 * optionalBody reads a body that may be absent: the viewer completes an item
 * with no payload at all, and an empty body means every default. Go tested
 * `r.ContentLength == 0`; a request sent with no length header and no bytes
 * means the same thing, so both are accepted here.
 */
function optionalBody(r: Req, known: readonly string[]): JSONObject {
  if (r.contentLength === 0 || r.body === '') {
    return {};
  }
  return body(r, known);
}

/** abort throws a usage error. It returns `never` so a reader can `return` it. */
function abort(message: string): never {
  throw usagef(message);
}

// The field readers. Each one refuses the request `encoding/json` would have
// refused for the same Go type, and names the field when it does: a browser
// showing "bad request" with no field named is a bug report nobody can act
// on.

/** present reports whether a key was sent with a value. JSON null reads as
 * absent, because Go's pointer fields were nil for both. */
function present(o: JSONObject, key: string): boolean {
  const v = o[key];
  return v !== undefined && v !== null;
}

/** optString is Go's `*string`: undefined for absent or null. */
function optString(o: JSONObject, key: string): string | undefined {
  if (!present(o, key)) {
    return undefined;
  }
  const v = o[key];
  if (typeof v !== 'string') {
    return abort(`${key} must be a string`);
  }
  return v;
}

/** reqString is Go's plain `string`: absent reads as the zero value. */
function reqString(o: JSONObject, key: string): string {
  return optString(o, key) ?? '';
}

/** optBool is Go's `*bool`. */
function optBool(o: JSONObject, key: string): boolean | undefined {
  if (!present(o, key)) {
    return undefined;
  }
  const v = o[key];
  if (typeof v !== 'boolean') {
    return abort(`${key} must be true or false`);
  }
  return v;
}

/** reqBool is Go's plain `bool`. */
function reqBool(o: JSONObject, key: string): boolean {
  return optBool(o, key) ?? false;
}

/**
 * optInt is Go's `*int`. A fraction is refused rather than rounded, which is
 * what `encoding/json` did for an int field.
 */
function optInt(o: JSONObject, key: string): number | undefined {
  if (!present(o, key)) {
    return undefined;
  }
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return abort(`${key} must be a whole number`);
  }
  return v;
}

/** optStrings is Go's `*[]string`, where "sent as []" and "not sent" differ. */
function optStrings(o: JSONObject, key: string): string[] | undefined {
  if (!present(o, key)) {
    return undefined;
  }
  const v = o[key];
  if (!Array.isArray(v)) {
    return abort(`${key} must be an array of strings`);
  }
  return v.map((item) => {
    if (typeof item !== 'string') {
      return abort(`${key} must be an array of strings`);
    }
    return item;
  });
}

/** reqStrings is Go's plain `[]string`: absent reads as empty. */
function reqStrings(o: JSONObject, key: string): string[] {
  return optStrings(o, key) ?? [];
}

/**
 * fields is Go's `map[string]any`, the open field map of §3.6. The values are
 * left exactly as they arrived: the shared layer decides which keys are
 * reserved and which values are legal, and this is a transport.
 */
/**
 * textFields reads an object of KEY to the text a person typed, and gives
 * back what `parseValue` makes of each one — the rule `tdo add --set` and
 * `tdo edit --set` already use, so a field typed into the inspector and the
 * same field typed at a shell end up as the same stored value.
 */
function textFields(o: JSONObject, key: string): Record<string, JSONValue> {
  const out: Record<string, JSONValue> = {};
  for (const [k, v] of Object.entries(fields(o, key))) {
    if (typeof v !== 'string') {
      return abort(`${key}.${k} must be a string`);
    }
    out[k] = parseValue(v);
  }
  return out;
}

function fields(o: JSONObject, key: string): Record<string, JSONValue> {
  if (!present(o, key)) {
    return {};
  }
  const v = o[key];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return abort(`${key} must be an object`);
  }
  return v;
}

/**
 * API is the endpoints over one store. Go hung them on `*Server`; they are
 * separated here so that `web.ts` owns the listener, the mutex and the token
 * and this module owns nothing but the store calls.
 *
 * now is a function rather than a clock value because `Server` holds the
 * injectable clock and a test replaces it after construction.
 */
export class API {
  readonly st: Store;
  readonly now: () => Date;

  constructor(st: Store, now: () => Date) {
    this.st = st;
    this.now = now;
  }

  /**
   * handleState answers with the whole tree, the saved perspectives and the
   * tags in one response.
   *
   * A viewer shows several slices of the same tree at once — a sidebar
   * counting the inbox, a list, a detail panel naming the parent — and those
   * slices have to agree with each other. One snapshot under one lock is the
   * only way they can: fetching them separately would let a write land
   * between two of them and leave the page showing a count that contradicts
   * the list below it. The tree a person owns is small enough that this is
   * the cheap option as well as the correct one.
   */
  handleState: Handler = async () => {
    const now = this.now();
    // Every status, tombstones excluded: which of them to show is the
    // viewer's decision, and it makes it without asking again.
    const tasks = await runSelection(
      this.st,
      new Selection({ filter: new Filter({ order: OrderPosition, now }) }),
    );
    const av = await taskops.availabilityOf(this.st, tasks, now);
    const perspectives = await this.st.perspectives();
    const tags = await this.st.tags();
    return {
      tasks: Views(tasks, av),
      count: tasks.length,
      perspectives: perspectives.map(perspectiveJSON),
      tags: tags.map(tagJSON),
      store: this.st.describe(),
      now: formatTime(now),
    };
  };

  /**
   * handleCreate takes the JSON of `POST /api/tasks`. It is Draft in the
   * spellings a browser can send: a date as a string, a priority as a number.
   */
  handleCreate: Handler = async (r) => {
    const o = body(r, [
      'kind',
      'title',
      'parent_id',
      'note',
      'tags',
      'flagged',
      'defer_at',
      'due_at',
      'estimate',
      'repeat',
      'priority',
      'set',
    ]);
    const title = reqString(o, 'title');
    if (title.trim() === '') {
      throw usagef('a new item needs a title');
    }

    let kind: Kind = KindTask;
    const given = reqString(o, 'kind');
    if (given !== '') {
      kind = given;
      if (!kindValid(kind)) {
        throw usagef(`kind must be folder, project or task, got ${quote(given)}`);
      }
    }
    const d = new Draft({
      kind,
      title,
      parentID: reqString(o, 'parent_id').trim(),
      note: reqString(o, 'note'),
      tags: reqStrings(o, 'tags'),
      flagged: reqBool(o, 'flagged'),
      priority: optInt(o, 'priority'),
      set: fields(o, 'set'),
    });
    // The parent arrives as an id from the page, which read it out of a
    // previous state response, so it is resolved rather than trusted: an id
    // the store does not know must be a 404 and not a row with a dangling
    // parent.
    if (d.parentID !== '') {
      const parent = await this.st.get(d.parentID);
      d.parentID = parent.id;
    }
    d.deferAt = parseInstant(optString(o, 'defer_at'), 'defer_at');
    d.dueAt = parseInstant(optString(o, 'due_at'), 'due_at');
    const estimate = optString(o, 'estimate');
    if (estimate !== undefined) {
      d.estimatedMinutes = parseMinutes(estimate);
    }
    const repeat = optString(o, 'repeat');
    if (repeat !== undefined && repeat.trim() !== '') {
      d.repeat = parseRepeat(repeat);
    }

    const t = d.build(id.New(), this.now());
    await taskops.create(this.st, t);
    return this.taskPayload(t);
  };

  /**
   * handleEdit takes the JSON of `PATCH /api/tasks/{id}`. A field left out is
   * left alone; a field present and null clears it. That is the same
   * distinction `tdo edit --note ""` relies on, and it is why the Go struct's
   * fields were pointers.
   *
   * `flagged` is here rather than in Edit because flagging is its own
   * operation in the shared layer, and the inspector sends one request.
   *
   * `set` carries JSON values, which is what an agent writing the API has.
   * `set_text` carries the text a person typed into a box, read by the same
   * `parseValue` that reads `tdo edit --set KEY=VALUE`: the inspector's
   * custom-field rows are text, and deciding in the page whether `3` is a
   * number or a string would be a second implementation of that rule, which
   * would answer differently the first time either changed. The two merge,
   * with `set` winning a key they share.
   */
  handleEdit: Handler = async (r) => {
    let t = await this.task(r);
    const o = body(r, [
      'title',
      'note',
      'tags',
      'untag',
      'estimate',
      'priority',
      'set',
      'set_text',
      'unset',
      'flagged',
    ]);

    const e = new Edit({
      title: optString(o, 'title'),
      note: optString(o, 'note'),
      tags: optStrings(o, 'tags'),
      untag: reqStrings(o, 'untag'),
      priority: optInt(o, 'priority'),
      set: { ...textFields(o, 'set_text'), ...fields(o, 'set') },
      unset: reqStrings(o, 'unset'),
    });
    const estimate = optString(o, 'estimate');
    if (estimate !== undefined) {
      e.estimatedMinutes = parseMinutes(estimate);
    }
    const flagged = optBool(o, 'flagged');
    if (e.empty() && flagged === undefined) {
      throw usagef('this request changes nothing');
    }
    if (flagged !== undefined) {
      const res = await taskops.setFlagged(this.st, [t], flagged, this.now());
      t = first(res.tasks);
    }
    if (e.empty()) {
      return this.taskPayload(t);
    }
    const res = await taskops.apply(this.st, [t], e, this.now());
    return this.taskPayload(first(res.tasks));
  };

  handleDone: Handler = async (r) => {
    const t = await this.task(r);
    const o = optionalBody(r, ['no_repeat']);
    const res = await taskops.complete(
      this.st,
      [t],
      this.now(),
      reqBool(o, 'no_repeat'),
      id.New,
    );
    return this.resultPayload(res);
  };

  handleStatus: Handler = async (r) => {
    const t = await this.task(r);
    const o = body(r, ['status']);
    const given = reqString(o, 'status');
    const status: Status = given.trim();
    if (!statusValid(status)) {
      throw usagef(
        `status must be active, on_hold, done or dropped, got ${quote(given)}`,
      );
    }
    if (status === StatusDone) {
      // Completing is never a plain status change: a repeating item owes a
      // successor, and §3.4 says where it comes from.
      throw usagef(
        'completing an item goes through /api/tasks/{id}/done, so a repeat gets its successor',
      );
    }
    const res = await taskops.setStatus(this.st, [t], status, this.now());
    return this.resultPayload(res);
  };

  handleFlag: Handler = async (r) => {
    const t = await this.task(r);
    const o = body(r, ['flagged']);
    const res = await taskops.setFlagged(
      this.st,
      [t],
      reqBool(o, 'flagged'),
      this.now(),
    );
    return this.resultPayload(res);
  };

  handleDate: Handler = async (r) => {
    const t = await this.task(r);
    const o = body(r, ['field', 'at']);
    const given = reqString(o, 'field');
    let field: taskops.DateField;
    switch (given.trim()) {
      case taskops.DeferDate:
        field = taskops.DeferDate;
        break;
      case taskops.DueDate:
        field = taskops.DueDate;
        break;
      default:
        throw usagef(`field must be defer or due, got ${quote(given)}`);
    }
    const at = parseInstant(optString(o, 'at'), 'at');
    const res = await taskops.setDate(this.st, [t], field, at, this.now());
    return this.resultPayload(res);
  };

  handleMove: Handler = async (r) => {
    const t = await this.task(r);
    // An empty parent_id means the top level, which for a task is the inbox:
    // it is how the viewer unfiles something.
    const o = body(r, ['parent_id']);
    let parentID = reqString(o, 'parent_id').trim();
    if (parentID !== '') {
      const parent = await this.st.get(parentID);
      parentID = parent.id;
    }
    const res = await taskops.moveTo(this.st, [t], parentID, this.now());
    return this.resultPayload(res);
  };

  /**
   * handleReorder takes the JSON of `POST /api/tasks/{id}/reorder`:
   * `{"anchor": "<id>", "where": "before"|"after"}`. It is `tdo mv --before`
   * and `--after`.
   *
   * A separate endpoint from `/move` rather than two more keys on it. The
   * two are different operations in the shared layer — `moveTo` changes a
   * parent and leaves the order alone, `reorder` rewrites a sibling group's
   * positions — and `/move`'s body is a contract the page is already written
   * against, where `parent_id` is required.
   *
   * Placing an item next to an anchor in another container moves it into
   * that container too, which is what "put it after this one" means and what
   * `tdo mv --after` already does. The viewer's drop zones rely on it: a drop
   * on the edge of a row in another project is both a move and a placement.
   */
  handleReorder: Handler = async (r) => {
    const t = await this.task(r);
    const o = body(r, ['anchor', 'where']);
    const anchor = await this.st.get(reqString(o, 'anchor').trim());
    const given = reqString(o, 'where').trim();
    if (given !== 'before' && given !== 'after') {
      throw usagef(`where must be before or after, got ${quote(given)}`);
    }
    const res = await taskops.reorder(
      this.st,
      [t],
      anchor,
      given === 'before' ? taskops.Before : taskops.After,
      this.now(),
    );
    return this.resultPayload(res);
  };

  /**
   * handleRemove is the ordinary removal: a tombstone, taking the subtree
   * with it. There is no purge here. It is the one irreversible path in the
   * CLI and the one that asks for confirmation at a terminal (§4.2); a button
   * in a browser is not that, and `tdo rm --purge` is a command away.
   */
  handleRemove: Handler = async (r) => {
    const t = await this.task(r);
    const res = await taskops.tombstone(this.st, [t], this.now());
    return this.resultPayload(res);
  };

  /**
   * handleRunPerspective answers `GET /api/perspectives/{name}`: the saved
   * filter, run.
   *
   * The store runs it, which is the whole reason this endpoint exists. A
   * perspective is stored as the JSON of a `Filter`, and a `Filter` is what
   * the providers translate into their own query language; re-reading it in
   * the page would mean a second implementation of the same query, and the
   * two would answer differently the first time either changed. That is the
   * drift this project was rewritten to be rid of, so the page asks for the
   * answer instead of working it out.
   *
   * The reply carries the filter as well as the tasks, so the editor can
   * open a perspective without a second request, and so a viewer can show
   * what a saved query actually says.
   */
  handleRunPerspective: Handler = async (r) => {
    const p = await this.st.perspective(perspectiveName(r));
    const now = this.now();
    // A fresh Filter from the stored JSON rather than the one the store
    // handed over: `now` is a clock reading written onto the filter before
    // it runs, and writing it onto something the store may be holding is
    // how a cache ends up with a timestamp baked into it.
    const filter = filterFromJSON(p.filter.toJSON());
    filter.now = now;
    const tasks = await runSelection(this.st, new Selection({ filter }));
    const av = await taskops.availabilityOf(this.st, tasks, now);
    return {
      name: p.name,
      filter: p.filter.toJSON() as JSONValue,
      tasks: Views(tasks, av),
      count: tasks.length,
    };
  };

  /**
   * handleSavePerspective takes the JSON of `POST /api/perspectives`:
   * `{"name": "...", "filter": {...}}`, where the filter is the same object
   * the perspective is stored as and `tdo export` writes into a backup.
   *
   * The filter is read by `filterFromJSON`, which refuses a key it does not
   * know rather than dropping it — every field in a Filter narrows a
   * listing, so an ignored key produces a *wider* query than the one that
   * was asked for, and the caller would never be told. Saving replaces a
   * perspective of the same name, which is what the CLI's `perspective save`
   * does, and the timestamps are set the same way it sets them.
   */
  handleSavePerspective: Handler = async (r) => {
    const o = body(r, ['name', 'filter']);
    const name = reqString(o, 'name').trim();
    if (name === '') {
      throw usagef('a perspective needs a name');
    }
    const raw = o['filter'];
    if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
      throw usagef('filter must be an object');
    }
    let filter: Filter;
    try {
      filter = filterFromJSON(raw ?? {});
    } catch (err) {
      // A filter this binary cannot read is a bad request, not a crash:
      // it came off a form in a browser.
      throw usagef(err instanceof Error ? err.message : String(err));
    }
    const invalid = filter.validate();
    if (invalid !== undefined) {
      throw usagef(invalid.message);
    }
    const now = this.now();
    const p: Perspective = { name, filter, createdAt: now, updatedAt: now };
    await this.st.savePerspective(p);
    return { perspectives: [perspectiveJSON(p)], count: 1 };
  };

  /** handleRemovePerspective answers `DELETE /api/perspectives/{name}`. */
  handleRemovePerspective: Handler = async (r) => {
    const name = perspectiveName(r);
    await this.st.deletePerspective(name);
    return { removed: name };
  };

  /**
   * handleRenameTag takes the JSON of `PATCH /api/tags/{name}`:
   * `{"name": "..."}`, the spelling the tag is to have. It is `tdo tag
   * rename <from> <to>`, and the store does the work: every task carrying
   * the old tag carries the new one afterwards, the destination keeps its own
   * status when it already has one, and a rename that only changes the case
   * restyles the tag rather than making a second one.
   *
   * The reply is the renamed tag, read back from the store rather than echoed
   * from the request, because the stored spelling is the one the page has to
   * show — a rename into an existing tag's case takes that tag's spelling.
   */
  handleRenameTag: Handler = async (r) => {
    const from = tagName(r);
    const o = body(r, ['name']);
    const to = reqString(o, 'name').trim();
    if (to === '') {
      throw usagef('a tag needs a name');
    }
    await this.st.renameTag(from, to, this.now());
    const key = tagKey(to);
    const tags = (await this.st.tags()).filter((g) => tagKey(g.name) === key);
    return { tags: tags.map(tagJSON), count: tags.length };
  };

  /**
   * task reads the {id} of the route. The id is taken as an exact one rather
   * than a prefix: a prefix is for a person typing, and the page always has
   * the whole thing.
   */
  private async task(r: Req): Promise<Task> {
    const raw = (r.params['id'] ?? '').trim();
    if (!id.Valid(raw)) {
      throw usagef(`${quote(raw)} is not a task id`);
    }
    return this.st.get(raw);
  }

  /**
   * taskPayload renders one task the way `--json` does, availability included
   * — and in the same envelope, `{"tasks":[…],"count":1}`, so the viewer and
   * an agent reading the CLI parse one shape rather than two.
   */
  private async taskPayload(t: Task): Promise<unknown> {
    const av = await taskops.availabilityOf(this.st, [t], this.now());
    const answer = av.get(t.id);
    return {
      tasks: [
        NewTaskView(t, answer ?? emptyAvailability(), answer !== undefined),
      ],
      count: 1,
    };
  }

  /**
   * resultPayload renders what a write changed, including the rows nobody
   * asked for: the successor of a repeat and the containers that closed with
   * their last child. The viewer refetches its state afterwards, but it tells
   * the user about these, and a silent one would be a surprise later.
   */
  private async resultPayload(res: taskops.Result): Promise<unknown> {
    const av = await taskops.availabilityOf(this.st, res.tasks, this.now());
    // Go passed a nil map for the two lists nobody asked about, which made
    // every `asked` false and every derived key null. An empty Map is the
    // same answer here.
    const none = new Map<string, Availability>();
    return {
      tasks: Views(res.tasks, av),
      count: res.tasks.length,
      repeated: Views(res.successors, none),
      completed_with_last: Views(res.autoCompleted, none),
    };
  }
}

/**
 * parseInstant reads a date from the API in the spellings the CLI accepts. An
 * absent value leaves the date alone; an empty string clears it, which is how
 * a browser sends an emptied date field. Both are undefined, because the only
 * caller that can tell them apart — `handleDate` — means "clear" by either.
 */
function parseInstant(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  try {
    return parseDue(trimmed);
  } catch (err) {
    throw usagef(`${field}: ${messageOf(err)}`);
  }
}

/**
 * first takes the one task an operation on one task returned. Go indexed
 * `res.Tasks[0]` and would have panicked on an empty slice; this says so
 * instead, because a 500 naming the invariant beats a stack trace.
 */
function first(tasks: readonly Task[]): Task {
  const t = tasks[0];
  if (t === undefined) {
    throw new Error('the shared layer returned no task for a write on one');
  }
  return t;
}

/**
 * perspectiveJSON and tagJSON write the keys Go's struct tags wrote. The
 * ported types are plain interfaces with camelCase fields, and the wire shape
 * is a contract the page is written against, so the two are spelled out here
 * rather than left to `JSON.stringify`.
 */
function perspectiveJSON(p: Perspective): JSONObject {
  return {
    name: p.name,
    filter: p.filter.toJSON() as JSONValue,
    created_at: formatTime(p.createdAt),
    updated_at: formatTime(p.updatedAt),
  };
}

function tagJSON(g: Tag): JSONObject {
  const out: JSONObject = { name: g.name, status: g.status, count: g.count };
  if (g.note !== undefined && g.note !== '') {
    // Go's `omitempty`: an untouched tag has no note key at all.
    out['note'] = g.note;
  }
  return out;
}

/**
 * perspectiveName reads the {name} of the route. An empty one cannot reach a
 * handler — `perspectivePath` refuses that path — but a name of nothing but
 * spaces can, and `savePerspective` would have stored it under a name
 * nothing could ask for again.
 */
function perspectiveName(r: Req): string {
  const name = (r.params['name'] ?? '').trim();
  if (name === '') {
    throw usagef('a perspective needs a name');
  }
  return name;
}

/**
 * tagName reads the {name} of the route. `tagPath` refuses an empty segment,
 * but a name of nothing but spaces can reach a handler, and no tag is filed
 * under one.
 */
function tagName(r: Req): string {
  const name = (r.params['name'] ?? '').trim();
  if (name === '') {
    throw usagef('a tag needs a name');
  }
  return name;
}

/**
 * emptyAvailability is the zero value Go read out of a map for a missing key.
 * It is never looked at — `asked` is false wherever it is used — but
 * `NewTaskView` takes a value rather than a pointer, so one has to exist.
 */
function emptyAvailability(): Availability {
  return new Availability();
}
