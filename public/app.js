const form = document.getElementById('compose-form');
const restaurantInput = document.getElementById('restaurant');
const findBtn = document.getElementById('find-btn');
const findStatus = document.getElementById('find-status');

const confirmSection = document.getElementById('confirm');
const candidateList = document.getElementById('candidate-list');

const result = document.getElementById('result');
const resultTitle = document.getElementById('result-title');
const fallbackNote = document.getElementById('fallback-note');
const mustHavesEl = document.getElementById('must-haves');
const adventurousEl = document.getElementById('adventurous');
const skipEl = document.getElementById('skip');

const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

const savedList = document.getElementById('saved-list');
const savedEmpty = document.getElementById('saved-empty');

// Holds the most recently generated order so "Save" knows what to persist.
let currentOrder = null;

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
  findStatus.textContent = 'Composing your order — reading the menu (this can take ~30–45s)…';

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

function renderOrder(order) {
  currentOrder = order;
  resultTitle.textContent = order.restaurant;
  fallbackNote.classList.toggle('hidden', !order.fallback);
  renderItems(mustHavesEl, order.must_haves);
  renderItems(adventurousEl, [order.adventurous]);
  renderItems(skipEl, order.skip);
  result.classList.remove('hidden');
  saveBtn.disabled = false;
  saveStatus.textContent = '';
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

async function loadSaved() {
  try {
    const res = await fetch('/api/orders');
    const orders = await res.json();
    savedList.innerHTML = '';
    savedEmpty.classList.toggle('hidden', orders.length > 0);
    for (const row of orders) {
      const li = document.createElement('li');
      const when = new Date(row.created_at).toLocaleString();
      const count = row.order_data?.must_haves?.length ?? 0;
      li.innerHTML =
        `<span class="saved-restaurant">${row.restaurant}</span>` +
        `<div class="saved-meta">${count} must-have${count === 1 ? '' : 's'} · ${when}</div>`;
      savedList.appendChild(li);
    }
  } catch (err) {
    console.error('Could not load saved orders', err);
  }
}

loadSaved();
