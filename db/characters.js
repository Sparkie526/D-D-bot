const { getDb } = require('./init');

function ensurePlayer(playerId, username) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO players (id, username) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET username = excluded.username
  `);
  stmt.run(playerId, username);
}

function getPlayer(playerId) {
  const db = getDb();
  return db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
}

function createCharacter(playerId, guildId, name, className, options = {}) {
  const db = getDb();
  
  ensurePlayer(playerId, options.username || 'Unknown');

  const stmt = db.prepare(`
    INSERT INTO characters (player_id, guild_id, campaign_id, name, class, level, experience, background, alignment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const result = stmt.run(
    playerId,
    guildId,
    options.campaignId || null,
    name,
    className,
    options.level || 1,
    options.experience || 0,
    options.background || null,
    options.alignment || null
  );

  const characterId = result.lastInsertRowid;

  if (options.stats) {
    saveCharacterStats(characterId, options.stats);
  }
  if (options.skills) {
    saveCharacterSkills(characterId, options.skills);
  }
  if (options.saves) {
    saveCharacterSaves(characterId, options.saves);
  }
  if (options.inventory) {
    saveCharacterInventory(characterId, options.inventory);
  }
  if (options.features) {
    saveCharacterFeatures(characterId, options.features);
  }

  return getCharacter(characterId);
}

function getCharacter(characterId) {
  const db = getDb();
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId);
  if (!character) return null;

  character.stats = getCharacterStats(characterId);
  character.skills = getCharacterSkills(characterId);
  character.saves = getCharacterSaves(characterId);
  character.inventory = getCharacterInventory(characterId);
  character.features = getCharacterFeatures(characterId);
  
  return character;
}

function getCharacterByName(playerId, guildId, name) {
  const db = getDb();
  const character = db.prepare(`
    SELECT * FROM characters 
    WHERE player_id = ? AND guild_id = ? AND LOWER(name) = LOWER(?)
  `).get(playerId, guildId, name);
  
  if (!character) return null;
  
  character.stats = getCharacterStats(character.id);
  character.skills = getCharacterSkills(character.id);
  character.saves = getCharacterSaves(character.id);
  character.inventory = getCharacterInventory(character.id);
  character.features = getCharacterFeatures(character.id);
  
  return character;
}

function getCharacterByNameGlobal(guildId, name) {
  const db = getDb();
  const character = db.prepare(`
    SELECT c.*, p.username as player_name
    FROM characters c
    JOIN players p ON c.player_id = p.id
    WHERE c.guild_id = ? AND LOWER(c.name) = LOWER(?)
  `).get(guildId, name);
  
  if (!character) return null;
  
  character.stats = getCharacterStats(character.id);
  character.skills = getCharacterSkills(character.id);
  character.saves = getCharacterSaves(character.id);
  character.inventory = getCharacterInventory(character.id);
  character.features = getCharacterFeatures(character.id);
  
  return character;
}

function listCharacters(playerId, guildId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, name, class, level, active, last_played 
    FROM characters 
    WHERE player_id = ? AND guild_id = ?
    ORDER BY last_played DESC NULLS LAST, name
  `).all(playerId, guildId);
}

function listGuildCharacters(guildId, campaignId = null) {
  const db = getDb();
  if (campaignId) {
    return db.prepare(`
      SELECT c.*, p.username as player_name
      FROM characters c
      JOIN players p ON c.player_id = p.id
      WHERE c.guild_id = ? AND c.campaign_id = ? AND c.active = 1
      ORDER BY c.name
    `).all(guildId, campaignId);
  }
  return db.prepare(`
    SELECT c.*, p.username as player_name
    FROM characters c
    JOIN players p ON c.player_id = p.id
    WHERE c.guild_id = ? AND c.active = 1
    ORDER BY c.name
  `).all(guildId);
}

function updateCharacter(characterId, updates) {
  const db = getDb();
  const fields = [];
  const values = [];

  const allowedFields = ['name', 'class', 'level', 'experience', 'background', 'alignment', 'campaign_id', 'active', 'last_played'];
  
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(updates[field]);
    }
  }

  if (fields.length === 0) return false;

  values.push(characterId);
  db.prepare(`UPDATE characters SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  
  return getCharacter(characterId);
}

function updateCharacterLastPlayed(characterId) {
  const db = getDb();
  db.prepare('UPDATE characters SET last_played = CURRENT_TIMESTAMP WHERE id = ?').run(characterId);
}

function deleteCharacter(characterId) {
  const db = getDb();
  db.prepare('UPDATE characters SET active = 0 WHERE id = ?').run(characterId);
}

function hardDeleteCharacter(characterId) {
  const db = getDb();
  db.prepare('DELETE FROM characters WHERE id = ?').run(characterId);
}

function saveCharacterStats(characterId, stats) {
  const db = getDb();
  db.prepare(`
    INSERT INTO character_stats (character_id, strength, dexterity, constitution, intelligence, wisdom, charisma, ac, hp_current, hp_max, initiative, proficiency_bonus, speed, hit_dice, spellcasting_ability, spell_save_dc, spell_attack_bonus, conditions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      strength = excluded.strength,
      dexterity = excluded.dexterity,
      constitution = excluded.constitution,
      intelligence = excluded.intelligence,
      wisdom = excluded.wisdom,
      charisma = excluded.charisma,
      ac = excluded.ac,
      hp_current = excluded.hp_current,
      hp_max = excluded.hp_max,
      initiative = excluded.initiative,
      proficiency_bonus = excluded.proficiency_bonus,
      speed = excluded.speed,
      hit_dice = excluded.hit_dice,
      spellcasting_ability = excluded.spellcasting_ability,
      spell_save_dc = excluded.spell_save_dc,
      spell_attack_bonus = excluded.spell_attack_bonus,
      conditions = excluded.conditions
  `).run(
    characterId,
    stats.strength || 10,
    stats.dexterity || 10,
    stats.constitution || 10,
    stats.intelligence || 10,
    stats.wisdom || 10,
    stats.charisma || 10,
    stats.ac || 10,
    stats.hp_current || stats.hp?.current || 10,
    stats.hp_max || stats.hp?.max || 10,
    stats.initiative || 0,
    stats.proficiency_bonus || 2,
    stats.speed || '30 ft',
    stats.hit_dice || '1d8',
    stats.spellcasting_ability || null,
    stats.spell_save_dc || null,
    stats.spell_attack_bonus || null,
    JSON.stringify(stats.conditions || [])
  );
}

function updateCharacterHP(characterId, hpCurrent, hpMax = null) {
  const db = getDb();
  if (hpMax !== null) {
    db.prepare('UPDATE character_stats SET hp_current = ?, hp_max = ? WHERE character_id = ?').run(hpCurrent, hpMax, characterId);
  } else {
    db.prepare('UPDATE character_stats SET hp_current = ? WHERE character_id = ?').run(hpCurrent, characterId);
  }
}

function updateCharacterConditions(characterId, conditions) {
  const db = getDb();
  db.prepare('UPDATE character_stats SET conditions = ? WHERE character_id = ?').run(JSON.stringify(conditions), characterId);
}

function getCharacterStats(characterId) {
  const db = getDb();
  const stats = db.prepare('SELECT * FROM character_stats WHERE character_id = ?').get(characterId);
  if (stats && stats.conditions) {
    stats.conditions = JSON.parse(stats.conditions);
  }
  return stats;
}

function saveCharacterSkills(characterId, skills) {
  const db = getDb();
  const deleteStmt = db.prepare('DELETE FROM character_skills WHERE character_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO character_skills (character_id, skill_name, modifier, proficient)
    VALUES (?, ?, ?, ?)
  `);
  
  const transaction = db.transaction(() => {
    deleteStmt.run(characterId);
    for (const [name, data] of Object.entries(skills)) {
      insertStmt.run(characterId, name, data.modifier || 0, data.proficient ? 1 : 0);
    }
  });
  
  transaction();
}

function getCharacterSkills(characterId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM character_skills WHERE character_id = ?').all(characterId);
  const skills = {};
  for (const row of rows) {
    skills[row.skill_name] = {
      modifier: row.modifier,
      proficient: row.proficient === 1
    };
  }
  return skills;
}

function saveCharacterSaves(characterId, saves) {
  const db = getDb();
  const deleteStmt = db.prepare('DELETE FROM character_saves WHERE character_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO character_saves (character_id, save_name, modifier, proficient)
    VALUES (?, ?, ?, ?)
  `);
  
  const transaction = db.transaction(() => {
    deleteStmt.run(characterId);
    for (const [name, data] of Object.entries(saves)) {
      insertStmt.run(characterId, name, data.modifier || 0, data.proficient ? 1 : 0);
    }
  });
  
  transaction();
}

function getCharacterSaves(characterId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM character_saves WHERE character_id = ?').all(characterId);
  const saves = {};
  for (const row of rows) {
    saves[row.save_name] = {
      modifier: row.modifier,
      proficient: row.proficient === 1
    };
  }
  return saves;
}

function saveCharacterFeatures(characterId, features) {
  const db = getDb();
  const deleteStmt = db.prepare('DELETE FROM character_features WHERE character_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO character_features (character_id, name, description, uses_current, uses_max, reset_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  const transaction = db.transaction(() => {
    deleteStmt.run(characterId);
    for (const feature of features) {
      insertStmt.run(
        characterId,
        feature.name,
        feature.description || '',
        feature.uses?.current || 0,
        feature.uses?.max || 0,
        feature.uses?.resets || null
      );
    }
  });
  
  transaction();
}

function getCharacterFeatures(characterId) {
  const db = getDb();
  return db.prepare('SELECT * FROM character_features WHERE character_id = ?').all(characterId);
}

function useCharacterFeature(characterId, featureName) {
  const db = getDb();
  const feature = db.prepare('SELECT * FROM character_features WHERE character_id = ? AND name = ?').get(characterId, featureName);
  if (!feature) return null;
  
  if (feature.uses_max === 0) return feature;
  if (feature.uses_current >= feature.uses_max) return null;
  
  db.prepare('UPDATE character_features SET uses_current = uses_current + 1 WHERE id = ?').run(feature.id);
  return db.prepare('SELECT * FROM character_features WHERE id = ?').get(feature.id);
}

function resetCharacterFeatures(characterId, resetType) {
  const db = getDb();
  db.prepare(`
    UPDATE character_features 
    SET uses_current = 0 
    WHERE character_id = ? AND (reset_type = ? OR reset_type = 'short rest')
  `).run(characterId, resetType);
}

function saveCharacterInventory(characterId, inventory) {
  const db = getDb();
  const deleteStmt = db.prepare('DELETE FROM character_inventory WHERE character_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO character_inventory (character_id, item_name, item_type, quantity, damage, damage_type, bonus, equipped, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const transaction = db.transaction(() => {
    deleteStmt.run(characterId);
    for (const item of inventory) {
      insertStmt.run(
        characterId,
        item.name,
        item.type || null,
        item.quantity || 1,
        item.damage || null,
        item.damageType || null,
        item.bonus || null,
        item.equipped ? 1 : 0,
        item.description || null
      );
    }
  });
  
  transaction();
}

function addToInventory(characterId, item) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM character_inventory WHERE character_id = ? AND item_name = ?').get(characterId, item.name);
  
  if (existing) {
    db.prepare('UPDATE character_inventory SET quantity = quantity + ? WHERE id = ?').run(item.quantity || 1, existing.id);
  } else {
    db.prepare(`
      INSERT INTO character_inventory (character_id, item_name, item_type, quantity, damage, damage_type, bonus, equipped, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      characterId,
      item.name,
      item.type || null,
      item.quantity || 1,
      item.damage || null,
      item.damageType || null,
      item.bonus || null,
      item.equipped ? 1 : 0,
      item.description || null
    );
  }
}

function removeFromInventory(characterId, itemName, quantity = 1) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM character_inventory WHERE character_id = ? AND item_name = ?').get(characterId, itemName);
  
  if (!existing) return false;
  
  if (existing.quantity <= quantity) {
    db.prepare('DELETE FROM character_inventory WHERE id = ?').run(existing.id);
  } else {
    db.prepare('UPDATE character_inventory SET quantity = quantity - ? WHERE id = ?').run(quantity, existing.id);
  }
  return true;
}

function getCharacterInventory(characterId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM character_inventory WHERE character_id = ?').all(characterId);
  return rows.map(row => ({
    name: row.item_name,
    type: row.item_type,
    quantity: row.quantity,
    damage: row.damage,
    damageType: row.damage_type,
    bonus: row.bonus,
    equipped: row.equipped === 1,
    description: row.description
  }));
}

function equipItem(characterId, itemName, equipped = true) {
  const db = getDb();
  db.prepare('UPDATE character_inventory SET equipped = ? WHERE character_id = ? AND item_name = ?').run(equipped ? 1 : 0, characterId, itemName);
}

function getCharacterNotes(characterId) {
  const db = getDb();
  return db.prepare('SELECT * FROM character_notes WHERE character_id = ? ORDER BY created_at DESC').all(characterId);
}

function addCharacterNote(characterId, noteType, title, content, sessionId = null) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO character_notes (character_id, note_type, title, content, session_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(characterId, noteType, title, content, sessionId);
  return result.lastInsertRowid;
}

function getLastPlayedCharacter(playerId, guildId) {
  const db = getDb();
  const character = db.prepare(`
    SELECT * FROM characters 
    WHERE player_id = ? AND guild_id = ? AND active = 1
    ORDER BY last_played DESC
    LIMIT 1
  `).get(playerId, guildId);
  
  if (!character) return null;
  
  character.stats = getCharacterStats(character.id);
  character.skills = getCharacterSkills(character.id);
  character.saves = getCharacterSaves(character.id);
  character.inventory = getCharacterInventory(character.id);
  character.features = getCharacterFeatures(character.id);
  
  return character;
}

function copyCharacter(sourceCharacterId, newPlayerId, newGuildId, newName, copyType = 'full') {
  const db = getDb();
  const source = getCharacter(sourceCharacterId);
  if (!source) return null;
  
  ensurePlayer(newPlayerId, 'Unknown');
  
  const insertChar = db.prepare(`
    INSERT INTO characters (player_id, guild_id, name, class, level, background, alignment, original_character_id, is_copy, copy_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  
  const result = insertChar.run(
    newPlayerId,
    newGuildId,
    newName || source.name,
    source.class,
    source.level,
    source.background,
    source.alignment,
    sourceCharacterId,
    copyType
  );
  
  const newCharId = result.lastInsertRowid;
  
  const stats = source.stats;
  if (copyType === 'full' && stats) {
    saveCharacterStats(newCharId, stats);
  } else if (stats) {
    const baseStats = {
      strength: stats.strength || 10,
      dexterity: stats.dexterity || 10,
      constitution: stats.constitution || 10,
      intelligence: stats.intelligence || 10,
      wisdom: stats.wisdom || 10,
      charisma: stats.charisma || 10,
      ac: stats.ac || 10,
      hp_current: stats.hp_current || stats.hp_max || 10,
      hp_max: stats.hp_max || 10,
      initiative: stats.initiative || 0,
      proficiency_bonus: stats.proficiency_bonus || 2,
      conditions: []
    };
    saveCharacterStats(newCharId, baseStats);
  }
  
  if (copyType === 'full') {
    if (source.skills) saveCharacterSkills(newCharId, source.skills);
    if (source.saves) saveCharacterSaves(newCharId, source.saves);
    if (source.features) saveCharacterFeatures(newCharId, source.features);
  }
  
  if (copyType === 'full' && source.inventory) {
    const cleanInventory = source.inventory.filter(item => {
      const name = item.name?.toLowerCase() || '';
      return !name.includes('gold') && !name.includes('gp');
    });
    saveCharacterInventory(newCharId, cleanInventory);
  }
  
  return getCharacter(newCharId);
}

function swapCharacter(charId, swappedWithCharId, guildId) {
  const db = getDb();
  
  const currentChar = getCharacter(charId);
  if (!currentChar) return null;
  
  const swapState = JSON.stringify({
    hp_current: currentChar.stats?.hp_current,
    hp_max: currentChar.stats?.hp_max,
    inventory: currentChar.inventory,
    conditions: currentChar.stats?.conditions,
    features: currentChar.features?.map(f => ({ name: f.name, uses_current: f.uses_current }))
  });
  
  db.prepare(`
    INSERT INTO character_swaps (character_id, swapped_with_id, guild_id, swap_state)
    VALUES (?, ?, ?, ?)
  `).run(charId, swappedWithCharId, guildId, swapState);
  
  return getCharacter(charId);
}

function restoreSwappedCharacter(charId) {
  const db = getDb();
  
  const swap = db.prepare(`
    SELECT * FROM character_swaps 
    WHERE character_id = ? AND restored_at IS NULL
    ORDER BY swapped_at DESC
    LIMIT 1
  `).get(charId);
  
  if (!swap || !swap.swap_state) return null;
  
  const state = JSON.parse(swap.swap_state);
  
  if (state.hp_current !== undefined) {
    updateCharacterHP(charId, state.hp_current, state.hp_max);
  }
  
  if (state.inventory) {
    saveCharacterInventory(charId, state.inventory);
  }
  
  if (state.conditions) {
    updateCharacterConditions(charId, state.conditions);
  }
  
  if (state.features) {
    for (const f of state.features) {
      db.prepare(`
        UPDATE character_features SET uses_current = ? 
        WHERE character_id = ? AND name = ?
      `).run(f.uses_current, charId, f.name);
    }
  }
  
  db.prepare('UPDATE character_swaps SET restored_at = CURRENT_TIMESTAMP WHERE id = ?').run(swap.id);
  
  return getCharacter(charId);
}

function savePendingAction(guildId, userId, actionType, data, messageId = null, expiresInMinutes = 5) {
  const db = getDb();
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();
  
  const result = db.prepare(`
    INSERT INTO pending_actions (guild_id, user_id, action_type, data, message_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, userId, actionType, JSON.stringify(data), messageId, expiresAt);
  
  return result.lastInsertRowid;
}

function getPendingAction(guildId, userId, actionType = null) {
  const db = getDb();
  let query = `
    SELECT * FROM pending_actions 
    WHERE guild_id = ? AND user_id = ? AND expires_at > datetime('now')
  `;
  const params = [guildId, userId];
  
  if (actionType) {
    query += ' AND action_type = ?';
    params.push(actionType);
  }
  
  query += ' ORDER BY created_at DESC LIMIT 1';
  
  const action = db.prepare(query).get(...params);
  if (action) {
    action.data = JSON.parse(action.data);
  }
  return action;
}

function clearPendingAction(actionId) {
  const db = getDb();
  db.prepare('DELETE FROM pending_actions WHERE id = ?').run(actionId);
}

function clearExpiredPendingActions() {
  const db = getDb();
  db.prepare("DELETE FROM pending_actions WHERE expires_at < datetime('now')").run();
}

function getGuildCharacterWithOwner(guildId, characterName) {
  const db = getDb();
  const character = db.prepare(`
    SELECT c.*, p.username as owner_name, p.id as owner_id
    FROM characters c
    JOIN players p ON c.player_id = p.id
    WHERE c.guild_id = ? AND LOWER(c.name) = LOWER(?)
  `).get(guildId, characterName);
  
  if (!character) return null;
  
  character.stats = getCharacterStats(character.id);
  character.skills = getCharacterSkills(character.id);
  character.saves = getCharacterSaves(character.id);
  character.inventory = getCharacterInventory(character.id);
  character.features = getCharacterFeatures(character.id);
  
  return character;
}

module.exports = {
  ensurePlayer,
  getPlayer,
  createCharacter,
  getCharacter,
  getCharacterByName,
  getCharacterByNameGlobal,
  getGuildCharacterWithOwner,
  listCharacters,
  listGuildCharacters,
  updateCharacter,
  updateCharacterLastPlayed,
  deleteCharacter,
  hardDeleteCharacter,
  saveCharacterStats,
  updateCharacterHP,
  updateCharacterConditions,
  getCharacterStats,
  saveCharacterSkills,
  getCharacterSkills,
  saveCharacterSaves,
  getCharacterSaves,
  saveCharacterFeatures,
  getCharacterFeatures,
  useCharacterFeature,
  resetCharacterFeatures,
  saveCharacterInventory,
  addToInventory,
  removeFromInventory,
  getCharacterInventory,
  equipItem,
  getCharacterNotes,
  addCharacterNote,
  getLastPlayedCharacter,
  copyCharacter,
  swapCharacter,
  restoreSwappedCharacter,
  savePendingAction,
  getPendingAction,
  clearPendingAction,
  clearExpiredPendingActions
};
