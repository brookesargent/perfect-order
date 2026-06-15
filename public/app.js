// Single swappable unit for the rating control — change this one line to reskin.
const RATING_ICON = '🍴';

const form = document.getElementById('compose-form');
const restaurantInput = document.getElementById('restaurant');
const findBtn = document.getElementById('find-btn');
const findStatus = document.getElementById('find-status');

const confirmSection = document.getElementById('confirm');
const candidateList = document.getElementById('candidate-list');

const result = document.getElementById('result');
const resultTitle = document.getElementById('result-title');
const resultSubtitle = document.getElementById('result-subtitle');
const cacheCue = document.getElementById('cache-cue');
const fallbackNote = document.getElementById('fallback-note');
const savedNote = document.getElementById('saved-note');
const mustHavesEl = document.getElementById('must-haves');
const adventurousEl = document.getElementById('adventurous');
const skipEl = document.getElementById('skip');
const suggestionDetail = document.getElementById('suggestion-detail');
const loggedDetail = document.getElementById('logged-detail');
const loggedItemsEl = document.getElementById('logged-items');

const resultStatusLine = document.getElementById('result-status-line');
const statusBadge = document.getElementById('status-badge');
const orderedOn = document.getElementById('ordered-on');

const ratingControl = document.getElementById('rating-control');
const ratingUnits = document.getElementById('rating-units');

const notesBlock = document.getElementById('notes-block');
const notesInput = document.getElementById('notes-input');
const notesSaveBtn = document.getElementById('notes-save-btn');
const notesStatus = document.getElementById('notes-status');

const saveBtn = document.getElementById('save-btn');
const markOrderedBtn = document.getElementById('mark-ordered-btn');
const deleteBtn = document.getElementById('delete-btn');
const saveStatus = document.getElementById('save-status');

const signinLink = document.getElementById('signin-link');
const userInfo = document.getElementById('user-info');
const userName = document.getElementById('user-name');

const authGate = document.getElementById('auth-gate');
const savedPane = document.getElementById('saved-pane');
const savedList = document.getElementById('saved-list');
const savedEmpty = document.getElementById('saved-empty');

const logForm = document.getElementById('log-form');
const logRestaurant = document.getElementById('log-restaurant');
const logItems = document.getElementById('log-items');
const logDate = document.getElementById('log-date');
const logNotes = document.getElementById('log-notes');
const logBtn = document.getElementById('log-btn');
const logStatus = document.getElementById('log-status');

// Holds the most recently generated order so "Save" knows what to persist.
let currentOrder = null;
// Saved orders kept in memory so clicking a row re-renders without a network call.
let savedOrders = [];
// The id of the saved order currently shown in the revisit view, so Delete
// knows which row to remove. null when viewing a fresh (unsaved) order.
let viewingSavedId = null;
// The logged-in user ({id,email,name}) or null. Gates save/log/rating UI.
let currentUser = null;
const isLoggedIn = () => currentUser != null;

// fetch() with a hard client-side timeout so a slow/cold backend never leaves
// the user staring at a spinner for minutes. Aborts after `ms`; the caller's
// catch sees an AbortError and shows a graceful "try again" message.
async function fetchWithTimeout(url, options = {}, ms = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Step 1: find + confirm ------------------------------------------------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = restaurantInput.value.trim();
  if (!query) return;

  confirmSection.classList.add('hidden');
  result.classList.add('hidden');
  findBtn.disabled = true;
  findStatus.textContent = 'Searching for the restaurant…';

  try {
    const res = await fetchWithTimeout('/api/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }, 20000);
    const { candidates } = await res.json();
    renderCandidates(candidates || []);
    findStatus.textContent = '';
  } catch (err) {
    findStatus.textContent = err.name === 'AbortError'
      ? 'Search took too long — the app may be waking up. Try again.'
      : 'Search failed. Try again.';
    console.error(err);
  } finally {
    findBtn.disabled = false;
  }
});

function renderCandidates(candidates) {
  candidateList.innerHTML = '';
  if (candidates.length === 0) {
    findStatus.textContent = 'No matches found. Try adding a city.';
    return;
  }
  for (const c of candidates) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'candidate';
    const sub = [c.location, c.cuisine].filter(Boolean).join(' · ') || 'use the name as entered';
    btn.innerHTML = `${c.name}<small>${sub}</small>`;
    btn.addEventListener('click', () => chooseCandidate(c));
    li.appendChild(btn);
    candidateList.appendChild(li);
  }
  confirmSection.classList.remove('hidden');
}

// --- Step 2: compose the order ---------------------------------------------

async function chooseCandidate(candidate) {
  confirmSection.classList.add('hidden');
  // Compose is fast now (model-knowledge, no per-request web search), and popular
  // spots are pre-cached, so this resolves in a few seconds either way.
  findStatus.textContent = 'Composing your order…';

  try {
    const res = await fetchWithTimeout('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant: candidate }),
    }, 60000);
    const order = await res.json();
    renderOrder(order);
    findStatus.textContent = '';
  } catch (err) {
    findStatus.textContent = err.name === 'AbortError'
      ? 'Taking longer than usual — the free instance may be waking up. Try again (popular spots are cached and instant).'
      : 'Could not compose an order. Try again.';
    console.error(err);
  }
}

function renderItems(el, items) {
  el.innerHTML = '';
  for (const { item, why } of items) {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${item}</strong> — <span class="why">${why}</span>`;
    el.appendChild(li);
  }
}

// Builds the header line under the title from location + cuisine, when present.
// Both are new fields, so older saved orders may not have them — render only
// what's there, and hide the line entirely if neither is set.
function renderHeader(order) {
  resultTitle.textContent = order.restaurant || '';
  const sub = [order.location, order.cuisine].filter(Boolean).join(' · ');
  resultSubtitle.textContent = sub;
  resultSubtitle.classList.toggle('hidden', !sub);
}

// Compact read-only rating for the saved-orders list rows. Unrated → ''.
function ratingDisplay(rating) {
  if (!rating) return '';
  return RATING_ICON.repeat(rating) + ` ${rating}/5`;
}

// Build the interactive 5-unit control for the revisit view. `rating` may be
// null (unrated → all units dimmed). Clicking unit N persists rating = N.
function renderRatingControl(id, rating) {
  ratingUnits.innerHTML = '';
  for (let n = 1; n <= 5; n++) {
    const unit = document.createElement('button');
    unit.type = 'button';
    unit.className = 'rating-unit' + (rating && n <= rating ? ' on' : '');
    unit.textContent = RATING_ICON;
    unit.setAttribute('aria-label', `${n} of 5`);
    unit.addEventListener('click', () => rateOrder(id, n));
    ratingUnits.appendChild(unit);
  }
}

function renderOrder(order) {
  currentOrder = order;
  viewingSavedId = null;
  renderHeader(order);
  savedNote.classList.add('hidden');
  fallbackNote.classList.toggle('hidden', !order.fallback);
  cacheCue.classList.toggle('hidden', order.source !== 'cache');
  // A fresh AI compose always has the suggestion shape.
  renderOrderDetail(order);
  result.classList.remove('hidden');
  // No status/rating/notes/mark-ordered/delete on a not-yet-saved order.
  resultStatusLine.classList.add('hidden');
  ratingControl.classList.add('hidden');
  notesBlock.classList.add('hidden');
  markOrderedBtn.classList.add('hidden');
  deleteBtn.classList.add('hidden');
  // Save requires login. Logged out → prompt to sign in instead of a dead button.
  saveBtn.classList.remove('hidden');
  if (isLoggedIn()) {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save this order';
    saveStatus.textContent = '';
  } else {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Save this order';
    saveStatus.innerHTML = '<a href="/auth/login" class="auth-link">Sign in</a> to save & log orders.';
  }
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Renders whichever order_data shape is present: the AI suggestion
// (must_haves/adventurous/skip) or a manual log ({ items: [...] }).
function renderOrderDetail(order) {
  const isLogged = Array.isArray(order.items);
  if (isLogged) {
    loggedItemsEl.innerHTML = '';
    for (const item of order.items) {
      const li = document.createElement('li');
      li.textContent = item;
      loggedItemsEl.appendChild(li);
    }
    loggedDetail.classList.remove('hidden');
    suggestionDetail.classList.add('hidden');
  } else {
    renderItems(mustHavesEl, order.must_haves || []);
    renderItems(adventurousEl, order.adventurous ? [order.adventurous] : []);
    renderItems(skipEl, order.skip || []);
    suggestionDetail.classList.remove('hidden');
    loggedDetail.classList.add('hidden');
  }
}

// Re-render an already-saved/logged order from the in-memory row — no network
// call, no recompute. Surfaces status, the matching order_data shape, and the
// status-appropriate controls (mark-ordered / rating / notes).
function renderSavedOrder(row) {
  currentOrder = null;
  viewingSavedId = row.id;

  // order_data carries the body; restaurant/location/cuisine live alongside it.
  const order = { restaurant: row.restaurant, ...(row.order_data || {}) };
  renderHeader(order);
  savedNote.classList.remove('hidden');
  fallbackNote.classList.toggle('hidden', !order.fallback);
  // Source on saved orders reflects how it was originally composed; the catalog
  // cue isn't meaningful here, so keep it hidden.
  cacheCue.classList.add('hidden');
  renderOrderDetail(order);
  result.classList.remove('hidden');

  const ordered = row.status === 'ordered';

  // Status badge + ordered date.
  statusBadge.className = 'status-badge ' + (ordered ? 'ordered' : 'suggested');
  statusBadge.textContent = ordered ? 'Ordered' : 'Suggested';
  orderedOn.textContent = ordered && row.ordered_at
    ? `on ${new Date(row.ordered_at).toLocaleDateString()}`
    : '';
  resultStatusLine.classList.remove('hidden');

  // Already saved — don't offer to save again, but allow deleting it.
  saveBtn.classList.add('hidden');
  deleteBtn.classList.remove('hidden');
  deleteBtn.disabled = false;
  deleteBtn.textContent = 'Delete';

  // A suggestion can be marked ordered; an ordered entry gets rating + notes.
  markOrderedBtn.classList.toggle('hidden', ordered);
  markOrderedBtn.disabled = false;

  if (ordered) {
    renderRatingControl(row.id, row.rating);
    ratingControl.classList.remove('hidden');
    notesInput.value = row.notes || '';
    notesStatus.textContent = '';
    notesBlock.classList.remove('hidden');
  } else {
    ratingControl.classList.add('hidden');
    notesBlock.classList.add('hidden');
  }

  saveStatus.textContent = '';
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// --- Save + list -----------------------------------------------------------

saveBtn.addEventListener('click', async () => {
  if (!currentOrder) return;
  saveBtn.disabled = true;
  saveStatus.textContent = 'Saving…';
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant: currentOrder.restaurant, order: currentOrder }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      saveStatus.textContent = error || 'Could not save.';
      saveBtn.disabled = false;
      return;
    }
    saveStatus.textContent = 'Saved!';
    await loadSaved();
  } catch (err) {
    saveStatus.textContent = 'Could not save.';
    saveBtn.disabled = false;
    console.error(err);
  }
});

deleteBtn.addEventListener('click', async () => {
  if (viewingSavedId == null) return;
  if (!confirm('Delete this saved order?')) return;
  deleteBtn.disabled = true;
  saveStatus.textContent = 'Deleting…';
  try {
    const res = await fetch(`/api/orders/${viewingSavedId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      const { error } = await res.json().catch(() => ({}));
      saveStatus.textContent = error || 'Could not delete.';
      deleteBtn.disabled = false;
      return;
    }
    // It's gone — refresh the list and close the revisit view.
    viewingSavedId = null;
    result.classList.add('hidden');
    await loadSaved();
  } catch (err) {
    saveStatus.textContent = 'Could not delete.';
    deleteBtn.disabled = false;
    console.error(err);
  }
});

// Persist a rating, then update in-memory state + re-render the control and the
// matching list row — no full refetch.
async function rateOrder(id, rating) {
  try {
    const res = await fetch(`/api/orders/${id}/rating`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      saveStatus.textContent = error || 'Could not save rating.';
      return;
    }
    const row = savedOrders.find((o) => o.id === id);
    if (row) row.rating = rating;
    // Re-render the live control (if still viewing this one) and the list row.
    if (viewingSavedId === id) renderRatingControl(id, rating);
    renderSavedList();
  } catch (err) {
    saveStatus.textContent = 'Could not save rating.';
    console.error(err);
  }
}

// Promote a saved suggestion to "ordered", then re-render the revisit view
// (which now reveals the rating + notes) and the list.
markOrderedBtn.addEventListener('click', async () => {
  if (viewingSavedId == null) return;
  markOrderedBtn.disabled = true;
  saveStatus.textContent = 'Marking as ordered…';
  try {
    const res = await fetch(`/api/orders/${viewingSavedId}/mark-ordered`, { method: 'PATCH' });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      saveStatus.textContent = error || 'Could not update.';
      markOrderedBtn.disabled = false;
      return;
    }
    const row = savedOrders.find((o) => o.id === viewingSavedId);
    if (row) {
      row.status = 'ordered';
      if (!row.ordered_at) row.ordered_at = new Date().toISOString();
      renderSavedOrder(row);
    }
    renderSavedList();
  } catch (err) {
    saveStatus.textContent = 'Could not update.';
    markOrderedBtn.disabled = false;
    console.error(err);
  }
});

// Save edited notes on an ordered entry.
notesSaveBtn.addEventListener('click', async () => {
  if (viewingSavedId == null) return;
  const notes = notesInput.value;
  notesSaveBtn.disabled = true;
  notesStatus.textContent = 'Saving…';
  try {
    const res = await fetch(`/api/orders/${viewingSavedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      notesStatus.textContent = error || 'Could not save notes.';
      notesSaveBtn.disabled = false;
      return;
    }
    const row = savedOrders.find((o) => o.id === viewingSavedId);
    if (row) row.notes = notes;
    notesStatus.textContent = 'Saved!';
    notesSaveBtn.disabled = false;
    renderSavedList();
  } catch (err) {
    notesStatus.textContent = 'Could not save notes.';
    notesSaveBtn.disabled = false;
    console.error(err);
  }
});

// Manual "Log an order": items textarea → one trimmed item per line → array.
logForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const restaurant = logRestaurant.value.trim();
  const items = logItems.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!restaurant || items.length === 0) {
    logStatus.textContent = 'Add a restaurant and at least one item.';
    return;
  }

  const body = { restaurant, items };
  if (logDate.value) body.ordered_at = logDate.value; // YYYY-MM-DD
  const notes = logNotes.value.trim();
  if (notes) body.notes = notes;

  logBtn.disabled = true;
  logStatus.textContent = 'Logging…';
  try {
    const res = await fetch('/api/orders/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      logStatus.textContent = error || 'Could not log order.';
      logBtn.disabled = false;
      return;
    }
    logStatus.textContent = 'Logged!';
    logForm.reset();
    setLogDateToday();
    logBtn.disabled = false;
    await loadSaved();
  } catch (err) {
    logStatus.textContent = 'Could not log order.';
    logBtn.disabled = false;
    console.error(err);
  }
});

// Default the log-form date to today (local).
function setLogDateToday() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  logDate.value = local.toISOString().slice(0, 10);
}

// Short, plain-text item-count summary for a list row, matching its shape.
function itemSummary(data = {}) {
  if (Array.isArray(data.items)) {
    const n = data.items.length;
    return `${n} item${n === 1 ? '' : 's'}`;
  }
  const n = data.must_haves?.length ?? 0;
  return `${n} must-have${n === 1 ? '' : 's'}`;
}

// Escape user-supplied text before dropping it into innerHTML (notes snippet).
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Render the saved/logged list straight from in-memory savedOrders — no network.
function renderSavedList() {
  savedList.innerHTML = '';
  savedEmpty.classList.toggle('hidden', savedOrders.length > 0);
  for (const row of savedOrders) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'saved-row';

    const ordered = row.status === 'ordered';
    const badgeClass = ordered ? 'ordered' : 'suggested';
    const badgeText = ordered ? 'Ordered' : 'Suggested';
    const when = ordered && row.ordered_at
      ? new Date(row.ordered_at).toLocaleDateString()
      : new Date(row.created_at).toLocaleDateString();
    const rating = ordered ? ratingDisplay(row.rating) : '';
    const notes = (row.notes || '').trim();
    const snippet = notes.length > 80 ? notes.slice(0, 80) + '…' : notes;

    btn.innerHTML =
      `<span class="saved-restaurant">${escapeHtml(row.restaurant)}</span> ` +
      `<span class="status-badge ${badgeClass}">${badgeText}</span>` +
      `<div class="saved-meta">${itemSummary(row.order_data)} · ${when}</div>` +
      (rating ? `<div class="saved-rating">${rating}</div>` : '') +
      (snippet ? `<div class="saved-notes">“${escapeHtml(snippet)}”</div>` : '');

    // Render from the row we already have — no network call, no recompute.
    btn.addEventListener('click', () => renderSavedOrder(row));
    li.appendChild(btn);
    savedList.appendChild(li);
  }
}

async function loadSaved() {
  // Saved/logged orders are per-user — skip the call entirely when logged out.
  if (!isLoggedIn()) {
    savedOrders = [];
    return;
  }
  try {
    const res = await fetch('/api/orders');
    if (!res.ok) {
      // 401 (or anything else) → treat as no list; never crash the page.
      savedOrders = [];
      renderSavedList();
      return;
    }
    savedOrders = await res.json();
    renderSavedList();
  } catch (err) {
    console.error('Could not load saved orders', err);
  }
}

// --- Auth ------------------------------------------------------------------

// Show/hide the controls that require login. The suggestion flow stays open to
// everyone; only saving, the list, logging, and rating are gated.
function applyAuthGate() {
  const inn = isLoggedIn();
  // Saved/logged pane vs. the gentle sign-in prompt.
  savedPane.classList.toggle('hidden', !inn);
  authGate.classList.toggle('hidden', inn);
  // If a fresh order is on screen, refresh its Save button gating.
  if (currentOrder) {
    if (inn) {
      saveBtn.disabled = false;
      saveStatus.textContent = '';
    } else {
      saveBtn.disabled = true;
      saveStatus.innerHTML = '<a href="/auth/login" class="auth-link">Sign in</a> to save & log orders.';
    }
  }
}

// Fetch login state, set currentUser, update the auth bar + gating. The links
// are plain anchors to /auth/login and /auth/logout (server handles the
// redirect), so they work even if this fetch fails — we default to logged out.
async function loadAuth() {
  let user = null;
  try {
    const res = await fetch('/api/me');
    if (res.ok) ({ user } = await res.json());
  } catch (err) {
    console.error('Could not load auth state', err);
  }
  currentUser = user || null;

  if (currentUser) {
    userName.textContent = currentUser.name || currentUser.email || '';
    userInfo.classList.remove('hidden');
    signinLink.classList.add('hidden');
  } else {
    signinLink.classList.remove('hidden');
    userInfo.classList.add('hidden');
  }
  applyAuthGate();
}

// Auth must resolve before loadSaved (which is per-user and skips when logged
// out). Chain them; render the empty list either way.
setLogDateToday();
loadAuth().then(loadSaved);
