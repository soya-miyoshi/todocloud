// The viewer. It holds no model of its own: every write is a request, and
// every request is followed by a fresh snapshot of the whole tree, so what is
// on screen is what the store says and never a guess about what the store
// will say. A todo list is small and the server is on this machine, so the
// simple thing is also the fast one.
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

function say(message, isError) {
  const node = $('#status');
  node.textContent = message || '';
  node.classList.toggle('error', Boolean(isError));
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
    await reload(reportExtras(result) || done || 'done');
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

const VIEWS = [
  { key: 'inbox', label: 'Inbox', pick: (t) => t.kind === 'task' && !t.parent_id && open(t) },
  { key: 'next', label: 'Next', pick: (t) => t.kind === 'task' && t.status === 'active' && t.available },
  { key: 'flagged', label: 'Flagged', pick: (t) => t.flagged && open(t) },
  { key: 'due', label: 'Due', pick: (t) => t.due_at && open(t), sort: byDue },
  { key: 'blocked', label: 'Blocked', pick: (t) => open(t) && t.available === false },
  { key: 'review', label: 'Review', pick: (t) => t.next_review_at && open(t) },
  { key: 'all', label: 'All', pick: (t) => open(t) },
  { key: 'done', label: 'Completed', pick: (t) => closed(t), sort: (a, b) => (b.completed_at || '').localeCompare(a.completed_at || '') },
];

function byDue(a, b) {
  if (!a.due_at) return 1;
  if (!b.due_at) return -1;
  return a.due_at.localeCompare(b.due_at);
}

// A saved perspective is a stored filter the server runs, and running one
// here would mean reimplementing it in JavaScript — which is exactly the
// drift this UI is written to avoid. So the sidebar lists them, and
// selecting one narrows to what it names: the projects and tags a
// perspective holds are the parts a client can honour faithfully.
function currentItems() {
  if (view.kind === 'project') {
    const root = byID.get(view.key);
    if (!root) return [];
    return state.tasks.filter((t) => t.id !== root.id && inSubtree(t, root.id) && open(t));
  }
  if (view.kind === 'tag') {
    return state.tasks.filter((t) => open(t) && (t.tags || []).some((g) => g.toLowerCase() === view.key.toLowerCase()));
  }
  const spec = VIEWS.find((v) => v.key === view.kind) || VIEWS[0];
  const items = state.tasks.filter(spec.pick);
  return spec.sort ? items.slice().sort(spec.sort) : items;
}

function viewTitle() {
  if (view.kind === 'project') {
    const root = byID.get(view.key);
    return root ? root.title : 'Project';
  }
  if (view.kind === 'tag') return `#${view.key}`;
  const spec = VIEWS.find((v) => v.key === view.kind);
  return spec ? spec.label : 'Items';
}

// --- rendering ---------------------------------------------------------

function render() {
  renderSidebar();
  renderList();
  renderInspector();
}

function sidebarButton(label, count, isCurrent, onClick, depth) {
  const button = el('button', { type: 'button', textContent: label, onclick: onClick });
  if (depth) button.classList.add(`depth${Math.min(depth, 2)}`);
  button.setAttribute('aria-current', isCurrent ? 'true' : 'false');
  if (count !== null) button.append(el('span', { className: 'count', textContent: String(count) }));
  return el('li', {}, button);
}

function renderSidebar() {
  const views = $('#views');
  views.replaceChildren(...VIEWS.map((spec) =>
    sidebarButton(spec.label, state.tasks.filter(spec.pick).length, view.kind === spec.key,
      () => select({ kind: spec.key, key: '' }))));

  const containers = state.tasks.filter((t) => t.kind !== 'task' && open(t));
  const depthOf = (t) => parentsOf(t).length;
  $('#projects').replaceChildren(...containers.map((t) =>
    sidebarButton(t.title,
      state.tasks.filter((x) => x.id !== t.id && inSubtree(x, t.id) && open(x) && x.kind === 'task').length,
      view.kind === 'project' && view.key === t.id,
      () => select({ kind: 'project', key: t.id }),
      depthOf(t))));

  $('#saved').replaceChildren(...(state.perspectives || []).map((p) =>
    el('li', {}, el('button', {
      type: 'button',
      textContent: p.name,
      title: 'a saved query; run it with `tdo ls --perspective ' + p.name + '`',
      onclick: () => say(`“${p.name}” is a saved query: tdo ls --perspective ${p.name}`),
    }))));

  $('#tags').replaceChildren(...(state.tags || []).map((g) =>
    sidebarButton(g.name, g.count, view.kind === 'tag' && view.key === g.name,
      () => select({ kind: 'tag', key: g.name }))));
}

function select(next) {
  view = next;
  render();
}

function dueCell(t) {
  if (!t.due_at) return null;
  const due = new Date(t.due_at);
  const now = new Date(state.now);
  const days = Math.floor((due - now) / 86400000);
  const node = el('span', { className: 'due', textContent: t.due_at.slice(0, 10) });
  if (days < 0) node.classList.add('over');
  else if (days <= 2) node.classList.add('soon');
  return node;
}

function renderList() {
  $('#list-title').textContent = viewTitle();
  const items = currentItems();
  $('#empty').hidden = items.length > 0;

  $('#items').replaceChildren(...items.map((t) => {
    const row = el('li', { className: 'item', tabIndex: -1 });
    row.dataset.id = t.id;
    row.setAttribute('aria-selected', selected === t.id ? 'true' : 'false');
    if (closed(t)) row.classList.add('closed');
    if (t.available === false) row.classList.add('blocked');

    const box = el('input', { type: 'checkbox', className: 'box', checked: t.status === 'done' });
    box.setAttribute('aria-label', `complete ${t.title}`);
    box.onclick = (event) => {
      event.stopPropagation();
      complete(t);
    };
    row.append(box);

    if (t.kind !== 'task') row.append(el('span', { className: 'kind', textContent: t.kind }));
    row.append(el('span', { className: 'title', textContent: t.title }));
    if (t.flagged) row.append(el('span', { className: 'flag', textContent: '⚑' }));

    const where = parentsOf(t).map((p) => p.title).join(' › ');
    if (where && view.kind !== 'project') row.append(el('span', { className: 'where', textContent: where }));
    for (const g of t.tags || []) row.append(el('span', { className: 'tag', textContent: g }));
    const due = dueCell(t);
    if (due) row.append(due);
    if (t.blocked_by) row.title = `blocked: ${t.blocked_by.rule}`;

    row.onclick = () => { selected = t.id; render(); };
    return row;
  }));
}

function facts(t) {
  const rows = [
    ['id', t.id],
    ['kind', t.kind],
    ['available', t.available === null ? 'unknown' : String(t.available)],
    ['blocked by', t.blocked_by ? `${t.blocked_by.rule}` : '—'],
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
  if (!t) return;

  form.elements.title.value = t.title;
  form.elements.note.value = t.note || '';
  form.elements.tags.value = (t.tags || []).join(', ');
  form.elements.defer_at.value = t.defer_at ? t.defer_at.slice(0, 10) : '';
  form.elements.due_at.value = t.due_at ? t.due_at.slice(0, 10) : '';
  form.elements.estimate.value = t.estimated_minutes ? `${t.estimated_minutes}m` : '';
  form.elements.priority.value = String(t.priority || 0);
  form.elements.flagged.checked = Boolean(t.flagged);
  // A completed item is put back with the checkbox, not with this menu, so
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

  $('#facts').replaceChildren(...facts(t));
  $('#complete').textContent = t.status === 'done' ? 'Reopen' : 'Complete';
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
  // Capture goes to the inbox unless a project is the current view, which is
  // the one place the destination is already unambiguous.
  const body = { title };
  if (view.kind === 'project') body.parent_id = view.key;
  input.value = '';
  await act('POST', '/api/tasks', body, 'captured');
};

$('#detail').onsubmit = async (event) => {
  event.preventDefault();
  const t = byID.get(selected);
  if (!t) return;
  const form = event.target;
  const edit = {
    title: form.elements.title.value,
    note: form.elements.note.value,
    tags: form.elements.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
    estimate: form.elements.estimate.value.trim() || '0',
    priority: Number(form.elements.priority.value),
    flagged: form.elements.flagged.checked,
  };
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
  act('DELETE', `/api/tasks/${t.id}`, undefined, 'removed');
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
      $('#quick-title').focus();
      break;
    case 'r':
      reload('reloaded');
      break;
    default:
      break;
  }
});

reload().catch((err) => say(err.message, true));
