const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'bot.db');

let db = null;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initializeDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      world_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(guild_id, name)
    );

    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL REFERENCES players(id),
      guild_id TEXT NOT NULL,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      class TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      experience INTEGER DEFAULT 0,
      background TEXT,
      alignment TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_played DATETIME,
      original_character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
      is_copy INTEGER DEFAULT 0,
      copy_type TEXT,
      UNIQUE(player_id, guild_id, name)
    );

    CREATE TABLE IF NOT EXISTS character_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      strength INTEGER,
      dexterity INTEGER,
      constitution INTEGER,
      intelligence INTEGER,
      wisdom INTEGER,
      charisma INTEGER,
      ac INTEGER,
      hp_current INTEGER,
      hp_max INTEGER,
      initiative INTEGER,
      proficiency_bonus INTEGER,
      speed TEXT,
      hit_dice TEXT,
      spellcasting_ability TEXT,
      spell_save_dc INTEGER,
      spell_attack_bonus INTEGER,
      conditions TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(character_id)
    );

    CREATE TABLE IF NOT EXISTS character_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      skill_name TEXT NOT NULL,
      modifier INTEGER,
      proficient INTEGER DEFAULT 0,
      UNIQUE(character_id, skill_name)
    );

    CREATE TABLE IF NOT EXISTS character_saves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      save_name TEXT NOT NULL,
      modifier INTEGER,
      proficient INTEGER DEFAULT 0,
      UNIQUE(character_id, save_name)
    );

    CREATE TABLE IF NOT EXISTS character_features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      uses_current INTEGER DEFAULT 0,
      uses_max INTEGER DEFAULT 0,
      reset_type TEXT,
      UNIQUE(character_id, name)
    );

    CREATE TABLE IF NOT EXISTS character_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      item_type TEXT,
      quantity INTEGER DEFAULT 1,
      damage TEXT,
      damage_type TEXT,
      bonus INTEGER,
      equipped INTEGER DEFAULT 0,
      description TEXT,
      UNIQUE(character_id, item_name)
    );

    CREATE TABLE IF NOT EXISTS game_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
      world_id TEXT,
      world_name TEXT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      duration_minutes INTEGER,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS session_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      character_id INTEGER NOT NULL REFERENCES characters(id),
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      left_at DATETIME,
      UNIQUE(session_id, character_id)
    );

    CREATE TABLE IF NOT EXISTS game_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
      character_id INTEGER REFERENCES characters(id),
      event_type TEXT NOT NULL,
      roll_type TEXT,
      roll_result INTEGER,
      roll_total INTEGER,
      dc INTEGER,
      success INTEGER,
      damage_dealt INTEGER,
      damage_type TEXT,
      healing_done INTEGER,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS character_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      note_type TEXT,
      title TEXT,
      content TEXT,
      session_id INTEGER REFERENCES game_sessions(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS character_swaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      swapped_with_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
      guild_id TEXT NOT NULL,
      swapped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      restored_at DATETIME,
      swap_state TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      data TEXT NOT NULL,
      message_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_characters_player ON characters(player_id);
    CREATE INDEX IF NOT EXISTS idx_characters_guild ON characters(guild_id);
    CREATE INDEX IF NOT EXISTS idx_characters_campaign ON characters(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_characters_original ON characters(original_character_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_guild ON game_sessions(guild_id);
    CREATE INDEX IF NOT EXISTS idx_events_session ON game_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_character ON character_inventory(character_id);
    CREATE INDEX IF NOT EXISTS idx_features_character ON character_features(character_id);
    CREATE INDEX IF NOT EXISTS idx_swaps_character ON character_swaps(character_id);
    CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_actions(user_id, guild_id);

    -- Character sheet blob storage (preserves the full YAML-derived object as JSON)
    CREATE TABLE IF NOT EXISTS character_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      character_name TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(player_id, guild_id, character_name)
    );

    CREATE INDEX IF NOT EXISTS idx_sheets_player_guild ON character_sheets(player_id, guild_id);

    -- Persisted game session state (survives bot restarts)
    CREATE TABLE IF NOT EXISTS session_state (
      guild_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log('✅ Database initialized successfully');
  return db;
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  initializeDatabase,
  closeDatabase,
  DB_PATH
};
