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
    key: 'due', label: 'Due', tint: 'salmon', glyph: '◷', sort: byDue,
    pick: (t) => t.due_at && open(t),
    badge: (items) => items.filter(overdue).length,
  },
  {
    key: 'inbox', label: 'Inbox', tint: 'slate', glyph: '▤',
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
    key: 'projects', label: 'Projects', tint: 'sky', glyph: '▣',
    pick: (t) => t.kind === 'project' && open(t),
  },
  {
    key: 'review', label: 'Review', tint: 'violet', glyph: '↻',
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
  const spec = specOf(view.kind);
  return spec ? spec.label : 'Items';
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
  const button = el('button', { type: 'button', className: 'nav-row', onclick: onClick });
  button.setAttribute('aria-current', isCurrent ? 'true' : 'false');
  if (options.depth) button.classList.add(`depth${Math.min(options.depth, 2)}`);
  if (options.held) button.classList.add('held');
  if (options.mark) button.append(el('span', { className: 'mark' }, options.mark));
  button.append(el('span', { className: 'name', textContent: label }));
  if (count !== null && count !== undefined) {
    button.append(el('span', { className: 'count', textContent: String(count) }));
  }
  return el('li', {}, button);
}

function renderHome() {
  $('#tiles').replaceChildren(...PERSPECTIVES.map((spec) => {
    const items = state.tasks.filter(spec.pick);
    const n = spec.badge ? spec.badge(items) : items.length;
    const tile = el('button', { type: 'button', className: 'tile', onclick: () => select({ kind: spec.key, key: '' }) });
    tile.style.setProperty('--tint', `var(--${spec.tint})`);
    tile.setAttribute('aria-current', view.kind === spec.key ? 'true' : 'false');
    const glyph = el('span', { className: 'glyph', textContent: spec.glyph });
    // The glyph repeats what the label says, so it is decoration as far as a
    // screen reader is concerned; the tile's own aria-label carries the count.
    glyph.setAttribute('aria-hidden', 'true');
    tile.append(
      glyph,
      el('span', { className: 'name', textContent: spec.label }),
      el('span', { className: 'badge', textContent: n ? String(n) : '' }));
    tile.setAttribute('aria-label', `${spec.label}, ${n}`);
    return el('li', {}, tile);
  }));

  const containers = state.tasks.filter((t) => isContainer(t) && open(t));
  $('#projects').replaceChildren(...containers.map((t) => navRow(
    t.title,
    state.tasks.filter((x) => x.id !== t.id && inSubtree(x, t.id) && open(x) && x.kind === 'task').length,
    view.kind === 'project' && view.key === t.id,
    () => select({ kind: 'project', key: t.id }),
    { depth: parentsOf(t).length, mark: typeIcon(t) })));

  $('#tags').replaceChildren(...(state.tags || []).map((g) => navRow(
    g.name, g.count, view.kind === 'tag' && view.key === g.name,
    () => select({ kind: 'tag', key: g.name }),
    // A tag that is on hold or dropped holds its items back, so it reads as
    // inactive here too; `tdo tag unhold <tag>` is how it comes back.
    { held: g.status && g.status !== 'active', mark: el('span', { textContent: '#' }) })));

  $('#others').replaceChildren(
    ...OTHERS.map((spec) => navRow(spec.label, state.tasks.filter(spec.pick).length,
      view.kind === spec.key, () => select({ kind: spec.key, key: '' }))),
    ...(state.perspectives || []).map((p) => navRow(p.name, null, false,
      () => say(`“${p.name}” is a saved query: tdo ls --perspective ${p.name}`),
      { mark: el('span', { textContent: '⌕' }) })));
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

function renderList() {
  $('#list-title').textContent = viewTitle();
  $('#back-label').textContent = 'Home';
  const items = currentItems();
  $('#empty').hidden = items.length > 0;

  // Capture goes to the inbox unless a project is on screen, which is the one
  // place the destination is already unambiguous.
  $('#quick-title').placeholder = view.kind === 'project'
    ? `Add to ${viewTitle()}…`
    : 'Add to the inbox…';

  $('#items').replaceChildren(...items.map((t) => {
    const row = el('li', { className: 'item', tabIndex: -1 });
    row.dataset.id = t.id;
    row.setAttribute('aria-selected', selected === t.id ? 'true' : 'false');
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

    row.onclick = () => selectItem(t.id);
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
  // One save at a time, in order: two overlapping PATCHes of the same item
  // are a race whose loser silently wins.
  saving = saving.then(() => writeInspector(form, t)).catch(() => {});
  return saving;
}

async function writeInspector(form, t) {
  const edit = {
    title: form.elements.title.value,
    note: form.elements.note.value,
    tags: form.elements.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
    estimate: form.elements.estimate.value.trim() || '0',
    priority: Number(form.elements.priority.value),
    flagged: form.elements.flagged.checked,
  };
  if (!edit.title.trim()) return;        // an empty title is refused by the store
  try {
    say('saving…');
    await api('PATCH', `/api/tasks/${t.id}`, edit);
    // The dates, the status and the parent are their own operations in the
    // shared layer — completing is not a status write, and a move is not an
    // update — so the inspector sends what actually changed, in that order.
    const dates = [
      ['defer', form.elements.defer_at.value, t.defer_at],
      ['due', form.elements.due_at.value, t.due_at],
    ];
    for (const [field, next, before] of dates) {
      if (next === (before ? before.slice(0, 10) : '')) continue;
      await api('POST', `/api/tasks/${t.id}/date`, { field, at: next });
    }
    const status = form.elements.status.value;
    if (status !== t.status) {
      await api('POST', `/api/tasks/${t.id}/status`, { status });
    }
    const parent = form.elements.parent_id.value;
    if (parent !== (t.parent_id || '')) {
      await api('POST', `/api/tasks/${t.id}/move`, { parent_id: parent });
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
