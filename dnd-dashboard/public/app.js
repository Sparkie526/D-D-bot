// ============================================================
//  D&D Campaign Dashboard — Client
// ============================================================

const socket = io();

let gameState     = null;
let activePlayers = []; // discordIds currently logged in
let myDiscordId   = localStorage.getItem('dnd_discord_id');
let isObserver    = localStorage.getItem('dnd_observer') === 'true';

// ── Connection status ────────────────────────────────────────
const dot = document.getElementById('connectionDot');

socket.on('connect',    () => { dot.className = 'connection-dot connected';    dot.title = 'Connected'; });
socket.on('disconnect', () => { dot.className = 'connection-dot disconnected'; dot.title = 'Disconnected'; });

// ── Socket events ────────────────────────────────────────────

socket.on('state_update', (state) => {
  const prev = gameState;
  gameState = state;
  handleIdentityCheck();
  renderAll();
  checkHpChanges(prev, state);
  checkInventoryChanges(prev, state);
  refreshArsenalModal();
});

socket.on('story_entry', (entry) => {
  if (!gameState) return;
  gameState.storyFeed.push(entry);
  appendStoryEntry(entry);
});

socket.on('dice_entry', (entry) => {
  if (!gameState) return;
  gameState.diceLog.unshift(entry);
  renderDiceLog();
  showDiceAnimation(entry);
});

socket.on('token_move', ({ id, x, y }) => {
  if (!gameState) return;
  const token = gameState.tokens?.find(t => t.id === id);
  if (token) { token.x = x; token.y = y; }
  const overlay = document.getElementById('tokensOverlay');
  const el      = overlay?.querySelector(`.map-token[data-id="${id}"]`);
  if (el) positionToken(el, x, y);
});

socket.on('active_players', (ids) => {
  activePlayers = ids;
  renderTokens();
  renderPlayers();
});

// ── Identity check ───────────────────────────────────────────

function handleIdentityCheck() {
  if (myDiscordId || isObserver) {
    showApp();
  } else {
    renderIdentityList();
  }
}

let mapPanSetup = false;
function showApp() {
  document.getElementById('identityOverlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  if (!mapPanSetup) { setupMapPan(); mapPanSetup = true; }
  if (myDiscordId) {
    if (!activePlayers.includes(myDiscordId)) activePlayers.push(myDiscordId);
    socket.emit('player_active', myDiscordId);
  }
}

function renderIdentityList() {
  const list    = document.getElementById('identityList');
  const players = Object.values(gameState?.players || {});

  const playerBtns = players.length
    ? players.map(p => `
        <div class="identity-row">
          <button class="identity-btn" onclick="selectIdentity('${esc(p.discordId)}', '${esc(p.characterName)}')">
            <span class="ib-name">${esc(p.characterName)}</span>
            <span class="ib-info">${esc(p.class)} · Level ${p.level}</span>
          </button>
          <button class="identity-delete-btn" onclick="deleteCharacter('${esc(p.discordId)}', '${esc(p.characterName)}')" title="Delete character">✕</button>
        </div>`).join('')
    : '<p class="waiting-text">No characters yet — create one below or ask the DM to type <code>!register</code> in Discord.</p>';

  list.innerHTML = `
    ${playerBtns}
    <div class="identity-divider"></div>
    <button class="identity-btn new-char-btn" onclick="showCreateCharForm()">
      <span class="ib-name">+ Create New Character</span>
      <span class="ib-info">Add yourself to this session</span>
    </button>
    <div class="create-char-form hidden" id="createCharForm">
      <input class="create-char-input" id="ccName"        type="text" placeholder="Character name (e.g. Aldric the Bold)" maxlength="40">
      <input class="create-char-input" id="ccPlayerName"  type="text" placeholder="Your name / Discord username" maxlength="40">
      <div class="create-char-hint">
        Tip: if you want Discord commands like <code>!hp</code> to sync, enter your exact Discord display name.
      </div>
      <button class="create-char-submit" onclick="submitCreateChar()">Enter the Hall</button>
    </div>
  `;
}

function showCreateCharForm() {
  const form = document.getElementById('createCharForm');
  if (form) form.classList.toggle('hidden');
}

async function submitCreateChar() {
  const nameInput   = document.getElementById('ccName');
  const playerInput = document.getElementById('ccPlayerName');
  const charName    = nameInput?.value.trim();
  const playerName  = playerInput?.value.trim();

  if (!charName) { nameInput?.focus(); nameInput?.classList.add('input-error'); return; }
  nameInput?.classList.remove('input-error');

  // Generate a local ID — prefixed so it's distinguishable from real Discord IDs
  const localId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

  try {
    const res = await fetch('/api/player/new', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ discordId: localId, discordName: playerName || charName, characterName: charName }),
    });
    if (!res.ok) throw new Error('Create failed');
    selectIdentity(localId, charName);
  } catch (err) {
    alert('Could not create character. Is the server running?');
    console.error(err);
  }
}

async function deleteCharacter(discordId, charName) {
  if (!confirm(`Remove "${charName}" from this session?`)) return;
  try {
    const res = await fetch(`/api/player/${discordId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    // If this was the logged-in character, log out too
    if (myDiscordId === discordId) logout();
  } catch (err) {
    alert('Could not delete character. Is the server running?');
    console.error(err);
  }
}

function selectIdentity(discordId, charName) {
  myDiscordId = discordId;
  isObserver  = false;
  localStorage.setItem('dnd_discord_id', discordId);
  localStorage.removeItem('dnd_observer');
  // Update locally immediately — don't wait for server round-trip
  if (!activePlayers.includes(discordId)) activePlayers.push(discordId);
  socket.emit('player_active', discordId);
  showApp();
  updateMyCharBtn();
  // Force full token overlay rebuild so drag handlers attach to this player's tokens
  clearTokenOverlay();
  renderTokens();
  renderPlayers();
}

function selectObserver() {
  isObserver  = true;
  myDiscordId = null;
  localStorage.setItem('dnd_observer', 'true');
  localStorage.removeItem('dnd_discord_id');
  showApp();
}

function logout() {
  socket.emit('player_inactive', myDiscordId);
  // Remove locally immediately
  activePlayers = activePlayers.filter(id => id !== myDiscordId);
  renderTokens();
  myDiscordId = null;
  isObserver  = false;
  localStorage.removeItem('dnd_discord_id');
  localStorage.removeItem('dnd_observer');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('identityOverlay').classList.remove('hidden');
  renderIdentityList();
}

// ── Render all ───────────────────────────────────────────────

function renderAll() {
  renderLocation();
  renderStoryFeed();
  renderDiceLog();
  renderPlayers();
  renderTokens();
  updateMyCharBtn();
}

// ── Location ─────────────────────────────────────────────────

function renderLocation() {
  if (!gameState) return;
  const loc = gameState.location;
  document.getElementById('locationName').textContent   = loc.name        || 'Unknown Lands';
  document.getElementById('locationDesc').textContent   = loc.description || '';
  document.getElementById('headerLocation').textContent = `— ${loc.name || 'Unknown Lands'} —`;

  const img         = document.getElementById('mapImage');
  const placeholder = document.getElementById('mapPlaceholder');
  if (loc.mapImage) {
    img.src = loc.mapImage;
    img.classList.remove('hidden');
    placeholder.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    placeholder.classList.remove('hidden');
  }
}

// ── Tokens ───────────────────────────────────────────────────

// ── Map zoom / pan / token-scale state ───────────────────────
let mapZoom  = 1.0;
let panX     = 0;
let panY     = 0;
const ZOOM_STEP = 0.25;
const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 3.0;

let tokenScale   = 1.0;
const TOKEN_STEP = 0.25;
const TOKEN_MIN  = 0.5;
const TOKEN_MAX  = 2.5;

function applyMapTransform() {
  const stage = document.getElementById('mapZoomWrapper');
  if (stage) stage.style.transform = `translate(${panX}px, ${panY}px) scale(${mapZoom})`;
  const label = document.getElementById('mapZoomLabel');
  if (label) label.textContent = mapZoom.toFixed(2).replace(/\.?0+$/, '') + '×';
}

function zoomIn()    { zoomToward(mapZoom + ZOOM_STEP); }
function zoomOut()   { zoomToward(mapZoom - ZOOM_STEP); }
function resetZoom() { mapZoom = 1.0; panX = 0; panY = 0; applyMapTransform(); }

// Zoom toward the center of the map container
function zoomToward(newZoom, pivotX, pivotY) {
  newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(newZoom * 100) / 100));
  const container = document.getElementById('mapContainer');
  if (container && pivotX == null) {
    const r = container.getBoundingClientRect();
    pivotX = r.width  / 2;
    pivotY = r.height / 2;
  }
  // Keep the stage point under the pivot fixed
  const stageX = (pivotX - panX) / mapZoom;
  const stageY = (pivotY - panY) / mapZoom;
  mapZoom = newZoom;
  panX = pivotX - stageX * mapZoom;
  panY = pivotY - stageY * mapZoom;
  applyMapTransform();
}

// Set up map panning (drag on empty map) + mouse-wheel zoom
function setupMapPan() {
  const container = document.getElementById('mapContainer');
  if (!container) return;

  let panning = false, px0 = 0, py0 = 0, panX0 = 0, panY0 = 0;

  const panStart = (cx, cy, target) => {
    if (target.closest('.map-token') || target.closest('.map-toolbar')) return;
    panning = true;
    px0 = cx; py0 = cy; panX0 = panX; panY0 = panY;
    container.style.cursor = 'grabbing';
  };
  const panMove = (cx, cy) => {
    if (!panning) return;
    panX = panX0 + (cx - px0);
    panY = panY0 + (cy - py0);
    applyMapTransform();
  };
  const panEnd = () => { panning = false; container.style.cursor = ''; };

  container.addEventListener('mousedown',  e => panStart(e.clientX, e.clientY, e.target));
  window.addEventListener(   'mousemove',  e => panMove(e.clientX, e.clientY));
  window.addEventListener(   'mouseup',    panEnd);

  container.addEventListener('touchstart', e => {
    if (e.touches.length === 1) panStart(e.touches[0].clientX, e.touches[0].clientY, e.target);
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (e.touches.length === 1) panMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  window.addEventListener('touchend', panEnd);

  // Scroll wheel zooms toward the cursor
  container.addEventListener('wheel', e => {
    e.preventDefault();
    const r      = container.getBoundingClientRect();
    const pivotX = e.clientX - r.left;
    const pivotY = e.clientY - r.top;
    const delta  = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    zoomToward(mapZoom + delta, pivotX, pivotY);
  }, { passive: false });
}

function tokenSizeUp()   { setTokenScale(tokenScale + TOKEN_STEP); }
function tokenSizeDown() { setTokenScale(tokenScale - TOKEN_STEP); }
function setTokenScale(val) {
  tokenScale = Math.min(TOKEN_MAX, Math.max(TOKEN_MIN, Math.round(val * 100) / 100));
  clearTokenOverlay();
  renderTokens();
}

// Token modal state
let tkType  = 'shape';
let tkShape = 'circle';
let tkColor = '#c0392b';
let tkImageUrl = '';

function openAddTokenModal() {
  // Pre-fill label from current player's character name
  if (myDiscordId && gameState?.players[myDiscordId]) {
    const name = gameState.players[myDiscordId].characterName || '';
    document.getElementById('tkLabel').value = name;
  }
  tkType  = 'shape';
  tkShape = 'circle';
  tkColor = '#c0392b';
  tkImageUrl = '';
  setTokenType('shape');
  updateTokenPreview();
  document.getElementById('tokenModal').classList.remove('hidden');
}

function closeAddTokenModal() {
  document.getElementById('tokenModal').classList.add('hidden');
}

function setTokenType(type) {
  tkType = type;
  document.getElementById('tkTypeShape').classList.toggle('active', type === 'shape');
  document.getElementById('tkTypeImage').classList.toggle('active', type === 'image');
  document.getElementById('tkShapeSection').classList.toggle('hidden', type === 'image');
  document.getElementById('tkImageSection').classList.toggle('hidden', type === 'shape');
  updateTokenPreview();
}

function setTokenShape(shape) {
  tkShape = shape;
  document.querySelectorAll('.token-shape-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tk' + shape.charAt(0).toUpperCase() + shape.slice(1))?.classList.add('active');
  updateTokenPreview();
}

function setTokenColor(btn) {
  tkColor = btn.dataset.color;
  document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tkColorCustom').value = tkColor;
  updateTokenPreview();
}

function setTokenColorHex(hex) {
  tkColor = hex;
  document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
  updateTokenPreview();
}

async function handleTokenImageFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append('map', file);
  try {
    const res  = await fetch('/api/upload/map', { method: 'POST', body: form });
    const data = await res.json();
    if (data.url) {
      tkImageUrl = data.url;
      document.getElementById('tkImageUrl').value = tkImageUrl;
      updateTokenPreview();
    }
  } catch (e) { console.error('Token image upload failed', e); }
  input.value = '';
}

function updateTokenPreview() {
  const label    = document.getElementById('tkLabel')?.value || '?';
  const imageUrl = tkType === 'image' ? (document.getElementById('tkImageUrl')?.value || tkImageUrl) : '';
  const wrap     = document.getElementById('tkPreview');
  if (wrap) wrap.innerHTML = buildTokenHtml({ label, type: tkType, shape: tkShape, color: tkColor, image: imageUrl }, true);
}

// Wire up modal preview inputs and backdrop close
document.addEventListener('input', (e) => {
  if (e.target.id === 'tkLabel' || e.target.id === 'tkImageUrl') {
    if (e.target.id === 'tkImageUrl') tkImageUrl = e.target.value;
    updateTokenPreview();
  }
});
document.getElementById('tokenModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('tokenModal')) closeAddTokenModal();
});

async function placeToken() {
  if (!myDiscordId) { alert('Select your character first.'); return; }
  const label    = document.getElementById('tkLabel')?.value.trim() || 'Token';
  const imageUrl = tkType === 'image' ? (document.getElementById('tkImageUrl')?.value.trim() || tkImageUrl) : '';
  const tokenId  = myDiscordId + '_' + Date.now();

  await fetch('/api/tokens', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id:    tokenId,
      label,
      type:  tkType,
      shape: tkShape,
      color: tkColor,
      image: imageUrl || null,
      x:     0.5,
      y:     0.5,
      owner: myDiscordId,
    }),
  });
  closeAddTokenModal();
}

async function removeToken(id, event) {
  event?.stopPropagation();
  await fetch(`/api/tokens/${id}`, { method: 'DELETE' });
}

function clearTokenOverlay() {
  const overlay = document.getElementById('tokensOverlay');
  if (overlay) overlay.innerHTML = '';
}

// Render all tokens from state — only show tokens whose owner is currently active
function renderTokens() {
  if (!gameState) return;
  const overlay = document.getElementById('tokensOverlay');
  if (!overlay) return;

  // Visible tokens: owner is active, or token has no owner
  const visibleTokens = (gameState.tokens || []).filter(t =>
    !t.owner || activePlayers.includes(t.owner)
  );
  const visibleIds = new Set(visibleTokens.map(t => t.id));

  // Remove elements for tokens that are no longer visible
  overlay.querySelectorAll('.map-token').forEach(el => {
    if (!visibleIds.has(el.dataset.id)) el.remove();
  });

  visibleTokens.forEach(token => {
    let el = overlay.querySelector(`.map-token[data-id="${token.id}"]`);
    if (!el) {
      el = createTokenElement(token);
      overlay.appendChild(el);
    }
    positionToken(el, token.x, token.y);
    el.querySelector('.token-inner').innerHTML = buildTokenHtml(token, false);
  });
}

function createTokenElement(token) {
  const el = document.createElement('div');
  el.className  = 'map-token';
  el.dataset.id = token.id;
  el.innerHTML  = `
    <div class="token-inner">${buildTokenHtml(token, false)}</div>
    ${token.owner === myDiscordId ? `<button class="token-remove-btn" onclick="removeToken('${esc(token.id)}', event)" title="Remove">✕</button>` : ''}
  `;
  makeDraggable(el, token);
  return el;
}

// Always use offsetWidth/Height — these are the natural (pre-zoom) dimensions
function positionToken(el, x, y) {
  const overlay = document.getElementById('tokensOverlay');
  if (!overlay) return;
  const half = Math.round(22 * tokenScale);
  el.style.left = `${x * overlay.offsetWidth  - half}px`;
  el.style.top  = `${y * overlay.offsetHeight - half}px`;
}

function buildTokenHtml(token, isPreview) {
  const label    = token.label || '?';
  const initials = label.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const base     = isPreview ? 52 : 44;
  const size     = isPreview ? base : Math.round(base * tokenScale);

  if (token.image) {
    return `
      <div class="token-body token-body-image" style="width:${size}px;height:${size}px;border-color:${token.color || '#8b1a1a'}">
        <img src="${esc(token.image)}" alt="${esc(label)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;font-family:'Cinzel',serif;font-size:${size*0.3}px;color:#f0e6c8">${esc(initials)}</span>
      </div>
      <div class="token-label">${esc(label)}</div>`;
  }

  const shape  = token.shape || 'circle';
  const radius = shape === 'circle' ? '50%' : shape === 'diamond' ? '4px' : '4px';
  const rotate = shape === 'diamond' ? 'rotate(45deg)' : 'none';

  return `
    <div class="token-body token-body-shape" style="width:${size}px;height:${size}px;background:${token.color};border-radius:${radius};transform:${rotate}">
      <span class="token-initials" style="transform:${shape === 'diamond' ? 'rotate(-45deg)' : 'none'};font-size:${size*0.3}px">${esc(initials)}</span>
    </div>
    <div class="token-label">${esc(label)}</div>`;
}

// Drag-and-drop for tokens
function makeDraggable(el, token) {
  if (token.owner !== myDiscordId) return;

  let dragging = false;
  let offsetX  = 0, offsetY = 0;

  // Convert a client (screen) coordinate into unscaled stage-local coordinates
  function toStageLocal(cx, cy) {
    const stage = document.getElementById('mapZoomWrapper');
    const r     = stage.getBoundingClientRect();
    return { x: (cx - r.left) / mapZoom, y: (cy - r.top) / mapZoom };
  }

  const onStart = (e) => {
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    el.classList.add('dragging');
    const cx    = e.touches ? e.touches[0].clientX : e.clientX;
    const cy    = e.touches ? e.touches[0].clientY : e.clientY;
    const local = toStageLocal(cx, cy);
    offsetX = local.x - parseFloat(el.style.left || 0);
    offsetY = local.y - parseFloat(el.style.top  || 0);
    e.stopPropagation(); // prevent map pan starting under the token
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!dragging) return;
    const cx    = e.touches ? e.touches[0].clientX : e.clientX;
    const cy    = e.touches ? e.touches[0].clientY : e.clientY;
    const local = toStageLocal(cx, cy);
    el.style.left = `${local.x - offsetX}px`;
    el.style.top  = `${local.y - offsetY}px`;
    e.preventDefault();
  };

  const onEnd = async () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    // Use natural (offsetWidth) dimensions — unaffected by CSS transform
    const overlay = document.getElementById('tokensOverlay');
    const half    = Math.round(22 * tokenScale);
    const x       = Math.max(0, Math.min(1, (parseFloat(el.style.left) + half) / overlay.offsetWidth));
    const y       = Math.max(0, Math.min(1, (parseFloat(el.style.top)  + half) / overlay.offsetHeight));
    const t       = gameState.tokens?.find(t => t.id === token.id);
    if (t) { t.x = x; t.y = y; }
    await fetch(`/api/tokens/${token.id}/move`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ x, y }),
    });
  };

  el.addEventListener('mousedown',  onStart);
  el.addEventListener('touchstart', onStart, { passive: false });
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('touchmove',  onMove, { passive: false });
  window.addEventListener('mouseup',    onEnd);
  window.addEventListener('touchend',   onEnd);
}

// Reposition all tokens when window resizes
window.addEventListener('resize', () => {
  if (!gameState) return;
  const overlay = document.getElementById('tokensOverlay');
  if (!overlay) return;
  (gameState.tokens || []).forEach(token => {
    const el = overlay.querySelector(`.map-token[data-id="${token.id}"]`);
    if (el) positionToken(el, token.x, token.y);
  });
});

// ── Map upload ───────────────────────────────────────────────

function triggerMapUpload() {
  document.getElementById('mapFileInput')?.click();
}

async function clearMap() {
  if (!confirm('Remove the current map?')) return;
  await fetch('/api/location', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ mapImage: null }),
  });
}

async function handleMapFile(input) {
  const file = input.files?.[0];
  if (!file) return;

  const btn = document.getElementById('mapUploadBtn');
  if (btn) { btn.textContent = 'Uploading...'; btn.disabled = true; }

  try {
    const form = new FormData();
    form.append('map', file);
    const res = await fetch('/api/upload/map', { method: 'POST', body: form });
    if (!res.ok) throw new Error('Upload failed');
  } catch (err) {
    alert('Map upload failed. Is the server running?');
    console.error(err);
  } finally {
    if (btn) { btn.textContent = '🗺 Upload Map'; btn.disabled = false; }
    input.value = '';
  }
}

// ── Story feed ───────────────────────────────────────────────

async function clearStoryFeed() {
  if (!confirm('Clear the entire Story Chronicle? This cannot be undone.')) return;
  await fetch('/api/story', { method: 'DELETE' });
}

function renderStoryFeed() {
  if (!gameState) return;
  const feed = document.getElementById('storyFeed');
  feed.innerHTML = '';
  gameState.storyFeed.forEach(entry => feed.appendChild(buildStoryEntry(entry)));
  feed.scrollTop = feed.scrollHeight;
}

function buildStoryEntry(entry) {
  const div  = document.createElement('div');
  div.className = `story-entry ${entry.type || 'system'}`;
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `
    <div class="entry-name">${esc(entry.name)}</div>
    <p class="entry-text">${esc(entry.text)}</p>
    <div class="entry-time">${time}</div>
  `;
  return div;
}

function appendStoryEntry(entry) {
  const feed = document.getElementById('storyFeed');
  feed.appendChild(buildStoryEntry(entry));
  feed.scrollTop = feed.scrollHeight;
}

// ── Dice log ─────────────────────────────────────────────────

function renderDiceLog() {
  if (!gameState) return;
  const log     = document.getElementById('diceLog');
  const entries = (gameState.diceLog || []).slice(0, 8);

  if (entries.length === 0) {
    log.innerHTML = '<div class="no-rolls">No dice rolled yet...</div>';
    return;
  }

  log.innerHTML = entries.map(entry => {
    const isNat20 = entry.dice === '1d20' && entry.total === 20;
    const isNat1  = entry.dice === '1d20' && entry.total === 1;
    const cls     = isNat20 ? 'nat20' : isNat1 ? 'nat1' : '';
    const suffix  = isNat20 ? ' ✦' : isNat1 ? ' ✗' : '';
    const indiv   = entry.rolls?.length > 1 ? ` <span class="dice-individual">[${entry.rolls.join(', ')}]</span>` : '';
    return `
      <div class="dice-entry">
        <span class="dice-roller">${esc(entry.name)}</span>
        <span class="dice-notation">${esc(entry.dice)}${indiv}</span>
        <span class="dice-result ${cls}">${entry.total}${suffix}</span>
      </div>`;
  }).join('');
}

// ── Players ──────────────────────────────────────────────────

function renderPlayers() {
  if (!gameState) return;
  const container = document.getElementById('playerCards');
  const noPlayers = document.getElementById('noPlayers');

  // Only show players who are currently active in the session
  const players = Object.values(gameState.players)
    .filter(p => activePlayers.includes(p.discordId));

  if (players.length === 0) {
    noPlayers.classList.remove('hidden');
    container.querySelectorAll('.player-card').forEach(c => c.remove());
    return;
  }

  noPlayers.classList.add('hidden');

  const existing = {};
  container.querySelectorAll('.player-card').forEach(c => { existing[c.dataset.id] = c; });

  players.forEach(player => {
    const card = buildPlayerCard(player);
    if (existing[player.discordId]) {
      container.replaceChild(card, existing[player.discordId]);
    } else {
      container.appendChild(card);
    }
    delete existing[player.discordId];
  });

  // Remove cards for players who are no longer active
  Object.values(existing).forEach(c => c.remove());
}

function buildPlayerCard(player) {
  const isMe  = player.discordId === myDiscordId;
  const pct   = player.maxHp > 0 ? Math.max(0, Math.min(1, player.hp / player.maxHp)) : 0;
  const color = hpColor(pct);
  const barW  = Math.round(pct * 100);

  // Active conditions for card badge
  const activeConds = player.conditions
    ? Object.entries(player.conditions)
        .filter(([k, v]) => v === true)
        .map(([k]) => k)
    : [];

  const div        = document.createElement('div');
  div.className    = `player-card${isMe ? ' is-me' : ''}`;
  div.dataset.id   = player.discordId;

  const imgHtml = player.image
    ? `<img src="${esc(player.image)}" alt="${esc(player.characterName)}"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : '';
  const placeholderStyle = player.image ? 'style="display:none"' : '';
  const initial          = (player.characterName || '?').charAt(0).toUpperCase();

  const condHtml = activeConds.length
    ? `<div class="card-conditions">${activeConds.map(c => `<span class="cond-badge-mini">${c}</span>`).join('')}</div>`
    : '';

  div.innerHTML = `
    <div class="player-img-col">
      ${imgHtml}
      <div class="player-img-placeholder" ${placeholderStyle}>${initial}</div>
    </div>
    <div class="player-info-col">
      <div class="player-char-name">
        <span class="player-char-name-text">${esc(player.characterName)}</span>
        ${isMe ? '<span class="player-me-tag">YOU</span>' : ''}
      </div>
      <div class="player-class-level">${esc(player.class)} · Level ${player.level}</div>
      <div class="hp-row">
        <span class="hp-label">HP</span>
        <div class="hp-bar-track">
          <div class="hp-bar-fill" style="width:${barW}%; background:${color}"></div>
        </div>
        <span class="hp-nums">${player.hp}/${player.maxHp}</span>
      </div>
      <div class="player-ac-row">🛡 AC <span class="ac-val">${player.ac}</span></div>
      ${condHtml}
    </div>
    <button class="card-remove-btn" onclick="deleteCharacter('${esc(player.discordId)}', '${esc(player.characterName)}')" title="Remove from game">✕</button>
    <span class="arsenal-btn" data-arsenal-id="${esc(player.discordId)}" onclick="openArsenalModal('${esc(player.discordId)}')" title="View Arsenal">🎒</span>
  `;
  return div;
}

function hpColor(pct) {
  if (pct > 0.5)  return '#2d6b1f';
  if (pct > 0.25) return '#8a7a00';
  return '#8b1a1a';
}

// ── Arsenal Modal ────────────────────────────────────────────

let arsenalOpenId = null;

function openArsenalModal(discordId) {
  arsenalOpenId = discordId;
  renderArsenalModal();
  document.getElementById('arsenalModal').classList.remove('hidden');
}

function closeArsenalModal() {
  arsenalOpenId = null;
  document.getElementById('arsenalModal').classList.add('hidden');
}

function refreshArsenalModal() {
  if (arsenalOpenId) renderArsenalModal();
}

function renderArsenalModal() {
  if (!arsenalOpenId || !gameState) return;
  const p = gameState.players[arsenalOpenId];
  if (!p) { closeArsenalModal(); return; }

  const initial = (p.characterName || '?').charAt(0).toUpperCase();

  // Header
  document.getElementById('arsenalCharName').textContent = p.characterName || 'Unknown';
  document.getElementById('arsenalCharClass').textContent = `${p.class || '—'} · Level ${p.level || 1}`;
  document.getElementById('arsenalInitial').textContent = initial;

  // Weapons
  const weapons = p.weapons || [];
  document.getElementById('arsenalWeapons').innerHTML = weapons.length
    ? weapons.map(w => `
        <div class="arsenal-weapon-row">
          <span class="arsenal-weapon-name">${esc(w.name || 'Unknown')}</span>
          <span class="arsenal-weapon-dmg">${esc(w.damage || '—')}</span>
          <span class="arsenal-weapon-type">${esc(w.damageType || w.type || '')}</span>
          ${w.bonus != null ? `<span class="arsenal-weapon-bonus">${w.bonus >= 0 ? '+' : ''}${w.bonus} atk</span>` : ''}
        </div>`).join('')
    : '<span class="arsenal-none">None</span>';

  // Spells
  const spells = p.spells || [];
  document.getElementById('arsenalSpells').innerHTML = spells.length
    ? spells.map(s => `<span class="arsenal-spell-pill">${esc(s)}</span>`).join('')
    : '<span class="arsenal-none">None</span>';

  // Abilities & Features
  const features = p.features || [];
  document.getElementById('arsenalAbilities').innerHTML = features.length
    ? features.map(f => `
        <div class="arsenal-feature-row">
          <div class="arsenal-feature-name">${esc(f.name || 'Unknown')}${f.uses ? `<span class="arsenal-feature-uses">${f.uses.current}/${f.uses.max}</span>` : ''}</div>
          ${f.description ? `<div class="arsenal-feature-desc">${esc(f.description)}</div>` : ''}
        </div>`).join('')
    : '<span class="arsenal-none">None</span>';

  // Inventory + carry weight
  const inventory = p.inventory || [];
  const { current, max, enc1, enc2 } = carryWeightInfo(p);
  const cwPct   = max ? Math.min(current / max * 100, 100) : 0;
  const cwColor = current > enc2 ? '#c0392b' : current > enc1 ? '#c9a84c' : '#4a9e6b';
  const cwNote  = current > max  ? '⛔ Over capacity'
                : current > enc2 ? '🔴 Heavily Encumbered'
                : current > enc1 ? '🟡 Encumbered'
                : '✅ Within limits';
  const carryHtml = max ? `
    <div class="carry-weight-block arsenal-carry">
      <div class="carry-weight-header">
        <span class="carry-weight-label">⚖ Carry Weight</span>
        <span class="carry-weight-value">${current} / ${max} lbs</span>
      </div>
      <div class="carry-weight-track">
        <div class="carry-weight-fill" style="width:${cwPct}%;background:${cwColor}"></div>
        <div class="carry-weight-thresh" style="left:${enc1/max*100}%"></div>
        <div class="carry-weight-thresh" style="left:${enc2/max*100}%"></div>
      </div>
      <div class="carry-weight-note">${cwNote}</div>
    </div>` : '';
  document.getElementById('arsenalInventory').innerHTML = carryHtml + (inventory.length
    ? inventory.map(item => {
        const wt = invWeight(item);
        return `<li class="arsenal-item">${esc(invName(item))}${wt ? `<span class="arsenal-item-weight">${wt} lb</span>` : ''}</li>`;
      }).join('')
    : '<span class="arsenal-none">Nothing yet</span>');
}

function checkInventoryChanges(prev, next) {
  if (!prev || !next) return;
  Object.keys(next.players || {}).forEach(id => {
    const prevLen = (prev.players?.[id]?.inventory || []).length;
    const nextLen = (next.players?.[id]?.inventory || []).length;
    if (nextLen > prevLen) {
      const btn = document.querySelector(`.arsenal-btn[data-arsenal-id="${id}"]`);
      if (btn) {
        btn.classList.remove('bag-wiggle');
        void btn.offsetWidth; // reflow to restart animation
        btn.classList.add('bag-wiggle');
        btn.addEventListener('animationend', () => btn.classList.remove('bag-wiggle'), { once: true });
      }
    }
  });
}

// ── My Character button ──────────────────────────────────────

function updateMyCharBtn() {
  if (!myDiscordId || !gameState) return;
  const player = gameState.players[myDiscordId];
  if (player) document.getElementById('myCharName').textContent = player.characterName;
}

// ── Character sidebar ────────────────────────────────────────

document.getElementById('myCharBtn').addEventListener('click', openSidebar);
document.getElementById('closeSidebar').addEventListener('click', closeSidebar);
document.getElementById('sidebarOverlay').addEventListener('click', closeSidebar);

function openSidebar() {
  if (isObserver) { alert('You are watching as an observer. Register a character with !register in Discord to manage your sheet.'); return; }
  if (!myDiscordId || !gameState) return;
  const player = gameState.players[myDiscordId];
  if (!player) { alert('Your character is not found. Make sure you typed !register in Discord first.'); return; }
  renderSidebar(player);
  document.getElementById('charSidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('active');
}

function closeSidebar() {
  document.getElementById('charSidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('active');
}

// ── Sidebar renderer ─────────────────────────────────────────

function renderSidebar(player) {
  const content = document.getElementById('charContent');

  content.innerHTML = `
    ${sPortrait(player)}
    ${sImportBtn()}
    ${player.abilities ? sAbilityScores(player) : ''}
    ${sCombatStats(player)}
    <button class="save-stats-btn" onclick="saveStats()">✦ Save Stats <span class="save-flash" id="saveFlash">Saved!</span></button>
    ${player.saves    ? sSavingThrows(player) : ''}
    ${player.skills   ? sSkills(player)       : ''}
    ${sConditions(player)}
    ${player.weapons?.length ? sWeapons(player) : ''}
    ${sInventory(player)}
    ${player.features?.length ? sFeatures(player) : ''}
    ${sSpells(player)}
    ${player.notes ? sNotes(player) : ''}
    ${sPortraitUrl(player)}
  `;

  // Enter-key shortcuts on add inputs
  document.getElementById('sNewItem') ?.addEventListener('keydown', e => { if (e.key === 'Enter') addItem(); });
  document.getElementById('sNewSpell')?.addEventListener('keydown', e => { if (e.key === 'Enter') addSpell(); });
}

// Portrait + identity
function sPortrait(player) {
  const imgHtml = player.image
    ? `<img class="char-portrait" src="${esc(player.image)}" alt="${esc(player.characterName)}">`
    : `<div class="char-portrait-placeholder">${(player.characterName||'?').charAt(0).toUpperCase()}</div>`;

  const metaExtra = [player.background, player.alignment].filter(Boolean).join(' · ');

  return `
    <div class="char-portrait-section">
      ${imgHtml}
      <div class="char-identity">
        <div class="char-name-large">${esc(player.characterName)}</div>
        <div class="char-class-level-large">${esc(player.class)} · Level ${player.level}</div>
        ${metaExtra ? `<div class="char-meta-extra">${esc(metaExtra)}</div>` : ''}
        <div class="char-discord-name">${esc(player.discordName)}</div>
      </div>
    </div>`;
}

// Import button
function sImportBtn() {
  return `
    <div class="import-section">
      <button class="import-btn" onclick="triggerImport()">⬆ Import Character from YAML</button>
      <input type="file" id="yamlFileInput" accept=".yaml,.yml" style="display:none" onchange="handleYamlFile(this)">
      <div class="import-hint">Supports D&amp;D 5e character sheet .yaml files</div>
    </div>`;
}

// 6 ability scores
function sAbilityScores(player) {
  const abs  = player.abilities;
  const keys = ['strength','dexterity','constitution','intelligence','wisdom','charisma'];
  const abbr = ['STR','DEX','CON','INT','WIS','CHA'];

  const boxes = keys.map((k, i) => {
    const score = abs[k] ?? 10;
    const mod   = abilityMod(score);
    return `
      <div class="ability-box">
        <div class="ability-abbr">${abbr[i]}</div>
        <div class="ability-score">${score}</div>
        <div class="ability-mod">${modStr(mod)}</div>
      </div>`;
  }).join('');

  return `
    <div class="sheet-section">
      <div class="sheet-section-title collapsible-title" onclick="toggleSection(this)">
        Ability Scores <span class="coll-arrow">▾</span>
      </div>
      <div class="sheet-section-body ability-grid">${boxes}</div>
    </div>`;
}

// HP, AC, Initiative, Proficiency
function sCombatStats(player) {
  return `
    <div class="sheet-section">
      <div class="sheet-section-title">Combat</div>
      <div class="sheet-section-body">
        <div class="stats-grid">
          <div class="stat-block">
            <div class="stat-label">Hit Points</div>
            <div class="hp-edit-row">
              <button class="hp-adj-btn" onclick="adjustHp(-1)">−</button>
              <input id="sHpCur" type="number" value="${player.hp}" min="0">
              <span class="hp-sep">/</span>
              <input id="sHpMax" type="number" value="${player.maxHp}" min="1">
              <button class="hp-adj-btn" onclick="adjustHp(1)">+</button>
            </div>
          </div>
          <div class="stat-block">
            <div class="stat-label">Armor Class</div>
            <input id="sAc" class="stat-input" type="number" value="${player.ac}">
          </div>
          <div class="stat-block">
            <div class="stat-label">Initiative</div>
            <div class="stat-value-sm">${modStr(player.initiative ?? 0)}</div>
          </div>
          <div class="stat-block">
            <div class="stat-label">Proficiency</div>
            <div class="stat-value-sm">+${player.proficiencyBonus ?? 2}</div>
          </div>
        </div>
      </div>
    </div>`;
}

// Saving throws
function sSavingThrows(player) {
  const saves = player.saves;
  const keys  = ['strength','dexterity','constitution','intelligence','wisdom','charisma'];
  const abbr  = ['STR','DEX','CON','INT','WIS','CHA'];

  const rows = keys.map((k, i) => {
    const s   = saves[k] || {};
    const dot = s.proficient ? '●' : '○';
    const cls = s.proficient ? 'prof-dot filled' : 'prof-dot';
    return `<div class="save-row"><span class="${cls}">${dot}</span><span class="save-abbr">${abbr[i]}</span><span class="save-mod">${modStr(s.modifier ?? 0)}</span></div>`;
  }).join('');

  return `
    <div class="sheet-section">
      <div class="sheet-section-title collapsible-title" onclick="toggleSection(this)">
        Saving Throws <span class="coll-arrow">▾</span>
      </div>
      <div class="sheet-section-body saves-grid">${rows}</div>
    </div>`;
}

// Skills
function sSkills(player) {
  const skills   = player.skills;
  const skillMap = [
    ['acrobatics','Acrobatics','DEX'],['animal_handling','Animal Handling','WIS'],
    ['arcana','Arcana','INT'],['athletics','Athletics','STR'],
    ['deception','Deception','CHA'],['history','History','INT'],
    ['insight','Insight','WIS'],['intimidation','Intimidation','CHA'],
    ['investigation','Investigation','INT'],['medicine','Medicine','WIS'],
    ['nature','Nature','INT'],['perception','Perception','WIS'],
    ['performance','Performance','CHA'],['persuasion','Persuasion','CHA'],
    ['religion','Religion','INT'],['sleight_of_hand','Sleight of Hand','DEX'],
    ['stealth','Stealth','DEX'],['survival','Survival','WIS'],
  ];

  const rows = skillMap.map(([key, label, attr]) => {
    const s   = skills[key] || {};
    const dot = s.proficient ? '●' : '○';
    const cls = s.proficient ? 'prof-dot filled' : 'prof-dot';
    return `<div class="skill-row"><span class="${cls}">${dot}</span><span class="skill-name">${label}</span><span class="skill-attr">${attr}</span><span class="skill-mod">${modStr(s.modifier ?? 0)}</span></div>`;
  }).join('');

  return `
    <div class="sheet-section collapsed">
      <div class="sheet-section-title collapsible-title" onclick="toggleSection(this)">
        Skills <span class="coll-arrow">▸</span>
      </div>
      <div class="sheet-section-body skills-list" style="display:none">${rows}</div>
    </div>`;
}

// Conditions
function sConditions(player) {
  const conds = player.conditions || {};
  const condList = [
    ['blinded','Blinded'],['charmed','Charmed'],['deafened','Deafened'],
    ['frightened','Frightened'],['grappled','Grappled'],['incapacitated','Incapacitated'],
    ['invisible','Invisible'],['paralyzed','Paralyzed'],['petrified','Petrified'],
    ['poisoned','Poisoned'],['prone','Prone'],['restrained','Restrained'],
    ['stunned','Stunned'],['unconscious','Unconscious'],
  ];

  const exhaustion = conds.exhaustion ?? 0;

  const badges = condList.map(([key, label]) => {
    const active = conds[key] === true;
    return `<button class="cond-badge${active ? ' active' : ''}" onclick="toggleCondition('${key}')" title="${label}">${label}</button>`;
  }).join('');

  const exhaustBtns = `
    <div class="exhaustion-row">
      <span class="exhaustion-label">Exhaustion</span>
      <button class="hp-adj-btn" onclick="adjustExhaustion(-1)">−</button>
      <span class="exhaustion-val">${exhaustion}</span>
      <button class="hp-adj-btn" onclick="adjustExhaustion(1)">+</button>
    </div>`;

  return `
    <div class="sheet-section">
      <div class="sheet-section-title collapsible-title" onclick="toggleSection(this)">
        Conditions <span class="coll-arrow">▾</span>
      </div>
      <div class="sheet-section-body">
        <div class="conditions-grid">${badges}</div>
        ${exhaustBtns}
      </div>
    </div>`;
}

// Weapons
function sWeapons(player) {
  const rows = (player.weapons || []).map(w => `
    <div class="weapon-row">
      <span class="weapon-name">${esc(w.name)}</span>
      <span class="weapon-type">${esc(w.type || '')}</span>
      <span class="weapon-bonus">${w.bonus >= 0 ? '+' : ''}${w.bonus}</span>
      <span class="weapon-damage">${esc(w.damage)}</span>
      <span class="weapon-dmgtype">${esc(w.damageType || '')}</span>
    </div>`).join('');

  return `
    <div class="sheet-section">
      <div class="sheet-section-title">Weapons</div>
      <div class="sheet-section-body">
        <div class="weapons-header">
          <span>Name</span><span>Type</span><span>Bonus</span><span>Damage</span><span>Type</span>
        </div>
        ${rows}
      </div>
    </div>`;
}

// Inventory
function sInventory(player) {
  const items = player.inventory || [];
  const listHtml = items.length
    ? items.map((item, i) => {
        const name = invName(item);
        const wt   = invWeight(item);
        return `
        <li>
          <span>${esc(name)}</span>
          ${wt ? `<span class="item-weight">${wt} lb</span>` : ''}
          <button class="item-remove-btn" onclick="removeItem(${i})" title="Remove">✕</button>
        </li>`;
      }).join('')
    : '<li><span class="empty-list-msg">No items yet</span></li>';

  return `
    <div class="sheet-section">
      <div class="sheet-section-title collapsible-title" onclick="toggleSection(this)">
        Inventory <span class="list-count">${items.length} items</span> <span class="coll-arrow">▾</span>
      </div>
      <div class="sheet-section-body">
        ${carryWeightBarHtml(player)}
        <ul class="item-list" id="sInventory">${listHtml}</ul>
        <div class="add-row">
          <input id="sNewItem" type="text" placeholder="Add item...">
          <button class="add-btn" onclick="addItem()">+</button>
        </div>
      </div>
    </div>`;
}

// Class features (from YAML)
function sFeatures(player) {
  const features = player.features || [];

  const rows = features.map((f, i) => {
    if (typeof f === 'string') {
      return `<div class="feature-row"><span class="feature-name">${esc(f)}</span></div>`;
    }
    const hasUses = f.uses && f.uses.max;
    const usesHtml = hasUses ? `
      <div class="feature-uses">
        <button class="hp-adj-btn" onclick="adjustFeatureUse(${i}, -1)">−</button>
        <span class="feature-use-count">${f.uses.current ?? 0}/${f.uses.max}</span>
        <button class="hp-adj-btn" onclick="adjustFeatureUse(${i}, 1)">+</button>
        <span class="feature-reset">${esc(f.uses.resets || '')}</span>
      </div>` : '';

    return `
      <div class="feature-row">
        <div class="feature-header">
          <span class="feature-name">${esc(f.name)}</span>
          ${usesHtml}
        </div>
        ${f.description ? `<div class="feature-desc">${esc(f.description)}</div>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="sheet-section">
      <div class="sheet-section-title collapsible-title" onclick="toggleSection(this)">
        Class Features <span class="coll-arrow">▾</span>
      </div>
      <div class="sheet-section-body">${rows}</div>
    </div>`;
}

// Spells / manually-added abilities
function sSpells(player) {
  const spells   = player.spells || [];
  const listHtml = spells.length
    ? spells.map((s, i) => `
        <li>
          <span>${esc(s)}</span>
          <button class="item-remove-btn" onclick="removeSpell(${i})" title="Remove">✕</button>
        </li>`).join('')
    : '<li><span class="empty-list-msg">None added yet</span></li>';

  return `
    <div class="sheet-section">
      <div class="sheet-section-title collapsible-title" onclick="toggleSection(this)">
        Spells &amp; Abilities <span class="list-count">${spells.length} known</span> <span class="coll-arrow">▾</span>
      </div>
      <div class="sheet-section-body">
        <ul class="item-list" id="sSpells">${listHtml}</ul>
        <div class="add-row">
          <input id="sNewSpell" type="text" placeholder="Add spell or ability...">
          <button class="add-btn" onclick="addSpell()">+</button>
        </div>
      </div>
    </div>`;
}

// Notes
function sNotes(player) {
  const notes = player.notes || {};
  const fields = [
    ['biography','Biography'],['bonds','Bonds'],
    ['ideals','Ideals'],['flaws','Flaws'],['treasures','Treasures'],
  ];

  const rows = fields
    .filter(([k]) => notes[k])
    .map(([k, label]) => `
      <div class="note-row">
        <div class="note-label">${label}</div>
        <div class="note-text">${esc(notes[k])}</div>
      </div>`).join('');

  if (!rows) return '';

  return `
    <div class="sheet-section">
      <div class="sheet-section-title collapsible-title" onclick="toggleSection(this)">
        Notes <span class="coll-arrow">▾</span>
      </div>
      <div class="sheet-section-body">${rows}</div>
    </div>`;
}

// Portrait URL
function sPortraitUrl(player) {
  return `
    <div class="sheet-section">
      <div class="sheet-section-title">Character Portrait</div>
      <div class="sheet-section-body">
        <input class="image-url-input" id="sImageUrl" type="text"
               placeholder="Paste an image URL..." value="${esc(player.image || '')}">
        <button class="save-image-btn" onclick="saveImage()">Update Portrait</button>
      </div>
    </div>`;
}

// ── Collapsible sections ─────────────────────────────────────

function toggleSection(titleEl) {
  const section = titleEl.closest('.sheet-section');
  const body    = section.querySelector('.sheet-section-body');
  const arrow   = titleEl.querySelector('.coll-arrow');
  if (!body) return;

  const collapsed = section.classList.toggle('collapsed');
  body.style.display  = collapsed ? 'none' : '';
  if (arrow) arrow.textContent = collapsed ? '▸' : '▾';
}

// ── Stat editing ─────────────────────────────────────────────

function adjustHp(delta) {
  const input = document.getElementById('sHpCur');
  if (input) input.value = Math.max(0, (parseInt(input.value) || 0) + delta);
}

async function saveStats() {
  if (!myDiscordId || !gameState) return;
  const player = gameState.players[myDiscordId];
  if (!player) return;

  const hp    = parseInt(document.getElementById('sHpCur')?.value) ?? player.hp;
  const maxHp = parseInt(document.getElementById('sHpMax')?.value) ?? player.maxHp;
  const ac    = parseInt(document.getElementById('sAc')?.value)    ?? player.ac;

  await patchPlayer({ hp, maxHp, ac });

  const flash = document.getElementById('saveFlash');
  if (flash) { flash.classList.add('show'); setTimeout(() => flash.classList.remove('show'), 1800); }
}

// ── Conditions ───────────────────────────────────────────────

async function toggleCondition(key) {
  if (!myDiscordId || !gameState) return;
  const player     = gameState.players[myDiscordId];
  const conditions = { ...(player.conditions || {}), [key]: !(player.conditions?.[key]) };
  await patchPlayer({ conditions });
}

async function adjustExhaustion(delta) {
  if (!myDiscordId || !gameState) return;
  const player     = gameState.players[myDiscordId];
  const current    = player.conditions?.exhaustion ?? 0;
  const conditions = { ...(player.conditions || {}), exhaustion: Math.max(0, Math.min(6, current + delta)) };
  await patchPlayer({ conditions });
}

// ── Features use tracking ────────────────────────────────────

async function adjustFeatureUse(index, delta) {
  if (!myDiscordId || !gameState) return;
  const player   = gameState.players[myDiscordId];
  const features = JSON.parse(JSON.stringify(player.features || []));
  const f        = features[index];
  if (!f || !f.uses) return;
  f.uses.current = Math.max(0, Math.min(f.uses.max, (f.uses.current ?? 0) + delta));
  await patchPlayer({ features });
}

// ── Inventory & spells ───────────────────────────────────────

async function addItem() {
  const input = document.getElementById('sNewItem');
  if (!input?.value.trim()) return;
  const player    = gameState.players[myDiscordId];
  const inventory = [...(player.inventory || []), { name: input.value.trim(), weight: 0 }];
  await patchPlayer({ inventory });
  input.value = '';
}

async function removeItem(index) {
  const player    = gameState.players[myDiscordId];
  const inventory = (player.inventory || []).filter((_, i) => i !== index);
  await patchPlayer({ inventory });
}

// ── Carry weight helpers ─────────────────────────────────────

function invName(item)   { return typeof item === 'string' ? item : (item.name || ''); }
function invWeight(item) { return typeof item === 'string' ? 0    : (item.weight || 0); }

function carryWeightInfo(player) {
  const str = player.abilities?.strength ?? 10;
  const max  = str * 15;
  const enc1 = str * 5;
  const enc2 = str * 10;
  const weaponW = (player.weapons || []).reduce((s, w) => s + (w.weight || 0), 0);
  const invW    = (player.inventory || []).reduce((s, item) => s + invWeight(item), 0);
  const current = Math.round((weaponW + invW) * 10) / 10;
  return { current, max, enc1, enc2 };
}

function carryWeightBarHtml(player) {
  const { current, max, enc1, enc2 } = carryWeightInfo(player);
  if (!max) return '';
  const pct   = Math.min(current / max * 100, 100);
  const color = current > enc2 ? '#c0392b' : current > enc1 ? '#c9a84c' : '#4a9e6b';
  const note  = current > max  ? '⛔ Over capacity'
              : current > enc2 ? '🔴 Heavily Encumbered'
              : current > enc1 ? '🟡 Encumbered'
              : '✅ Within limits';
  return `
    <div class="carry-weight-block">
      <div class="carry-weight-header">
        <span class="carry-weight-label">⚖ Carry Weight</span>
        <span class="carry-weight-value">${current} / ${max} lbs</span>
      </div>
      <div class="carry-weight-track">
        <div class="carry-weight-fill" style="width:${pct}%;background:${color}"></div>
        <div class="carry-weight-thresh" style="left:${enc1/max*100}%"></div>
        <div class="carry-weight-thresh" style="left:${enc2/max*100}%"></div>
      </div>
      <div class="carry-weight-note">${note}</div>
    </div>`;
}

async function addSpell() {
  const input = document.getElementById('sNewSpell');
  if (!input?.value.trim()) return;
  const player = gameState.players[myDiscordId];
  const spells = [...(player.spells || []), input.value.trim()];
  await patchPlayer({ spells });
  input.value = '';
}

async function removeSpell(index) {
  const player = gameState.players[myDiscordId];
  const spells = (player.spells || []).filter((_, i) => i !== index);
  await patchPlayer({ spells });
}

async function saveImage() {
  const input = document.getElementById('sImageUrl');
  await patchPlayer({ image: input?.value.trim() || null });
}

// ── YAML Import ──────────────────────────────────────────────

function triggerImport() {
  document.getElementById('yamlFileInput')?.click();
}

function handleYamlFile(input) {
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = jsyaml.load(e.target.result);
      applyYamlCharacter(parsed);
    } catch (err) {
      alert(`Failed to parse YAML file:\n${err.message}`);
    }
  };
  reader.readAsText(file);
  // Reset so the same file can be re-imported
  input.value = '';
}

async function applyYamlCharacter(yaml) {
  if (!myDiscordId || !gameState) return;
  const existing = gameState.players[myDiscordId];
  if (!existing) return;

  const char    = yaml.character   || {};
  const combat  = yaml.combat      || {};
  const hp      = combat.hp        || {};
  const abs     = yaml.abilities   || {};
  const skills  = yaml.skills      || {};
  const saves   = yaml.saves       || {};
  const equip   = yaml.equipment   || {};
  const feats   = yaml.features    || [];
  const conds   = yaml.conditions  || {};
  const notes   = yaml.notes       || {};

  // Convert inventory items to objects with weight
  const inventory = (equip.inventory || []).map(item => ({
    name:   (item.quantity ?? 1) > 1 ? `${item.name} (×${item.quantity})` : item.name,
    weight: (item.weight || 0) * (item.quantity ?? 1),
  }));

  // Map class features (keep full objects for use tracking)
  const features = feats.map(f => ({
    name:        f.name        || '',
    description: f.description || '',
    uses:        f.uses        ? { ...f.uses } : null,
  }));

  const update = {
    characterName:   char.name       || existing.characterName,
    class:           char.class      || existing.class,
    level:           char.level      || existing.level,
    background:      char.background || '',
    alignment:       char.alignment  || '',
    hp:              hp.current      ?? existing.hp,
    maxHp:           hp.max          ?? existing.maxHp,
    ac:              combat.ac       ?? existing.ac,
    initiative:      combat.initiative     ?? 0,
    proficiencyBonus: combat.proficiencyBonus ?? 2,
    abilities: {
      strength:     abs.strength     ?? 10,
      dexterity:    abs.dexterity    ?? 10,
      constitution: abs.constitution ?? 10,
      intelligence: abs.intelligence ?? 10,
      wisdom:       abs.wisdom       ?? 10,
      charisma:     abs.charisma     ?? 10,
    },
    skills,
    saves,
    armor:    equip.armor   || '',
    weapons:  (equip.weapons || []).map(w => ({
      name:       w.name       || '',
      type:       w.type       || 'Melee',
      bonus:      w.bonus      ?? 0,
      damage:     w.damage     || '',
      damageType: w.damageType || '',
      weight:     w.weight     ?? 0,
    })),
    inventory,
    features,
    conditions: {
      blinded: false, charmed: false, deafened: false,
      frightened: false, grappled: false, incapacitated: false,
      invisible: false, paralyzed: false, petrified: false,
      poisoned: conds.poisoned ?? false,
      prone: false,
      restrained: conds.restrained ?? false,
      stunned: conds.stunned ?? false,
      unconscious: conds.unconscious ?? false,
      exhaustion: conds.exhaustion ?? 0,
    },
    notes: {
      biography: notes.biography || '',
      bonds:     notes.bonds     || '',
      ideals:    notes.ideals    || '',
      flaws:     notes.flaws     || '',
      treasures: notes.treasures || '',
    },
  };

  await patchPlayer(update);
  alert(`✦ ${update.characterName} imported successfully!`);
}

// ── Patch player ─────────────────────────────────────────────

async function patchPlayer(data) {
  if (!myDiscordId) return;
  try {
    const res = await fetch(`/api/player/${myDiscordId}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Update failed');
    Object.assign(gameState.players[myDiscordId], data);
    renderSidebar(gameState.players[myDiscordId]);
    renderPlayers();
  } catch (err) {
    console.error('patchPlayer error:', err);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function abilityMod(score) { return Math.floor((score - 10) / 2); }
function modStr(mod)       { return mod >= 0 ? `+${mod}` : `${mod}`; }

function esc(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Dice Roll Animation ───────────────────────────────────────

function showDiceAnimation(entry) {
  const match  = (entry.dice || '').match(/d(\d+)/i);
  const sides  = match ? parseInt(match[1]) : 20;
  const total  = entry.total;

  const overlay  = document.getElementById('diceRollOverlay');
  const dieFace  = document.getElementById('dieFace');
  const dieNum   = document.getElementById('dieNumber');
  const label    = document.getElementById('diceRollLabel');
  const notation = document.getElementById('diceRollNotation');
  if (!overlay) return;

  // Reset state
  dieFace.className  = `die-face die-d${sides}`;
  dieFace.style.animation = '';
  dieNum.textContent  = '?';
  label.textContent   = `${entry.name} rolls`;
  notation.textContent = entry.dice || `1d${sides}`;
  overlay.style.opacity   = '1';
  overlay.style.animation = '';
  overlay.style.display   = 'flex';

  // Rolling animation + number cycling
  dieFace.style.animation = 'die-rolling 1.2s ease-out forwards';
  const cycle = setInterval(() => {
    dieNum.textContent = Math.floor(Math.random() * sides) + 1;
  }, 55);

  // Reveal result at end of roll
  setTimeout(() => {
    clearInterval(cycle);
    dieNum.textContent = total;
    dieFace.style.animation = 'die-land 0.45s ease-out forwards';
    if (sides === 20 && total === 20) dieFace.classList.add('nat20');
    else if (sides === 20 && total === 1) dieFace.classList.add('nat1');
  }, 1200);

  // Fade overlay out
  setTimeout(() => {
    overlay.style.animation = 'die-exit 0.45s ease forwards';
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.animation = '';
    }, 450);
  }, 2500);
}

// ── HP change detection ───────────────────────────────────────

function checkHpChanges(prevState, newState) {
  if (!prevState?.players || !newState?.players) return;
  Object.entries(newState.players).forEach(([id, p]) => {
    const prev = prevState.players[id];
    if (!prev) return;
    const oldHp = prev.hp ?? 0;
    const newHp = p.hp  ?? 0;
    if (newHp === oldHp) return;
    const delta = newHp - oldHp;
    triggerPlayerEffect(id, delta < 0 ? 'damage' : 'heal', Math.abs(delta));
  });
}

function triggerPlayerEffect(discordId, type, amount) {
  const card = document.querySelector(`.player-card[data-id="${discordId}"]`);
  if (!card) return;

  // Border flash — remove first to restart if already animating
  card.classList.remove('card-flash-damage', 'card-flash-heal');
  void card.offsetWidth;
  card.classList.add(type === 'damage' ? 'card-flash-damage' : 'card-flash-heal');
  card.addEventListener('animationend', () => {
    card.classList.remove('card-flash-damage', 'card-flash-heal');
  }, { once: true });

  // Floating number
  const rect = card.getBoundingClientRect();
  const el   = document.createElement('div');
  el.className   = `float-number ${type}`;
  el.textContent = (type === 'damage' ? '−' : '+') + amount;
  el.style.left  = (rect.left + rect.width  / 2 - 28) + 'px';
  el.style.top   = (rect.top  + rect.height / 3)      + 'px';
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
}
