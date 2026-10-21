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

const token = document.body.dataset.token;

let state = { tasks: [], perspectives: [], tags: [], now: null };
let byID = new Map();
let view = { kind: 'inbox', key: '' };
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

function toggleExpanded(id) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  saveExpanded();
  renderHome();
}

// shownInSidebar hides what is inside a closed folder, at any depth: a
// folder shut two levels up hides everything under it, not just its
// children.
function shownInSidebar(t) {
  return parentsOf(t).every((p) => expanded.has(p.id));
}

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of [].concat(kids)) node.append(kid);
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

async function api(method, path, body) {
  const init = { method, headers: { 'X-Tdo-Token': token } };
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
    say(err.message, true);
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
  say(message || '');
}

// --- the slices of the tree --------------------------------------------

const closed = (t) => t.status === 'done' || t.status === 'dropped';
const open = (t) => !closed(t);
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

// passed reports whether an instant is behind us. It is the question "is
// this overdue", which is about the moment and not about the day.
const passed = (stamp) => Boolean(stamp) && new Date(stamp) <= new Date(state.now);

// calendarDays counts whole days between two dates, not elapsed hours: an
// item due at midnight this morning is still due *today*, an hour overdue,
// and calling that "Yesterday" is how a list starts lying to its reader.
function calendarDays(stamp) {
  if (!stamp) return null;
  const a = new Date(stamp);
  const b = new Date(state.now);
  const at = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const now = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((at - now) / 86400000);
}

const overdue = (t) => Boolean(t.due_at) && open(t) && passed(t.due_at);
const dueSoon = (t) => Boolean(t.due_at) && open(t) && !passed(t.due_at) && calendarDays(t.due_at) <= 2;

// The perspectives, in the order the manual lists OmniFocus's own, with the
// two this tool has no equivalent for (Forecast's calendar, Nearby's
// location) standing in for what it does have: a plain due list and the next
// available actions. Each badge counts what OmniFocus counts — Forecast
// counts what is past due, not what is due today, and Inbox and Flagged
// count only what is actually available.
const PERSPECTIVES = [
  {
    key: 'due', label: 'Forecast', tint: 'salmon', glyph: '◷', sort: byDue, wide: true,
    pick: (t) => t.due_at && open(t),
    badge: (items) => items.filter(overdue).length,
  },
  {
    key: 'inbox', label: 'Inbox', tint: 'slate', glyph: '▤', wide: true,
    pick: (t) => t.kind === 'task' && !t.parent_id && open(t),
    badge: (items) => items.filter((t) => t.available).length,
  },
  {
    key: 'flagged', label: 'Flagged', tint: 'creamsicle', glyph: '⚑',
    pick: (t) => t.flagged && open(t),
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
    key: 'projects', label: 'Projects', tint: 'sky', glyph: '▣', rows: 'tree',
    pick: (t) => t.kind === 'project' && open(t),
  },
  {
    // Tags is a way into the tree rather than a queue of work, so it lists
    // the tags themselves and each one leads to its items — which is what
    // OmniFocus's Tags perspective does, and why Home no longer carries a
    // tag list of its own below the tiles. `rows` says the outline shows
    // something other than tasks here; `pick` still has to exist, because
    // every tile asks its spec for a count.
    key: 'tags', label: 'Tags', tint: 'purple', glyph: '#', rows: 'tags',
    pick: () => false,
  },
  {
    key: 'review', label: 'Review', tint: 'violet', glyph: '↻', wide: true,
    pick: (t) => t.next_review_at && open(t),
    badge: (items) => items.filter((t) => passed(t.next_review_at)).length,
  },
];

// Other Perspectives, which OmniFocus keeps collapsed behind a Show: the
// views that answer a question about the list rather than offering work.
const OTHERS = [
  { key: 'blocked', label: 'Blocked', pick: (t) => open(t) && t.available === false },
  { key: 'all', label: 'All', pick: (t) => open(t) },
  { key: 'done', label: 'Completed', pick: (t) => closed(t), sort: (a, b) => (b.completed_at || '').localeCompare(a.completed_at || '') },
];

const specOf = (key) => PERSPECTIVES.find((v) => v.key === key) || OTHERS.find((v) => v.key === key);

function byDue(a, b) {
  if (!a.due_at) return 1;
  if (!b.due_at) return -1;
  return a.due_at.localeCompare(b.due_at);
}

// A saved perspective is a stored filter the server runs, and running one
// here would mean reimplementing it in JavaScript — which is exactly the
// drift this UI is written to avoid. So Home lists them and says what to
// type; the projects and tags are the parts a client can honour faithfully.
function currentItems() {
  if (view.kind === 'project') {
    const root = byID.get(view.key);
    if (!root) return [];
    return state.tasks.filter((t) => t.id !== root.id && inSubtree(t, root.id) && open(t));
  }
  if (view.kind === 'tag') {
    return state.tasks.filter((t) => open(t) && (t.tags || []).some((g) => g.toLowerCase() === view.key.toLowerCase()));
  }
  // One day of the forecast. Without a key the Due perspective is the whole
  // of it, which is what the tile above the strip selects.
  if (view.kind === 'saved') {
    // The server decided what is in it and in what order; the page's job is
    // to render that and not to re-sort it.
    return savedView.name === view.key ? savedView.tasks : [];
  }
  if (view.kind === 'due' && view.key) {
    const cell = forecastCell(view.key);
    return cell ? forecastOn(cell) : [];
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
  if (view.kind === 'due' && view.key) {
    const cell = forecastCell(view.key);
    return cell ? `Forecast · ${cell.label}` : 'Forecast';
  }
  const spec = specOf(view.kind);
  return spec ? spec.label : 'Items';
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
    say(err.message, true);
  }
}

// --- panes --------------------------------------------------------------

// On a narrow screen one pane is on at a time and the back chevron walks
// Home ← outline ← item, the way it does in OmniFocus; on a wide one all
// three are on screen and this attribute is ignored.
function showPane(name) {
  document.body.dataset.pane = name;
}

function select(next) {
  view = next;
  showPane('outline');
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

// --- rendering ---------------------------------------------------------

function render() {
  renderHome();
  renderList();
  renderInspector();
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
    const tile = el('button', { type: 'button', className: 'tile', onclick: () => select({ kind: spec.key, key: '' }) });
    tile.style.setProperty('--tint', `var(--${spec.tint})`);
    tile.setAttribute('aria-current', view.kind === spec.key ? 'true' : 'false');
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
    const cell = el('li', { className: spec.wide ? 'wide' : (narrow++ % 2 === 0 ? 'col1' : 'col2') }, tile);
    if (spec.key === 'due') cell.append(forecastStrip());
    return cell;
  }));

  $('#others').replaceChildren(
    ...OTHERS.map((spec) => navRow(spec.label, state.tasks.filter(spec.pick).length,
      view.kind === spec.key, () => select({ kind: spec.key, key: '' }))),
    ...(state.perspectives || []).map((p) => navRow(
      p.name,
      savedView.name === p.name ? savedView.tasks.length : null,
      view.kind === 'saved' && view.key === p.name,
      () => openSaved(p.name),
      { mark: el('span', { textContent: '⌕' }), perspective: p.name })));
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

// The buckets, defined once. The strip counts with them and the outline
// filters with them, so a day that says 2 shows two items — the one thing a
// forecast must never get wrong. The keys are stable (`d1`..`d4`) while the
// labels are not: Thursday is `d4` today and `d3` tomorrow, and a view held
// open across midnight should follow the day it means rather than the name
// it had.
function forecastDays() {
  const today = new Date(state.now);
  const cells = [
    { key: 'past', label: 'Past', match: (d) => d < 0, late: true },
    { key: 'today', label: 'Today', match: (d) => d === 0, today: true },
  ];
  for (let i = 1; i <= 4; i += 1) {
    const day = new Date(today.getTime() + i * 86400000);
    cells.push({ key: `d${i}`, label: WEEKDAYS[day.getUTCDay()], match: (d) => d === i });
  }
  cells.push({ key: 'future', label: 'Future', match: (d) => d > 4 });
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
const dueOn = (cell) => state.tasks.filter((t) => t.due_at && open(t) && cell.match(calendarDays(t.due_at)));

const startsOn = (cell) => (cell.late ? [] : state.tasks.filter(
  (t) => t.defer_at && open(t) && cell.match(calendarDays(t.defer_at))));

// forecastOn is the day itself: everything the day has to say, deadlines
// first. It is what a day cell opens.
function forecastOn(cell) {
  const items = dueOn(cell);
  const ids = new Set(items.map((t) => t.id));
  for (const t of startsOn(cell)) {
    if (!ids.has(t.id)) items.push(t);
  }
  return items.sort(byDue);
}

function forecastStrip() {
  const strip = el('div', { className: 'forecast' });
  for (const c of forecastDays()) {
    const n = dueOn(c).length;
    const starting = startsOn(c).length;
    // A day is a button, not a label: the count is only useful if the
    // things it counts are one tap away. An empty day stays live rather
    // than going dead under the finger — the outline has an empty state,
    // and a control that is sometimes a control is worse than one that is
    // always one.
    const cell = el('button', {
      type: 'button',
      className: 'day',
      onclick: () => select({ kind: 'due', key: c.key }),
    });
    cell.setAttribute('aria-current', view.kind === 'due' && view.key === c.key ? 'true' : 'false');
    cell.setAttribute('aria-label', starting
      ? `${c.label}, ${n} due, ${starting} starting`
      : `${c.label}, ${n} due`);
    if (c.today) cell.classList.add('today');
    if (c.late && n) cell.classList.add('late');
    if (!n && !starting) cell.classList.add('none');
    cell.append(
      el('span', { className: 'when', textContent: c.label }),
      el('span', { className: 'n', textContent: String(n) }));
    // The second number is only there when there is something to say. An
    // arrow rather than a plus, because it is the same `↓` the rows use for
    // a defer date.
    if (starting) cell.append(el('span', { className: 'starting', textContent: `↓${starting}` }));
    strip.append(cell);
  }
  return strip;
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

// treeRows is the container tree: folders holding projects, a folder's
// contents hidden until it is opened. It used to be a list under the tiles
// on Home, and moved here when Projects became a perspective; what it draws
// is unchanged, including the disclosure triangles and the folders that are
// shut to begin with.
function treeRows() {
  const containers = state.tasks.filter((t) => isContainer(t) && open(t));
  return containers.filter(shownInSidebar).map((t) => {
    // Only a folder holds other containers (§3.1), so only a folder has
    // anything to disclose; a project's contents are tasks, which this list
    // does not show. `null` is a spacer of the triangle's width, so the
    // names still line up.
    const holds = t.kind === 'folder' && containers.some((x) => x.parent_id === t.id);
    const row = navRow(
      t.title,
      state.tasks.filter((x) => x.id !== t.id && inSubtree(x, t.id) && open(x) && x.kind === 'task').length,
      false,
      () => select({ kind: 'project', key: t.id }),
      {
        depth: parentsOf(t).length,
        mark: typeIcon(t),
        id: t.id,
        disclosure: holds ? { id: t.id, label: t.title, isOpen: expanded.has(t.id) } : null,
      });
    // The button, not the `li`: the `li` holds the disclosure triangle as
    // well, and a drag that started on the triangle would be a drag of the
    // control rather than of the folder.
    draggable(row.querySelector('.nav-row'), t, t);
    return row;
  });
}

// tagRows is the Tags perspective: the tags themselves, each leading to its
// items. A tag that is on hold or dropped holds its items back, so it reads
// as inactive here too; `tdo tag unhold <tag>` is how it comes back.
function tagRows() {
  return (state.tags || []).map((g) => navRow(
    g.name,
    g.count,
    false,
    () => select({ kind: 'tag', key: g.name }),
    { held: g.status && g.status !== 'active', mark: el('span', { textContent: '#' }) }));
}

function renderList() {
  $('#list-title').textContent = viewTitle();
  $('#back-label').textContent = 'Home';

  // Capture goes to the inbox unless a project is on screen, which is the one
  // place the destination is already unambiguous.
  $('#quick-title').placeholder = view.kind === 'project'
    ? `Add to ${viewTitle()}…`
    : 'Add to the inbox…';

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

  $('#items').replaceChildren(...items.map((t) => {
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
    if (closed(t)) row.classList.add('closed');
    // Grey for what cannot be worked on — completed, blocked, on hold, a
    // container — and black again for anything due soon or overdue, which is
    // the exception the manual makes and the reason the rule is useful.
    if (closed(t) || isContainer(t) || t.available === false) row.classList.add('quiet');
    if (overdue(t) || dueSoon(t)) row.classList.add('dated');

    // Directly actionable items have a status circle; a project or a folder
    // carries its type icon instead, because it is not something to do.
    row.append(isContainer(t) ? el('span', { className: 'type' }, typeIcon(t)) : statusCircle(t));

    const lines = el('div', { className: 'lines' });
    // The project path goes above the title, not beside it: on one line the
    // title shared its width with the path, the tags and the date, and the
    // thing being read was the first to be cut.
    const where = parentsOf(t).map((p) => p.title).join(' › ');
    if (where && view.kind !== 'project') lines.append(el('div', { className: 'where', textContent: where }));
    if (!where && view.kind === 'inbox') lines.append(el('div', { className: 'where', textContent: 'No project' }));
    lines.append(el('div', { className: 'title', textContent: t.title }));

    const under = el('div', { className: 'under' });
    for (const g of t.tags || []) under.append(tagChip(g));
    if (t.note) under.append(el('span', { className: 'note', textContent: '✎' }));
    if (isContainer(t)) {
      const inside = state.tasks.filter((x) => x.id !== t.id && inSubtree(x, t.id) && open(x) && x.kind === 'task');
      const late = inside.filter(overdue).length;
      under.append(el('span', {
        className: 'count',
        textContent: late ? `${inside.length} items · ${late} overdue` : `${inside.length} items`,
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
  }));
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

function renderInspector() {
  const form = $('#detail');
  const t = selected ? byID.get(selected) : null;
  $('#no-selection').hidden = Boolean(t);
  form.hidden = !t;
  $('#back-label').textContent = 'Home';
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
    p.id !== t.id && open(p) && !inSubtree(p, t.id) && canContain(p.kind, t.kind));
  form.elements.parent_id.replaceChildren(
    el('option', { value: '', textContent: t.kind === 'task' ? '(inbox)' : '(top level)' }),
    ...parents.map((p) => el('option', { value: p.id, textContent: p.title })));
  form.elements.parent_id.value = t.parent_id || '';
  grow(form.elements.note);
}

// grow sizes the note to its contents: a note is read far more often than
// it is written, and a four-line box with twenty lines in it hides what it
// was written for.
function grow(area) {
  area.style.height = 'auto';
  area.style.height = `${Math.max(area.scrollHeight, 56)}px`;
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
    event.dataTransfer.dropEffect = 'move';
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
  event.dataTransfer.dropEffect = 'move';
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
      say(err.message, true);
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

$('#items').addEventListener('dblclick', (event) => {
  // A folder or a project in the Projects tree, which is a nav row rather
  // than an item row.
  const name = event.target.closest('.nav-row .name');
  if (name) {
    const container = byID.get(name.closest('.nav-row').dataset.id || '');
    if (container) editInPlace(name, `title of ${container.title}`, container.title, commitTitle(container));
    return;
  }
  const row = event.target.closest('.item');
  if (!row) return;
  const t = byID.get(row.dataset.id);
  if (!t) return;
  const chip = event.target.closest('.tag');
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
  const title = event.target.closest('.title');
  if (title) {
    editInPlace(title, `title of ${t.title}`, t.title, commitTitle(t));
  }
});



// --- writes ------------------------------------------------------------

function complete(t) {
  if (t.status === 'done') {
    return act('POST', `/api/tasks/${t.id}/status`, { status: 'active' }, 'reopened');
  }
  return act('POST', `/api/tasks/${t.id}/done`, {}, 'completed');
}

$('#quick').onsubmit = async (event) => {
  event.preventDefault();
  const input = $('#quick-title');
  const title = input.value.trim();
  if (!title) return;
  const body = { title };
  if (view.kind === 'project') body.parent_id = view.key;
  input.value = '';
  await act('POST', '/api/tasks', body, 'captured');
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
  const form = $('#detail');
  const t = byID.get(form.dataset.id);
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

// readInspector takes the form as a plain value with no DOM left in it, so
// that what gets saved is what was on screen when the save was asked for.
function readInspector(form) {
  return {
    title: form.elements.title.value,
    note: form.elements.note.value,
    tags: form.elements.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
    estimate: form.elements.estimate.value.trim() || '0',
    priority: Number(form.elements.priority.value),
    flagged: form.elements.flagged.checked,
    defer_at: form.elements.defer_at.value,
    due_at: form.elements.due_at.value,
    status: form.elements.status.value,
    parent_id: form.elements.parent_id.value,
  };
}

async function writeInspector(edited, t) {
  const { defer_at, due_at, status, parent_id, ...edit } = edited;
  if (!edit.title.trim()) return;        // an empty title is refused by the store
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
    say(err.message, true);
  }
}

$('#detail').oninput = (event) => {
  if (event.target.name === 'note') grow(event.target);
  scheduleSave();
};

// A menu, a checkbox or a date is finished the moment it changes, and a
// date picker never fires `input` on every platform anyway.
$('#detail').onchange = () => saveNow();

// Leaving a field commits it rather than waiting out the timer, and so does
// Enter in a single-line field — which must not submit the form, since the
// form has no submit left to do.
$('#detail').addEventListener('focusout', () => saveNow());
$('#detail').onsubmit = (event) => {
  event.preventDefault();
  saveNow();
};

$('#complete').onclick = () => {
  const t = byID.get(selected);
  if (t) complete(t);
};

$('#remove').onclick = () => {
  const t = byID.get(selected);
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

const editor = $('#perspective-editor');
const editorForm = $('#perspective-form');

// editingName is the perspective being changed, or '' while making a new
// one. It is also what a rename is measured against.
let editingName = '';

const fields = () => editorForm.elements;
const ticked = (name) => [...editorForm.querySelectorAll(`input[name="${name}"]:checked`)].map((n) => n.value);
const tick = (name, values) => {
  for (const node of editorForm.querySelectorAll(`input[name="${name}"]`)) {
    node.checked = values.includes(node.value);
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
  const containers = state.tasks.filter((t) => isContainer(t) && open(t));
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
    say(err.message, true);
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
    say(err.message, true);
  }
};

// Editing an existing one is a double click on its row, which is how every
// other name in this UI is edited.
$('#others').addEventListener('dblclick', (event) => {
  const row = event.target.closest('.nav-row');
  const name = row && row.dataset.perspective;
  if (name) openEditor(name);
});

// --- navigation ---------------------------------------------------------

$('#back').onclick = () => showPane('home');
$('#inspector-back').onclick = () => showPane('outline');
$('#to-inspector').onclick = () => {
  if (!selected) {
    const first = currentItems()[0];
    if (first) selected = first.id;
  }
  render();
  showPane('inspector');
};
$('#reload').onclick = () => reload('reloaded').catch((err) => say(err.message, true));
$('#capture').onclick = () => {
  showPane('outline');
  $('#quick-title').focus();
};

$('#show-other').onclick = (event) => {
  const list = $('#others');
  list.hidden = !list.hidden;
  event.target.textContent = list.hidden ? 'Show' : 'Hide';
  event.target.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
};

// --- keyboard ----------------------------------------------------------

const typing = (node) => node && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName);

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (typing(event.target)) {
    if (event.key === 'Escape') event.target.blur();
    return;
  }
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
      $('#quick-title').focus();
      break;
    case 'r':
      reload('reloaded');
      break;
    case 'Escape':
      // Back out one pane, which on a wide screen is a no-op worth having
      // anyway: it is the same key in both layouts.
      showPane(document.body.dataset.pane === 'inspector' ? 'outline' : 'home');
      break;
    default:
      break;
  }
});

reload().catch((err) => say(err.message, true));

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
