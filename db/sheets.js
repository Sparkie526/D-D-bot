const { getDb } = require('./init');

function saveSheet(playerId, guildId, characterName, data) {
  const db = getDb();
  const json = JSON.stringify(data);
  db.prepare(`
    INSERT INTO character_sheets (player_id, guild_id, character_name, data, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(player_id, guild_id, character_name)
    DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
  `).run(playerId, guildId, characterName, json);
}

function loadSheet(playerId, guildId, characterName) {
  const db = getDb();
  const row = db.prepare(
    'SELECT data FROM character_sheets WHERE player_id = ? AND guild_id = ? AND character_name = ?'
  ).get(playerId, guildId, characterName);
  return row ? JSON.parse(row.data) : null;
}

function listSheets(playerId, guildId) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT character_name FROM character_sheets WHERE player_id = ? AND guild_id = ? ORDER BY updated_at DESC'
  ).all(playerId, guildId);
  return rows.map(r => r.character_name);
}

function deleteSheet(playerId, guildId, characterName) {
  const db = getDb();
  db.prepare(
    'DELETE FROM character_sheets WHERE player_id = ? AND guild_id = ? AND character_name = ?'
  ).run(playerId, guildId, characterName);
}

module.exports = { saveSheet, loadSheet, listSheets, deleteSheet };
