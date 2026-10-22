// The viewer. It holds no model of its own: every write is a request, and
// every request is followed by a fresh snapshot of the whole tree, so what is
// on screen is what the store says and never a guess about what the store
// will say. A todo list is small and the server is on this machine, so the
// simple thing is also the fast one.
//
// The shape of the screen follows OmniFocus 3: three panes, one at a time on
// a phone and up to three at once on a wide screen, a Home of tinted
// perspective tiles, and a row whose status circle carries the colour.
'use strict';

// --- the shapes this file is written against -----------------------------
//
// This is JavaScript and stays JavaScript — it is served as it is, with no
// step between this file and the browser — but it is type-checked, by
// `tsconfig.json` beside it, with `checkJs` and `strictNullChecks`. The
// JSDoc below is what gives the checker the shapes: a task as `/api/state`
// renders it (§ *JSON shapes* in docs/agents.md), which is the same object
// `tdo ls --json` writes, derived keys included. The index signature is the
// open fields of `--set k=v`, which are flattened alongside the fixed ones
// and are what the inspector's Fields block edits.
//
/**
 * @typedef {Object.<string, any>} Task
 * @typedef {{name: string, status: string, count: number, note?: string}} Tag
 * @typedef {{name: string, filter: Object.<string, any>, created_at: string, updated_at: string}} Perspective
 * @typedef {{tasks: Task[], perspectives: Perspective[], tags: Tag[], now: string | null}} State
 * @typedef {{kind: string, key: string}} View
 */

const token = document.body.dataset.token;

/** @type {State} */
let state = { tasks: [], perspectives: [], tags: [], now: null };
/** @type {Map<string, Task>} */
let byID = new Map();
// Where the app opens: the Forecast, today. See `rootHash`.
/** @type {View} */
let view = { kind: 'due', key: 'today' };
/** @type {string | null} */
let selected = null;

// --- what this browser remembers ----------------------------------------

// The sidebar's folders are collapsed to begin with: a folder is a filing
// cabinet, and the reason to open one is to go into it, so a store with a
// dozen folders opens as a dozen rows rather than as everything it has.
//
// What is remembered is therefore the set of folders that have been
// *opened*, not the ones that are shut. A folder nobody has touched — one
// created since this browser last looked — is then closed by default
// instead of inheriting an expansion it was never part of.
//
// localStorage rather than the store, because this is where this browser is
// looking and not a fact about the todo list: `tdo` on another machine, and
// the next person to open the viewer, must not inherit it. Every access is
// guarded, because localStorage throws rather than returning nothing when
// the quota is full or the browser has blocked site data.
const ExpandedKey = 'tdo.expanded';

function loadExpanded() {
  try {
    const stored = JSON.parse(localStorage.getItem(ExpandedKey) || '[]');
    return new Set(Array.isArray(stored) ? stored.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

let expanded = loadExpanded();

function saveExpanded() {
  try {
    localStorage.setItem(ExpandedKey, JSON.stringify([...expanded]));
  } catch {
    // A viewer that cannot remember which folders were open is still a
    // viewer. The alternative is taking the pane down over a preference.
  }
}

// Two more preferences live in the same place and for the same reason: the
// order the Forecast is read in, and whether its tail is folded open. They
// are this browser's way of looking at the list and not a fact about it, so
// they are not in the store either. `remembered`/`remember` are the guarded
// pair the three of them share — every access has to be in a try, because
// localStorage throws rather than returning nothing when site data is
// blocked.
function remembered(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // As above: a forgotten preference is not worth a message on screen.
  }
}

// Whether the Projects and Tags lists under their tiles are open. A
// preference of this browser, like which folders are open: Projects starts
// open, Tags starts shut.
const TileOpenKey = 'todocloud.tile.open.';
const tileOpenDefault = { projects: true, tags: false };
const tileOpen = {
  projects: remembered(TileOpenKey + 'projects', tileOpenDefault.projects ? '1' : '0') === '1',
  tags: remembered(TileOpenKey + 'tags', tileOpenDefault.tags ? '1' : '0') === '1',
};

// Vim-style navigation of the sidebar (see `sideKeys`). `sideMode` is whether
// the keys go to the sidebar, and `sideKey` is the row they are on: the
// sidebar is rebuilt by every render, so the row is found again by its key.
let sideMode = false;
let sideKey = '';

function toggleTile(key) {
  tileOpen[key] = !tileOpen[key];
  remember(TileOpenKey + key, tileOpen[key] ? '1' : '0');
  renderHome();
}

function toggleExpanded(id) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  saveExpanded();
  renderHome();
}

// $ is the furniture of the page, by id, and it refuses to answer null.
//
// It used to be `querySelector` and nothing else, and a selector that
// matched nothing gave back null for the caller to walk into — which is how
// `about.hidden` on a shell without that element became `null is not an
// object` on a phone rather than anything a reader of this file could have
// seen. There are two shells over this one script (the local viewer's page
// and the PWA's, which differ in their connect flow), so a missing element
// is a real possibility and the honest answer to one is to say which
// element, at once, by name. The drift itself is caught before it ships:
// `web.test.ts` and `packages/pwa/src/shell.test.ts` hold both shells to
// every id this file asks for.
//
// `maybe` is for the handful that genuinely differ between the two. The
// difference between the two functions is the whole point: a caller says
// which kind of element it is reaching for, and the checker holds it to it.
/**
 * @param {string} sel
 * @param {ParentNode} [root] where to look; the document by default, and a
 * row of the inspector's Fields block where one is passed.
 * @returns {HTMLElement}
 */
function $(sel, root = document) {
  const node = root.querySelector(sel);
  if (node === null) {
    throw new Error(`tdo: this page has no ${sel}`);
  }
  return /** @type {HTMLElement} */ (node);
}

/**
 * @param {string} sel
 * @returns {HTMLElement | null}
 */
function maybe(sel) {
  return /** @type {HTMLElement | null} */ (document.querySelector(sel));
}

// What a handler's event happened on. `event.target` is an `EventTarget`,
// which has no `closest` and may be null; every listener in this file is on
// an element and fires for an element.
/** @param {Event} event @returns {HTMLElement} */
const nodeOf = (event) => /** @type {HTMLElement} */ (event.target);

// `closest` from a handler's own node, and from an element already in hand:
// it answers `Element | null`, and every caller here wants an element it can
// read a `dataset` off.
/** @param {Event} event @param {string} sel @returns {HTMLElement | null} */
const closestOf = (event, sel) => /** @type {HTMLElement | null} */ (nodeOf(event).closest(sel));
/** @param {Element} node @param {string} sel @returns {HTMLElement | null} */
const closestTo = (node, sel) => /** @type {HTMLElement | null} */ (node.closest(sel));

// What a caught thing says. A `catch` binding is `unknown` — which is the
// truth, since `throw` takes anything — and every caller here wants the one
// line to put on screen.
/** @param {unknown} err @returns {string} */
const messageOf = (err) => (err instanceof Error ? err.message : String(err));

// The same element under the type it actually has. A `<form>`'s `elements`,
// an `<input>`'s `value` and a `<dialog>`'s `showModal` are not on
// `HTMLElement`, and a cast at the one place the element is reached for is
// how the checker is told which kind it is — once, rather than at every use.
//
// A form's named controls are the exception that needs a type of its own.
// The DOM calls them an `HTMLFormControlsCollection` and reaches them by
// `namedItem`, which is not how any of the code below reads them or how the
// HTML names them; `form.elements.title` is the idiom, and it is stringly
// typed by nature — the name is in the markup. So the collection is widened
// here, once, rather than by a cast at each of the sixty places a field is
// read.
/** @typedef {HTMLFormControlsCollection & Object.<string, any>} FormFields */
/** @param {string} sel @returns {HTMLFormElement & {elements: FormFields}} */
const $form = (sel) => /** @type {HTMLFormElement & {elements: FormFields}} */ ($(sel));
/** @param {string} sel @param {ParentNode} [root] @returns {HTMLInputElement} */
const $input = (sel, root = document) => /** @type {HTMLInputElement} */ ($(sel, root));
/** @param {string} sel @returns {HTMLSelectElement} */
const $select = (sel) => /** @type {HTMLSelectElement} */ ($(sel));
/** @param {string} sel @returns {HTMLDialogElement} */
const $dialog = (sel) => /** @type {HTMLDialogElement} */ ($(sel));
/** @param {string} sel @returns {HTMLFieldSetElement} */
const $fieldset = (sel) => /** @type {HTMLFieldSetElement} */ ($(sel));

// The form a submit or a focusout happened in, under that same type.
/** @param {Event} event @returns {HTMLFormElement & {elements: FormFields}} */
const formOf = (event) => /** @type {HTMLFormElement & {elements: FormFields}} */ (event.target);

/**
 * el builds one element: the tag, the properties to assign and the children
 * to append. The properties are assigned rather than set, so `textContent`,
 * `className` and the `on…` handlers all work the way they read.
 *
 * @param {string} tag
 * @param {Object.<string, any>} [props]
 * @param {(Node | string)[] | Node | string} [kids]
 * @returns {any}
 */
const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of Array.isArray(kids) ? kids : [kids]) node.append(kid);
  return node;
};

// svg draws one of the small type icons. They are inline because they are
// three shapes, and a sprite sheet for three shapes is a second file to keep
// in step with this one.
function svg(paths, size = 15) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 16 16');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.4');
  node.innerHTML = paths;
  return node;
}

// A sequential project is three dots joined by a line; a parallel one is two
// dotted lines side by side; a folder is a folder. The manual describes the
// first two in exactly those words.
const TYPE_ICONS = {
  sequential: '<path d="M3 8h10"/><circle cx="3" cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="13" cy="8" r="1.4" fill="currentColor" stroke="none"/>',
  parallel: '<path d="M3 4h10" stroke-dasharray="2 2"/><path d="M3 11h10" stroke-dasharray="2 2"/>',
  folder: '<path d="M2 5.5a1 1 0 0 1 1-1h3l1.2 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
};

// --- talking to the server ---------------------------------------------

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function api(method, path, body) {
  /** @type {RequestInit & {headers: Object.<string, string>}} */
  const init = { method, headers: token === undefined ? {} : { 'X-Tdo-Token': token } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  if (!res.ok) {
    const message = payload && payload.error ? payload.error.message : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return payload;
}

// say reports in every status line there is: the outline's toolbar and the
// inspector's bar, which on a phone are never on screen together.
function say(message, isError) {
  for (const node of document.querySelectorAll('.status')) {
    node.textContent = message || '';
    node.classList.toggle('error', Boolean(isError));
  }
  toast(message, isError);
}

// The same words, floating, for the layout that has no room for a status
// bar: on a phone the outline's toolbar is gone — the keyboard hints mean
// nothing there and capture has left it — so what a write reported would
// otherwise be reported to a bar nobody can see. It is built here rather
// than in either index.html for the reason the pull indicator is: it
// belongs to this behaviour, not to the page.
const toaster = el('div', { className: 'toast' });
document.body.append(toaster);
let toastTimer = null;

function toast(message, isError) {
  clearTimeout(toastTimer);
  if (!message) {
    toaster.classList.remove('on');
    return;
  }
  toaster.textContent = message;
  toaster.classList.toggle('error', Boolean(isError));
  toaster.classList.add('on');
  // An error stays longer: it is the one a reader has to act on, and it is
  // also the one most likely to arrive while they are looking elsewhere.
  toastTimer = setTimeout(() => toaster.classList.remove('on'), isError ? 5000 : 2200);
}

// A write reports what it changed beyond what was asked: a repeat's
// successor and a container that closed with its last action are the two
// things a user would otherwise discover later, by their absence.
function reportExtras(result) {
  if (!result) return '';
  const notes = [];
  for (const t of result.repeated || []) notes.push(`repeats: “${t.title}” is next`);
  for (const t of result.completed_with_last || []) notes.push(`“${t.title}” completed with its last action`);
  return notes.join(' · ');
}

async function act(method, path, body, done) {
  try {
    say('working…');
    const result = await api(method, path, body);
    await reload(reportExtras(result) || done || '');
  } catch (err) {
    say(messageOf(err), true);
  }
}

async function reload(message) {
  const fresh = await api('GET', '/api/state');
  state = fresh;
  byID = new Map(state.tasks.map((t) => [t.id, t]));
  if (selected && !byID.has(selected)) selected = null;
  // A saved perspective is not part of the snapshot — only the store can say
  // what is in it — so a write that changed what it matches has to be asked
  // again, or the list on screen answers the question as it stood before.
  if (view.kind === 'saved') {
    try {
      await runSaved(view.key);
    } catch {
      savedView = { name: view.key, tasks: [] };
    }
  }
  render();
  updateBadge();
  // The first snapshot is where the address bar gets its say: a link to an
  // item cannot be opened before the ids are known. It is here rather than
  // beside the first `reload()` call at the end of this file because in the
  // PWA the first successful load is not that call — the page boots with no
  // store, and the viewer is reloaded once the connect form has opened one.
  if (!located) {
    located = true;
    adoptLocation();
  }
  say(message || '');
}

// located guards the above: every later reload leaves the pane where the
// reader put it.
let located = false;

// --- the slices of the tree --------------------------------------------

// `isClosed` and `isOpen` rather than `closed` and `open`: this file is a
// script and not a module, so a top-level `const open` is a redeclaration of
// `window.open` — which the checker refuses and a reader should not have to
// think about either.
const isClosed = (t) => t.status === 'done' || t.status === 'dropped';
const isOpen = (t) => !isClosed(t);
const isContainer = (t) => t.kind !== 'task';

function parentsOf(t) {
  const chain = [];
  let at = t.parent_id ? byID.get(t.parent_id) : null;
  while (at) {
    chain.unshift(at);
    at = at.parent_id ? byID.get(at.parent_id) : null;
  }
  return chain;
}

function inSubtree(t, rootID) {
  if (t.id === rootID) return true;
  return parentsOf(t).some((p) => p.id === rootID);
}

// Both of these answer against the server's own clock rather than the
// phone's: the two disagree often enough to matter at midnight.

// clock is that reading as a Date. `state.now` is null until the first
// snapshot arrives, and `new Date(null)` is the epoch, so the fallback is
// the behaviour this always had rather than a new one — nothing renders
// before the first reload anyway.
const clock = () => new Date(state.now ?? 0);

// passed reports whether an instant is behind us. It is the question "is
// this overdue", which is about the moment and not about the day.
const passed = (stamp) => Boolean(stamp) && new Date(stamp) <= clock();

// calendarDays counts whole days between two dates, not elapsed hours: an
// item due at midnight this morning is still due *today*, an hour overdue,
// and calling that "Yesterday" is how a list starts lying to its reader.
/**
 * @param {string | null | undefined} stamp
 * @returns {number} days away, or NaN when there is no date — every caller
 * guards with the date itself first, and NaN compares false either way.
 */
function calendarDays(stamp) {
  if (!stamp) return NaN;
  const a = new Date(stamp);
  const b = clock();
  const at = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const now = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((at - now) / 86400000);
}

const overdue = (t) => Boolean(t.due_at) && isOpen(t) && passed(t.due_at);
const dueSoon = (t) => Boolean(t.due_at) && isOpen(t) && !passed(t.due_at) && calendarDays(t.due_at) <= 2;

// landed is "the day has come": due today or on any day before it. It is a
// calendar question and not an hourly one, which is the difference that
// matters here — something due at 18:00 today has landed at breakfast, and a
// forecast that waits until 18:01 to say so is useless in the morning.
//
// It is what the number on the Forecast tile counts. The app icon counts
// something wider, `arrived` below.
const landed = (t) => Boolean(t.due_at) && isOpen(t) && calendarDays(t.due_at) <= 0;

// arrived is "either date has come": a task, open, due today or earlier, or
// deferred until today or earlier. Both, because the two say different things
// and either is a reason to look — a deadline has come, or work has just
// become available. It is what the icon counts, and deliberately not what the
// Forecast tile counts: a task whose defer date has passed but which has no
// deadline is not late, and the tile's number means late.
const arrived = (t) =>
  t.kind === 'task' && isOpen(t)
  && ((Boolean(t.due_at) && calendarDays(t.due_at) <= 0)
    || (Boolean(t.defer_at) && calendarDays(t.defer_at) <= 0));

// pastDue is "this is from an earlier day", which is a different question
// from `overdue` and the one the Forecast needs. A due date with no time on
// it is midnight, so everything due today is already `overdue` by breakfast
// — true, and useless for telling today's work apart from last week's.
// Today's list holds both, there is no Past column to separate them, so this
// is what the red edge on a row and the red rule under a day cell mean.
const pastDue = (t) => Boolean(t.due_at) && isOpen(t) && calendarDays(t.due_at) < 0;

// The perspectives, in the order the manual lists OmniFocus's own, with the
// two this tool has no equivalent for (Forecast's calendar, Nearby's
// location) standing in for what it does have: a plain due list and the next
// available actions. Each badge counts what OmniFocus counts — Forecast
// counts what is past due, not what is due today, and Inbox and Flagged
// count only what is actually available.
const PERSPECTIVES = [
  {
    // Forecast lists tasks, and only tasks. A project carries a due date of
    // its own and used to appear here beside them, which read as work to do
    // and was not: a project is a container, the thing to do is whichever of
    // its tasks is next, and the row for the container was in the way of
    // seeing it. Projects have a perspective — the one below — and a due date
    // on one still shows there and in `tdo ls`.
    //
    // An item belongs to the forecast if it has either date on it. A defer
    // date is what this view is sorted by out of the box (see
    // `forecastOrder`), so an item that has only a defer date has to be in
    // it, or the default order is over a list the date is missing from.
    key: 'due', label: 'Forecast', tint: 'salmon', glyph: '◷', wide: true,
    pick: (t) => t.kind === 'task' && isOpen(t) && (t.due_at || t.defer_at),
    badge: (items) => items.filter(landed).length,
  },
  {
    key: 'inbox', label: 'Inbox', tint: 'slate', glyph: '▤', wide: true,
    pick: (t) => t.kind === 'task' && !t.parent_id && isOpen(t),
    badge: (items) => items.filter((t) => t.available).length,
  },
  {
    key: 'flagged', label: 'Flagged', tint: 'creamsicle', glyph: '⚑',
    pick: (t) => t.flagged && isOpen(t),
    badge: (items) => items.filter((t) => t.available).length,
  },
  {
    key: 'next', label: 'Next', tint: 'mint', glyph: '➤',
    pick: (t) => t.kind === 'task' && t.status === 'active' && t.available,
  },
  {
    // Projects lists the containers as a tree — folders holding projects,
    // with the folders shut until they are opened — rather than as a flat
    // list of projects. That tree used to live under the tiles on Home; it
    // is a perspective like any other now, so it opens in the outline and
    // Home is only perspectives.
    key: 'projects', label: 'Projects', tint: 'sky', glyph: '▣', rows: 'tree', wide: true,
    pick: (t) => t.kind === 'project' && isOpen(t),
  },
  {
    // Tags is a way into the tree rather than a queue of work, so it lists
    // the tags themselves and each one leads to its items — which is what
    // OmniFocus's Tags perspective does, and why Home no longer carries a
    // tag list of its own below the tiles. `rows` says the outline shows
    // something other than tasks here; `pick` still has to exist, because
    // every tile asks its spec for a count.
    key: 'tags', label: 'Tags', tint: 'purple', glyph: '#', rows: 'tags', wide: true,
    pick: () => false,
  },
  {
    key: 'review', label: 'Review', tint: 'violet', glyph: '↻', wide: true,
    pick: (t) => t.next_review_at && isOpen(t),
    badge: (items) => items.filter((t) => passed(t.next_review_at)).length,
  },
];

// Other Perspectives, which OmniFocus keeps collapsed behind a Show: the
// views that answer a question about the list rather than offering work.
const OTHERS = [
  { key: 'blocked', label: 'Blocked', pick: (t) => isOpen(t) && t.available === false },
  { key: 'all', label: 'All', pick: (t) => isOpen(t) },
  { key: 'done', label: 'Completed', pick: (t) => isClosed(t), sort: (a, b) => (b.completed_at || '').localeCompare(a.completed_at || '') },
];

const specOf = (key) => PERSPECTIVES.find((v) => v.key === key) || OTHERS.find((v) => v.key === key);

function byDue(a, b) {
  if (!a.due_at) return 1;
  if (!b.due_at) return -1;
  return a.due_at.localeCompare(b.due_at);
}

// --- the Forecast's own order and horizon --------------------------------

// Forecast is the view this list is read in, so it is the one that gets a
// choice of order, and the choice is remembered: a preference that has to be
// made again every time the app is opened is not a preference.
//
// Defer first, which is the one the manual's own argument points at. A due
// date says when something must be finished; a defer date says when it may
// be started, and a list read in the morning to decide what to do today is a
// list of what has been released. Due order is the other question — what is
// closest to going wrong — and is one tap away.
const ForecastOrderKey = 'tdo.forecast.order';
const ForecastLaterKey = 'tdo.forecast.later';

const FORECAST_ORDERS = [
  { key: 'defer', label: 'Defer' },
  { key: 'due', label: 'Due' },
];

let forecastOrder = FORECAST_ORDERS.some((o) => o.key === remembered(ForecastOrderKey, ''))
  ? remembered(ForecastOrderKey, 'defer')
  : 'defer';

// Whether the tail is open is remembered too, for the same reason, and
// starts shut.
let forecastLaterOpen = remembered(ForecastLaterKey, '') === 'open';

// Inside a project, whether what is finished stays on screen.
//
// Everywhere else the answer is no and is not a choice: the Forecast, Next
// and the tag views are lists of work, and a finished item is not work. A
// project is the other thing — a plan, read to see where it has got to —
// and there the completed actions are what says how far it has got. That is
// the question OmniFocus answers with a per-project View setting, and this
// is the same setting with one scope: it applies to every project, because
// a preference per project is a thing to set over and over before it is
// ever useful.
//
// Off to begin with, so a project opens as a list of what is left, and
// remembered per browser like the Forecast's order. `Completed` is still
// the view for the whole store's history.
const ProjectDoneKey = 'tdo.project.done';

let projectDoneShown = remembered(ProjectDoneKey, '') === 'shown';

// On one day of the Forecast, whether what was finished that day is on it.
//
// A day is the one part of the Forecast where a completed item is not noise.
// The Forecast as a whole is a list of work and a finished task has left it;
// a single day is also a day — "what was Tuesday" is a question with an
// answer, and the answer without the four things that were done that day is
// a worse answer. OmniFocus's Forecast says the same thing by putting the
// day's calendar events beside its tasks: a day is a record as much as a
// plan.
//
// Scoped to a day on purpose. `all` does not get these rows: the flat list
// is ordered by a date that is in the future for most of it, and a task
// finished on Monday has no place in it. Off to begin with, and remembered
// per browser like the order above.
const ForecastDoneKey = 'tdo.forecast.done';

let forecastDoneShown = remembered(ForecastDoneKey, '') === 'shown';

function toggleForecastDone() {
  forecastDoneShown = !forecastDoneShown;
  remember(ForecastDoneKey, forecastDoneShown ? 'shown' : 'hidden');
  render();
}

function toggleProjectDone() {
  projectDoneShown = !projectDoneShown;
  remember(ProjectDoneKey, projectDoneShown ? 'shown' : 'hidden');
  render();
}

function setForecastOrder(key) {
  forecastOrder = key;
  remember(ForecastOrderKey, key);
  render();
}

function toggleForecastLater() {
  forecastLaterOpen = !forecastLaterOpen;
  remember(ForecastLaterKey, forecastLaterOpen ? 'open' : 'shut');
  render();
}

// The two orders. Each is named after a date, and the item's *other* date
// stands in where the named one is missing: an item with no defer date is
// available already, so in defer order it belongs where its deadline puts it
// rather than dumped at the end of the list — and an overdue item at the
// bottom of a forecast is exactly the failure to avoid. Ties break on the
// title so that the order is stable between renders.
function byDateThen(first, second) {
  const keyOf = (t) => t[first] || t[second] || '';
  return (a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    if (!x) return 1;
    if (!y) return -1;
    return x.localeCompare(y) || a.title.localeCompare(b.title);
  };
}

const FORECAST_SORTS = {
  defer: byDateThen('defer_at', 'due_at'),
  due: byDateThen('due_at', 'defer_at'),
};

// The horizon. A forecast is about the week in front of you: what is
// already here, and what arrives over the next seven days. Something
// released in three weeks is a fact about the list and not news about today,
// so it is still in the view — it has not been filtered away, which would be
// a different and more dishonest thing — but folded into one row at the end.
const ForecastHorizonDays = 7;

const beyondHorizon = (t) => Boolean(t.defer_at) && calendarDays(t.defer_at) > ForecastHorizonDays;

// forecastList splits the whole Forecast into the part that is on screen and
// the tail behind the fold. One function, because the fold's own count and
// the rows it hides have to agree.
function forecastList() {
  const due = PERSPECTIVES[0];
  const items = state.tasks.filter(due.pick).sort(FORECAST_SORTS[forecastOrder]);
  return {
    near: items.filter((t) => !beyondHorizon(t)),
    later: items.filter(beyondHorizon),
  };
}

// A saved perspective is a stored filter the server runs, and running one
// here would mean reimplementing it in JavaScript — which is exactly the
// drift this UI is written to avoid. So Home lists them and says what to
// type; the projects and tags are the parts a client can honour faithfully.
function currentItems() {
  if (view.kind === 'project') {
    const root = byID.get(view.key);
    if (!root) return [];
    // A dropped item is not shown either way: it was decided against, and
    // the plan is not a record of what was considered. What is completed is
    // the toggle above the list.
    const keep = (t) => (projectDoneShown ? t.status !== 'dropped' : isOpen(t));
    return state.tasks.filter((t) => t.id !== root.id && inSubtree(t, root.id) && keep(t));
  }
  if (view.kind === 'tag') {
    return state.tasks.filter((t) => isOpen(t) && (t.tags || []).some((g) => g.toLowerCase() === view.key.toLowerCase()));
  }
  if (view.kind === 'saved') {
    // The server decided what is in it and in what order; the page's job is
    // to render that and not to re-sort it.
    return savedView.name === view.key ? savedView.tasks : [];
  }
  // The Forecast is one day of the week, or — under `all` — the whole of it
  // in one list. What is behind the `all` list's fold is in it only while
  // the fold is open, so that `j`/`k` and the inspector's "first item" never
  // land on a row that is not on screen.
  if (view.kind === 'due') {
    if (view.key && view.key !== 'all') {
      const cell = forecastCell(view.key);
      return cell ? forecastOn(cell) : [];
    }
    const { near, later } = forecastList();
    return forecastLaterOpen ? near.concat(later) : near;
  }
  const spec = specOf(view.kind) || PERSPECTIVES[1];
  const items = state.tasks.filter(spec.pick);
  return spec.sort ? items.slice().sort(spec.sort) : items;
}

function viewTitle() {
  if (view.kind === 'project') {
    const root = byID.get(view.key);
    return root ? root.title : 'Project';
  }
  if (view.kind === 'tag') return view.key;
  if (view.kind === 'saved') return view.key;
  // The week is on screen under the title and says which day is open, so the
  // title does not repeat it.
  if (view.kind === 'due') return 'Forecast';
  const spec = specOf(view.kind);
  return spec ? spec.label : 'Items';
}

// --- search --------------------------------------------------------------

// What is being looked for, as typed. It is not in the URL: a half-typed
// query is not a place, and a history entry per keystroke would make the
// back gesture useless for as long as the box has focus.
let query = '';

// Everything live, matched on the words a person would remember: the title,
// the note and the tags. Containers are in it too — a project is a thing you
// look for by name — and so are completed items, because "what did I call
// that thing I finished last week" is half of what a search is for.
//
// The matching is every word, in any order and anywhere: a query of two
// words finds a title that has both, which is what a search box is assumed
// to do and is one line to write.
function searchResults() {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const haystack = (t) => [t.title, t.note || '', ...(t.tags || [])].join(' ').toLowerCase();
  return state.tasks.filter((t) => {
    const text = haystack(t);
    return words.every((w) => text.includes(w));
  });
}

function setQuery(text) {
  query = text;
  $('#search-clear').hidden = text === '';
  render();
}

// --- saved perspectives --------------------------------------------------

// A saved perspective is a stored `Filter`, and the thing that can run a
// Filter is the store — SQLite here, Turso over `fetch` in the PWA. Reading
// it back in JavaScript would be a second implementation of the same query,
// and the two would answer differently the first time either changed, so the
// page asks the server to run it and keeps the answer.
//
// What is kept is the whole task, not a list of ids: a perspective may ask
// for tombstoned items (`only_deleted`), and those are not in the snapshot
// `/api/state` returns.
let savedView = { name: '', tasks: [] };

async function runSaved(name) {
  const res = await api('GET', `/api/perspectives/${encodeURIComponent(name)}`);
  savedView = { name, tasks: res.tasks || [] };
}

async function openSaved(name) {
  try {
    say('running…');
    await runSaved(name);
    say('');
    select({ kind: 'saved', key: name });
  } catch (err) {
    say(messageOf(err), true);
  }
}

// --- panes --------------------------------------------------------------

// On a narrow screen one pane is on at a time and the back chevron walks
// Home ← outline ← item, the way it does in OmniFocus; on a wide one all
// three are on screen and this attribute is ignored.
function showPane(name) {
  document.body.dataset.pane = name;
  if (!restoring) keepLocation(name);
}

function select(next) {
  view = next;
  showPane('outline');
  render();
}

// compact is the one-pane layout, the same 859px app.css switches on. It is
// asked rather than remembered because a window is resized and a phone is
// rotated.
const compact = () => window.matchMedia('(max-width: 859px)').matches;

// openContainer is a click on a folder or a project in the Projects tree.
//
// Two things happen, because a container is two things: a list to read and
// an item in its own right. The pane the tree was in becomes the
// container's own outline — its tasks, in tree order, under the heading
// that says what is written on the container (`renderAbout`) — and the
// container is also selected, so the inspector is showing the project that
// is open rather than whatever was selected before it.
//
// Which pane is in front afterwards differs with the layout, and only
// because of what is on screen. Wide, all three panes are up: the list is
// the project and the inspector is the project, with nothing to choose
// between. Compact, one pane is up and the list is the one that was asked
// for — a tap on a project means "show me what is in it" — so the inspector
// is selected and waits behind the `i` button.
function openContainer(t) {
  if (saveTimer) saveNow();
  view = { kind: 'project', key: t.id };
  selected = t.id;
  // Opening a project unfolds it in the sidebar: the tree under it is the
  // point of opening it.
  if (!expanded.has(t.id)) { expanded.add(t.id); saveExpanded(); }
  showPane(compact() ? 'outline' : 'inspector');
  render();
}

function selectItem(id) {
  // A pending edit belongs to the item that was on screen when it was
  // typed, so it goes up before the inspector shows another one.
  if (saveTimer) saveNow();
  selected = id;
  showPane('inspector');
  render();
}

// --- where we are, in the URL -------------------------------------------

// Walking back a pane has to be the platform's own gesture, and the only way
// to be handed that gesture is to have an address per pane. Installed to a
// home screen there is no chrome and no back button at all: iOS gives a
// standalone app the edge swipe and Android the system back, and both of
// them mean "pop the history entry". A page that never pushed one is a page
// those gestures can only leave.
//
// So every pane this viewer opens is an entry, and `popstate` is the one
// thing that puts a pane back. The chevron, Escape and the swipe are all
// `history.back()` — one path, so they cannot disagree.
//
// The addresses are paths and read as paths:
//
//     /                      the Forecast, today — where the app opens
//     /home                  the perspectives
//     /forecast/d3           one day of the week
//     /forecast/all          the whole Forecast as one list
//     /inbox /flagged /next /projects /tags /review /blocked /all /done
//     /project/<id>
//     /tag/<name>
//     /perspective/<name>
//     …/item/<id>            the inspector, on any of the above
//
// They are after a `#`, and that is the one compromise. `tdo serve` serves
// this page at `/` and the PWA is a static site on GitHub Pages; a real path
// either of them has not been taught is a 404 on the next reload, and
// teaching both would mean a catch-all route in the server and a `404.html`
// in the build. A hash is also never sent to the server, which is the right
// property for something that names an item id. The grammar above is the
// part that matters, and it is the same either way.
//
// Every segment is encoded, because a tag or a perspective may be named
// anything at all — a `/` in a tag name would otherwise read as another
// segment.
const rootHash = '#/';           // the Forecast, today
const homeHash = '#/home';

// The word each kind of view is called in an address. A perspective that is
// not listed is called by its own key (`/inbox`, `/flagged`, …), which is
// what makes those addresses read the way they do.
const VIEW_WORDS = { due: 'forecast', project: 'project', tag: 'tag', saved: 'perspective' };

/** pathFor is the address of a view, without the item. */
function pathFor(v) {
  const word = VIEW_WORDS[v.kind];
  if (!word) return `#/${encodeURIComponent(v.kind)}`;
  if (v.kind === 'due') {
    // Today is the root: it is where the app opens, and an address bar that
    // says `/forecast/today` on the screen everybody starts on is noise.
    if (!v.key || v.key === 'today') return rootHash;
    return `#/forecast/${encodeURIComponent(v.key)}`;
  }
  return `#/${word}/${encodeURIComponent(v.key)}`;
}

function hashFor(pane) {
  if (pane === 'home') return homeHash;
  const at = pathFor(view);
  if (pane !== 'inspector' || !selected) return at;
  return `${at === rootHash ? '#' : at}/item/${encodeURIComponent(selected)}`;
}

// restoring is true only while popstate is being applied: what the entry
// says is already in the history, and pushing it again would mean two
// entries for one pane and a back gesture that appears to do nothing.
let restoring = false;

// viewPathOf is the view half of an address, with any `/item/<id>` suffix
// taken off: the list a hash names, without which item of it is open.
function viewPathOf(hash) {
  return hash.replace(/\/item\/[^/]*$/, '') || rootHash;
}

// keepLocation records where we are in the URL, and decides whether that is
// somewhere to come back from.
//
// It is an entry — a push — when the list changes: Inbox to Flagged, the
// Forecast to a project, one project to another. It is a replace when the
// list is the same one and all that changed is which of its items is
// selected, because clicking down a list of thirty items is reading one
// list and not thirty places, and thirty entries would make the back button
// useless for leaving it.
//
// Going deeper is a push as well, which is what the back gesture on a phone
// walks: Home → a list → an item are three panes and three entries, even
// when the list is the one already open.
//
// This used to be the depth test alone, and on a wide screen that made the
// back button almost inert: all three panes are up at once there, so
// nothing is ever deeper after the first click, and every list after the
// first replaced the one before it. Back left the app instead of walking it.
function keepLocation(pane) {
  const next = hashFor(pane);
  if (next === location.hash) return;
  const deeper = depthOfPane(pane) > depthOfPane(lastPane);
  const elsewhere = viewPathOf(next) !== viewPathOf(location.hash);
  lastPane = pane;
  try {
    if (deeper || elsewhere) history.pushState(null, '', next);
    else history.replaceState(null, '', next);
  } catch {
    // A history that refuses to be written is a viewer that still works,
    // with the back gesture leaving it. There is nothing useful to say.
  }
}

// Home is depth 0 and the outline is 1, which is still true now that the app
// opens on the outline: Home is the screen the back gesture arrives at, and
// boot puts it under the first entry (see `adoptLocation`).
const PANE_DEPTH = { home: 0, outline: 1, inspector: 2 };
const depthOfPane = (pane) => PANE_DEPTH[pane] ?? 0;
let lastPane = 'home';

// applyLocation is the other direction: the URL decides what is on screen.
// It runs on `popstate` — the back gesture, the back button, Escape — and
// once at boot, so a link to an item opens that item.
function applyLocation() {
  const where = parseHash(location.hash);
  // An address this build cannot place — an old link, a typo, a saved
  // perspective since deleted — lands on the Forecast, and the address is
  // corrected to say so. An address bar that still names somewhere the app
  // is not is what makes the next back gesture surprising.
  if (!where) return goRoot();
  // `/home` is the one address with no view on it; the checker is as
  // entitled to know that as the reader is.
  if (where.pane === 'home' || where.view === undefined) return showRestored('home');
  view = where.view;
  if (where.id && byID.has(where.id)) {
    selected = where.id;
    return showRestored('inspector');
  }
  return showRestored('outline');
}

/**
 * parseHash reads one of the addresses above. It returns undefined for
 * anything it cannot place, which is the caller's cue to go to the root —
 * the hash came from the address bar, so none of it is trusted.
 */
/**
 * @typedef {{pane: string, view?: View, id?: string}} Place
 * @param {string} hash
 * @returns {Place | undefined}
 */
function parseHash(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));

  // `…/item/<id>` is a suffix on any view, so it comes off first.
  let id = '';
  if (parts.length >= 2 && parts[parts.length - 2] === 'item') {
    id = parts[parts.length - 1];
    parts.length -= 2;
  }

  const [word = '', key = ''] = parts;
  if (parts.length > 2) return undefined;
  if (word === '') return { pane: 'outline', view: { kind: 'due', key: 'today' }, id };
  if (word === 'home') return parts.length === 1 ? { pane: 'home' } : undefined;
  if (word === 'forecast') {
    if (key === '' || key === 'today') return { pane: 'outline', view: { kind: 'due', key: 'today' }, id };
    if (key === 'all' || forecastCell(key)) return { pane: 'outline', view: { kind: 'due', key }, id };
    return undefined;
  }
  if (word === 'project') {
    // The id is checked against the store rather than taken on trust: a
    // project that has been deleted must not open as an empty outline
    // titled "Project".
    return byID.has(key) ? { pane: 'outline', view: { kind: 'project', key }, id } : undefined;
  }
  if (word === 'tag') {
    const known = (state.tags || []).some((g) => g.name.toLowerCase() === key.toLowerCase());
    return known ? { pane: 'outline', view: { kind: 'tag', key }, id } : undefined;
  }
  if (word === 'perspective') {
    const known = (state.perspectives || []).some((perspective) => perspective.name === key);
    return known ? { pane: 'outline', view: { kind: 'saved', key }, id } : undefined;
  }
  if (parts.length === 1 && specOf(word) && !VIEW_WORDS[word]) {
    return { pane: 'outline', view: { kind: word, key: '' }, id };
  }
  return undefined;
}

function goRoot() {
  view = { kind: 'due', key: 'today' };
  try {
    history.replaceState(null, '', rootHash);
  } catch { /* a history that cannot be written is still a working viewer */ }
  return showRestored('outline');
}

function showRestored(pane) {
  restoring = true;
  try {
    lastPane = pane;
    showPane(pane);
    render();
  } finally {
    restoring = false;
  }
}

// adoptLocation is the boot: Home goes into the history first and whatever
// the address asked for is pushed on top of it, so that the first back
// gesture walks up the app rather than out of it. That is what makes the
// Forecast the opening screen *and* leaves the chevron somewhere to go —
// `/` is the Forecast, and Home is the entry underneath it.
function adoptLocation() {
  const asked = location.hash || rootHash;
  try {
    history.replaceState(null, '', homeHash);
    history.pushState(null, '', asked);
  } catch {
    // Without a writable history the viewer opens where it stands, which is
    // what it did before any of this existed.
  }
  applyLocation();
}

window.addEventListener('popstate', () => applyLocation());

// --- swiping back -------------------------------------------------------

// The gesture an installed viewer does not otherwise get. iOS hands a
// standalone app its edge swipe, but only near the edge and only when there
// is an entry to pop; a drag from the middle of the list does nothing, and
// on a phone the middle of the list is where the thumb is. So the pane
// itself takes a horizontal drag and reads it as back.
//
// Right-to-left is deliberately not forward: there is no one place forward
// goes from the outline, and a gesture that guesses is worse than no
// gesture. Back is unambiguous.
const SwipeMinX = 72;      // far enough not to fire on a tap that slid
const SwipeMaxY = 50;      // a drag that is mostly vertical is a scroll

let swipe = null;

// --- pulling down to reload ---------------------------------------------

// The other half of the same gesture. A phone list is reloaded by dragging
// it down past its top, and this one has to do it itself: the page is a
// single screen with `overflow: hidden` on the body, each pane scrolls
// inside itself, and `overscroll-behavior` stops the pull from reaching the
// browser — which is the right answer for the rubber-band and leaves no
// native refresh to inherit. Installed to a home screen there is no reload
// button in any chrome either, and the one in Home's navigation bar is a
// pane away from the list being read.
//
// It fires only from a pane already scrolled to its top. Anywhere else the
// drag is a scroll, and a list that reloaded because someone scrolled up
// quickly would be worse than one that never reloaded at all.
const PullTrigger = 72;   // how far down before letting go means reload
const PullMax = 110;      // where the indicator stops following the finger

// The indicator is built here rather than in either index.html, because it
// belongs to this behaviour and both front ends would otherwise carry a
// markup element whose only purpose is to be found by this file.
const puller = el('div', { className: 'pull' }, el('span', { className: 'mark', textContent: '\u21bb' }));
document.body.append(puller);

function showPull(distance, ready) {
  if (distance <= 0) {
    puller.classList.remove('on', 'ready', 'busy');
    puller.style.removeProperty('--pull');
    return;
  }
  puller.classList.add('on');
  puller.classList.toggle('ready', ready);
  puller.style.setProperty('--pull', String(Math.min(distance, PullMax)));
}

async function pullReload() {
  puller.classList.add('busy');
  try {
    await reload('reloaded');
  } catch (err) {
    say(messageOf(err), true);
  } finally {
    showPull(0, false);
  }
}

document.addEventListener('touchstart', (event) => {
  // One finger only: two is a pinch or a scroll, and neither is this.
  if (event.touches.length !== 1) {
    swipe = null;
    return;
  }
  const t = event.touches[0];
  // The pane this drag started in, and only when it is already at its top:
  // what makes a pull a pull is that there is nothing above it to scroll to.
  // `closest` also answers no inside a dialog, which is what should happen —
  // a modal is not a list to refresh.
  const pane = closestOf(event, '.pane-body');
  swipe = {
    x: t.clientX,
    y: t.clientY,
    ok: true,
    pane: pane && pane.scrollTop <= 0 ? pane : null,
    pulled: 0,
  };
}, { passive: true });

document.addEventListener('touchmove', (event) => {
  if (!swipe || event.touches.length !== 1) return;
  const t = event.touches[0];
  const dy = t.clientY - swipe.y;
  swipe.dx = t.clientX - swipe.x;
  // Once a drag has gone further down than across it is a scroll, and it
  // stays a scroll however it ends: a flick that curves back must not take
  // the pane away under the finger.
  if (Math.abs(dy) > SwipeMaxY) swipe.ok = false;

  // Downwards, from the top, and more down than across — the last of those
  // is what keeps the back swipe and this gesture from both being true.
  if (swipe.pane && dy > 0 && dy > Math.abs(swipe.dx)) {
    // The pane may have been scrolled since the drag began: a momentum
    // scroll still settling is not the top.
    if (swipe.pane.scrollTop > 0) {
      swipe.pulled = 0;
      showPull(0, false);
      return;
    }
    // Resistance, so that the indicator keeps moving as the finger does but
    // the trip is longer than the thumb's: a pull that fires at the first
    // pixel fires by accident.
    swipe.pulled = dy * 0.5;
    showPull(swipe.pulled, swipe.pulled >= PullTrigger);
  } else if (swipe.pulled) {
    swipe.pulled = 0;
    showPull(0, false);
  }
}, { passive: true });

document.addEventListener('touchend', () => {
  const done = swipe;
  swipe = null;
  if (!done) return;
  if (done.pulled >= PullTrigger) {
    pullReload();
    return;
  }
  if (done.pulled) showPull(0, false);
  if (!done.ok || !(done.dx > SwipeMinX)) return;
  // Only where there is a pane to go back to. On a wide screen all three
  // are on at once and the gesture means nothing, which `data-pane` is also
  // how the layout decides.
  if (document.body.dataset.pane === 'home') return;
  if (!window.matchMedia('(max-width: 859px)').matches) return;
  history.back();
}, { passive: true });

// A cancelled touch — a call arriving, a system gesture taking over — leaves
// the indicator on screen with nothing driving it.
document.addEventListener('touchcancel', () => {
  swipe = null;
  showPull(0, false);
}, { passive: true });

// --- the badge on the app icon ------------------------------------------

// What a glance at the home screen should say: how many tasks have a due or
// defer date that has arrived (`arrived`). That is wider than the number on
// the Forecast tile, which counts only what is late — the icon is "look at
// the app", the tile is "this is overdue".
//
// Both calls are guarded and both are allowed to fail. The API does not
// exist in every browser, and on iOS it exists but answers only an installed
// app whose notification permission has been granted — which is what
// `#badge-ask` is for. A refusal is not an error worth a line on screen:
// the list is on screen either way.
function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const n = state.tasks.filter(arrived).length;
  const call = n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge();
  if (call && typeof call.catch === 'function') call.catch(() => {});
}

// badgeAsk is the one control the badge needs and only on iOS: there, the
// badge is part of the notification permission, so it cannot be turned on
// without a tap to hang the prompt on. The button is in Home's toolbar and
// is hidden unless all three things are true — the API is here, the viewer
// is installed, and the permission has not been answered yet — so on a
// desktop browser and on Android nobody ever sees it.
function renderBadgeAsk() {
  const button = maybe('#badge-ask');
  if (!button) return;
  const asked = typeof Notification === 'undefined' || Notification.permission !== 'default';
  const installed = window.matchMedia('(display-mode: standalone)').matches
    || /** @type {any} */ (window.navigator).standalone === true;
  button.hidden = !('setAppBadge' in navigator) || asked || !installed;
}

// --- rendering ---------------------------------------------------------

function render() {
  renderHome();
  renderList();
  renderInspector();
  renderBadgeAsk();
}

function navRow(label, count, isCurrent, onClick, options = {}) {
  const button = el('button', {
    type: 'button',
    className: 'nav-row',
    // The second click of a double click must not navigate: a double click
    // on the name edits it in place, and going into the folder at the same
    // time would take the field being typed into off screen.
    onclick: (event) => { if (event.detail < 2) onClick(event); },
  });
  button.setAttribute('aria-current', isCurrent ? 'true' : 'false');
  if (options.depth) button.classList.add(`depth${Math.min(options.depth, 2)}`);
  if (options.held) button.classList.add('held');
  if (options.mark) button.append(el('span', { className: 'mark' }, options.mark));
  button.append(el('span', { className: 'name', textContent: label }));
  if (count !== null && count !== undefined) {
    button.append(el('span', { className: 'count', textContent: String(count) }));
  }
  if (options.id) button.dataset.id = options.id;
  if (options.key) button.dataset.key = options.key;
  if (options.tag) button.dataset.tag = options.tag;
  if (options.perspective) button.dataset.perspective = options.perspective;
  if (options.disclosure === undefined) {
    return el('li', {}, button);
  }
  // A folder's row stays one target, so the triangle is a button of its own
  // beside it rather than inside it: a button within a button is not a
  // thing HTML has. A folder with nothing in it gets the same width as a
  // spacer, so every name in the list still starts at the same place.
  const slot = options.disclosure === null
    ? el('span', { className: 'twisty-space' })
    : twisty(options.disclosure);
  return el('li', { className: 'nav-branch' }, [slot, button]);
}

// twisty is the disclosure triangle. It names the folder it opens, because
// a list of identical triangles is unusable with a screen reader.
function twisty({ id, label, isOpen }) {
  const button = el('button', {
    type: 'button',
    className: 'twisty',
    textContent: isOpen ? '\u25be' : '\u25b8',
    onclick: (event) => { event.stopPropagation(); toggleExpanded(id); },
  });
  button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  button.setAttribute('aria-label', `${isOpen ? 'collapse' : 'expand'} ${label}`);
  return button;
}

function renderHome() {
  // OmniFocus's Home is a grid of coloured squares, two to a row except for
  // the ones that get a row to themselves, with hairlines between them
  // rather than cards. `wide` says which of ours take the whole width; the
  // rest alternate, and which column a tile is in decides whether it draws
  // the line down its right-hand side.
  let narrow = 0;
  $('#tiles').replaceChildren(...PERSPECTIVES.map((spec) => {
    const items = state.tasks.filter(spec.pick);
    const n = spec.rows === 'tags'
      ? (state.tags || []).length
      : (spec.badge ? spec.badge(items) : items.length);
    const tile = el('button', {
      type: 'button',
      className: 'tile',
      // The Forecast opens on today; every other perspective has one list.
      // Projects is a tree in the sidebar rather than a list in the outline:
      // the outline is the one pane whose contents change with every click,
      // and a list of projects that turned into a list of tasks under the
      // pointer was the hardest thing in it to aim at.
      onclick: spec.rows
        ? () => toggleTile(spec.key)
        : () => select({ kind: spec.key, key: spec.key === 'due' ? 'today' : '' }),
    });
    tile.style.setProperty('--tint', `var(--${spec.tint})`);
    tile.setAttribute('aria-current', view.kind === spec.key || (spec.key === 'projects' && view.kind === 'project') ? 'true' : 'false');
    if (spec.rows) tile.setAttribute('aria-expanded', tileOpen[spec.key] ? 'true' : 'false');
    // The square carries the count for a perspective that is a queue of work
    // and the perspective's own glyph for one that is a way into the tree —
    // which is what OmniFocus shows, numbers on Forecast, Inbox, Flagged and
    // Review and icons on Projects and Tags. `badge` is what tells the two
    // apart here, because it is defined exactly for the queues.
    const glyph = el('span', { className: 'glyph', textContent: spec.badge ? String(n) : spec.glyph });
    // The square repeats what the label says, so it is decoration as far as
    // a screen reader is concerned; the tile's own aria-label carries the
    // count.
    glyph.setAttribute('aria-hidden', 'true');
    tile.append(glyph, el('span', { className: 'name', textContent: spec.label }));
    tile.setAttribute('aria-label', `${spec.label}, ${n}`);
    tile.dataset.key = spec.key;
    const cell = el('li', { className: spec.wide ? 'wide' : (narrow++ % 2 === 0 ? 'col1' : 'col2') }, tile);
    if (spec.key === 'due') cell.append(forecastStrip());
    // The list sits directly under its own tile, so opening Projects shows
    // the projects where the word Projects is.
    if (spec.rows && tileOpen[spec.key]) {
      cell.append(el('ul', { className: 'rows tile-list' }, spec.rows === 'tree' ? treeRows() : tagRows()));
    }
    return cell;
  }));

  $('#others').replaceChildren(
    ...OTHERS.map((spec) => navRow(spec.label, state.tasks.filter(spec.pick).length,
      view.kind === spec.key, () => select({ kind: spec.key, key: '' }), { key: spec.key })),
    ...(state.perspectives || []).map((p) => navRow(
      p.name,
      savedView.name === p.name ? savedView.tasks.length : null,
      view.kind === 'saved' && view.key === p.name,
      () => openSaved(p.name),
      { mark: el('span', { textContent: '⌕' }), perspective: p.name })));
  restoreSide();
}

// The week under Due, which is the one thing on OmniFocus's Home that is a
// picture rather than a row: what is already late, today, the next four days
// by name, and everything after that.
//
// Due dates only. A deferred item is not forecast — it is waiting, and the
// day it becomes available is not the day it is wanted. It reports rather
// than navigates: there is no single-day view to go to, and a cell that
// looked tappable and was not would be worse than one that plainly is not.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The buckets, defined once. The strip on Home counts with them, the
// calendar on the Forecast screen counts with them and the outline filters
// with them, so a day that says 2 shows two items — the one thing a forecast
// must never get wrong. The keys are stable (`d1`..`d6`) while the labels are
// not: Thursday is `d4` today and `d3` tomorrow, and a view held open across
// midnight should follow the day it means rather than the name it had.
//
// Seven cells, today first. There is no "Past" cell of its own any more:
// **Today carries everything already due**, which is what a day you open in
// the morning has to say — an overdue bill is today's problem, and filing it
// under a day that has gone is how it stops being looked at. OmniFocus does
// the same thing, and it is why `dueMatch` and `startMatch` are separate: a
// deadline that has passed belongs to today, a defer date that has passed is
// nothing but availability and belongs to no day at all.
function forecastDays() {
  const today = clock();
  const cells = [{
    key: 'today',
    label: 'Today',
    day: today.getUTCDate(),
    weekday: WEEKDAYS[today.getUTCDay()],
    dueMatch: (d) => d <= 0,
    startMatch: (d) => d === 0,
    // Unlike `dueMatch`, today's completions are today's and no earlier
    // day's. A deadline that has passed is still work and belongs to the day
    // it is being looked at on; something finished last Tuesday happened on
    // Tuesday, and today claiming it would make every day's record the whole
    // history.
    doneMatch: (d) => d === 0,
    today: true,
  }];
  for (let i = 1; i <= 6; i += 1) {
    const day = new Date(today.getTime() + i * 86400000);
    cells.push({
      key: `d${i}`,
      label: WEEKDAYS[day.getUTCDay()],
      day: day.getUTCDate(),
      weekday: WEEKDAYS[day.getUTCDay()],
      dueMatch: (d) => d === i,
      startMatch: (d) => d === i,
      doneMatch: (d) => d === i,
      today: false,
    });
  }
  return cells;
}

const forecastCell = (key) => forecastDays().find((c) => c.key === key);

// A day holds two different facts, and GTD keeps them apart on purpose.
//
// A due date is a commitment: this has to be finished by then, and missing
// it has a consequence outside the list. A defer date is the opposite — a
// decision *not* to think about something until a day comes (the tickler
// file). One is a deadline, the other is a release. Mixed into one number
// they stop meaning anything: a day showing "5" that turns out to be five
// things that merely became available reads as pressure that is not there,
// and the one real deadline hides inside it.
//
// So each day counts both and shows them apart: due in the deadline colour,
// starting in a calm one. Past carries no starting count, because something
// released last week is not news — it is just available, which is what the
// Next perspective is for.
// Tasks only, here as in the perspective itself: the day's number has to be
// the number of rows the day opens, and a project with a due date was in
// both the count and the list.
const dueOn = (cell) => state.tasks.filter(
  (t) => t.kind === 'task' && t.due_at && isOpen(t) && cell.dueMatch(calendarDays(t.due_at)));

const startsOn = (cell) => state.tasks.filter(
  (t) => t.kind === 'task' && t.defer_at && isOpen(t) && cell.startMatch(calendarDays(t.defer_at)));

// completedOn is the day as a record rather than a plan: what was finished
// on it. Not counted on the cell and not in any badge — a day's number means
// work, and a number that grew as the day went well would be the opposite of
// what the Forecast is read for. These rows appear only inside the day, and
// only while `forecastDoneShown` is on.
//
// `completed_at` rather than the status, because the question is which day it
// happened on: a task done on Monday is `done` on Tuesday too. Dropped items
// are not in it — deciding against something is not an achievement to file
// under the afternoon — and neither is a task completed by its parent, which
// has no `completed_at` of its own to place it.
const completedOn = (cell) => state.tasks.filter(
  (t) => t.kind === 'task' && t.status === 'done' && t.completed_at
    && cell.doneMatch(calendarDays(t.completed_at)));

// forecastOn is the day itself: everything the day has to say, deadlines
// first. It is what a day cell opens.
function forecastOn(cell) {
  const items = dueOn(cell);
  const ids = new Set(items.map((t) => t.id));
  for (const t of startsOn(cell)) {
    if (!ids.has(t.id)) items.push(t);
  }
  // In the order the reader chose for the Forecast, like every other list in
  // it: a day that sorted itself differently from the week above it would be
  // a second rule to learn for no reason.
  items.sort(FORECAST_SORTS[forecastOrder]);
  if (!forecastDoneShown) return items;
  // After the work, never mixed into it, and in the order they were finished
  // — which is the order the day happened in and the only order a record
  // wants. Sorting them with the rest would scatter them through the day's
  // list by a deadline that no longer means anything, and a task finished
  // early would sit above the one still to do.
  // Nothing here can already be above: `dueOn` and `startsOn` take open
  // items only, and this takes finished ones.
  const done = completedOn(cell)
    .sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)));
  return items.concat(done);
}

function forecastStrip() {
  // The same cells and the same class as the Forecast's own week: one
  // picture, drawn in two places.
  return el('div', { className: 'week forecast' }, weekCells());
}

// weekCells is the seven day buttons, which Home's strip and the Forecast's
// own week both draw. One builder, because the two have to agree about what
// a day holds — and they used to be two copies of this loop.
//
// A day is a button, not a label: the count is only useful if the things it
// counts are one tap away. An empty day stays live rather than going dead
// under the finger — the outline has an empty state, and a control that is
// sometimes a control is worse than one that is always one.
function weekCells() {
  return forecastDays().map((c) => {
    const due = dueOn(c);
    // Counted apart from the deadlines and never twice: an item that is both
    // due and released on the same day is one row, not two.
    const starting = startsOn(c).filter((t) => !due.some((x) => x.id === t.id));
    const cell = el('button', {
      type: 'button',
      className: 'day',
      onclick: () => select({ kind: 'due', key: c.key }),
    });
    cell.setAttribute('aria-current', view.kind === 'due' && view.key === c.key ? 'true' : 'false');
    // There is no Past cell, so the lateness has to be in the colour: the
    // count turns red and the cell gets a red rule under it. A screen reader
    // gets the same fact as a number, because a colour is not a label.
    const late = due.filter(pastDue).length;
    const says = [`${due.length} due`];
    if (late) says.push(`${late} from earlier days`);
    if (starting.length) says.push(`${starting.length} starting`);
    cell.setAttribute('aria-label', `${c.label}, ${says.join(', ')}`);
    if (c.today) cell.classList.add('today');
    if (late) cell.classList.add('late');
    if (!due.length && !starting.length) cell.classList.add('none');
    cell.append(
      el('span', { className: 'when', textContent: c.today ? 'Today' : c.weekday }),
      el('span', { className: 'date', textContent: String(c.day) }),
      el('span', { className: 'n', textContent: due.length ? String(due.length) : '\u00b7' }));
    // The second number is only there when there is something to say. An
    // arrow rather than a plus, because it is the same `↓` the rows use for
    // a defer date.
    if (starting.length) cell.append(el('span', { className: 'starting', textContent: `\u2193${starting.length}` }));
    return cell;
  });
}

// typeIcon is the small glyph that says what kind of container this is.
function typeIcon(t) {
  if (t.kind === 'folder') return svg(TYPE_ICONS.folder, 14);
  return svg(t.sequential ? TYPE_ICONS.sequential : TYPE_ICONS.parallel, 14);
}

// statusCircle is the tappable circle an actionable item carries. Its colour
// is the item's state — amber due soon, red overdue, orange flagged, and
// both at once when both are true — because in a list of thirty rows the
// circle is the only thing that should be shouting.
function statusCircle(t) {
  const circle = el('button', { type: 'button', className: 'circle' });
  circle.setAttribute('aria-label', t.status === 'done' ? `reopen ${t.title}` : `complete ${t.title}`);
  if (t.status === 'done') circle.classList.add('done');
  else if (t.status === 'dropped') circle.classList.add('dropped');
  else {
    if (overdue(t)) circle.classList.add('over');
    else if (dueSoon(t)) circle.classList.add('soon');
    if (t.flagged) circle.classList.add('flagged');
    if (t.repeat) circle.classList.add('repeating');
  }
  circle.onclick = (event) => {
    event.stopPropagation();
    complete(t);
  };
  return circle;
}

// A container shows its state only when it is not active: on hold is two
// blue bars, completed a purple check, dropped a red cross.
function stateMark(t) {
  if (t.status === 'on_hold') return el('span', { className: 'state hold', textContent: '❙❙' });
  if (t.status === 'done') return el('span', { className: 'state done', textContent: '✓' });
  if (t.status === 'dropped') return el('span', { className: 'state dropped', textContent: '✕' });
  return null;
}

function dateCell(t) {
  const cell = el('span', { className: 'dates' });
  if (t.due_at) {
    const due = el('span', { className: 'due', textContent: shortDate(t.due_at) });
    if (overdue(t)) due.classList.add('over');
    else if (dueSoon(t)) due.classList.add('soon');
    cell.append(due);
  }
  // A defer date in the past has nothing left to say, so it goes away once
  // it passes — the manual is explicit about that.
  if (t.defer_at && !passed(t.defer_at)) {
    cell.append(el('span', { className: 'defer', textContent: `↓ ${shortDate(t.defer_at)}` }));
  }
  return cell.childNodes.length ? cell : null;
}

function shortDate(stamp) {
  const days = calendarDays(stamp);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return stamp.slice(5, 10).replace('-', '/');
}

// tagChip renders one tag on an item, struck through when the tag itself is
// not active: a tag on hold is why the items under it are out of play, so the
// row says so where the tag is and not only in the block reason.
function tagChip(name) {
  const node = el('span', { className: 'tag', textContent: name });
  const known = (state.tags || []).find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (known && known.status && known.status !== 'active') {
    node.classList.add('held');
    node.title = `the tag “${known.name}” is ${known.status.replace('_', ' ')}`;
  }
  return node;
}

// blockedTitle names the tag as well as the rule, since `tag_status` and
// `ancestor_tag_status` are the two rules a reader cannot act on without
// knowing which tag is responsible.
function blockedTitle(blocked) {
  if (blocked.tag) return `blocked: ${blocked.rule} (${blocked.tag})`;
  return `blocked: ${blocked.rule}`;
}

// treeRows is the Projects list in the sidebar: every open project, flat —
// folders are not shown, because nobody here files projects into them — and
// under a project that is expanded, all of its tasks at every depth, so the
// whole hierarchy of a project is readable without opening it. A project
// opens (expands) when it is clicked; the triangle folds it again.
function treeRows() {
  const rows = [];
  for (const p of state.tasks.filter((t) => t.kind === 'project' && isOpen(t))) {
    const kids = state.tasks.filter((x) => x.id !== p.id && x.kind === 'task' && isOpen(x) && inSubtree(x, p.id));
    const open = expanded.has(p.id);
    const row = navRow(
      p.title,
      kids.length,
      view.kind === 'project' && view.key === p.id,
      // The row is its own disclosure: a click opens the project, and a click
      // on the project that is already open folds it. No triangle, so the
      // name starts where every other row's does and the tasks under it are
      // the only thing indented.
      () => (view.kind === 'project' && view.key === p.id ? toggleExpanded(p.id) : openContainer(p)),
      { id: p.id });
    // The button, not the `li`: a drag that started on the triangle would be
    // a drag of the control rather than of the project.
    draggable(row.querySelector('.nav-row'), p, p);
    rows.push(row);
    if (!open) continue;
    for (const x of kids) {
      const depth = parentsOf(x).filter((q) => q.id !== p.id && inSubtree(q, p.id)).length + 1;
      const child = navRow(x.title, null, selected === x.id, () => selectItem(x.id), { depth, id: x.id });
      draggable(child.querySelector('.nav-row'), x, x);
      rows.push(child);
    }
  }
  return rows;
}

// tagRows is the Tags perspective: the tags themselves, each leading to its
// items. A tag that is on hold or dropped holds its items back, so it reads
// as inactive here too; `tdo tag unhold <tag>` is how it comes back.
//
// `tag` puts the name on the row so a double click can rename it, the way
// `id` does for a folder or a project in the Projects tree. A tag has no id
// — the name is what it is filed under — so the two cannot share one key.
function tagRows() {
  return (state.tags || []).map((g) => navRow(
    g.name,
    g.count,
    view.kind === 'tag' && view.key === g.name,
    () => select({ kind: 'tag', key: g.name }),
    { held: g.status && g.status !== 'active', mark: el('span', { textContent: '#' }), tag: g.name }));
}

// renderAbout draws what the container itself says, above its list. It is
// the answer to a question the outline could not be asked before: a project
// has a note, dates, tags and its own fields like anything else, and inside
// the project none of that was on screen — the row carrying it is the one
// row the list leaves out.
//
// It is a reader and not a second inspector: the note is drawn, not typed
// into, and the button goes to the pane where everything about the project
// can be changed. A container with nothing written on it still gets the
// block, because the button is the point as much as the note is.
function renderAbout(t) {
  const about = $('#about');
  about.hidden = t === undefined;
  if (t === undefined) {
    about.replaceChildren();
    return;
  }

  const kids = [];
  // The toggle lives here rather than in the sidebar's settings, where it
  // would be a preference about a view you cannot see while you set it. It
  // says which state it is in rather than what it would do, like the
  // Forecast's own segmented words.
  const done = el('button', {
    type: 'button',
    className: 'about-toggle',
    textContent: projectDoneShown ? 'Completed: shown' : 'Completed: hidden',
    onclick: toggleProjectDone,
  });
  done.setAttribute('aria-pressed', projectDoneShown ? 'true' : 'false');

  kids.push(el('div', { className: 'about-head' }, [
    el('span', { className: 'type' }, typeIcon(t)),
    el('span', { className: 'about-kind', textContent: t.kind }),
    done,
    el('button', {
      type: 'button',
      className: 'about-open',
      textContent: 'Inspector \u2192',
      onclick: () => selectItem(t.id),
    }),
  ]));

  // The note is this project's description, and a blank one says so rather
  // than leaving a gap whose meaning has to be guessed.
  kids.push(t.note
    ? el('div', { className: 'about-note', textContent: t.note })
    : el('div', { className: 'about-note empty', textContent: 'No note on this ' + t.kind + '.' }));

  // Then everything else written on it: the two dates, the tags, the
  // structure flags that only a container has, and its own fields. A line
  // is drawn only when it has something to say — a list of dashes is not
  // worth the room it takes on a phone.
  const rows = [];
  if (t.due_at) rows.push(['due', shortDate(t.due_at)]);
  if (t.defer_at) rows.push(['defer', shortDate(t.defer_at)]);
  if (t.status !== 'active') rows.push(['status', t.status.replace('_', ' ')]);
  if (t.sequential) rows.push(['order', 'sequential']);
  if (t.completed_by_children) rows.push(['completes', 'with its last action']);
  if (t.next_review_at) rows.push(['next review', t.next_review_at.slice(0, 10)]);
  for (const [key, value] of customFields(t)) rows.push([key, value]);

  if (rows.length) {
    const dl = el('dl', { className: 'about-fields' });
    for (const [key, value] of rows) {
      dl.append(el('dt', { textContent: key }), el('dd', { textContent: value }));
    }
    kids.push(dl);
  }
  if ((t.tags || []).length) {
    kids.push(el('div', { className: 'about-tags' }, (t.tags || []).map(tagChip)));
  }

  about.replaceChildren(...kids);
}

function renderList() {
  $('#list-title').textContent = viewTitle();
  $('#back-label').textContent = 'Home';
  renderWeek();

  // A search is a view of its own and ignores the one underneath it: typing
  // into the box at the top of a list to filter *that list* is the behaviour
  // nobody wants, because the thing being looked for is almost never in the
  // list already on screen. So the whole store is searched, and clearing the
  // box puts the view back exactly as it was.
  // A container's own description belongs to the container's view and to no
  // other: a search and the Projects tree are lists of items from all over
  // the tree, and there is nothing whose heading this would be.
  renderAbout(view.kind === 'project' && !query ? byID.get(view.key) : undefined);

  if (query) {
    const found = searchResults();
    $('#list-title').textContent = `Search \u00b7 ${found.length}`;
    $('#empty').hidden = found.length > 0;
    $('#items').replaceChildren(...found.map((t) => itemRow(t, () => 0)));
    return;
  }

  // Two perspectives list something that is not a task: Projects is the
  // tree of containers, Tags is the tags. Both are ways through the tree
  // rather than work to do, so they draw nav rows and skip the empty state
  // — a store with no projects in it is not a mistake to report.
  const spec = specOf(view.kind);
  if (spec && spec.rows) {
    $('#items').replaceChildren(...(spec.rows === 'tree' ? treeRows() : tagRows()));
    $('#empty').hidden = true;
    return;
  }

  const items = currentItems();
  $('#empty').hidden = items.length > 0;

  // Inside a project, the rows are a tree and not a list: a sub-task under
  // its parent is what says "this is part of that", and in a sequential
  // project it is also what says which one is next. The order is already
  // right — `/api/state` asks for tree order, so a child follows its parent
  // — so the only thing missing was saying so on screen.
  //
  // Only here. Every other view mixes items from all over the tree, and
  // there the project path above the title (`.where`) is what locates a row;
  // indenting against a root that is not on screen would mean nothing.
  const root = view.kind === 'project' ? byID.get(view.key) : undefined;
  const depthOf = (t) => (root === undefined
    ? 0
    : parentsOf(t).filter((p) => p.id !== root.id && inSubtree(p, root.id)).length);

  // The whole Forecast is the one view with furniture of its own: the order
  // it is read in at the top, and the tail beyond the horizon folded at the
  // bottom. A single day of it is a plain list — there is nothing to fold,
  // because the day *is* the horizon.
  if (view.kind === 'due' && (!view.key || view.key === 'all')) {
    const { near, later } = forecastList();
    const rows = near.map((t) => itemRow(t, depthOf));
    if (later.length) {
      rows.push(laterRow(later.length));
      if (forecastLaterOpen) rows.push(...later.map((t) => itemRow(t, depthOf)));
    }
    $('#items').replaceChildren(...rows);
    return;
  }

  $('#items').replaceChildren(...items.map((t) => itemRow(t, depthOf)));
}

// --- the Forecast's week -------------------------------------------------

// The week, at the top of the Forecast and nowhere else: seven days from
// today, each a column with its weekday, its date and what it holds. It is
// the shape of the week that is the information — which is why an empty day
// fades rather than disappearing — and the day you are reading is the one
// highlighted.
//
// Today is the one that matters and it is first, carrying **everything
// already due** as well as today's own (see `forecastDays`). A list opened
// in the morning that leaves last week's unpaid bill on last week's day is a
// list that has stopped being read.
function renderWeek() {
  const bar = maybe('#week');
  if (!bar) return;
  bar.hidden = view.kind !== 'due' || Boolean(query);
  if (bar.hidden) {
    bar.replaceChildren();
    return;
  }

  const week = el('div', { className: 'week' }, weekCells());

  // Under the week: the whole Forecast as one list, and the order both it
  // and the days are read in. `All` is a day cell's opposite number, so it
  // is marked the same way.
  const row = el('div', { className: 'weekbar' });
  const all = el('button', {
    type: 'button',
    className: 'seg',
    textContent: 'All',
    onclick: () => select({ kind: 'due', key: 'all' }),
  });
  all.setAttribute('aria-pressed', view.key === 'all' ? 'true' : 'false');
  row.append(all);

  // And, on a day, whether what was finished on it is shown. Only on a day:
  // the toggle does nothing to the `all` list (see `forecastDoneShown`), and
  // a control that is live on one tab of a bar and inert on the other is a
  // control that teaches the wrong thing. It says which state it is in
  // rather than what it would do, like the project's own toggle.
  if (view.key && view.key !== 'all') {
    const done = el('button', {
      type: 'button',
      className: 'seg',
      textContent: forecastDoneShown ? 'Completed: shown' : 'Completed: hidden',
      onclick: toggleForecastDone,
    });
    done.setAttribute('aria-pressed', forecastDoneShown ? 'true' : 'false');
    row.append(done);
  }

  row.append(el('span', { className: 'spacer' }), el('span', { className: 'label', textContent: 'Sort' }));
  // Two words, the one in force marked: a menu to pick between two things is
  // one tap too many.
  for (const o of FORECAST_ORDERS) {
    const button = el('button', {
      type: 'button',
      className: 'seg',
      textContent: o.label,
      onclick: () => setForecastOrder(o.key),
    });
    button.setAttribute('aria-pressed', forecastOrder === o.key ? 'true' : 'false');
    row.append(button);
  }

  bar.replaceChildren(week, row);
}

// laterRow is the fold at the end of the Forecast. It says how many rows are
// behind it and when they start, because a fold that says only "more" gives
// no reason to open it or to leave it shut.
function laterRow(n) {
  const row = el('li', { className: 'fold' });
  const button = el('button', {
    type: 'button',
    onclick: toggleForecastLater,
  });
  button.setAttribute('aria-expanded', forecastLaterOpen ? 'true' : 'false');
  button.append(
    el('span', { className: 'twisty', textContent: forecastLaterOpen ? '\u25be' : '\u25b8' }),
    el('span', {
      className: 'name',
      textContent: `Later \u2014 ${n} item${n === 1 ? '' : 's'} deferred past the next ${ForecastHorizonDays} days`,
    }));
  row.append(button);
  return row;
}

// itemRow is one row of the outline. It was the body of a `map` inside
// renderList and became a function of its own when the Forecast grew a fold:
// the rows behind the fold are the same rows, and two copies of this would
// be two things to keep in step.
function itemRow(t, depthOf) {
  const row = el('li', { className: 'item', tabIndex: -1 });
  row.dataset.id = t.id;
  row.setAttribute('aria-selected', selected === t.id ? 'true' : 'false');
  const depth = depthOf(t);
  if (depth > 0) {
    row.classList.add('nested');
    row.style.setProperty('--nest', String(depth));
    // A screen reader gets the nesting from the level rather than from an
    // indent it cannot see.
    row.setAttribute('aria-level', String(depth + 1));
  }
  if (isClosed(t)) row.classList.add('closed');
  // Grey for what cannot be worked on — completed, blocked, on hold, a
  // container — and black again for anything due soon or overdue, which is
  // the exception the manual makes and the reason the rule is useful.
  if (isClosed(t) || isContainer(t) || t.available === false) row.classList.add('quiet');
  if (overdue(t) || dueSoon(t)) row.classList.add('dated');
  // Today's list holds what is due today and what was due before it, and
  // nothing in the row said which was which beyond a date two words long.
  // A red edge does, at the speed a list is actually read — and it is why
  // the week needs no Past cell to send the late work somewhere else.
  if (pastDue(t)) row.classList.add('late');

  // Directly actionable items have a status circle; a project or a folder
  // carries its type icon instead, because it is not something to do.
  row.append(isContainer(t) ? el('span', { className: 'type' }, typeIcon(t)) : statusCircle(t));

  const lines = el('div', { className: 'lines' });
  // The project path goes above the title, not beside it: on one line the
  // title shared its width with the path, the tags and the date, and the
  // thing being read was the first to be cut.
  const where = parentsOf(t).map((p) => p.title).join(' \u203a ');
  if (where && view.kind !== 'project') lines.append(el('div', { className: 'where', textContent: where }));
  if (!where && view.kind === 'inbox') lines.append(el('div', { className: 'where', textContent: 'No project' }));
  lines.append(el('div', { className: 'title', textContent: t.title }));

  const under = el('div', { className: 'under' });
  for (const g of t.tags || []) under.append(tagChip(g));
  if (t.note) under.append(el('span', { className: 'note', textContent: '\u270e' }));
  if (isContainer(t)) {
    const inside = state.tasks.filter((x) => x.id !== t.id && inSubtree(x, t.id) && isOpen(x) && x.kind === 'task');
    const late = inside.filter(overdue).length;
    under.append(el('span', {
      className: 'count',
      textContent: late ? `${inside.length} items \u00b7 ${late} overdue` : `${inside.length} items`,
    }));
  }
  if (under.childNodes.length) lines.append(under);
  row.append(lines);

  const mark = stateMark(t);
  if (mark && isContainer(t)) row.append(mark);
  const dates = dateCell(t);
  if (dates) row.append(dates);
  if (t.blocked_by) row.title = blockedTitle(t.blocked_by);

  // As in the sidebar: the second click of a double click is the one that
  // starts an edit, so it must not also change pane.
  row.onclick = (event) => { if (event.detail < 2) selectItem(t.id); };
  draggable(row, t, t);
  return row;
}

function facts(t) {
  const rows = [
    ['id', t.id],
    ['kind', t.kind],
    ['available', t.available === null ? 'unknown' : String(t.available)],
    ['blocked by', t.blocked_by ? blockedTitle(t.blocked_by).replace('blocked: ', '') : '—'],
    ['repeat', t.repeat ? `${t.repeat.every} (${t.repeat.method})` : '—'],
    ['next review', t.next_review_at ? t.next_review_at.slice(0, 10) : '—'],
    ['created', (t.created_at || '').slice(0, 10)],
  ];
  const list = [];
  for (const [key, value] of rows) {
    list.push(el('dt', { textContent: key }));
    list.push(el('dd', { textContent: value || '—' }));
  }
  return list;
}

// --- a task's own fields -------------------------------------------------

// The keys the task shape owns: the required fields of the model and the
// four derived ones. Everything else on a task object is a field somebody
// set, which is what the inspector's Fields block edits. The list is the
// `reserved` set of `packages/core/src/task.ts`, and `priority` is
// deliberately not in it there or here — it is an ordinary open field with a
// control of its own above, so the Fields block must not show it twice.
const RESERVED_KEYS = new Set([
  'id', 'kind', 'title', 'parent_id', 'position', 'status', 'flagged',
  'sequential', 'completed_by_children', 'defer_at', 'due_at',
  'estimated_minutes', 'note', 'repeat', 'series_id', 'review_interval',
  'last_reviewed_at', 'created_at', 'updated_at', 'completed_at',
  'dropped_at', 'deleted_at', 'tags', 'done', 'available', 'blocked_by',
  'next_review_at', 'priority',
]);

// customFields lists what a task carries beyond the shape, sorted the way
// `--json` sorts its keys so the rows do not move about between renders.
/**
 * @param {Task} t
 * @returns {[string, string][]} each key with its value as a line of text
 */
function customFields(t) {
  return Object.keys(t)
    .filter((k) => !RESERVED_KEYS.has(k))
    .sort()
    .map((k) => /** @type {[string, string]} */ ([k, fieldText(t[k])]));
}

// fieldText is a stored value as a line of text to type into. A string is
// itself; everything else is its JSON, which is the spelling `--set` reads
// back — `3`, `true`, `null`, `{"rounds":2}`.
//
// The round trip is not quite the identity: the *string* "3" comes back as
// the number 3, because that is what `--set ref=3` means. It only matters
// for a value that is sent again, and a row is only sent when its text
// changed, so a field nobody touched keeps the type it has.
function fieldText(v) {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// fieldRow is one key/value pair, shaped like the labelled boxes above it:
// the key is the small caps line a field's name is drawn in everywhere in
// this pane — TAGS, DEFER, NOTE — and the value is a box that wraps and
// grows with what is in it, the way the note does. A field holds whatever
// `--set` can store, which includes a paragraph and a line of JSON long
// enough to need two lines, and neither of those is readable in a box that
// scrolls sideways.
//
// The boxes carry no `name`: they live inside #detail, and a field called
// "title" would otherwise shadow the title box in `form.elements`.
function fieldRow(key, value) {
  const row = el('div', { className: 'field-row' });
  const name = el('input', { type: 'text', className: 'field-key', value: key, placeholder: 'key' });
  name.setAttribute('aria-label', 'field name');
  // A textarea rather than an input, for the wrapping. Enter is left alone
  // here, unlike in the title: a field value may genuinely have lines in it,
  // and the save is on the way out of the box either way.
  const val = el('textarea', { className: 'field-value', rows: 1, value, placeholder: 'value' });
  val.setAttribute('aria-label', key ? `value of ${key}` : 'field value');
  // Removing a field is its own button because an empty value is a value:
  // `--set note2=` stores the empty string, so a blanked box cannot mean
  // "take this field off".
  const drop = el('button', {
    type: 'button',
    className: 'icon field-drop',
    textContent: '\u2715',
    onclick: () => { row.remove(); saveNow(); },
  });
  drop.setAttribute('aria-label', key ? `remove field ${key}` : 'remove field');
  row.append(el('div', { className: 'field-head' }, [name, drop]), val);
  return row;
}

function renderFields(t) {
  const rows = customFields(t).map(([k, v]) => fieldRow(k, v));
  $('#field-rows').replaceChildren(...rows);
  // `grow` reads `scrollHeight`, which is 0 for a box that is not in the
  // document yet, so the height is set after the rows are in place rather
  // than inside `fieldRow`.
  for (const row of rows) grow(row.querySelector('.field-value'));
}

function renderInspector() {
  const form = $form('#detail');
  const t = selected ? byID.get(selected) : null;
  $('#no-selection').hidden = Boolean(t);
  form.hidden = !t;
  $('#back-label').textContent = 'Home';
  renderInspectorTitle(t);
  if (!t) return;

  // Every write is followed by a fresh snapshot, and the snapshot arrives
  // while the cursor is still in the field that caused it. Refilling the
  // fields then would delete whatever was typed in the meantime, so the
  // inputs are left alone while this item is being edited; the facts below
  // them, which nobody types into, are refreshed either way.
  const sameItem = form.dataset.id === t.id;
  if (!sameItem || !form.contains(document.activeElement)) {
    fillInspector(form, t);
  }
  form.dataset.id = t.id;

  $('#facts').replaceChildren(...facts(t));
  $('#complete').textContent = t.status === 'done' ? 'Reopen' : 'Complete';
}

// The inspector's title is the project the item belongs to, and clicking it
// goes up to that project's view. A project is its own title; an item with
// no project above it (an inbox task, a folder) has nothing to go up to, so
// the title is plain text there.
function renderInspectorTitle(t) {
  const button = /** @type {HTMLButtonElement} */ ($('#inspector-project'));
  const project = t ? [t, ...parentsOf(t).reverse()].find((x) => x.kind === 'project') : null;
  button.textContent = project ? project.title : t ? (t.kind === 'folder' ? t.title : 'Inbox') : '';
  button.disabled = !project;
  button.onclick = project ? () => openContainer(project) : null;
}

function fillInspector(form, t) {
  form.elements.title.value = t.title;
  form.elements.note.value = t.note || '';
  form.elements.tags.value = (t.tags || []).join(', ');
  form.elements.defer_at.value = t.defer_at ? t.defer_at.slice(0, 10) : '';
  form.elements.due_at.value = t.due_at ? t.due_at.slice(0, 10) : '';
  form.elements.estimate.value = t.estimated_minutes ? `${t.estimated_minutes}m` : '';
  form.elements.priority.value = String(t.priority || 0);
  form.elements.flagged.checked = Boolean(t.flagged);
  // A completed item is put back with the circle, not with this menu, so
  // "done" is not one of the choices here.
  form.elements.status.value = t.status === 'done' ? 'active' : t.status;

  // Only a container this item may legally go into is offered, so the tree
  // rules of §3.1 are a shape on screen rather than an error after a save.
  const parents = state.tasks.filter((p) =>
    p.id !== t.id && isOpen(p) && !inSubtree(p, t.id) && canContain(p.kind, t.kind));
  form.elements.parent_id.replaceChildren(
    el('option', { value: '', textContent: t.kind === 'task' ? '(inbox)' : '(top level)' }),
    ...parents.map((p) => el('option', { value: p.id, textContent: p.title })));
  form.elements.parent_id.value = t.parent_id || '';
  renderFields(t);
  grow(form.elements.title);
  grow(form.elements.note);
}

// grow sizes a box to its contents: a note is read far more often than it is
// written, and a four-line box with twenty lines in it hides what it was
// written for. The title is the same argument in one line — it wraps and the
// box follows rather than scrolling sideways past what was typed.
//
// There is no floor here any more. app.css gives each box a `min-height` and
// that wins over the `height` set below, so the three-line note and the
// one-line title are a stylesheet decision rather than a number in here.
function grow(area) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight}px`;
}

// canContain mirrors task.Kind.CanContain: a folder holds folders and
// projects, a project holds tasks, a task holds tasks.
function canContain(parent, child) {
  if (parent === 'folder') return child === 'folder' || child === 'project';
  return child === 'task';
}

// --- dragging an item somewhere else -------------------------------------

// Dropping a row on a project, a folder or another task files it there;
// dropping it on the empty space below the list takes it out of whatever it
// was in — the inbox for a task, the top level for a container. That is the
// whole of it: this moves an item between parents and does not reorder
// within one, because position is its own operation (`tdo mv --before`) and
// a drop that sometimes reparents and sometimes reorders, depending on
// where in a 38-pixel row it landed, is a coin toss the user has to win.
//
// The rules are the tree's own (§3.1) and they are checked before the drop
// is allowed rather than after it is refused: a folder holds folders and
// projects, a project and a task hold tasks, and nothing may be dropped
// into itself or into its own subtree. `canContain` and `inSubtree` are the
// same two functions the inspector's parent menu is built from, so the
// shapes the two offer cannot disagree.
//
// This is pointer-only: HTML drag and drop does not fire for touch. On a
// phone the inspector's parent menu is the way, which is why that menu
// stays.

let dragging = null;

function canDropInto(parent) {
  const t = dragging ? byID.get(dragging) : null;
  if (!t || !parent || parent.id === t.id) return false;
  if (inSubtree(parent, t.id)) return false;
  return canContain(parent.kind, t.kind);
}

function dropMove(parentID) {
  const id = dragging;
  dragging = null;
  if (!id) return;
  const t = byID.get(id);
  if (t && (t.parent_id || '') === parentID) return;   // dropped where it already was
  act('POST', `/api/tasks/${id}/move`, { parent_id: parentID }, 'moved');
}

// canDropBeside asks whether the dragged item may become a sibling of the
// anchor. Placing it beside the anchor puts it in the anchor's container, so
// that container is what has to be able to hold it — which for an anchor at
// the top level means the inbox for a task and the top level for a
// container, and both of those are allowed.
function canDropBeside(anchor) {
  const t = dragging ? byID.get(dragging) : null;
  if (!t || !anchor || anchor.id === t.id) return false;
  if (inSubtree(anchor, t.id)) return false;
  const parent = anchor.parent_id ? byID.get(anchor.parent_id) : null;
  if (parent) return canContain(parent.kind, t.kind);
  return t.kind === 'task' || t.kind === 'project' || t.kind === 'folder';
}

function dropBeside(anchorID, where) {
  const id = dragging;
  dragging = null;
  if (!id) return;
  act('POST', `/api/tasks/${id}/reorder`, { anchor: anchorID, where }, 'moved');
}

/**
 * zoneOf reads which of the three things a drop on this row would mean.
 *
 * The top and bottom slivers reorder, the middle files the item inside. The
 * slivers are deliberately thin — a quarter of the row, capped at 10px — so
 * the common case is the one you get by aiming at the row, and reordering is
 * something you have to aim for. Mixing the two in one gesture is only safe
 * because the three outcomes look different before the mouse is released:
 * a line above, a line below, or an outline around.
 */
function zoneOf(node, event) {
  const box = node.getBoundingClientRect();
  const edge = Math.min(10, box.height / 4);
  if (event.clientY - box.top < edge) return 'before';
  if (box.bottom - event.clientY < edge) return 'after';
  return 'into';
}

// draggable makes a rendered row both a thing to pick up and a thing to drop
// on. `into` is the item the row stands for, or null for a row that can only
// be picked up.
function draggable(node, t, into) {
  node.draggable = true;
  node.ondragstart = (event) => {
    dragging = t.id;
    event.dataTransfer.effectAllowed = 'move';
    // Firefox starts no drag at all without data on the transfer.
    event.dataTransfer.setData('text/plain', t.id);
    node.classList.add('dragging');
  };
  node.ondragend = () => {
    dragging = null;
    node.classList.remove('dragging');
    for (const lit of document.querySelectorAll('.drop-into, .drop-before, .drop-after')) {
      lit.classList.remove('drop-into', 'drop-before', 'drop-after');
    }
  };
  if (!into) return node;
  const clear = () => node.classList.remove('drop-into', 'drop-before', 'drop-after');
  // The zone a drop would mean, or '' when this row cannot take it.
  const zone = (event) => {
    const want = zoneOf(node, event);
    if (want === 'into') return canDropInto(into) ? 'into' : '';
    return canDropBeside(into) ? want : '';
  };
  node.ondragover = (event) => {
    const want = zone(event);
    clear();
    // Not calling preventDefault is how a target says "not here", and it is
    // what makes the cursor show the refusal.
    if (!want) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    node.classList.add(`drop-${want}`);
  };
  node.ondragleave = clear;
  node.ondrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const want = zone(event);
    clear();
    if (want === 'into') dropMove(into.id);
    else if (want) dropBeside(into.id, want);
  };
  return node;
}

// The list itself is the way out: a drop that lands on the list and not on a
// row means "not inside anything any more".
const outline = $('#items');
outline.addEventListener('dragover', (event) => {
  if (!dragging) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  outline.classList.add('drop-into');
});
outline.addEventListener('dragleave', (event) => {
  if (event.target === outline) outline.classList.remove('drop-into');
});
outline.addEventListener('drop', (event) => {
  event.preventDefault();
  outline.classList.remove('drop-into');
  dropMove('');
});

// --- editing in place ---------------------------------------------------

// Double-clicking a name edits it where it is: a folder or a project in the
// sidebar, and a row's title or its tags in the outline. The inspector is
// still where everything about an item can be changed; this is for the one
// correction that would otherwise cost a trip to another pane and back.
//
// The handlers are delegated from the two lists rather than bound to each
// row. The first click of a double click selects the item, which re-renders
// the list and replaces the very node the second click would have landed
// on, so a listener on that node would never hear it. The lists themselves
// survive every render.
//
// There is no cancel-and-restore by hand: finishing an edit re-renders from
// the store either way, so what ends up on screen is what was saved and
// never what was typed.

let editingInPlace = null;

function editInPlace(node, label, current, commit) {
  if (editingInPlace) return;
  editingInPlace = node;
  const input = el('input', { type: 'text', className: 'inline', value: current });
  input.setAttribute('aria-label', label);
  node.replaceChildren(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (keep) => {
    if (settled) return;
    settled = true;
    editingInPlace = null;
    const next = input.value;
    if (!keep || next === current) {
      render();
      return;
    }
    try {
      say('saving\u2026');
      await commit(next);
      await reload('saved');
    } catch (err) {
      say(messageOf(err), true);
      render();
    }
  };

  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // Escape abandons the edit, which is the one case where leaving the
      // field must not keep it; `settled` is why the blur that follows does
      // nothing.
      finish(false);
    }
  };
  // Leaving the field keeps what was typed, the way the inspector's fields
  // do. The two must not disagree about what a click elsewhere means.
  input.onblur = () => finish(true);
  // A click inside the field is not a click on the row underneath it.
  const swallow = (event) => event.stopPropagation();
  input.onclick = swallow;
  input.ondblclick = swallow;
}

const tagList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

// A title is the one field the store refuses to leave empty, so an empty
// one is reported here rather than sent and bounced.
function commitTitle(t) {
  return (next) => {
    if (!next.trim()) throw new Error('an item must have a title');
    return api('PATCH', `/api/tasks/${t.id}`, { title: next });
  };
}

// Renaming a tag moves every task carrying it, which is what `tdo tag
// rename` does and why the store does the work rather than the page walking
// the tasks itself. The name is the only thing a tag is filed under, so an
// empty one is refused here rather than sent.
function commitTagName(name) {
  return (next) => {
    if (!next.trim()) throw new Error('a tag must have a name');
    return api('PATCH', `/api/tags/${encodeURIComponent(name)}`, { name: next.trim() });
  };
}

const onOutlineDblclick = (event) => {
  // A folder or a project in the Projects tree, or a tag in the Tags
  // perspective — both are nav rows rather than item rows.
  const name = closestOf(event, '.nav-row .name');
  if (name) {
    const row = closestTo(name, '.nav-row');
    if (!row) return;
    const tag = row.dataset.tag;
    if (tag) {
      editInPlace(name, `name of tag ${tag}`, tag, commitTagName(tag));
      return;
    }
    const container = byID.get(row.dataset.id || '');
    if (container) editInPlace(name, `title of ${container.title}`, container.title, commitTitle(container));
    return;
  }
  const row = closestOf(event, '.item');
  if (!row) return;
  const t = byID.get(row.dataset.id ?? '');
  if (!t) return;
  const chip = closestOf(event, '.tag');
  if (chip) {
    // The whole set is edited as one comma-separated string, because
    // `tags` replaces the set and that is what the field means. The line
    // holding the chips is what gets the field, so the text starts where
    // the first chip was.
    editInPlace(
      chip.parentNode,
      `tags of ${t.title}`,
      (t.tags || []).join(', '),
      (next) => api('PATCH', `/api/tasks/${t.id}`, { tags: tagList(next) }));
    return;
  }
  const title = closestOf(event, '.title');
  if (title) {
    editInPlace(title, `title of ${t.title}`, t.title, commitTitle(t));
  }
};
$('#items').addEventListener('dblclick', onOutlineDblclick);
// The Projects and Tags lists live under their tiles in the sidebar, so renaming a folder in place has
// to work there as well.
$('#tiles').addEventListener('dblclick', onOutlineDblclick);



// --- writes ------------------------------------------------------------

function complete(t) {
  if (t.status === 'done') {
    return act('POST', `/api/tasks/${t.id}/status`, { status: 'active' }, 'reopened');
  }
  return act('POST', `/api/tasks/${t.id}/done`, {}, 'completed');
}

// --- capture ------------------------------------------------------------

// The Add button at the bottom opens a form rather than capturing a bare
// title, which is what the box at the top of the list used to do. Both of
// those were one decision: a phone's keyboard is at the bottom, so the
// control that summons it belongs there, and a captured task nearly always
// wants a date or a project — going straight to the inspector afterwards to
// add one is the step the form removes.
//
// Everything but the title is optional, so the fast path is still a title
// and Add.
const capture = $dialog('#capture-editor');

// What the form is making. A task, a project and a folder are the same seven
// fields over the same endpoint — only the name of the thing and the list of
// places it may go differ — so they are one dialog and not three.
const NEW_KINDS = {
  task: { title: 'New task', home: 'Project', empty: '(inbox)' },
  project: { title: 'New project', home: 'Folder', empty: '(top level)' },
  folder: { title: 'New folder', home: 'Folder', empty: '(top level)' },
};

let capturing = 'task';

function openCapture(kind = 'task') {
  const spec = NEW_KINDS[kind] || NEW_KINDS.task;
  capturing = NEW_KINDS[kind] ? kind : 'task';
  const form = $form('#capture-form');
  form.reset();
  $('#capture-note').textContent = '';
  $('#capture-title').textContent = spec.title;
  $('#capture-parent-label').textContent = spec.home;

  // Only a container this kind may legally live in, as in the inspector, so
  // the tree rules of §3.1 are a shape on screen rather than an error after
  // a save.
  const parents = state.tasks.filter((p) => isOpen(p) && canContain(p.kind, capturing));
  form.elements.parent_id.replaceChildren(
    el('option', { value: '', textContent: spec.empty }),
    ...parents.map((p) => el('option', { value: p.id, textContent: p.title })));

  // Captured where you are standing: inside a project it goes there, and on
  // a day of the Forecast it is due that day. Both are what the screen was
  // already saying, and both can be changed before Add is pressed.
  if (view.kind === 'project' && canContain(byID.get(view.key)?.kind || '', capturing)) {
    form.elements.parent_id.value = view.key;
  }
  const cell = capturing === 'task' && view.kind === 'due' && view.key !== 'all'
    ? forecastCell(view.key)
    : undefined;
  if (cell && !cell.today) form.elements.due_at.value = dayValue(cell);
  capture.showModal();
  form.elements.title.focus();
}

// --- the floating button ------------------------------------------------

// One control, bottom right, on every pane. It opens a menu rather than
// capturing straight away, because "add" has four answers here and a button
// that silently picks one of them is a button you have to undo.
const fabMenu = $('#fab-menu');

function showFabMenu(on) {
  fabMenu.hidden = !on;
  $('#fab').setAttribute('aria-expanded', on ? 'true' : 'false');
  $('#fab').classList.toggle('open', on);
}

$('#fab').onclick = (event) => {
  event.stopPropagation();
  showFabMenu(fabMenu.hidden);
};

fabMenu.addEventListener('click', (event) => {
  const what = closestOf(event, '[data-new]');
  if (!what) return;
  showFabMenu(false);
  if (what.dataset.new === 'perspective') {
    openEditor('');
    return;
  }
  openCapture(what.dataset.new);
});

// A menu closes when the next thing is touched, wherever that is.
document.addEventListener('click', () => {
  if (!fabMenu.hidden) showFabMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !fabMenu.hidden) showFabMenu(false);
}, true);

/** dayValue is a forecast day as the `yyyy-mm-dd` a date input takes. */
function dayValue(cell) {
  const at = clock();
  const days = forecastDays().findIndex((c) => c.key === cell.key);
  at.setUTCDate(at.getUTCDate() + Math.max(days, 0));
  return at.toISOString().slice(0, 10);
}

$('#capture-close').onclick = () => capture.close();

$form('#capture-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = formOf(event);
  const title = form.elements.title.value.trim();
  if (!title) return;
  const body = { title };
  // The endpoint defaults to a task, so the kind is sent only when it is
  // something else — which keeps the request the same one it always was.
  if (capturing !== 'task') body.kind = capturing;
  /** @param {string} name */
  const text = (name) => String(form.elements[name].value).trim();
  if (text('note')) body.note = text('note');
  if (text('tags')) body.tags = text('tags').split(',').map((g) => g.trim()).filter(Boolean);
  if (text('defer_at')) body.defer_at = text('defer_at');
  if (text('due_at')) body.due_at = text('due_at');
  if (text('estimate')) body.estimate = text('estimate');
  if (form.elements.priority.value !== '0') body.priority = Number(form.elements.priority.value);
  if (form.elements.parent_id.value) body.parent_id = form.elements.parent_id.value;
  if (form.elements.flagged.checked) body.flagged = true;
  try {
    await api('POST', '/api/tasks', body);
  } catch (err) {
    // The dialog stays open with what was typed still in it: a rejected
    // estimate or a date that would not parse is a correction, not a loss.
    $('#capture-note').textContent = messageOf(err);
    return;
  }
  capture.close();
  await reload('captured');
};

// --- the inspector saves itself ----------------------------------------

// There is no Save button. Typing settles for a moment and the change goes
// up; a menu, a checkbox or a date goes up at once, because those are
// finished the instant they change. The status line in the outline's
// toolbar is where "saved" appears, so an edit is never silent.
let saveTimer = null;
let saving = Promise.resolve();

function scheduleSave(delay = 700) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow(); }, delay);
}

async function saveNow() {
  clearTimeout(saveTimer);
  const form = $form('#detail');
  const t = byID.get(form.dataset.id ?? '');
  if (!t) return;
  // The fields are read here, synchronously, and the write below is given
  // the values rather than the form. A save queued behind one still in
  // flight does not run until a network round trip later, and by then the
  // inspector may hold another item: `renderInspector` refills as soon as
  // the form no longer has the focus, which is what clicking another row
  // does. Reading the fields at that point would send the newly selected
  // item's title and note to `t`, the item being saved — losing the edit
  // that asked for the save and corrupting a second item with it.
  const edited = readInspector(form);
  // One save at a time, in order: two overlapping PATCHes of the same item
  // are a race whose loser silently wins.
  saving = saving.then(() => writeInspector(edited, t)).catch(() => {});
  return saving;
}

// oneLine folds the newlines out of a pasted title. The title field wraps
// what is in it, which is a width, not a line break; the store trims a title
// and otherwise keeps it exactly, so a break that reached it would stay there
// and be drawn in every list the item appears in.
function oneLine(value) {
  return value.replace(/[\r\n]+/g, ' ');
}

// readInspector takes the form as a plain value with no DOM left in it, so
// that what gets saved is what was on screen when the save was asked for.
function readInspector(form) {
  return {
    title: oneLine(form.elements.title.value),
    note: form.elements.note.value,
    tags: form.elements.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
    estimate: form.elements.estimate.value.trim() || '0',
    priority: Number(form.elements.priority.value),
    flagged: form.elements.flagged.checked,
    defer_at: form.elements.defer_at.value,
    due_at: form.elements.due_at.value,
    status: form.elements.status.value,
    parent_id: form.elements.parent_id.value,
    // The rows as typed. Which of them is a change and which key has gone
    // is `writeInspector`'s to work out, because only it has the item the
    // edit belongs to.
    fields: [...$('#field-rows').querySelectorAll('.field-row')].map((row) => [
      $input('.field-key', row).value.trim(),
      $input('.field-value', row).value,
    ]),
  };
}

// fieldEdit turns the rows into the `set_text` and `unset` of one PATCH: a
// row whose text differs from what is stored is sent, a key that no longer
// has a row is unset, and a key that was renamed is both. A row with no key
// is one being typed and is left alone — it is not an instruction yet.
function fieldEdit(rows, t) {
  const before = new Map(customFields(t));
  const set_text = {};
  const kept = new Set();
  for (const [key, value] of rows) {
    if (key === '') continue;
    kept.add(key);
    if (before.get(key) !== value) set_text[key] = value;
  }
  const unset = [...before.keys()].filter((key) => !kept.has(key));
  return { set_text, unset };
}

async function writeInspector(edited, t) {
  const { defer_at, due_at, status, parent_id, fields, ...edit } = edited;
  if (!edit.title.trim()) return;        // an empty title is refused by the store
  const { set_text, unset } = fieldEdit(fields, t);
  if (Object.keys(set_text).length) edit.set_text = set_text;
  if (unset.length) edit.unset = unset;
  try {
    say('saving…');
    await api('PATCH', `/api/tasks/${t.id}`, edit);
    // The dates, the status and the parent are their own operations in the
    // shared layer — completing is not a status write, and a move is not an
    // update — so the inspector sends what actually changed, in that order.
    const dates = [
      ['defer', defer_at, t.defer_at],
      ['due', due_at, t.due_at],
    ];
    for (const [field, next, before] of dates) {
      if (next === (before ? before.slice(0, 10) : '')) continue;
      await api('POST', `/api/tasks/${t.id}/date`, { field, at: next });
    }
    if (status !== t.status) {
      await api('POST', `/api/tasks/${t.id}/status`, { status });
    }
    if (parent_id !== (t.parent_id || '')) {
      await api('POST', `/api/tasks/${t.id}/move`, { parent_id });
    }
    await reload('saved');
  } catch (err) {
    say(messageOf(err), true);
  }
}

$form('#detail').oninput = (event) => {
  if (nodeOf(event).tagName === 'TEXTAREA') grow(nodeOf(event));
  scheduleSave();
};

// A title is one line of text whatever it is drawn in, so Enter commits it
// the way it did when this was an `<input>` — the browser would otherwise put
// a newline in a field the store keeps verbatim, and the outline would draw
// an item whose title has a break in the middle of it. A newline that arrives
// by paste is folded in `readInspector`, which is the other way in.
$form('#detail').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || /** @type {HTMLInputElement} */ (event.target).name !== 'title') return;
  event.preventDefault();
  saveNow();
});

// A menu, a checkbox or a date is finished the moment it changes, and a
// date picker never fires `input` on every platform anyway.
$form('#detail').onchange = () => saveNow();

// Leaving a field commits it rather than waiting out the timer, and so does
// Enter in a single-line field — which must not submit the form, since the
// form has no submit left to do.
$form('#detail').addEventListener('focusout', () => saveNow());
$form('#detail').onsubmit = (event) => {
  event.preventDefault();
  saveNow();
};

$('#complete').onclick = () => {
  const t = selected === null ? undefined : byID.get(selected);
  if (t) complete(t);
};

// A new field is an empty row rather than a prompt: the key and the value
// are two things to type, and a row is where they are typed everywhere else
// in this block. Nothing is sent until the key has something in it.
$('#field-add').onclick = () => {
  const row = fieldRow('', '');
  $('#field-rows').append(row);
  grow(row.querySelector('.field-value'));
  row.querySelector('.field-key').focus();
};

$('#remove').onclick = () => {
  const t = selected === null ? undefined : byID.get(selected);
  if (!t) return;
  // Removal writes a tombstone and takes the subtree with it, so it says so
  // before doing it. The irreversible one is `tdo rm --purge`, which this UI
  // does not have.
  if (!confirm(`Remove “${t.title}” and everything inside it? \`tdo ls --deleted\` still lists it.`)) return;
  showPane('outline');
  act('DELETE', `/api/tasks/${t.id}`, undefined, 'removed');
};

// --- the perspective editor ---------------------------------------------

// A perspective is a stored `Filter`, and this is one control per field of
// it. What it can express is therefore exactly what the store can evaluate,
// which is also exactly what `tdo ls` can express — the flags applied in the
// client after the query runs (`--where`, `--priority`, `--untagged`,
// `--estimate-under`, `--sort title`) have no control here, because the CLI
// refuses to save them for the same reason: a perspective carrying them
// would come back meaning something wider than what was saved.
//
// The form reads and writes the stored JSON, not an intermediate shape of
// its own. Keys are left out rather than written empty, the way `toJSON`
// leaves them out, so a perspective saved here and one saved by `tdo
// perspective save` are the same bytes.

const editor = $dialog('#perspective-editor');
const editorForm = $form('#perspective-form');

// editingName is the perspective being changed, or '' while making a new
// one. It is also what a rename is measured against.
let editingName = '';

const fields = () => editorForm.elements;
/** @param {string} name */
const ticked = (name) => [...editorForm.querySelectorAll(`input[name="${name}"]:checked`)]
  .map((n) => /** @type {HTMLInputElement} */ (n).value);
const tick = (name, values) => {
  for (const node of editorForm.querySelectorAll(`input[name="${name}"]`)) {
    const box = /** @type {HTMLInputElement} */ (node);
    box.checked = values.includes(box.value);
  }
};
const day = (stamp) => (stamp ? String(stamp).slice(0, 10) : '');
const tri = (v) => (v === undefined ? '' : (v ? 'yes' : 'no'));

function fillEditor(name, f) {
  const e = fields();
  e.name.value = name;
  tick('kind', f.kinds || []);
  tick('status', f.statuses || []);
  e.availability.value = f.availability || '';
  e.flagged.value = tri(f.flagged);
  e.tags.value = (f.tags || []).join(', ');
  e.tags_any.value = f.tags_any ? 'any' : '';
  e.has_due.value = tri(f.has_due);
  e.deleted.value = f.only_deleted ? 'only' : (f.include_deleted ? 'include' : '');
  e.due_after.value = day(f.due_after);
  e.due_before.value = day(f.due_before);
  e.defer_after.value = day(f.defer_after);
  e.defer_before.value = day(f.defer_before);
  e.review_due_before.value = day(f.review_due_before);
  e.order.value = f.order || '';
  e.limit.value = f.limit ? String(f.limit) : '';

  // Every container, because a scope may name a folder or a project; the
  // top level is the empty option, which with "Directly inside" is how
  // "the top level itself" is said.
  const containers = state.tasks.filter((t) => isContainer(t) && isOpen(t));
  e.scope_id.replaceChildren(
    el('option', { value: '', textContent: '(top level)' }),
    ...containers.map((t) => el('option', { value: t.id, textContent: t.title })));

  const scope = f.scope || {};
  if (scope.inbox) e.scope_kind.value = 'inbox';
  else if (scope.subtree) { e.scope_kind.value = 'subtree'; e.scope_id.value = scope.subtree; }
  else if (scope.children) { e.scope_kind.value = 'children'; e.scope_id.value = scope.parent_id || ''; }
  else e.scope_kind.value = '';
  scopeEnabled();
}

// The container menu is meaningless for "anywhere" and for the inbox, so it
// is turned off rather than left offering a choice that is not read.
function scopeEnabled() {
  const kind = fields().scope_kind.value;
  fields().scope_id.disabled = kind !== 'subtree' && kind !== 'children';
}

function readEditor() {
  const e = fields();
  const f = {};
  const kinds = ticked('kind');
  if (kinds.length) f.kinds = kinds;
  const statuses = ticked('status');
  if (statuses.length) f.statuses = statuses;
  if (e.availability.value) f.availability = e.availability.value;
  if (e.flagged.value) f.flagged = e.flagged.value === 'yes';
  const tags = tagList(e.tags.value);
  if (tags.length) {
    f.tags = tags;
    if (e.tags_any.value === 'any') f.tags_any = true;
  }
  const scope = e.scope_kind.value;
  if (scope === 'inbox') f.scope = { inbox: true };
  else if (scope === 'subtree' && e.scope_id.value) f.scope = { subtree: e.scope_id.value };
  else if (scope === 'children') f.scope = { children: true, parent_id: e.scope_id.value };
  if (e.has_due.value) f.has_due = e.has_due.value === 'yes';
  if (e.deleted.value === 'include') f.include_deleted = true;
  if (e.deleted.value === 'only') f.only_deleted = true;
  for (const key of ['due_after', 'due_before', 'defer_after', 'defer_before', 'review_due_before']) {
    if (e[key].value) f[key] = e[key].value;
  }
  if (e.order.value) f.order = e.order.value;
  const limit = Number(e.limit.value);
  if (Number.isFinite(limit) && limit > 0) f.limit = Math.trunc(limit);
  return { name: e.name.value.trim(), filter: f };
}

function openEditor(name) {
  editingName = name;
  const saved = (state.perspectives || []).find((p) => p.name === name);
  fillEditor(name, (saved && saved.filter) || {});
  $('#perspective-heading').textContent = name ? `Edit “${name}”` : 'New perspective';
  $('#perspective-delete').hidden = !name;
  $('#perspective-note').textContent = name
    ? 'Saving under a different name renames it.'
    : 'Double-click a saved perspective to edit it again.';
  editor.showModal();
  fields().name.focus();
}

$('#new-perspective').onclick = () => openEditor('');
$('#perspective-close').onclick = () => editor.close();
editorForm.elements.scope_kind.onchange = scopeEnabled;

// The form's method is `dialog`, so submitting closes it. The save has to
// happen first and has to be able to refuse, which is why this prevents the
// default and closes the dialog itself once the write has landed.
editorForm.onsubmit = async (event) => {
  event.preventDefault();
  const { name, filter } = readEditor();
  if (!name) {
    say('a perspective needs a name', true);
    return;
  }
  try {
    say('saving…');
    await api('POST', '/api/perspectives', { name, filter });
    // A rename is a save under the new name and a delete of the old one;
    // there is no rename in the store, because a perspective is keyed by
    // its name. The order matters: the new one exists before the old one
    // goes, so a failure between the two leaves two perspectives rather
    // than none.
    const renamed = editingName !== '' && editingName !== name;
    if (renamed) await api('DELETE', `/api/perspectives/${encodeURIComponent(editingName)}`);
    editor.close();
    if (view.kind === 'saved' && view.key === editingName) view = { kind: 'saved', key: name };
    await reload(renamed ? 'renamed' : 'saved');
  } catch (err) {
    say(messageOf(err), true);
  }
};

$('#perspective-delete').onclick = async () => {
  if (!editingName) return;
  if (!confirm(`Remove the perspective “${editingName}”? The items it listed are not touched.`)) return;
  try {
    await api('DELETE', `/api/perspectives/${encodeURIComponent(editingName)}`);
    editor.close();
    if (view.kind === 'saved' && view.key === editingName) view = { kind: 'inbox', key: '' };
    await reload('removed');
  } catch (err) {
    say(messageOf(err), true);
  }
};

// Editing an existing one is a double click on its row, which is how every
// other name in this UI is edited.
$('#others').addEventListener('dblclick', (event) => {
  const row = closestOf(event, '.nav-row');
  const name = row && row.dataset.perspective;
  if (name) openEditor(name);
});

// --- navigation ---------------------------------------------------------

// The chevrons are `history.back()` and not a pane change, so that they
// unwind the same stack the swipe and the system back button unwind. A
// viewer opened straight onto a deep hash has an entry behind it too: boot
// puts Home in the history first (see the end of this file).
$('#back').onclick = () => history.back();
$('#inspector-back').onclick = () => history.back();
$('#to-inspector').onclick = () => {
  if (!selected) {
    const first = currentItems()[0];
    if (first) selected = first.id;
  }
  render();
  showPane('inspector');
};
// A search box submits nothing: it filters as it is typed, and the Enter
// key on a phone keyboard must not reload the page.
$form('#search').onsubmit = (event) => event.preventDefault();
$input('#search-text').oninput = (event) => setQuery(/** @type {HTMLInputElement} */ (event.target).value.trim());
$('#search-clear').onclick = () => {
  $input('#search-text').value = '';
  setQuery('');
};

$('#reload').onclick = () => reload('reloaded').catch((err) => say(messageOf(err), true));


$('#show-other').onclick = (event) => {
  const list = $('#others');
  list.hidden = !list.hidden;
  nodeOf(event).textContent = list.hidden ? 'Show' : 'Hide';
  nodeOf(event).setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
};

// --- keyboard ----------------------------------------------------------

// --- the sidebar, by keyboard -----------------------------------------

// `h` puts the keys on the sidebar, on the row for what is open, and from
// there it is vim's tree: j/k move, l opens (and, on an open project or tile,
// steps into it), h folds (and, on a task, steps out to its project). Escape,
// or opening something that is not a container, hands the keys back to the
// outline. The mouse hands them back too: a click is never half in this mode.
const sideKeyOf = (b) => (b.dataset.key ? `k:${b.dataset.key}`
  : b.dataset.id ? `i:${b.dataset.id}`
    : b.dataset.tag ? `g:${b.dataset.tag}`
      : b.dataset.perspective ? `p:${b.dataset.perspective}` : '');

function sideButtons() {
  return /** @type {HTMLElement[]} */ ([...$('#sidebar').querySelectorAll('.tile, .nav-row')])
    .filter((b) => b.offsetParent !== null);
}

function focusSide(b) {
  if (!b) return;
  sideKey = sideKeyOf(b);
  b.focus();
  b.scrollIntoView({ block: 'nearest' });
}

function restoreSide() {
  if (sideMode) focusSide(sideButtons().find((b) => sideKeyOf(b) === sideKey));
}

function leaveSide() {
  sideMode = false;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

document.addEventListener('pointerdown', () => { sideMode = false; });

// peekSide moves to a row and shows what it is, so j and k browse: a project
// becomes the open list and the inspector's subject, a task is shown in the
// inspector under its project, and a perspective opens. A project is only
// shown, not unfolded — walking down the list must not unfold every one —
// and the Projects and Tags tiles, which only fold, are left alone.
function peekSide(b) {
  focusSide(b);
  const t = b.dataset.id ? byID.get(b.dataset.id) : undefined;
  if (saveTimer) saveNow();
  if (t && t.kind === 'project') {
    view = { kind: 'project', key: t.id };
    selected = t.id;
    render();
  } else if (t) {
    const root = parentsOf(t).find((p) => p.kind === 'project');
    if (root && !(view.kind === 'project' && view.key === root.id)) view = { kind: 'project', key: root.id };
    selected = t.id;
    render();
  } else {
    const spec = b.classList.contains('tile') ? specOf(b.dataset.key || '') : undefined;
    if (!spec || !spec.rows) b.click();
  }
}

// editSelected shows an item in the inspector and puts the cursor in its
// title, so the fields can be walked with Tab. Escape in a field blurs it,
// and `h` is then the way back to the sidebar.
function editSelected(t) {
  sideMode = false;
  if (t.kind === 'task') selectItem(t.id);
  else openContainer(t);
  showPane('inspector');
  const title = $form('#detail').elements.namedItem('title');
  if (title instanceof HTMLElement) title.focus();
}

function sideKeys(event) {
  const all = sideButtons();
  if (!all.length) return false;
  if (!sideMode) {
    if (event.key !== 'h') return false;
    sideMode = true;
    focusSide((view.kind === 'project'
      ? all.find((b) => b.dataset.id === view.key)
      : all.find((b) => b.dataset.key === view.kind)) || all[0]);
    event.preventDefault();
    return true;
  }
  const at = all.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  if (event.key === 'Escape') { leaveSide(); return true; }
  if (at < 0) { focusSide(all[0]); event.preventDefault(); return true; }
  const cur = all[at];
  const t = cur.dataset.id ? byID.get(cur.dataset.id) : undefined;
  const isTile = cur.classList.contains('tile');
  const spec = isTile ? specOf(cur.dataset.key || '') : undefined;
  const folds = spec ? Boolean(spec.rows) : (t !== undefined && t.kind === 'project');
  const open = spec ? Boolean(spec.rows && tileOpen[spec.key]) : (t !== undefined && expanded.has(t.id));
  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      peekSide(all[Math.min(at + 1, all.length - 1)]);
      break;
    case 'k':
    case 'ArrowUp':
      peekSide(all[Math.max(at - 1, 0)]);
      break;
    case 'l':
    case 'ArrowRight':
      if (folds && open) {
        // Into the first row under it: inside the tile's own cell for a
        // tile, a task for a project.
        const next = all[at + 1];
        const inside = isTile
          ? Boolean(next && cur.closest('li')?.contains(next))
          : Boolean(next && next.dataset.id && byID.get(next.dataset.id)?.kind === 'task');
        if (inside) focusSide(next);
      } else if (t && t.kind === 'task') {
        editSelected(t);
      } else {
        cur.click();
        if (!folds) leaveSide();
      }
      break;
    case 'Enter':
      // Open it and go straight to its fields: Tab walks them from here.
      if (t) editSelected(t);
      else { cur.click(); leaveSide(); }
      break;
    case 'h':
    case 'ArrowLeft':
      if (folds && open) cur.click();
      else if (t && t.kind === 'task') {
        const up = parentsOf(t).find((p) => p.kind === 'project');
        if (up) peekSide(all.find((b) => b.dataset.id === up.id));
      } else if (cur.dataset.tag) focusSide(all.find((b) => b.dataset.key === 'tags'));
      break;
    case ' ':
      return true;
    default:
      return false;
  }
  event.preventDefault();
  return true;
}

// escapeByJJ is vim's `jj`: a second j typed within 300ms of the first, in a
// text field, takes the first one back out and counts as Escape. In the
// inspector's fields it also hands the keys to the sidebar, on the project
// the item belongs to. The price is that "jj" cannot be typed quickly in a
// field; with a pause between the two, or anything else in between, they are
// ordinary letters.
let lastJ = 0;

function escapeByJJ(event) {
  const field = event.target;
  if (event.key !== 'j' || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
    lastJ = 0;
    return false;
  }
  const now = Date.now();
  const at = field.selectionStart;
  const quick = now - lastJ < 300 && at !== null && at === field.selectionEnd && at > 0 && field.value[at - 1] === 'j';
  lastJ = quick ? 0 : now;
  if (!quick || at === null) return false;
  event.preventDefault();
  field.setRangeText('', at - 1, at, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  if (field.closest('#detail')) {
    // Blurred first, so the save that a blur triggers has run before the
    // sidebar's row is looked for.
    field.blur();
    const t = byID.get(selected || '');
    const home = t && (t.kind === 'project' ? t : parentsOf(t).find((p) => p.kind === 'project'));
    const row = home && sideButtons().find((b) => b.dataset.id === home.id);
    if (row) { sideMode = true; focusSide(row); }
  }
  return true;
}

const typing = (node) => node && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName);

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (typing(event.target)) {
    if (event.key === 'Escape' || escapeByJJ(event)) nodeOf(event).blur();
    return;
  }
  if (sideKeys(event)) return;
  const items = currentItems();
  const at = items.findIndex((t) => t.id === selected);

  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      if (items.length) { selected = items[Math.min(at + 1, items.length - 1)].id; render(); }
      break;
    case 'k':
    case 'ArrowUp':
      if (items.length) { selected = items[Math.max(at - 1, 0)].id; render(); }
      break;
    case ' ':
    case 'x':
      if (at >= 0) { event.preventDefault(); complete(items[at]); }
      break;
    case 'f':
      if (at >= 0) act('PATCH', `/api/tasks/${items[at].id}`, { flagged: !items[at].flagged }, 'flagged');
      break;
    case 'n':
      event.preventDefault();
      showPane('outline');
      openCapture();
      break;
    case '/':
      // The search box, by the key every list on the web uses for it.
      event.preventDefault();
      showPane('outline');
      $input('#search-text').focus();
      break;
    case 'r':
      reload('reloaded');
      break;
    case 'Escape':
      // Back out one pane, which on a wide screen is a no-op worth having
      // anyway: it is the same key in both layouts. The history rather than
      // the attribute, for the same reason the chevrons are.
      if (document.body.dataset.pane !== 'home') history.back();
      break;
    default:
      break;
  }
});

reload().catch((err) => say(messageOf(err), true));

// The permission the badge needs, asked for only when it is tapped: a
// prompt nobody asked for is the thing that gets a permission denied
// forever. iOS grants the badge along with notifications; nothing here
// sends a notification, and there is no push subscription and no server to
// send one from.
const badgeAsk = maybe('#badge-ask');
if (badgeAsk) {
  badgeAsk.onclick = async () => {
    try {
      await Notification.requestPermission();
    } catch {
      // An older iOS rejects rather than resolving; either way the next
      // render hides the button, because the permission is answered.
    }
    updateBadge();
    renderBadgeAsk();
  };
}

// --- the server dialog -----------------------------------------------

// Where the database is. Both front ends serve this dialog and this code; the
// only thing that differs is what `GET /api/settings` says about whether the
// page may change it. `tdo serve` says no — its connection is the CLI's
// configuration — and the fieldset is disabled, greyed out, with the notice
// naming the commands. The PWA says yes and keeps what it is given in this
// browser. Neither ever sends a token back: only whether one is stored.
const settingsEditor = $dialog('#settings-editor');
const settingsForm = $form('#settings-form');
const localSqld = 'http://127.0.0.1:8080';

function settingsStatus(message, isError) {
  const node = $('#settings-status');
  node.textContent = message || '';
  node.classList.toggle('error', Boolean(isError));
}

async function openSettings() {
  const current = await api('GET', '/api/settings');
  const f = settingsForm.elements;
  f.url.value = current.url;
  f.token.value = '';
  f.token.placeholder = current.token_set ? 'unchanged — a token is stored' : 'TOKEN_GOES_HERE';
  f.remember.checked = current.remember;
  $('#settings-notice').textContent = current.notice;
  $fieldset('#settings-fields').disabled = !current.editable;
  settingsStatus('');
  settingsEditor.showModal();
}

if (settingsEditor) {
  // The footer's own `Server` word is gone — the gear's dialog has the
  // button now — but the PWA's shell is a different file and may still
  // carry one, so this stays conditional rather than assuming either.
  const serverWord = maybe('#settings');
  if (serverWord) {
    serverWord.onclick = () => openSettings().catch((err) => say(messageOf(err), true));
  }
  $('#settings-close').onclick = () => settingsEditor.close();
  $('#settings-local').onclick = () => {
    settingsForm.elements.url.value = localSqld;
    settingsForm.elements.token.focus();
  };
  // `method="dialog"` would close the dialog on submit, so the default is
  // prevented: a connection that failed has to stay open to say why.
  settingsForm.onsubmit = async (e) => {
    e.preventDefault();
    const f = settingsForm.elements;
    settingsStatus('connecting…');
    try {
      await api('PUT', '/api/settings', {
        url: f.url.value.trim(),
        token: f.token.value.trim(),
        remember: f.remember.checked,
      });
    } catch (err) {
      settingsStatus(messageOf(err), true);
      return;
    }
    f.token.value = '';
    settingsEditor.close();
    await reload('connected').catch((err) => say(messageOf(err), true));
  };
}

// --- the colour scheme ------------------------------------------------

// auto follows the system, which is all app.css did on its own; light and
// dark force it through `data-theme` on the root, and the rules for those
// are in app.css. The choice is this browser's way of looking at the list,
// so it lives in localStorage like the other preferences above.
const ThemeKey = 'todocloud.theme';
const themes = ['auto', 'light', 'dark'];

function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const button = maybe('#theme');
  if (button) button.textContent = `Theme: ${theme}`;
}

// The choice is state of this module rather than of a block, because the
// settings dialog sets it as well as the button that used to be the only way
// to: two copies of "which theme is it" would be two answers the first time
// either changed.
let theme = themes.includes(remembered(ThemeKey, 'auto')) ? remembered(ThemeKey, 'auto') : 'auto';

function setTheme(next) {
  theme = themes.includes(next) ? next : 'auto';
  remember(ThemeKey, theme);
  applyTheme(theme);
}

setTheme(theme);
const themeWord = maybe('#theme');
if (themeWord) {
  themeWord.onclick = () => setTheme(themes[(themes.indexOf(theme) + 1) % themes.length]);
}

// --- how wide the inspector is ----------------------------------------

// Three steps, cycled by the button on the inspector's own bar. Which one is
// right depends on the screen it is being read on and on how much is in the
// item, so it is a preference and it lives in localStorage beside the theme
// and the Forecast's order — this browser's way of looking at the list, not a
// fact about it. The widths themselves are in app.css: `data-inspector` on
// the root picks one, the same way `data-theme` picks a palette.
const InspectorWidthKey = 'todocloud.inspector.width';
const inspectorWidths = ['narrow', 'medium', 'wide'];

function applyInspectorWidth(width) {
  if (width === 'narrow') document.documentElement.removeAttribute('data-inspector');
  else document.documentElement.setAttribute('data-inspector', width);
  const button = maybe('#inspector-width');
  // The label is the state, not the next step: the arrow is the same control
  // whatever it is about to do, and a title attribute is the only place a
  // one-character button can say which of the three it is in.
  if (button) button.title = `Inspector width: ${width}`;
  // A title that was wrapped to the old width is wrapped to the wrong one
  // now, and the box is still the height the old wrapping needed. Nothing to
  // re-measure while the form is hidden: `scrollHeight` is 0 there, and
  // `fillInspector` grows both boxes when an item is put in them.
  const form = $form('#detail');
  if (form && !form.hidden) {
    grow(form.elements.title);
    grow(form.elements.note);
  }
}

// As with the theme: the arrow on the inspector's bar and the menu in the
// settings dialog are two controls over one piece of state.
let inspectorWidth = inspectorWidths.includes(remembered(InspectorWidthKey, 'narrow'))
  ? remembered(InspectorWidthKey, 'narrow')
  : 'narrow';

function setInspectorWidth(next) {
  inspectorWidth = inspectorWidths.includes(next) ? next : 'narrow';
  remember(InspectorWidthKey, inspectorWidth);
  applyInspectorWidth(inspectorWidth);
}

setInspectorWidth(inspectorWidth);
const widthArrow = maybe('#inspector-width');
if (widthArrow) {
  widthArrow.onclick = () => setInspectorWidth(
    inspectorWidths[(inspectorWidths.indexOf(inspectorWidth) + 1) % inspectorWidths.length]);
}

// --- how wide the sidebar is -----------------------------------------

// The inspector's steps again, for the other side: the sidebar was a fixed
// 264px, which is more than the perspectives need and less than a deep
// Projects tree does. Same mechanism — `data-sidebar` on the root, widths in
// app.css, the choice in localStorage.
const SidebarWidthKey = 'todocloud.sidebar.width';
const sidebarWidths = ['small', 'narrow', 'medium', 'wide'];

function applySidebarWidth(width) {
  if (width === 'narrow') document.documentElement.removeAttribute('data-sidebar');
  else document.documentElement.setAttribute('data-sidebar', width);
  const button = maybe('#sidebar-width');
  if (button) button.title = `Sidebar width: ${width}`;
}

let sidebarWidth = sidebarWidths.includes(remembered(SidebarWidthKey, 'narrow'))
  ? remembered(SidebarWidthKey, 'narrow')
  : 'narrow';

function setSidebarWidth(next) {
  sidebarWidth = sidebarWidths.includes(next) ? next : 'narrow';
  remember(SidebarWidthKey, sidebarWidth);
  applySidebarWidth(sidebarWidth);
}

setSidebarWidth(sidebarWidth);
const sidebarArrow = maybe('#sidebar-width');
if (sidebarArrow) {
  sidebarArrow.onclick = () => setSidebarWidth(
    sidebarWidths[(sidebarWidths.indexOf(sidebarWidth) + 1) % sidebarWidths.length]);
}

// --- the settings dialog ----------------------------------------------

// The gear at the bottom left of Home. What is in it is everything this
// browser remembers about how the list is read — the theme, the inspector's
// width, the Forecast's order, whether a project keeps its completed
// actions — and none of it is in the store: a preference that followed the
// tasks would be a preference about somebody else's screen.
//
// The controls are filled from the live state each time the dialog opens
// rather than kept in step with the other ways in (the arrow on the
// inspector's bar, the Forecast's own segmented words). A dialog that is
// only ever read while it is open has no reason to hold a second copy of
// anything, and that is also why each control writes through the same
// setter those other controls call.
const prefsEditor = $dialog('#prefs-editor');

function openPrefs() {
  $select('#prefs-theme').value = theme;
  $select('#prefs-inspector').value = inspectorWidth;
  $select('#prefs-sidebar').value = sidebarWidth;
  $select('#prefs-forecast').value = forecastOrder;
  $input('#prefs-project-done').checked = projectDoneShown;
  $input('#prefs-forecast-done').checked = forecastDoneShown;
  prefsEditor.showModal();
}

if (prefsEditor) {
  $('#prefs').onclick = openPrefs;
  $('#prefs-close').onclick = () => prefsEditor.close();
  $select('#prefs-theme').onchange = (event) => setTheme(/** @type {HTMLInputElement} */ (event.target).value);
  $select('#prefs-sidebar').onchange = (event) => setSidebarWidth(/** @type {HTMLInputElement} */ (event.target).value);
  $select('#prefs-inspector').onchange = (event) => setInspectorWidth(/** @type {HTMLInputElement} */ (event.target).value);
  $select('#prefs-forecast').onchange = (event) => setForecastOrder(/** @type {HTMLInputElement} */ (event.target).value);
  $input('#prefs-project-done').onchange = () => toggleProjectDone();
  $input('#prefs-forecast-done').onchange = () => toggleForecastDone();
  // Where the database is is a question about the store and not about this
  // browser, so it keeps the dialog it had. One modal at a time: the gear is
  // the way to it now, so it closes behind the one it opens.
  $('#prefs-server').onclick = () => {
    prefsEditor.close();
    openSettings().catch((err) => say(messageOf(err), true));
  };
}

// --- installing to a home screen ---------------------------------------

// The worker caches nothing; it exists so the page is installable to a home
// screen. It is registered only in a secure context, which is where a
// browser will accept one at all: over loopback, or behind TLS. Reached by
// plain http across a tailnet there is no worker, the viewer works exactly
// as before, and nothing here complains — `tailscale serve` is how that
// install gets its https, and it is documented rather than demanded.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    // updateViaCache: 'none' so the worker itself is never served from the
    // browser's HTTP cache: a phone has no devtools window to clear, and a
    // worker one version behind is the one thing nobody can fix from there.
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      // A viewer without a worker is a working viewer — the worker answers
      // no requests. Only the install prompt is lost, which is not worth a
      // message on screen.
    });
  });
}
