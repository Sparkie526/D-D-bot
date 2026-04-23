const { getDb } = require('./init');

// Fields from the in-memory session we want to survive a restart.
// Volatile runtime handles (timeouts, audio players, socket connections) are excluded.
const PERSIST_KEYS = [
  'history', 'players', 'originalNicknames', 'activePlayers',
  'active', 'nameCollectionActive', 'currentLocation',
  'turnOrder', 'currentTurnIndex', 'lastRollResult', 'pendingAction',
  'characterSheets', 'currentCharacters', 'encounter',
];

function saveSessionState(guildId, session) {
  const db = getDb();
  const snapshot = {};
  for (const key of PERSIST_KEYS) {
    if (key in session) snapshot[key] = session[key];
  }
  db.prepare(`
    INSERT INTO session_state (guild_id, data, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
  `).run(guildId, JSON.stringify(snapshot));
}

function loadSessionState(guildId) {
  const db = getDb();
  const row = db.prepare('SELECT data FROM session_state WHERE guild_id = ?').get(guildId);
  return row ? JSON.parse(row.data) : null;
}

function clearSessionState(guildId) {
  const db = getDb();
  db.prepare('DELETE FROM session_state WHERE guild_id = ?').run(guildId);
}

module.exports = { saveSessionState, loadSessionState, clearSessionState };
