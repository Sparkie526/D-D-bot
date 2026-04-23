const { getDb } = require('./init');

function startGameSession(guildId, worldId = null, worldName = null, campaignId = null) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO game_sessions (guild_id, campaign_id, world_id, world_name, started_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(guildId, campaignId, worldId, worldName);
  
  return result.lastInsertRowid;
}

function endGameSession(sessionId, summary = null) {
  const db = getDb();
  const session = db.prepare('SELECT started_at FROM game_sessions WHERE id = ?').get(sessionId);
  if (!session) return false;

  const startedAt = new Date(session.started_at);
  const endedAt = new Date();
  const durationMinutes = Math.round((endedAt - startedAt) / 60000);

  db.prepare(`
    UPDATE game_sessions 
    SET ended_at = CURRENT_TIMESTAMP, duration_minutes = ?, summary = ?
    WHERE id = ?
  `).run(durationMinutes, summary, sessionId);

  return true;
}

function getSession(sessionId) {
  const db = getDb();
  return db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
}

function getActiveSession(guildId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM game_sessions 
    WHERE guild_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `).get(guildId);
}

function listGuildSessions(guildId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT gs.*, 
      (SELECT COUNT(*) FROM session_participants WHERE session_id = gs.id) as participant_count,
      (SELECT GROUP_CONCAT(c.name) FROM session_participants sp JOIN characters c ON sp.character_id = c.id WHERE sp.session_id = gs.id) as participants
    FROM game_sessions gs
    WHERE gs.guild_id = ?
    ORDER BY gs.started_at DESC
    LIMIT ?
  `).all(guildId, limit);
}

function listCampaignSessions(campaignId, limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT gs.*, 
      (SELECT COUNT(*) FROM session_participants WHERE session_id = gs.id) as participant_count
    FROM game_sessions gs
    WHERE gs.campaign_id = ?
    ORDER BY gs.started_at DESC
    LIMIT ?
  `).all(campaignId, limit);
}

function addSessionParticipant(sessionId, characterId) {
  const db = getDb();
  db.prepare(`
    INSERT INTO session_participants (session_id, character_id, joined_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id, character_id) DO UPDATE SET left_at = NULL
  `).run(sessionId, characterId);
}

function removeSessionParticipant(sessionId, characterId) {
  const db = getDb();
  db.prepare(`
    UPDATE session_participants 
    SET left_at = CURRENT_TIMESTAMP 
    WHERE session_id = ? AND character_id = ? AND left_at IS NULL
  `).run(sessionId, characterId);
}

function getSessionParticipants(sessionId) {
  const db = getDb();
  return db.prepare(`
    SELECT sp.*, c.name as character_name, c.class, c.level, p.username as player_name
    FROM session_participants sp
    JOIN characters c ON sp.character_id = c.id
    JOIN players p ON c.player_id = p.id
    WHERE sp.session_id = ?
    ORDER BY sp.joined_at
  `).all(sessionId);
}

function logGameEvent(sessionId, eventType, options = {}) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO game_events (session_id, character_id, event_type, roll_type, roll_result, roll_total, dc, success, damage_dealt, damage_type, healing_done, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    sessionId,
    options.characterId || null,
    eventType,
    options.rollType || null,
    options.rollResult || null,
    options.rollTotal || null,
    options.dc || null,
    options.success !== undefined ? (options.success ? 1 : 0) : null,
    options.damage || null,
    options.damageType || null,
    options.healing || null,
    options.details ? JSON.stringify(options.details) : null
  );
  
  return result.lastInsertRowid;
}

function logRoll(sessionId, characterId, rollType, rollResult, rollTotal, dc, success, details = null) {
  return logGameEvent(sessionId, 'roll', {
    characterId,
    rollType,
    rollResult,
    rollTotal,
    dc,
    success,
    details
  });
}

function logDamage(sessionId, characterId, damage, damageType, details = null) {
  return logGameEvent(sessionId, 'damage', {
    characterId,
    damage,
    damageType,
    details
  });
}

function logHealing(sessionId, characterId, healing, details = null) {
  return logGameEvent(sessionId, 'healing', {
    characterId,
    healing,
    details
  });
}

function logLevelUp(sessionId, characterId, newLevel) {
  return logGameEvent(sessionId, 'level_up', {
    characterId,
    details: { newLevel }
  });
}

function logDeath(sessionId, characterId, cause = null) {
  return logGameEvent(sessionId, 'death', {
    characterId,
    details: { cause }
  });
}

function logCondition(sessionId, characterId, condition, added) {
  return logGameEvent(sessionId, 'condition', {
    characterId,
    details: { condition, added }
  });
}

function getSessionEvents(sessionId, options = {}) {
  const db = getDb();
  let query = `
    SELECT ge.*, c.name as character_name, p.username as player_name
    FROM game_events ge
    LEFT JOIN characters c ON ge.character_id = c.id
    LEFT JOIN players p ON c.player_id = p.id
    WHERE ge.session_id = ?
  `;
  const params = [sessionId];

  if (options.characterId) {
    query += ' AND ge.character_id = ?';
    params.push(options.characterId);
  }
  if (options.eventType) {
    query += ' AND ge.event_type = ?';
    params.push(options.eventType);
  }
  if (options.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  } else {
    query += ' ORDER BY ge.created_at';
  }

  return db.prepare(query).all(...params);
}

function getCharacterSessionHistory(characterId, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT gs.*, ge.event_type, ge.roll_total, ge.damage_dealt, ge.healing_done
    FROM game_events ge
    JOIN game_sessions gs ON ge.session_id = gs.id
    WHERE ge.character_id = ?
    ORDER BY gs.started_at DESC
    LIMIT ?
  `).all(characterId, limit);
}

function getSessionStats(sessionId) {
  const db = getDb();
  
  const events = db.prepare(`
    SELECT 
      event_type,
      COUNT(*) as count,
      SUM(damage_dealt) as total_damage,
      SUM(healing_done) as total_healing,
      SUM(CASE WHEN event_type = 'roll' AND success = 1 THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN event_type = 'roll' AND success = 0 THEN 1 ELSE 0 END) as failures
    FROM game_events
    WHERE session_id = ?
    GROUP BY event_type
  `).all(sessionId);

  const byCharacter = db.prepare(`
    SELECT 
      c.id, c.name, c.class, c.level,
      COUNT(CASE WHEN ge.event_type = 'roll' THEN 1 END) as rolls,
      COUNT(CASE WHEN ge.event_type = 'roll' AND ge.success = 1 THEN 1 END) as successes,
      COUNT(CASE WHEN ge.event_type = 'roll' AND ge.success = 0 THEN 1 END) as failures,
      COALESCE(SUM(ge.damage_dealt), 0) as total_damage,
      COALESCE(SUM(ge.healing_done), 0) as total_healing
    FROM characters c
    JOIN session_participants sp ON c.id = sp.character_id
    LEFT JOIN game_events ge ON c.id = ge.character_id AND ge.session_id = sp.session_id
    WHERE sp.session_id = ?
    GROUP BY c.id
  `).all(sessionId);

  return { events, byCharacter };
}

function createCampaign(guildId, name, description = null, worldId = null) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO campaigns (guild_id, name, description, world_id)
    VALUES (?, ?, ?, ?)
  `).run(guildId, name, description, worldId);
  return result.lastInsertRowid;
}

function getCampaign(campaignId) {
  const db = getDb();
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
}

function getCampaignByName(guildId, name) {
  const db = getDb();
  return db.prepare('SELECT * FROM campaigns WHERE guild_id = ? AND LOWER(name) = LOWER(?)').get(guildId, name);
}

function listGuildCampaigns(guildId) {
  const db = getDb();
  return db.prepare(`
    SELECT c.*, 
      (SELECT COUNT(*) FROM characters WHERE campaign_id = c.id AND active = 1) as character_count,
      (SELECT COUNT(*) FROM game_sessions WHERE campaign_id = c.id) as session_count,
      (SELECT MAX(started_at) FROM game_sessions WHERE campaign_id = c.id) as last_session
    FROM campaigns c
    WHERE c.guild_id = ?
    ORDER BY c.name
  `).all(guildId);
}

function updateCampaign(campaignId, updates) {
  const db = getDb();
  const fields = [];
  const values = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.worldId !== undefined) {
    fields.push('world_id = ?');
    values.push(updates.worldId);
  }

  if (fields.length === 0) return false;

  values.push(campaignId);
  db.prepare(`UPDATE campaigns SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  
  return getCampaign(campaignId);
}

function deleteCampaign(campaignId) {
  const db = getDb();
  db.prepare('UPDATE characters SET campaign_id = NULL WHERE campaign_id = ?').run(campaignId);
  db.prepare('UPDATE game_sessions SET campaign_id = NULL WHERE campaign_id = ?').run(campaignId);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
}

function takeSnapshot(characterId, sessionId) {
  const db = getDb();
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId);
  const stats = db.prepare('SELECT * FROM character_stats WHERE character_id = ?').get(characterId);
  
  if (!character || !stats) return null;

  const conditions = stats.conditions ? JSON.parse(stats.conditions) : [];
  const inventory = db.prepare('SELECT * FROM character_inventory WHERE character_id = ?').all(characterId);
  const features = db.prepare('SELECT * FROM character_features WHERE character_id = ?').all(characterId);

  const { getCharacter } = require('./characters');
  const fullChar = getCharacter(characterId);
  
  return logGameEvent(sessionId, 'snapshot', {
    characterId,
    details: {
      level: character.level,
      experience: character.experience,
      hp_current: stats.hp_current,
      hp_max: stats.hp_max,
      conditions,
      inventory: inventory.map(i => ({ name: i.item_name, quantity: i.quantity, equipped: i.equipped === 1 })),
      features: features.map(f => ({ name: f.name, uses_current: f.uses_current, uses_max: f.uses_max }))
    }
  });
}

module.exports = {
  startGameSession,
  endGameSession,
  getSession,
  getActiveSession,
  listGuildSessions,
  listCampaignSessions,
  addSessionParticipant,
  removeSessionParticipant,
  getSessionParticipants,
  logGameEvent,
  logRoll,
  logDamage,
  logHealing,
  logLevelUp,
  logDeath,
  logCondition,
  getSessionEvents,
  getCharacterSessionHistory,
  getSessionStats,
  createCampaign,
  getCampaign,
  getCampaignByName,
  listGuildCampaigns,
  updateCampaign,
  deleteCampaign,
  takeSnapshot
};
