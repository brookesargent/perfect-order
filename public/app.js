const form = document.getElementById('compose-form');
const restaurantInput = document.getElementById('restaurant');
const composeBtn = document.getElementById('compose-btn');

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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const restaurant = restaurantInput.value.trim();
  if (!restaurant) return;

  composeBtn.disabled = true;
  composeBtn.textContent = 'Composing…';
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant }),
    });
    const order = await res.json();
    renderOrder(order);
  } catch (err) {
    saveStatus.textContent = 'Something went wrong. Try again.';
    console.error(err);
  } finally {
    composeBtn.disabled = false;
    composeBtn.textContent = 'Compose my order';
  }
});

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
