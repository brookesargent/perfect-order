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

const ratingControl = document.getElementById('rating-control');
const ratingUnits = document.getElementById('rating-units');

const saveBtn = document.getElementById('save-btn');
const deleteBtn = document.getElementById('delete-btn');
const saveStatus = document.getElementById('save-status');

const savedList = document.getElementById('saved-list');
const savedEmpty = document.getElementById('saved-empty');

// Holds the most recently generated order so "Save" knows what to persist.
let currentOrder = null;
// Saved orders kept in memory so clicking a row re-renders without a network call.
let savedOrders = [];
// The id of the saved order currently shown in the revisit view, so Delete
// knows which row to remove. null when viewing a fresh (unsaved) order.
let viewingSavedId = null;

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
    const res = await fetch('/api/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const { candidates } = await res.json();
    renderCandidates(candidates || []);
    findStatus.textContent = '';
  } catch (err) {
    findStatus.textContent = 'Search failed. Try again.';
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
  // Grounded candidates come from the catalog and compose from cache (instant),
  // so skip the long-wait status for them. Anything else means a web search.
  findStatus.textContent = candidate.grounded
    ? 'Pulling your order from the catalog…'
    : 'Composing your order — reading the menu (this can take ~30–45s)…';

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant: candidate }),
    });
    const order = await res.json();
    renderOrder(order);
    findStatus.textContent = '';
  } catch (err) {
    findStatus.textContent = 'Could not compose an order. Try again.';
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
  renderItems(mustHavesEl, order.must_haves || []);
  renderItems(adventurousEl, order.adventurous ? [order.adventurous] : []);
  renderItems(skipEl, order.skip || []);
  result.classList.remove('hidden');
  // Fresh order: offer to save it, and never delete (nothing saved to delete).
  saveBtn.classList.remove('hidden');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save this order';
  deleteBtn.classList.add('hidden');
  // Rating only applies to saved orders — hide it in the fresh-compose view.
  ratingControl.classList.add('hidden');
  saveStatus.textContent = '';
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Re-render an already-saved order from its stored order_data — no network call,
// no recompute. Makes clear this is a saved view and doesn't offer to re-save.
// `rating` is a saved_orders column (not part of order_data); may be null.
function renderSavedOrder(id, order, rating) {
  currentOrder = null;
  viewingSavedId = id;
  renderHeader(order);
  savedNote.classList.remove('hidden');
  fallbackNote.classList.toggle('hidden', !order.fallback);
  // Source on saved orders reflects how it was originally composed; the catalog
  // cue isn't meaningful here, so keep it hidden.
  cacheCue.classList.add('hidden');
  renderItems(mustHavesEl, order.must_haves || []);
  renderItems(adventurousEl, order.adventurous ? [order.adventurous] : []);
  renderItems(skipEl, order.skip || []);
  result.classList.remove('hidden');
  // Already saved — don't offer to save again, but allow deleting it.
  saveBtn.classList.add('hidden');
  deleteBtn.classList.remove('hidden');
  deleteBtn.disabled = false;
  deleteBtn.textContent = 'Delete';
  // Interactive rating reflects the current saved value (null = unrated).
  renderRatingControl(id, rating);
  ratingControl.classList.remove('hidden');
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

// Render the saved-orders list straight from in-memory savedOrders — no network.
function renderSavedList() {
  savedList.innerHTML = '';
  savedEmpty.classList.toggle('hidden', savedOrders.length > 0);
  for (const row of savedOrders) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'saved-row';
    const when = new Date(row.created_at).toLocaleString();
    const count = row.order_data?.must_haves?.length ?? 0;
    const rating = ratingDisplay(row.rating);
    btn.innerHTML =
      `<span class="saved-restaurant">${row.restaurant}</span>` +
      `<div class="saved-meta">${count} must-have${count === 1 ? '' : 's'} · ${when}</div>` +
      (rating ? `<div class="saved-rating">${rating}</div>` : '');
    // Render from the order_data we already have — no network call, no recompute.
    // Fall back to the row's restaurant name in case order_data lacks one.
    btn.addEventListener('click', () =>
      renderSavedOrder(row.id, { restaurant: row.restaurant, ...(row.order_data || {}) }, row.rating)
    );
    li.appendChild(btn);
    savedList.appendChild(li);
  }
}

async function loadSaved() {
  try {
    const res = await fetch('/api/orders');
    savedOrders = await res.json();
    renderSavedList();
  } catch (err) {
    console.error('Could not load saved orders', err);
  }
}

loadSaved();
