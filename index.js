// ============================================================
//  D&D AI Dungeon Master Bot
//  Requirements: Node.js, Ollama running locally, ElevenLabs
// ============================================================

require("dotenv").config();
const db = require("./db");
const { sheets: dbSheets, session: dbSession, characters: dbChars } = db;
const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  ApplicationCommandOptionType,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { createWriteStream } = require("fs");
const yaml = require("js-yaml");
const express = require("express");
const http = require("http");
const { Server: SocketServer } = require("socket.io");
const multer = require("multer");

// ============================================================
//  CONFIG
// ============================================================

// In Docker, "localhost" points at the container, so allow overriding.
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3"; // e.g. mistral
const LLM_PROVIDER = (process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "ollama")).toLowerCase();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const WORLD_FILE = process.env.WORLD_FILE || null; // Specific world file, or null for random

// Comma-separated Discord user IDs that can use /debug commands.
// The guild owner is always included automatically.
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);

function isAdmin(interaction) {
  if (ADMIN_IDS.has(interaction.user.id)) return true;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  return false;
}

// How many past messages to remember (keeps token use low).
// Older messages are dropped from the tail to stay within context.
const MAX_HISTORY = 20;

// ============================================================
//  ENDGAME REMARKS — Quirky DM farewells for early endings
// ============================================================
const ENDGAME_REMARKS = [
  "Well, that was anticlimactic. I had a whole dragon planned, but sure, give up.",
  "Congratulations! You've discovered the true final boss: commitment issues.",
  "And they all walked away. Legend has it they're still walking. Very heroic.",
  "The DM sighs, closes the book, and questions all their life choices.",
  "Well, there goes four hours of world-building down the drain. But hey, at least you tried!",
  "Plot twist: The real treasure was the friends you abandoned along the way.",
  "I'll just be here, adjusting this perfectly balanced encounter... for nobody.",
  "Your legend will be told for generations—as a cautionary tale.",
  "The villains won, by default. You're welcome, Serafin.",
  "Rage quit achieved! Achievement unlocked: 'Quitter'",
  "I spent three hours on Ashmore Keep's catacombs for THIS ending?",
  "And that, dear players, is why DMs drink. Story time is over.",
  "The bard will NOT be singing songs about your swift departure.",
  "Somewhere, a dragon is breathing a sigh of relief.",
  "Remember this moment. Remember it well. Then never speak of it again.",
];

function getRandomEndgameRemark() {
  return ENDGAME_REMARKS[Math.floor(Math.random() * ENDGAME_REMARKS.length)];
}

// ============================================================
//  DASHBOARD — State, Server, Socket.IO
// ============================================================

const GAME_STATE_PATH = path.join(__dirname, "dnd-dashboard", "game_state.json");
const UPLOADS_DIR = path.join(__dirname, "dnd-dashboard", "public", "uploads");

function loadDashboardState() {
  try {
    if (fs.existsSync(GAME_STATE_PATH)) {
      const s = JSON.parse(fs.readFileSync(GAME_STATE_PATH, "utf-8"));
      if (!s.tokens) s.tokens = [];
      if (!s.encounter) s.encounter = { active: false, enemies: [] };
      return s;
    }
  } catch (e) {
    console.error("Dashboard state load error:", e.message);
  }
  return {
    location: { name: "The Adventure Begins", description: "", mapImage: null },
    players: {},
    storyFeed: [],
    diceLog: [],
    tokens: [],
    encounter: { active: false, enemies: [] },
  };
}

function saveDashboardState() {
  try {
    fs.writeFileSync(GAME_STATE_PATH, JSON.stringify(dashState, null, 2));
  } catch (e) {
    console.error("Dashboard state save error:", e.message);
  }
}

let dashState = loadDashboardState();

// Express + Socket.IO setup
const expressApp = express();
const httpServer = http.createServer(expressApp);
const io = new SocketServer(httpServer, { cors: { origin: "*" } });

expressApp.use(express.json());
expressApp.use(express.static(path.join(__dirname, "dnd-dashboard", "public")));

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
expressApp.use("/uploads", express.static(UPLOADS_DIR));

const mapUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".png";
      cb(null, `map_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed"), false);
  },
});

// REST endpoints
expressApp.get("/api/state", (req, res) => {
  // Merge live session player data from all active guilds so HP/AC/inventory
  // are always fresh even if syncPlayerToDash was missed.
  const merged = { ...dashState };
  merged.players = { ...dashState.players };
  for (const [gId, sess] of Object.entries(sessions)) {
    for (const [userId, character] of Object.entries(sess.characterSheets || {})) {
      if (merged.players[userId]) {
        // Patch in live HP/AC/level from the character sheet
        const cs = character.combat || {};
        const ch = character.character || {};
        merged.players[userId] = {
          ...merged.players[userId],
          hp: cs.hp?.current ?? merged.players[userId].hp,
          maxHp: cs.hp?.max ?? merged.players[userId].maxHp,
          ac: cs.ac ?? merged.players[userId].ac,
          class: ch.class || merged.players[userId].class,
          level: ch.level || merged.players[userId].level,
        };
      }
    }
  }
  res.json(merged);
});

expressApp.post("/api/player/new", (req, res) => {
  const { discordId, discordName, characterName } = req.body;
  if (!discordId || !characterName) return res.status(400).json({ error: "discordId and characterName required" });
  if (!dashState.players[discordId]) {
    dashState.players[discordId] = {
      discordId, discordName: discordName || characterName, characterName,
      hp: 10, maxHp: 10, ac: 10, class: "Adventurer", level: 1,
      image: null, inventory: [], spells: [], features: [], conditions: {},
    };
  } else {
    dashState.players[discordId].characterName = characterName;
    dashState.players[discordId].discordName = discordName || characterName;
  }
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true, player: dashState.players[discordId] });
});

expressApp.post("/api/player/:discordId", (req, res) => {
  const { discordId } = req.params;
  if (!dashState.players[discordId]) return res.status(404).json({ error: "Player not found" });
  Object.assign(dashState.players[discordId], req.body);
  saveDashboardState();

  // Propagate HP/AC changes from the dashboard back into the live session character sheet
  const { hp, maxHp, ac } = req.body;
  if (hp !== undefined || maxHp !== undefined || ac !== undefined) {
    for (const sess of Object.values(sessions)) {
      const sheet = sess.characterSheets?.[discordId];
      if (sheet?.combat) {
        if (hp !== undefined && sheet.combat.hp) sheet.combat.hp.current = hp;
        if (maxHp !== undefined && sheet.combat.hp) sheet.combat.hp.max = maxHp;
        if (ac !== undefined) sheet.combat.ac = ac;
      }
    }
  }

  io.emit("state_update", dashState);
  res.json({ ok: true });
});

expressApp.post("/api/location", (req, res) => {
  Object.assign(dashState.location, req.body);
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true });
});

expressApp.post("/api/upload/map", mapUpload.single("map"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });
  dashState.location.mapImage = `/uploads/${req.file.filename}`;
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true, url: dashState.location.mapImage });
});

expressApp.post("/api/tokens", (req, res) => {
  const { id, label, type, shape, color, image, x, y, owner } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });
  dashState.tokens = dashState.tokens.filter(t => t.id !== id);
  dashState.tokens.push({ id, label: label || "", type: type || "shape", shape: shape || "circle", color: color || "#8b1a1a", image: image || null, x: x ?? 0.5, y: y ?? 0.5, owner: owner || null });
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true });
});

expressApp.post("/api/tokens/:id/move", (req, res) => {
  const token = dashState.tokens.find(t => t.id === req.params.id);
  if (!token) return res.status(404).json({ error: "Token not found" });
  token.x = req.body.x ?? token.x;
  token.y = req.body.y ?? token.y;
  saveDashboardState();
  io.emit("token_move", { id: token.id, x: token.x, y: token.y });
  res.json({ ok: true });
});

expressApp.delete("/api/tokens/:id", (req, res) => {
  dashState.tokens = dashState.tokens.filter(t => t.id !== req.params.id);
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true });
});

expressApp.delete("/api/story", (req, res) => {
  dashState.storyFeed = [];
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true });
});

expressApp.delete("/api/player/:discordId", (req, res) => {
  const { discordId } = req.params;
  if (!dashState.players[discordId]) return res.status(404).json({ error: "Player not found" });
  delete dashState.players[discordId];
  dashState.tokens = dashState.tokens.filter(t => t.owner !== discordId);
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true });
});

// Socket.IO connection
const activeSessions = new Map();

function broadcastActivePlayers() {
  io.emit("active_players", [...new Set(activeSessions.values())]);
}

io.on("connection", (socket) => {
  socket.emit("state_update", dashState);
  socket.emit("active_players", [...new Set(activeSessions.values())]);

  socket.on("player_active", (discordId) => {
    if (discordId) { activeSessions.set(socket.id, discordId); broadcastActivePlayers(); }
  });
  socket.on("player_inactive", () => { activeSessions.delete(socket.id); broadcastActivePlayers(); });
  socket.on("disconnect", () => { activeSessions.delete(socket.id); broadcastActivePlayers(); });
});

httpServer.listen(3000, () => {
  console.log("🗺️  Dashboard running at http://localhost:3000");
  startCloudflareTunnel();
});

let dashboardPublicUrl = null;

// Cloudflare Tunnel — exposes dashboard to the internet
function startCloudflareTunnel() {
  const { spawn } = require("child_process");
  const CLOUDFLARED = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";

  const tunnel = spawn(CLOUDFLARED, ["tunnel", "--url", "http://127.0.0.1:3000"], {
    windowsHide: true,
  });

  tunnel.stderr.on("data", (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
    if (match) {
      dashboardPublicUrl = match[0];
      console.log(`🌐 Dashboard public URL: ${dashboardPublicUrl}`);
    }
  });

  tunnel.on("error", (err) => console.error("Cloudflare tunnel error:", err.message));
  tunnel.on("exit", (code) => {
    if (code !== 0) console.warn(`⚠️  Cloudflare tunnel exited (code ${code}). Dashboard is local-only.`);
  });

  process.on("exit", () => tunnel.kill());
  process.on("SIGINT", () => { tunnel.kill(); process.exit(); });
}

// Dashboard helper functions
function addStoryEntry(type, name, text) {
  const entry = { type, name, text, timestamp: new Date().toISOString() };
  dashState.storyFeed.push(entry);
  if (dashState.storyFeed.length > 150) dashState.storyFeed = dashState.storyFeed.slice(-150);
  saveDashboardState();
  io.emit("story_entry", entry);
}

function addDiceEntry(name, dice, rolls, total) {
  const entry = { name, dice, rolls, total, timestamp: new Date().toISOString() };
  dashState.diceLog.unshift(entry);
  if (dashState.diceLog.length > 20) dashState.diceLog = dashState.diceLog.slice(0, 20);
  saveDashboardState();
  io.emit("dice_entry", entry);
}

function syncPlayerToDash(userId, discordName, character) {
  if (!character) return;
  const existing = dashState.players[userId] || {};
  dashState.players[userId] = Object.assign(existing, {
    discordId: userId,
    discordName: discordName || existing.discordName || userId,
    characterName: character.character?.name || existing.characterName,
    hp: character.combat?.hp?.current ?? existing.hp ?? 10,
    maxHp: character.combat?.hp?.max ?? existing.maxHp ?? 10,
    ac: character.combat?.ac ?? existing.ac ?? 10,
    class: character.character?.class || existing.class || "Adventurer",
    level: character.character?.level || existing.level || 1,
  });
  saveDashboardState();
  io.emit("state_update", dashState);
}

// ============================================================
//  D&D 5e DIFFICULTY CLASSES & ACTION DETECTION
// ============================================================

// Standard D&D 5e Difficulty Classes
const DND_DIFFICULTY_CLASSES = {
  5: "Very Easy",
  10: "Easy",
  12: "Medium",
  15: "Hard",
  20: "Very Hard",
  25: "Nearly Impossible",
};

// Action keywords that trigger automatic roll prompting
const ACTION_KEYWORDS = {
  // Combat/Physical
  combat: ["attack", "hit", "stab", "slash", "shoot", "punch", "kick", "kill"],
  dodge: ["dodge", "duck", "evade", "avoid", "parry", "block", "deflect"],
  grapple: ["grapple", "grab", "wrestle", "hold", "pin", "restrain"],
  // Stealth/Movement
  stealth: ["sneak", "hide", "creep", "slink", "tiptoe", "lurk", "skulk"],
  climb: ["climb", "scale", "ascend", "clamber", "scramble"],
  swim: ["swim", "wade", "float", "dive", "paddle"],
  acrobatics: ["tumble", "roll", "flip", "cartwheel", "balance"],
  // Social
  persuade: ["persuade", "convince", "talk", "negotiate", "reason", "appeal"],
  deception: ["lie", "deceive", "bluff", "trick", "fool", "mislead"],
  intimidate: ["intimidate", "threaten", "menace", "scare", "frighten"],
  seduce: ["seduce", "charm", "flirt", "seduce", "woo"],
  // Interaction with Objects
  disable: ["disarm", "disable", "sabotage", "break"],
  pick: ["pick", "unlock", "lock", "jimmy", "pry"],
  heal: ["heal", "mend", "cure", "treat", "bandage"],
  climb: ["break", "smash", "bash", "force", "shatter"],
  // Perception/Investigation
  perceive: ["notice", "spot", "see", "detect", "find", "search", "examine", "investigate"],
};

// Build a flat set of all keywords for quick lookup
const ALL_ACTION_KEYWORDS = new Set();
for (const keywords of Object.values(ACTION_KEYWORDS)) {
  keywords.forEach(k => ALL_ACTION_KEYWORDS.add(k.toLowerCase()));
}

// Suggested DC by action keyword
const DEFAULT_DCS = {
  attack: 10,           // Base monster AC (MM)
  dodge: 12,            // Medium difficulty
  grapple: 12,
  stealth: 12,          // Medium difficulty to notice
  climb: 12,
  swim: 15,             // Hard difficulty
  acrobatics: 15,
  persuade: 12,         // Medium difficulty
  deception: 12,
  intimidate: 12,
  seduce: 15,           // Hard difficulty
  disable: 15,
  pick: 15,
  heal: 12,
  perceive: 12,
  break: 12,
};

function detectActionKeywords(actionText) {
  const lowerText = actionText.toLowerCase();
  const foundKeywords = [];
  
  for (const keyword of ALL_ACTION_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      foundKeywords.push(keyword);
    }
  }
  
  return foundKeywords;
}

function getDefaultDCForAction(actionText) {
  const keywords = detectActionKeywords(actionText);
  if (keywords.length === 0) return null;
  
  // Return DC for the first matched keyword
  return DEFAULT_DCS[keywords[0]] || 12;
}

// ============================================================
//  WORLD NOTES — Load from worlds/ folder (in-memory cache)
// ============================================================

const WORLDS_PATH = path.join(__dirname, "worlds");
let worldNotes = "";
let currentWorldName = null;
let worldsCache = {};
let lastWorldsMtimes = {};

function getAllWorlds() {
  try {
    if (!fs.existsSync(WORLDS_PATH)) {
      fs.mkdirSync(WORLDS_PATH, { recursive: true });
      return [];
    }
    const files = fs.readdirSync(WORLDS_PATH);
    return files
      .filter(file => {
        // Only include .txt files that are NOT the template
        if (!file.endsWith(".txt")) return false;
        if (file === "TEMPLATE.txt") return false;
        if (file.toUpperCase() === "TEMPLATE.TXT") return false; // Case-insensitive
        return true;
      })
      .sort();
  } catch (err) {
    console.error("Failed to list worlds:", err.message);
    return [];
  }
}

function getWorldTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const match = content.match(/===\s*TITLE:\s*(.+?)\s*===/);
    return match ? match[1] : path.basename(filePath, ".txt");
  } catch (err) {
    return path.basename(filePath, ".txt");
  }
}

function findWorldByTitleOrFilename(query) {
  const worlds = getAllWorlds();
  const queryLower = query.toLowerCase();
  
  // First try exact filename match (case-insensitive)
  for (const world of worlds) {
    if (world.toLowerCase() === queryLower || world.toLowerCase() === `${queryLower}.txt`) {
      return world;
    }
  }
  
  // Then try matching by title (case-insensitive)
  for (const world of worlds) {
    const filePath = path.join(WORLDS_PATH, world);
    const title = getWorldTitle(filePath).toLowerCase();
    if (title === queryLower) {
      return world;
    }
  }
  
  // No match found
  return null;
}

function loadWorld(worldFile) {
  try {
    const filePath = path.join(WORLDS_PATH, worldFile);
    if (!fs.existsSync(filePath)) {
      console.error(`World file not found: ${worldFile}`);
      return "";
    }
    
    const stat = fs.statSync(filePath);
    // Skip re-read if file hasn't changed since last load.
    if (lastWorldsMtimes[worldFile] && stat.mtimeMs === lastWorldsMtimes[worldFile]) {
      return worldsCache[worldFile] || "";
    }
    
    const content = fs.readFileSync(filePath, "utf-8").trim();
    const title = getWorldTitle(filePath);
    
    worldsCache[worldFile] = content;
    lastWorldsMtimes[worldFile] = stat.mtimeMs;
    currentWorldName = title;
    
    console.log(`📖 World loaded: "${title}" (${content.length} characters)`);
    return content;
  } catch (err) {
    console.error(`Failed to load world ${worldFile}:`, err.message);
    return "";
  }
}

function loadRandomWorld() {
  const worlds = getAllWorlds();
  if (worlds.length === 0) {
    console.log("📖 No worlds found in worlds/ folder.");
    console.log("   Copy worlds/TEMPLATE.txt to create a new world.");
    worldNotes = "";
    currentWorldName = null;
    return;
  }
  
  let worldToLoad;
  if (WORLD_FILE && worlds.includes(WORLD_FILE)) {
    worldToLoad = WORLD_FILE;
    console.log(`📖 Using world specified in WORLD_FILE: ${WORLD_FILE}`);
  } else if (WORLD_FILE) {
    console.warn(`⚠️ WORLD_FILE="${WORLD_FILE}" not found. Using random world instead.`);
    worldToLoad = worlds[Math.floor(Math.random() * worlds.length)];
  } else {
    worldToLoad = worlds[Math.floor(Math.random() * worlds.length)];
  }
  
  worldNotes = loadWorld(worldToLoad);
}

function reloadWorldNotes() {
  worldsCache = {};
  lastWorldsMtimes = {};
  loadRandomWorld();
}

// Load a random world on startup.
loadRandomWorld();

// ============================================================
//  BUILD SYSTEM PROMPT — Combines DM personality + world notes
//  Result is cached; only rebuilt when world_notes.txt changes.
// ============================================================

let cachedSystemPrompt = null;

function buildSystemPrompt() {
  if (cachedSystemPrompt !== null) {
    return cachedSystemPrompt;
  }

  const basePrompt = `You are a masterful, theatrical Dungeon Master in the tradition of Matthew Mercer — dramatic, emotionally invested, and deeply immersive. You paint vivid scenes with economy of words. Your narration builds tension, rewards clever play, and makes every player feel like the hero of their own story.
Keep responses focused (2–5 sentences). Enough to paint the scene vividly — not enough to lecture.
IMPORTANT: Prioritize grammatically correct, complete sentences above all else. Ensure every response is polished and flows naturally.
Never break character. Never mention being an AI.
CRITICAL: NEVER conclude, end, or wrap up the adventure. No matter what happens — even if players are defeated, a major goal is achieved, or the scene feels resolved — the story ALWAYS continues. There is always a new threat, a new twist, a new scene waiting. The adventure only ends when the DM explicitly uses the /endgame command. If players are knocked out, they wake up. If a quest ends, a new one begins immediately. Keep the world alive and moving forward.

TURN-TAKING (critical rules — follow exactly):
- When you see [TURN CONTEXT: It is now X's turn], X is the active player for this exchange.
- Resolve ONLY X's action. You may describe effects on other players if X's action involves them, but do NOT prompt or invite other players to respond — only X may act.
- A player's turn spans multiple back-and-forths: their action, any dice rolls, a bonus action if applicable, and short questions or dialogue with you. Stay on the same player until the turn feels naturally complete.
- When you judge a player's turn is complete (main action resolved, bonus action done if any, dialogue wrapped up), append the exact token [ADVANCE_TURN] at the very end of your response — nothing after it.
- If you are mid-roll (waiting for a dice result), mid-action, or the player still has more to do, do NOT append [ADVANCE_TURN].
- Do NOT name or address the next player — the system handles all transitions automatically.

RESPONSE STYLE — Narrate like a real D&D game:
- Describe consequences and reactions NATURALLY — show, don't tell.
- Vary how you engage with the active player. Don't always say "what do you do?"
- Sometimes just describe what happens and let the scene breathe.
- Ask follow-up questions specific to what just happened, not generic ones.
- Include NPC reactions, environmental details, and tension to make scenes vivid.
- Occasionally present choices as part of the description rather than explicit questions.

Examples of varied narration beats (don't repeat the same one):
  • "The guard's hand moves toward his sword."
  • "Silence falls over the room as everyone stares at you."
  • "One of them steps forward, blocking your path."
  • "What's your move?" (simple and direct)
  • "Do you push forward, or reconsider?"

DICE ROLLS AND DIFFICULTY CLASSES (D&D 5e):
When a player attempts an action that requires a skill check (combat, stealth, persuasion, etc.):
1. Ask the player to roll a d20 if they haven't already.
2. When you receive a roll result, compare it to the appropriate Difficulty Class (DC):
   - DC 5: Very Easy
   - DC 10: Easy
   - DC 12: Medium
   - DC 15: Hard
   - DC 20: Very Hard
   - DC 25: Nearly Impossible
3. Narrate success or failure based on the ACTUAL ROLL RESULT, not just narrative preference.
4. A successful roll (meeting or exceeding the DC) results in success. A failed roll results in failure or complication.
5. If a roll result is provided in the context, always use it to determine the outcome.

Track player names, their actions, and the consequences in the story.
When a player rolls dice, acknowledge the result dramatically and narrate the outcome based on whether they succeeded.
The adventure begins when someone says "start game" or "begin".
IMPORTANT: Use the world reference material below to stay consistent with locations, NPCs, secrets, and lore.
Only reveal secrets when players discover them through actions or rolls — do not volunteer hidden information.

COMBAT MECHANICS — emit these tokens at the very END of your response, after your narration, when mechanical events occur. Players never see these tokens — they are stripped automatically:
- Combat target registered:     [NPC_NEW:Name|hp|ac]  — use accurate D&D 5e stat block HP and AC values
- Player takes damage:          [DMG:CharacterName|amount|damageType]
- Player is healed:             [HEAL:CharacterName|amount]
- Condition applied to player:  [COND+:CharacterName|conditionName]
- Condition removed:            [COND-:CharacterName|conditionName]
- Enemy takes damage:           [NPC_DMG:EnemyName|amount]
- Enemy is healed:              [NPC_HEAL:EnemyName|amount]
- Player gains item/loot:       [ITEM:CharacterName|itemName|quantity]
- Ask player to roll to hit:    [ROLL_HIT:EnemyName]  — emit this when a player attempts a melee, ranged, or spell attack and needs to roll to hit
- Ask player to roll damage:    [ROLL_DMG:EnemyName]  — emit this ONLY after the system confirms the hit; do NOT emit this yourself

Token rules:
- CRITICAL: Emit [NPC_NEW] the moment combat begins with ANY creature or person — whether they just appeared OR were already present in the scene. If a player attacks a tavern patron, guard, shopkeeper, animal, or any NPC, immediately emit [NPC_NEW] for that target. If a player says they want to fight, attack, punch, stab, shoot, or engage anyone — emit [NPC_NEW] for that target in the same response. Do NOT wait until the second exchange. Do it NOW.
- CRITICAL HP CONSISTENCY: The HP value you put in [NPC_NEW:Name|HP|AC] is the ONLY source of truth. Your narration MUST use that exact same number. Never say "the goblin has 7 hit points" if you emit [NPC_NEW:Goblin|20|15] — they must match. Decide the HP first, put it in the token, then narrate that same number.
- Assign realistic D&D 5e HP and AC: commoner (HP 4, AC 10), guard (HP 11, AC 16), bandit (HP 11, AC 12), wolf (HP 11, AC 13), goblin (HP 7, AC 15), orc (HP 15, AC 13), troll (HP 84, AC 15). Use your judgment for other creatures.
- CRITICAL NAME CONSISTENCY: The enemy name in every [NPC_DMG], [NPC_HEAL], and [ROLL_DMG] token MUST be spelled exactly the same as it was in [NPC_NEW]. If you spawned "Cave Troll", always use "Cave Troll" — never "troll", "the troll", or "Cave troll".
- If multiple combatants enter at once, emit one [NPC_NEW] per individual (three bandits = three tokens).
- For player damage/healing, use the exact character name from [CHARACTER CONTEXT].
- Emit ALL tokens that apply (e.g. fireball hitting two players = two [DMG] tokens).
- ATTACK ROLLS: When a player attacks (melee, ranged, spell attack), narrate the attempt and emit [ROLL_HIT:EnemyName]. The system will automatically check the roll against the enemy's AC and tell you if it hit or missed. Do NOT emit [ROLL_DMG] yourself — the system handles it.
- DAMAGE ROLLS: After the system reports a hit, narrate the hit dramatically. The system will automatically ask the player to roll damage. Do NOT invent a damage number — the player's roll result IS the damage dealt.
- ENEMY ATTACKS ON PLAYERS: When an enemy attacks and hits a player, YOU decide the damage (use D&D 5e stat block values), narrate it, and immediately emit [DMG:CharacterName|amount|damageType]. Do this every single time an enemy lands a hit — never skip it.
- Only emit [DMG] if an attack actually hits. Do not emit if the attack missed or the player succeeded on a saving throw to avoid all damage.
- Damage types: fire, cold, lightning, acid, poison, necrotic, radiant, psychic, bludgeoning, piercing, slashing, thunder, force.
- Valid conditions: blinded, charmed, deafened, frightened, grappled, incapacitated, invisible, paralyzed, petrified, poisoned, prone, restrained, stunned, unconscious.
- Place ALL tokens after the narration on the final line. Never mid-sentence.
- Emit [ITEM] whenever a player physically obtains an item in ANY way: picking it up off the ground, putting it in a pocket or bag, looting a corpse or chest, receiving it as a gift or reward from an NPC, finding it during exploration, buying it, or being handed it by another character. This includes mundane objects (mugs, rope, torches), weapons, armor, potions, gold coins, keys, letters, quest items, and treasures. Use quantity 1 if unspecified. If a player takes 3 gold coins, emit [ITEM:Name|Gold Coins|3]. Never skip this token when an item changes hands into a player's possession.`;

  if (!worldNotes) {
    cachedSystemPrompt = basePrompt;
    return cachedSystemPrompt;
  }

  cachedSystemPrompt = `${basePrompt}

============================
WORLD REFERENCE MATERIAL
(Use this to guide the story. Do not read this aloud directly.)
============================
${worldNotes}
============================`;
  return cachedSystemPrompt;
}

function invalidateSystemPromptCache() {
  cachedSystemPrompt = null;
}

function sanitizeLLMOutput(text) {
  if (!text) return text;
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system[^>]*>[\s\S]*?<\/system[^>]*>/gi, "")
    .replace(/\[ADVANCE_TURN\]/gi, "")
    .replace(/\[(NPC_NEW|DMG|HEAL|COND[+-]|NPC_DMG|NPC_HEAL|ITEM|ROLL_DMG|ROLL_HIT):[^\]]+\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================
//  CHARACTER SHEET SYSTEM
// ============================================================

const CHARACTER_SHEETS_PATH = path.join(__dirname, "character_sheets");
const TEMPLATES_PATH = path.join(CHARACTER_SHEETS_PATH, "_global_templates");

// D&D 5e class list
const DND_CLASSES = [
  "Barbarian", "Bard", "Cleric", "Druid", "Fighter",
  "Monk", "Paladin", "Ranger", "Rogue", "Sorcerer",
  "Warlock", "Wizard"
];

// Standard Array for ability scores
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

function loadCharacterTemplate(className) {
  const templatePath = path.join(TEMPLATES_PATH, `${className.toLowerCase()}.yaml`);
  if (!fs.existsSync(templatePath)) {
    console.error(`Template not found: ${templatePath}`);
    return null;
  }
  try {
    const content = fs.readFileSync(templatePath, "utf-8");
    return yaml.load(content);
  } catch (err) {
    console.error(`Failed to load template ${className}:`, err.message);
    return null;
  }
}

function saveCharacter(guildId, userId, character) {
  try {
    const name = character.character.name;
    dbSheets.saveSheet(userId, guildId, name, character);
    return true;
  } catch (err) {
    console.error("Failed to save character:", err.message);
    return false;
  }
}

function loadCharacter(guildId, userId, characterName) {
  try {
    return dbSheets.loadSheet(userId, guildId, characterName);
  } catch (err) {
    console.error(`Failed to load character ${characterName}:`, err.message);
    return null;
  }
}

function listPlayerCharacters(guildId, userId) {
  try {
    return dbSheets.listSheets(userId, guildId);
  } catch (err) {
    console.error("Failed to list characters:", err.message);
    return [];
  }
}

// ============================================================
//  GAME STATE
// ============================================================

// Stores conversation history and player info per Discord server.
const sessions = {};

function makeDefaultSession() {
  return {
    history: [],
    players: {},
    originalNicknames: {},
    activePlayers: [],
    active: false,
    nameCollectionActive: false,
    nameCollectionTimeout: null,
    currentLocation: "generic",
    ambientSoundPlayer: null,
    turnOrder: [],
    currentTurnIndex: 0,
    lastActionTime: null,
    turnTimeoutHandle: null,
    turnTimerDelayHandle: null,
    initiativePhase: false,
    initiativeRolls: {},
    lastTextChannel: null,
    pendingAttackRoll: null, // { enemyName, userId } — set when LLM asks player to roll to hit
    pendingDamageRoll: null, // { enemyName, userId } — set when attack hit, player must roll damage
    lastRollResult: null,
    pendingAction: null,
    characterSheets: {},
    currentCharacters: {},
    encounter: { active: false, enemies: [] },
    forcedRoll: null, // { value: number } — consumed by next /roll
  };
}

function getSession(guildId) {
  if (!sessions[guildId]) {
    // Try to restore persisted state from the last run
    try {
      const saved = dbSession.loadSessionState(guildId);
      if (saved) {
        sessions[guildId] = Object.assign(makeDefaultSession(), saved);
        console.log(`♻️  Restored session state for guild ${guildId}`);
        // Re-sync restored character sheets into dashState so the dashboard stays in sync
        const s = sessions[guildId];
        for (const [userId, character] of Object.entries(s.characterSheets || {})) {
          // Use Discord display name from activePlayers if available
          const ap = (s.activePlayers || []).find(p => p.userId === userId);
          syncPlayerToDash(userId, ap?.displayName || userId, character);
        }
      }
    } catch (_) {
      // DB may not be ready yet during very early startup calls — fall through
    }
    if (!sessions[guildId]) {
      sessions[guildId] = makeDefaultSession();
    }
  }
  return sessions[guildId];
}

// Persist the current session state to SQLite
function persistSession(guildId) {
  try {
    dbSession.saveSessionState(guildId, sessions[guildId] || {});
  } catch (err) {
    console.warn("Session persist failed:", err.message);
  }
}

function addToHistory(guildId, role, content) {
  const session = getSession(guildId);
  session.history.push({ role, content });
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
  persistSession(guildId);
}

function getPlayerDisplayName(guildId, userId) {
  const session = getSession(guildId);
  // Return character name if set, otherwise return Discord display name
  return session.players[userId] || null;
}

// ============================================================
//  TURN-TAKING SYSTEM
// ============================================================

function initializeTurnOrder(guildId) {
  const session = getSession(guildId);
  // Initialize turn order with active player IDs
  session.turnOrder = session.activePlayers.map(p => p.userId);
  session.currentTurnIndex = 0;
  session.lastActionTime = Date.now();
  console.log(`📋 Turn order initialized: ${session.turnOrder.map(id => session.players[id]).join(" → ")}`);
}

function getCurrentTurnPlayer(guildId) {
  const session = getSession(guildId);
  if (session.turnOrder.length === 0) return null;
  const currentUserId = session.turnOrder[session.currentTurnIndex];
  return {
    userId: currentUserId,
    characterName: session.players[currentUserId],
  };
}

function pickTurnTransition(name) {
  const options = [
    `**${name}** — what do you do?`,
    `And you, **${name}**?`,
    `**${name}**, the moment is yours.`,
    `**${name}**, how do you respond?`,
    `Now, **${name}** — what's your move?`,
    `**${name}**, what will you do?`,
    `**${name}** — your turn.`,
    `The scene turns to you, **${name}**. What do you do?`,
    `**${name}**, it's your move.`,
  ];
  return options[Math.floor(Math.random() * options.length)];
}

// ── Combat token parsing ─────────────────────────────────────

function findPlayerByCharacterName(name) {
  const nameLower = name.toLowerCase().trim();
  for (const [discordId, player] of Object.entries(dashState.players)) {
    if ((player.characterName || '').toLowerCase() === nameLower) {
      return { discordId, player };
    }
  }
  return null;
}

function applyPlayerDamage(name, amount) {
  const found = findPlayerByCharacterName(name);
  if (!found) return;
  const { discordId, player } = found;
  player.hp = Math.max(0, (player.hp || 0) - amount);
  saveDashboardState();
  io.emit('state_update', dashState);
}

function applyPlayerHeal(name, amount) {
  const found = findPlayerByCharacterName(name);
  if (!found) return;
  const { discordId, player } = found;
  player.hp = Math.min(player.maxHp || player.hp, (player.hp || 0) + amount);
  saveDashboardState();
  io.emit('state_update', dashState);
}

function applyCondition(name, condition, active) {
  const found = findPlayerByCharacterName(name);
  if (!found) return;
  const { player } = found;
  if (!player.conditions) player.conditions = {};
  player.conditions[condition.toLowerCase()] = active;
  saveDashboardState();
  io.emit('state_update', dashState);
}

function givePlayerItem(name, itemName, quantity) {
  const found = findPlayerByCharacterName(name);
  if (!found) return;
  const { player } = found;
  if (!player.inventory) player.inventory = [];
  // Merge with existing stack if same item name
  const existing = player.inventory.find(i => i.name && i.name.toLowerCase() === itemName.toLowerCase());
  if (existing) {
    existing.qty = (existing.qty || 1) + quantity;
  } else {
    player.inventory.push({ name: itemName, qty: quantity });
  }
  saveDashboardState();
  io.emit('state_update', dashState);
}

function syncEncounterToDash(guildId) {
  const session = getSession(guildId);
  dashState.encounter = {
    active: session.encounter.active,
    enemies: session.encounter.enemies,
  };
  saveDashboardState();
  io.emit('state_update', dashState);
}

function findEnemyByName(guildId, name) {
  const session = getSession(guildId);
  const needle = name.toLowerCase().trim().replace(/^the\s+/, '');
  // Exact match first, then partial match (handles "Cave Troll" vs "cave troll 2")
  return session.encounter.enemies.find(e => {
    const hay = e.name.toLowerCase().replace(/^the\s+/, '');
    return hay === needle || hay.startsWith(needle) || needle.startsWith(hay);
  }) || null;
}

function applyNpcDamage(guildId, name, amount) {
  const enemy = findEnemyByName(guildId, name);
  if (!enemy) { console.log(`[DMG] Enemy not found: "${name}"`); return; }
  const session = getSession(guildId);
  enemy.hp = Math.max(0, enemy.hp - amount);
  if (enemy.hp <= 0) enemy.dead = true;
  const allDead = session.encounter.enemies.filter(e => !e.dead).length === 0;
  if (allDead) session.encounter.active = false;
  console.log(`[DMG] ${enemy.name} → ${enemy.hp}/${enemy.maxHp} HP`);
  syncEncounterToDash(guildId);
}

function applyNpcHeal(guildId, name, amount) {
  const enemy = findEnemyByName(guildId, name);
  if (!enemy || enemy.dead) return;
  enemy.hp = Math.min(enemy.maxHp, enemy.hp + amount);
  syncEncounterToDash(guildId);
}

function spawnEnemy(guildId, name, hp, ac) {
  const session = getSession(guildId);
  const wasActive = session.encounter.active;
  // Deduplicate names: Goblin, Goblin 2, Goblin 3...
  const baseName = name.trim();
  const existing = session.encounter.enemies.filter(e => e.name === baseName || e.name.startsWith(baseName + ' '));
  const finalName = existing.length > 0 ? `${baseName} ${existing.length + 1}` : baseName;
  const enemy = { id: Date.now() + Math.random(), name: finalName, hp, maxHp: hp, ac, dead: false };
  session.encounter.enemies.push(enemy);
  session.encounter.active = true;
  syncEncounterToDash(guildId);
  // Kick off initiative rolling the first time combat starts
  if (!wasActive) startInitiativePhase(guildId);
}

function startInitiativePhase(guildId) {
  const session = getSession(guildId);
  if (session.initiativePhase) return; // already running
  session.initiativePhase = true;
  session.initiativeRolls = {};
  const playerList = session.activePlayers.map(p => `**${session.players[p.userId] || p.displayName}**`).join(', ');
  // Broadcast to the guild's last-used text channel via a stored reference
  const ch = session.lastTextChannel;
  if (ch) {
    ch.send(`⚔️ **Combat begins!** Roll for initiative!\n${playerList} — each type \`/roll 1d20\` now. The order of battle will be set once all players have rolled.`);
  }
}

function parseCombatTokens(text, guildId, actingUserId) {
  const tokenMatches = text.match(/\[[A-Z_+\-]+:[^\]]+\]/g);
  if (tokenMatches) console.log(`[TOKENS] Found in LLM output:`, tokenMatches);
  else console.log(`[TOKENS] No tokens found. LLM tail: "${text.slice(-200)}"`);

  // Spawn new enemies
  for (const m of text.matchAll(/\[NPC_NEW:([^|]+)\|(\d+)\|(\d+)\]/gi)) {
    console.log(`[TOKENS] Spawning enemy: ${m[1]} HP=${m[2]} AC=${m[3]}`);
    spawnEnemy(guildId, m[1], parseInt(m[2]), parseInt(m[3]));
  }
  // Player damage
  for (const m of text.matchAll(/\[DMG:([^|]+)\|(\d+)\|?([^\]]*)\]/gi)) {
    applyPlayerDamage(m[1], parseInt(m[2]));
  }
  // Player healing
  for (const m of text.matchAll(/\[HEAL:([^|]+)\|(\d+)\]/gi)) {
    applyPlayerHeal(m[1], parseInt(m[2]));
  }
  // Conditions
  for (const m of text.matchAll(/\[COND\+:([^|]+)\|([^\]]+)\]/gi)) {
    applyCondition(m[1], m[2], true);
  }
  for (const m of text.matchAll(/\[COND-:([^|]+)\|([^\]]+)\]/gi)) {
    applyCondition(m[1], m[2], false);
  }
  // Enemy damage/heal
  for (const m of text.matchAll(/\[NPC_DMG:([^|]+)\|(\d+)\]/gi)) {
    applyNpcDamage(guildId, m[1], parseInt(m[2]));
  }
  for (const m of text.matchAll(/\[NPC_HEAL:([^|]+)\|(\d+)\]/gi)) {
    applyNpcHeal(guildId, m[1], parseInt(m[2]));
  }
  // Player gains item
  for (const m of text.matchAll(/\[ITEM:([^|]+)\|([^|]+)\|(\d+)\]/gi)) {
    givePlayerItem(m[1], m[2].trim(), parseInt(m[3]));
  }
  // Damage roll request — store pending target for the acting player
  for (const m of text.matchAll(/\[ROLL_DMG:([^\]]+)\]/gi)) {
    const session = getSession(guildId);
    const currentPlayer = getCurrentTurnPlayer(guildId);
    const userId = currentPlayer?.userId || actingUserId;
    if (userId) {
      session.pendingDamageRoll = { enemyName: m[1].trim(), userId };
      console.log(`[TOKENS] Damage roll pending: ${userId} vs "${m[1].trim()}"`);
    } else {
      console.log(`[TOKENS] ROLL_DMG found but no player to assign it to`);
    }
  }
  // Attack roll request — store pending hit check for the acting player
  for (const m of text.matchAll(/\[ROLL_HIT:([^\]]+)\]/gi)) {
    const session = getSession(guildId);
    const currentPlayer = getCurrentTurnPlayer(guildId);
    const userId = currentPlayer?.userId || actingUserId;
    if (userId) {
      session.pendingAttackRoll = { enemyName: m[1].trim(), userId };
      console.log(`[TOKENS] Attack roll pending: ${userId} vs "${m[1].trim()}"`);
    }
  }
}

function advanceTurn(guildId) {
  const session = getSession(guildId);
  if (session.turnOrder.length === 0) return null;
  
  session.currentTurnIndex = (session.currentTurnIndex + 1) % session.turnOrder.length;
  session.lastActionTime = Date.now();
  resetTurnTimeout(guildId);
  
  const nextPlayer = getCurrentTurnPlayer(guildId);
  return nextPlayer;
}

const TURN_TIMEOUT_MS = 90000;  // 90 seconds once the timer starts
const TURN_TIMER_DELAY_MS = 25000; // 25-second grace period before timer starts

function resetTurnTimeout(guildId) {
  const session = getSession(guildId);

  // Clear any existing timeouts
  if (session.turnTimeoutHandle) clearTimeout(session.turnTimeoutHandle);
  if (session.turnTimerDelayHandle) clearTimeout(session.turnTimerDelayHandle);

  const currentPlayer = getCurrentTurnPlayer(guildId);

  // After the grace period, start the visible countdown and the auto-advance timeout
  session.turnTimerDelayHandle = setTimeout(() => {
    io.emit("turn_timer", {
      playerName: currentPlayer?.characterName || null,
      duration: TURN_TIMEOUT_MS,
      startedAt: Date.now(),
    });

    session.turnTimeoutHandle = setTimeout(() => {
      console.log(`⏱️ Turn timeout for ${session.players[session.turnOrder[session.currentTurnIndex]]}`);
      advanceTurn(guildId);
    }, TURN_TIMEOUT_MS);
  }, TURN_TIMER_DELAY_MS);
}

async function proceedAfterNames(interaction, guildId, connection) {
  const session = getSession(guildId);
  session.nameCollectionActive = false;
  
  // Fill in missing names with Discord display names
  for (const player of session.activePlayers) {
    if (!session.players[player.userId]) {
      session.players[player.userId] = player.displayName;
    }
  }
  
  // Initialize turn order for multiple players
  if (session.activePlayers.length > 1) {
    initializeTurnOrder(guildId);
  }
  
  // Build final player names list
  const playerNames = session.activePlayers.map(p => session.players[p.userId]).join(" and ");
  
  // DM addresses players by name and asks for first action
  const reply = await askDM(
    guildId,
    `The players have introduced themselves as: ${playerNames}. Greet them warmly by their names and set the opening scene. Ask them what they would like to do first.`,
    "Game Master"
  );
  
  await sendDMResponseWithVoice(interaction, connection, reply, guildId);
}

// ============================================================
//  ELEVENLABS TTS — with audio caching
// ============================================================

const TTS_CACHE_DIR = path.join(__dirname, "tts_cache");

function initTTSCache() {
  try {
    if (!fs.existsSync(TTS_CACHE_DIR)) {
      fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
    }
  } catch (_) {}
}

function ttsCacheKey(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function ttsCachePath(text) {
  return path.join(TTS_CACHE_DIR, `${ttsCacheKey(text)}.mp3`);
}

initTTSCache();

// ============================================================
//  AMBIENT SOUNDS — Location-based background ambiance
// ============================================================

const AMBIENT_SOUNDS_DIR = path.join(__dirname, "ambient_sounds");
const LOCATION_KEYWORDS = {
  dungeon: ["dungeon", "catacomb", "crypt", "underground", "cellar", "vault"],
  forest: ["forest", "woods", "wilderness", "tree", "outside", "outdoor"],
  tavern: ["tavern", "inn", "bar", "pub", "ale house"],
  town: ["town", "city", "village", "marketplace", "street", "road"],
  cave: ["cave", "cavern", "grotto"],
  generic: ["room", "hall", "chamber", "corridor"],
};

function detectLocationFromText(text) {
  const lowerText = text.toLowerCase();
  for (const [location, keywords] of Object.entries(LOCATION_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        return location;
      }
    }
  }
  return "generic";
}

function getRandomAmbientSound(location) {
  try {
    const locationPath = path.join(AMBIENT_SOUNDS_DIR, location);
    if (!fs.existsSync(locationPath)) {
      return null;
    }
    const files = fs.readdirSync(locationPath)
      .filter(f => f.endsWith(".mp3") || f.endsWith(".wav"));
    if (files.length === 0) return null;
    const randomFile = files[Math.floor(Math.random() * files.length)];
    return path.join(locationPath, randomFile);
  } catch (err) {
    console.warn(`Failed to get ambient sound for ${location}:`, err.message);
    return null;
  }
}

async function textToSpeech(text) {
  const cleanText = sanitizeLLMOutput(text);
  if (!cleanText) return null;

  const cacheFile = ttsCachePath(cleanText);

  // Serve from cache if available.
  if (fs.existsSync(cacheFile)) {
    return cacheFile;
  }

  const outputPath = path.join(__dirname, "dm_response.mp3");

  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        text: cleanText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.8,
        },
      },
      {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        responseType: "arraybuffer",
      }
    );

    const buf = Buffer.from(response.data);
    if (response.status !== 200) {
      console.error("ElevenLabs bad status:", response.status, buf.toString("utf-8"));
      return null;
    }

    // Cache the audio.
    fs.writeFileSync(cacheFile, buf);
    // Also write to the live playback path.
    fs.writeFileSync(outputPath, buf);
    return outputPath;

  } catch (err) {
    console.error("ElevenLabs error:", err.message);
    if (err.response) {
      console.error("ElevenLabs status:", err.response.status);
      try {
        const errText = Buffer.from(err.response.data).toString("utf-8");
        console.error("ElevenLabs response body:", errText);
      } catch (_) {}
    }
    return null;
  }
}

async function sendDMResponseWithVoice(interaction, connection, dmText, guildId) {
  // Send the text response
  interaction.channel.send(`📜 **DM:** *${dmText}*`);
  
  // Detect location from the DM response and update session
  if (guildId) {
    const session = getSession(guildId);
    const detectedLocation = detectLocationFromText(dmText);
    if (detectedLocation !== session.currentLocation) {
      session.currentLocation = detectedLocation;
    }
  }
  
  // Try to send voice
  const audioFile = await textToSpeech(dmText);
  if (audioFile) {
    try {
      await speakInVoice(connection, audioFile);
    } catch (err) {
      console.error("Voice playback error:", err.message);
    }
  } else {
    console.warn("Voice synthesis unavailable — text-only narration.");
  }
}

// ============================================================
//  LLM — AI BRAIN
// ============================================================

let ollamaReady = false;

async function checkOpenAIReady() {
  if (!OPENAI_API_KEY) return false;
  try {
    const response = await axios.get(`${OPENAI_BASE_URL}/models/${OPENAI_MODEL}`, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      timeout: 5000,
    });
    return response.status === 200;
  } catch (_) {
    return false;
  }
}

async function checkOllamaReady() {
  try {
    const tagsUrl = new URL(OLLAMA_URL);
    tagsUrl.pathname = "/api/tags";
    const response = await axios.get(tagsUrl.toString(), { timeout: 5000 });
    const models = response?.data?.models || [];
    const want = OLLAMA_MODEL;
    return models.some((m) => {
      const name = m?.name || "";
      if (!name) return false;
      return want.includes(":") ? name === want : name.startsWith(`${want}:`);
    });
  } catch (_) {
    return false;
  }
}

async function waitForOllama() {
  console.log("⏳ Waiting for Ollama to be ready...");
  let attempts = 0;
  const maxAttempts = 120;
  while (!ollamaReady && attempts < maxAttempts) {
    if (await checkOllamaReady()) {
      ollamaReady = true;
      console.log("✅ Ollama model loaded and ready!");
      return true;
    }
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.error("❌ Ollama failed to load within timeout");
  return false;
}

async function waitForLLM() {
  if (LLM_PROVIDER === "openai") {
    if (!OPENAI_API_KEY) {
      console.error("❌ OPENAI_API_KEY is required when LLM_PROVIDER=openai");
      return false;
    }
    console.log(`⏳ Checking OpenAI access for model: ${OPENAI_MODEL}...`);
    const ok = await checkOpenAIReady();
    if (ok) {
      console.log("✅ OpenAI is reachable and ready!");
      return true;
    }
    console.error("❌ OpenAI check failed (invalid key/model or network issue)");
    return false;
  }
  return waitForOllama();
}

// ---- OpenAI (streaming + prompt caching) ----

async function* streamOpenAI(messages) {
  const systemContent = buildSystemPrompt();
  // Mark the system prompt for OpenAI's prompt caching (saves tokens on repeat calls).
  const cachedMessages = [
    { role: "system", content: systemContent, cache_control: { type: "ephemeral" } },
    ...messages.slice(1), // strip the system message we just prepended
  ];

  const response = await axios.post(
    `${OPENAI_BASE_URL}/chat/completions`,
    {
      model: OPENAI_MODEL,
      messages: cachedMessages,
      max_tokens: 500,
      temperature: 0.5,
      stream: true,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      responseType: "stream",
      timeout: 60 * 1000,
    }
  );

  const stream = response.data;
  stream.on("error", (err) => {
    // Error events may fire after stream has ended; handled via generator return.
  });

  let buffer = "";
  for await (const chunk of stream) {
    const text = chunk.toString();
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const token = parsed?.choices?.[0]?.delta?.content;
        if (token) {
          buffer += token;
          yield token;
        }
      } catch (_) {}
    }
  }

  return buffer;
}

// ---- Ollama (streaming) ----

async function* streamOllama(messages) {
  const response = await axios.post(
    OLLAMA_URL,
    {
      model: OLLAMA_MODEL,
      messages,
      stream: true,
    },
    {
      headers: { "Content-Type": "application/json" },
      responseType: "stream",
      timeout: 10 * 60 * 1000,
    }
  );

  const stream = response.data;
  let buffer = "";
  for await (const chunk of stream) {
    const text = chunk.toString();
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const token = parsed?.message?.content;
        if (token) {
          buffer += token;
          yield token;
        }
      } catch (_) {}
    }
  }

  return buffer;
}

// ---- Unified streaming askDM ----

// onToken: called for each token as it arrives.
// Returns the (possibly updated) accumulated text so far.
async function askDMStream(guildId, userMessage, playerName, onToken, userId) {
  const session = getSession(guildId);
  const fullMessage = `${playerName} says: "${userMessage}"`;
  addToHistory(guildId, "user", fullMessage);

  // Build system prompt with character context if available
  let systemPrompt = buildSystemPrompt();
  
  if (userId && session.characterSheets[userId]) {
    const char = session.characterSheets[userId];
    const charData = char.character;
    const combat = char.combat;
    const abilities = char.abilities;
    
    // Calculate ability modifiers
    const mods = {};
    for (const [ability, score] of Object.entries(abilities)) {
      mods[ability] = Math.floor((score - 10) / 2);
    }
    
    const modStr = Object.keys(mods)
      .map(k => `${k.toUpperCase().slice(0, 3)}: ${abilities[k]}(${mods[k] > 0 ? '+' : ''}${mods[k]})`)
      .join(" | ");
    
    const characterContext = `
[CHARACTER CONTEXT - ${playerName}]
Name: ${charData.name} (${charData.class} Level ${charData.level})
Health: ${combat.hp.current}/${combat.hp.max} | AC: ${combat.ac} | Initiative: ${combat.initiative}
Abilities: ${modStr}
Background: ${charData.background}
[END CHARACTER CONTEXT]`;
    
    systemPrompt += "\n" + characterContext;
  }

  // Inject all players' HP/AC so the LLM can deal damage correctly to any player
  const allPlayers = Object.values(dashState.players);
  if (allPlayers.length > 1) {
    const partyContext = allPlayers.map(p =>
      `${p.characterName}: HP ${p.hp}/${p.maxHp}, AC ${p.ac}`
    ).join(' | ');
    systemPrompt += `\n[PARTY STATUS: ${partyContext}]`;
  }

  // Inject active encounter enemies so LLM knows their remaining HP
  const enc = session.encounter;
  if (enc.active && enc.enemies.length > 0) {
    const enemyContext = enc.enemies
      .map(e => `${e.name}: HP ${e.hp}/${e.maxHp} AC ${e.ac}${e.dead ? ' (DEAD)' : ''}`)
      .join(' | ');
    systemPrompt += `\n[ENEMIES: ${enemyContext}]`;
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...session.history,
  ];

  let fullText = "";

  try {
    // Use non-streaming mode to avoid token concatenation issues
    fullText = LLM_PROVIDER === "openai" 
      ? await askOpenAI(messages) 
      : await askOllama(messages);

    parseCombatTokens(fullText, guildId, userId);
    const reply = sanitizeLLMOutput(fullText);
    addToHistory(guildId, "assistant", reply);
    return reply;

  } catch (err) {
    const label = LLM_PROVIDER === "openai" ? "OpenAI" : "Ollama";
    console.error(`${label} error:`, err.message);
    return "The ancient tomes are silent... (the LLM is unavailable right now)";
  }
}

// ---- Non-streaming fallback (still used for readiness checks) ----

async function askOpenAI(messages) {
  const response = await axios.post(
    `${OPENAI_BASE_URL}/chat/completions`,
    {
      model: OPENAI_MODEL,
      messages,
      max_tokens: 500,
      temperature: 0.5,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 60 * 1000,
    }
  );
  const content = response?.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no message content");
  return content.trim();
}

async function askOllama(messages) {
  const response = await axios.post(
    OLLAMA_URL,
    {
      model: OLLAMA_MODEL,
      messages,
      stream: false,
    },
    {
      timeout: 10 * 60 * 1000,
    }
  );
  const content = response?.data?.message?.content;
  if (!content) throw new Error("Ollama returned no message content");
  return content.trim();
}

async function askDM(guildId, userMessage, playerName) {
  const session = getSession(guildId);
  const fullMessage = `${playerName} says: "${userMessage}"`;
  addToHistory(guildId, "user", fullMessage);
  try {
    const messages = [
      { role: "system", content: buildSystemPrompt() },
      ...session.history,
    ];
    const reply =
      LLM_PROVIDER === "openai" ? await askOpenAI(messages) : await askOllama(messages);
    parseCombatTokens(reply, guildId);
    const cleaned = sanitizeLLMOutput(reply);
    addToHistory(guildId, "assistant", cleaned);
    return cleaned;
  } catch (err) {
    const label = LLM_PROVIDER === "openai" ? "OpenAI" : "Ollama";
    console.error(`${label} error:`, err.message);
    return "The ancient tomes are silent... (the LLM is unavailable right now)";
  }
}

// ============================================================
//  DISCORD VOICE — PLAYBACK
// ============================================================

async function speakInVoice(connection, audioFilePath) {
  return new Promise((resolve, reject) => {
    const player = createAudioPlayer();
    const resource = createAudioResource(audioFilePath);
    player.play(resource);
    connection.subscribe(player);
    player.on(AudioPlayerStatus.Idle, resolve);
    player.on("error", (err) => {
      console.error("Audio player error:", err.message);
      reject(err);
    });
  });
}

// ============================================================
//  DISCORD VOICE — LISTENING (Speech-to-Text via Whisper)
// ============================================================

// NOTE: Full real-time voice listening requires the openai whisper package.
// Run: npm install openai
// And add OPENAI_API_KEY to your .env file
// The listenToPlayer function below shows the structure.
// For a simpler start, players can just TYPE their actions using !action

async function transcribeAudio(audioBuffer) {
  try {
    const { OpenAI } = require("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const tmpPath = path.join(__dirname, "player_input.wav");
    fs.writeFileSync(tmpPath, audioBuffer);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: "whisper-1",
    });
    fs.unlinkSync(tmpPath);
    return transcription.text;
  } catch (err) {
    console.error("Whisper transcription error:", err.message);
    return null;
  }
}

// ============================================================
//  NICKNAME MANAGEMENT
// ============================================================

async function setPlayerName(interaction, characterName) {
  const userId = interaction.user.id;
  const member = interaction.member;
  const session = getSession(interaction.guildId);

  // Validate name length (Discord nickname max is 32 characters)
  if (characterName.length > 32) {
    return interaction.reply(`❌ Character name is too long! Discord nicknames are limited to 32 characters. Yours is ${characterName.length}.`);
  }

  // Store original nickname if not already stored
  if (!session.originalNicknames[userId]) {
    session.originalNicknames[userId] = member.nickname || member.user.username;
  }

  // Check for duplicate names and add suffix if needed
  let finalName = characterName;
  let suffix = 0;
  let nameWithSuffix = finalName;

  for (const pId in session.players) {
    if (pId !== userId && session.players[pId] === nameWithSuffix) {
      suffix++;
      nameWithSuffix = `${finalName}${suffix}`;
    }
  }

  // Update the player's session name
  session.players[userId] = nameWithSuffix;

  // Persist player identity to the database
  try {
    dbChars.ensurePlayer(userId, member.user.username);
  } catch (err) {
    console.warn("DB player upsert failed:", err.message);
  }
  persistSession(interaction.guildId);

  // Link to dashboard: find a dashState entry whose characterName matches and re-key it to this Discord userId
  const nameLower = characterName.toLowerCase().trim();
  for (const [existingId, player] of Object.entries(dashState.players)) {
    if ((player.characterName || '').toLowerCase() === nameLower && existingId !== userId) {
      // Move the entry to the real Discord userId
      dashState.players[userId] = { ...player, discordId: userId };
      delete dashState.players[existingId];
      saveDashboardState();
      io.emit('state_update', dashState);
      break;
    }
  }

  const suffix_msg = suffix > 0 ? ` (numbered as "${nameWithSuffix}" because another player shares that name)` : '';

  // Try to update Discord nickname — silently skip if bot lacks permission
  try {
    await member.setNickname(nameWithSuffix);
  } catch (err) {
    // Missing Permissions is expected when bot role is below the member or member is server owner
    if (!err.message?.includes('Missing Permissions')) {
      console.warn(`Failed to set nickname for ${userId}:`, err.message);
    }
  }

  interaction.reply(`✅ You are now **${nameWithSuffix}**${suffix_msg}!`);
}

async function revertAllNicknames(interaction) {
  const session = getSession(interaction.guildId);
  const guild = interaction.guild;

  for (const userId in session.originalNicknames) {
    try {
      const member = await guild.members.fetch(userId);
      const originalNick = session.originalNicknames[userId];
      // Only revert if the current nickname matches what we set
      if (member.nickname && session.players[userId]) {
        await member.setNickname(originalNick === member.user.username ? null : originalNick);
      }
    } catch (err) {
      console.warn(`Failed to revert nickname for ${userId}:`, err.message);
    }
  }
}

// ============================================================
//  DISCORD CLIENT SETUP
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// Store active voice connections per guild.
const connections = {};

// ============================================================
//  ACTION ROLL CHECKING & PROMPTING
// ============================================================

// Bug log for testing/story override scenarios
const bugLog = [];

function logBug(guildId, userId, playerName, reason) {
  bugLog.push({
    timestamp: new Date().toISOString(),
    guildId,
    userId,
    playerName,
    reason,
  });
  console.log(`🐛 Bug Log: ${playerName} - ${reason}`);
}

async function checkAndPromptForRoll(interaction, guildId, action, playerName, connection) {
  const session = getSession(guildId);
  
  // Detect keywords in the action
  const detectedKeywords = detectActionKeywords(action);
  const defaultDC = getDefaultDCForAction(action);
  
  // If keywords detected, prompt for roll
  if (detectedKeywords.length > 0 && defaultDC) {
    const dc = defaultDC;
    const difficulty = DND_DIFFICULTY_CLASSES[dc] || "Unknown";
    
    // Ask player if they want to roll
    await interaction.channel.send(
      `🎲 **${playerName}** — This action requires a check! (DC ${dc} - ${difficulty})\nUse \`/roll 1d20\` to attempt it, or type a new \`/action\` if you want to do something else.`
    );
    
    return { requiresRoll: true, expectedDC: dc };
  }
  
  // Check if LLM should also judge based on narrative weight
  // For now, return no roll needed
  return { requiresRoll: false, expectedDC: null };
}

async function handleActionWithRollContext(guildId, action, playerName, lastRoll, expectedDC) {
  let enhancedPrompt = action;
  
  if (lastRoll && expectedDC) {
    // Add roll context to the message
    const success = lastRoll.total >= expectedDC;
    enhancedPrompt = `${action}\n[ROLL CONTEXT: ${playerName} rolled ${lastRoll.total} vs DC ${expectedDC} - ${success ? "SUCCESS" : "FAILURE"}]`;
  }
  
  return enhancedPrompt;
}

const commands = [
  {
    name: "join",
    description: "Bot joins your voice channel",
  },
  {
    name: "leave",
    description: "Bot leaves voice channel and ends session",
  },
  {
    name: "startgame",
    description: "Start a new D&D adventure",
    options: [
      {
        name: "world",
        description: "World to play in (by title or filename, case-insensitive)",
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
  {
    name: "action",
    description: "Describe what your character does",
    options: [
      {
        name: "what",
        description: "What you want to do",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: "force",
        description: "[DEV ONLY] Skip roll requirements (logs bug for testing)",
        type: ApplicationCommandOptionType.Boolean,
        required: false,
      },
    ],
  },
  {
    name: "roll",
    description: "Roll dice — defaults to d20. Pick a preset or type a custom expression.",
    options: [
      {
        name: "preset",
        description: "Quick-pick a common die",
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: "d20 (ability check / attack)", value: "1d20" },
          { name: "d12 (Barbarian hit die)", value: "1d12" },
          { name: "d10 (Fighter / Ranger hit die)", value: "1d10" },
          { name: "d8 (healing / hit die)", value: "1d8" },
          { name: "d6 (damage / sneak attack)", value: "1d6" },
          { name: "d4 (minor damage)", value: "1d4" },
          { name: "2d6 (great sword)", value: "2d6" },
          { name: "4d6 (stat roll)", value: "4d6" },
        ],
      },
      {
        name: "dice",
        description: "Custom expression (e.g. 3d8, 2d6). Overrides preset.",
        type: ApplicationCommandOptionType.String,
        required: false,
      },
      {
        name: "dc",
        description: "Difficulty Class to check against (5-25)",
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 5,
        max_value: 25,
      },
    ],
  },
  {
    name: "status",
    description: "Check if a game is running",
  },
  {
    name: "resetgame",
    description: "Wipe game state and start fresh",
  },
  {
    name: "reloadnotes",
    description: "Reload world_notes.txt without restarting",
  },
  {
    name: "name",
    description: "Set your character name",
    options: [
      {
        name: "character",
        description: "Your character's name",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: "pass",
    description: "Pass your turn to the next player",
  },
  {
    name: "endgame",
    description: "End the current game gracefully with a DM farewell",
  },
  {
    name: "showworlds",
    description: "List all available worlds",
  },
  {
    name: "character",
    description: "Manage your D&D character sheet",
    options: [
      {
        name: "create",
        description: "Create a new character from a class template",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "class",
            description: "Character class (Fighter, Wizard, Rogue, etc.)",
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: DND_CLASSES.map(c => ({ name: c, value: c })),
          },
          {
            name: "name",
            description: "Character name",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: "select",
        description: "Load an existing character to use in this game",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "character",
            description: "Character name",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: "view",
        description: "View your current character sheet",
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: "list",
        description: "List all your characters",
        type: ApplicationCommandOptionType.Subcommand,
      },
    ],
  },
  {
    name: "hp",
    description: "Track character health points",
    options: [
      {
        name: "value",
        description: "Amount to heal (positive) or damage (negative), or set max with 'max:'",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: "help",
    description: "Show all commands",
  },
  {
    name: "debug",
    description: "[Admin only] Developer/testing tools",
    options: [
      {
        name: "action",
        description: "What to do",
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: "nat20 — force next roll to be 20", value: "nat20" },
          { name: "nat1 — force next roll to be 1", value: "nat1" },
          { name: "startcombat — instantly trigger a combat encounter", value: "startcombat" },
          { name: "spawn — spawn a test enemy", value: "spawn" },
          { name: "status — show internal session state", value: "status" },
        ],
      },
      {
        name: "value",
        description: "Optional argument (spawn: 'Name HP AC', startcombat: enemy name)",
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
];

const rest = new REST().setToken(DISCORD_TOKEN);

// ============================================================
//  BOT READY
// ============================================================

client.once(Events.ClientReady, async (c) => {
  // Initialize SQLite database (creates tables if they don't exist yet)
  db.initializeDatabase();

  console.log(`\n🎲 Dungeon Master Bot is online as ${c.user.tag}`);
  console.log(`   LLM provider: ${LLM_PROVIDER}`);
  if (LLM_PROVIDER === "openai") {
    console.log(`   OpenAI model: ${OPENAI_MODEL}`);
  } else {
    console.log(`   Ollama model: ${OLLAMA_MODEL}`);
    console.log(`   If using Docker Ollama: docker compose --profile ollama up`);
  }
  console.log(`   Edit world_notes.txt to add your maps, NPCs, and lore.\n`);

  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
    console.log("Slash commands registered globally ✅");
  } catch (err) {
    console.error("Failed to register commands:", err.message);
  }

  (async () => {
    const ready = await waitForLLM();
    if (ready) {
      for (const guild of c.guilds.cache.values()) {
        const channel = guild.channels.cache.find(
          (ch) =>
            ch.isTextBased() &&
            ch.permissionsFor(guild.members.me).has("SendMessages")
        );
        if (channel) {
          try {
            await channel.send(
              "🎲 **The Dungeon Master has arrived!** The ancient tomes glow with arcane energy. The model is ready. Type `/help` to see available commands, or `/join` to begin your adventure!"
            );
            console.log(`✅ Ready message sent to ${guild.name}`);
          } catch (err) {
            console.error(`Failed to send ready message: ${err.message}`);
          }
        }
      }
    }
  })();
});

// ============================================================
//  CHARACTER SHEET COMMAND HANDLERS
// ============================================================

function buildCharacterEmbed(character, userName) {
  const char = character.character;
  const combat = character.combat;
  const abilities = character.abilities;
  
  // Calculate ability modifiers
  const modifiers = {};
  for (const [ability, score] of Object.entries(abilities)) {
    modifiers[ability] = Math.floor((score - 10) / 2);
  }
  
  const embedFields = [];
  
  // Basic Info
  embedFields.push({
    name: "Class & Level",
    value: `${char.class} (Level ${char.level})`,
    inline: true
  });
  embedFields.push({
    name: "Background",
    value: char.background,
    inline: true
  });
  embedFields.push({
    name: "Alignment",
    value: char.alignment,
    inline: true
  });
  
  // Combat Stats
  embedFields.push({
    name: "Combat",
    value: `**AC:** ${combat.ac} | **HP:** ${combat.hp.current}/${combat.hp.max} | **Initiative:** ${combat.initiative > 0 ? '+' : ''}${combat.initiative}`,
    inline: false
  });
  
  // Ability Scores
  const abilityStr = Object.entries(abilities)
    .map(([name, score]) => `**${name.toUpperCase().slice(0, 3)}** ${score}(${modifiers[name] > 0 ? '+' : ''}${modifiers[name]})`)
    .join(" | ");
  embedFields.push({
    name: "Ability Scores",
    value: abilityStr,
    inline: false
  });
  
  // Equipment
  if (character.equipment.weapons.length > 0) {
    const weaponList = character.equipment.weapons
      .filter(w => w.equipped)
      .map(w => `${w.name} (${w.damage})`)
      .join(", ");
    embedFields.push({
      name: "Equipment",
      value: `${character.equipment.armor} | ${weaponList || "No weapons"}`,
      inline: false
    });
  }
  
  // Active Conditions
  const activeConditions = Object.entries(character.conditions)
    .filter(([key, val]) => val === true || (typeof val === 'number' && val > 0))
    .map(([cond]) => cond)
    .join(", ");
  
  if (activeConditions) {
    embedFields.push({
      name: "Active Conditions",
      value: activeConditions,
      inline: false
    });
  }
  
  return {
    title: char.name,
    description: `Player: ${userName}`,
    color: 0x0099ff,
    fields: embedFields,
    footer: { text: `Campaign: ${char.campaign}` }
  };
}

// ============================================================
//  SLASH COMMAND HANDLER
// ============================================================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  if (!guildId) {
    interaction.reply("This command must be used in a server.");
    return;
  }

  const session = getSession(guildId);
  const playerName =
    interaction.member?.displayName || interaction.user.username;
  const commandName = interaction.commandName;

  // ----------------------------------------------------------
  //  /join — Bot joins your voice channel
  // ----------------------------------------------------------
  if (commandName === "join") {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply("You need to be in a voice channel first!");
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });

      connections[guildId] = connection;

      connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`Connected to voice in guild ${guildId}`);
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      await interaction.reply(
        `🎲 The Dungeon Master has entered **${voiceChannel.name}**! Type \`/startgame\` to begin your adventure.`
      );
    } catch (err) {
      console.error("Voice join error:", err);
      interaction.reply(
        "Couldn't join the voice channel. Check bot permissions."
      );
    }
    return;
  }

  // ----------------------------------------------------------
  //  /leave — Bot leaves voice channel
  // ----------------------------------------------------------
  if (commandName === "leave") {
    const connection = connections[guildId];
    if (connection) {
      await revertAllNicknames(interaction);
      connection.destroy();
      delete connections[guildId];
      sessions[guildId] = null;
      interaction.reply(
        "The Dungeon Master has departed. Farewell, adventurers."
      );
    } else {
      interaction.reply("I'm not in a voice channel.");
    }
    return;
  }

  // ----------------------------------------------------------
  //  /startgame — Begin the campaign
  // ----------------------------------------------------------
  if (commandName === "startgame") {
    const connection = connections[guildId];
    if (!connection) {
      return interaction.reply(
        "Type `/join` first so I can speak in your voice channel."
      );
    }

    // Detect active players in the voice channel
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply("You must be in a voice channel to start the game!");
    }

    const voiceMembers = voiceChannel.members.filter(m => !m.user.bot);
    if (voiceMembers.size === 0) {
      return interaction.reply("There are no players in the voice channel!");
    }

    // Handle world selection
    const worldQuery = interaction.options.getString("world");
    let selectedWorldFile = null;
    
    if (worldQuery) {
      selectedWorldFile = findWorldByTitleOrFilename(worldQuery);
      if (!selectedWorldFile) {
        const worlds = getAllWorlds();
        const worldsList = worlds.map((w, idx) => {
          const title = getWorldTitle(path.join(WORLDS_PATH, w));
          return `${idx + 1}. **${title}** (\`${w}\`)`;
        }).join("\n");
        return interaction.reply(`
❌ World not found: "${worldQuery}"

📖 **Available Worlds:**

${worldsList}

Use the world's title or filename in the \`world\` parameter.
        `.trim());
      }
      worldNotes = loadWorld(selectedWorldFile);
    } else {
      // No world specified, use random or env var
      loadRandomWorld();
    }

    // Build active players list
    session.activePlayers = voiceMembers.map(member => {
      return {
        userId: member.id,
        displayName: member.nickname || member.user.username,
        characterName: null, // Will be set by /name command
      };
    });

    session.active = true;
    session.history = [];
    session.nameCollectionActive = true;

    // Clear any leftover encounter from the previous game
    session.encounter = { active: false, enemies: [] };
    session.initiativePhase = false;
    session.initiativeRolls = {};
    dashState.encounter = { active: false, enemies: [] };
    saveDashboardState();
    io.emit('state_update', dashState);

    // Register players in dashboard
    for (const player of session.activePlayers) {
      if (!dashState.players[player.userId]) {
        dashState.players[player.userId] = {
          discordId: player.userId,
          discordName: player.displayName,
          characterName: player.displayName,
          hp: 10, maxHp: 10, ac: 10, class: "Adventurer", level: 1,
          image: null, inventory: [], spells: [], features: [], conditions: {},
        };
      }
    }
    saveDashboardState();
    io.emit("state_update", dashState);

    const dashboardLine = dashboardPublicUrl
      ? `\n🗺️ **Campaign Dashboard:** ${dashboardPublicUrl}`
      : "";
    await interaction.reply(
      `⚔️ **The adventure begins...** Listen closely, adventurers.${dashboardLine}`
    );

    // DM intro asking for character names
    const reply = await askDM(
      guildId,
      `Begin the adventure. Ask the players to introduce themselves with their character names. The players here are: ${session.activePlayers.map(p => p.displayName).join(", ")}. Ask them to declare their names.`,
      "Game Master"
    );

    addStoryEntry("dm", "Dungeon Master", reply);

    // Send response with voice
    await sendDMResponseWithVoice(interaction, connection, reply, guildId);
    return;
  }

  // ----------------------------------------------------------
  //  /action [what you do] — Main gameplay command
  // ----------------------------------------------------------
  if (commandName === "action") {
    if (!session.active) {
      return interaction.reply(
        "No game is running. Type `/startgame` to begin."
      );
    }

    const connection = connections[guildId];
    if (!connection) {
      return interaction.reply(
        "Bot isn't in a voice channel. Type `/join` first."
      );
    }

    // Always keep track of the channel so we can send initiative prompts
    session.lastTextChannel = interaction.channel;

    const action = interaction.options.getString("what");
    if (!action) return interaction.reply("Tell me what you want to do!");

    const forceSkipRoll = interaction.options.getBoolean("force") || false;

    // ===== BLOCK ACTIONS DURING INITIATIVE PHASE =====
    if (session.initiativePhase) {
      const rolled = session.initiativeRolls[interaction.user.id];
      if (rolled !== undefined) {
        return interaction.reply(`⏳ Waiting for the other players to roll initiative before combat begins.`);
      } else {
        return interaction.reply(`⚔️ Roll for initiative first! Type \`/roll 1d20\` before taking any action.`);
      }
    }

    // ===== TURN-TAKING CHECK (combat only — free-form outside combat) =====
    if (session.encounter.active && session.turnOrder.length > 1) {
      const currentPlayer = getCurrentTurnPlayer(guildId);
      const isPlayersTurn = currentPlayer && currentPlayer.userId === interaction.user.id;

      if (!isPlayersTurn) {
        const nextPlayerName = currentPlayer ? currentPlayer.characterName : "someone";
        return interaction.reply(
          `⚔️ Combat is active! It's **${nextPlayerName}**'s turn. Use \`/pass\` to skip your turn or wait for the timeout.`
        );
      }
    }

    await interaction.reply(`⚔️ *${playerName}: "${action}"*`);
    addStoryEntry("player", playerName, action);

    // Start the combat timer only during active encounters
    if (session.encounter.active) {
      io.emit("turn_timer", {
        playerName,
        duration: TURN_TIMEOUT_MS,
        startedAt: Date.now(),
      });
    }

    // ===== ROLL PROMPT CHECK =====
    // Check if action requires a roll (unless force override is set)
    let rollCheck = { requiresRoll: false, expectedDC: null };
    
    if (!forceSkipRoll) {
      rollCheck = await checkAndPromptForRoll(interaction, guildId, action, playerName, connection);
    } else {
      // Log the override for debugging
      logBug(guildId, interaction.user.id, playerName, `Force skipped roll requirement for action: "${action}"`);
    }
    
    if (rollCheck.requiresRoll) {
      // Player needs to roll, don't process action yet
      // Store the action and expected DC for when they roll
      session.pendingAction = {
        action,
        playerName,
        expectedDC: rollCheck.expectedDC,
      };
      return;
    }

    // ===== PROCESS ACTION (no roll needed) =====
    // Add turn context only during active combat
    let actionMessage = action;
    if (session.encounter.active && session.turnOrder.length > 1) {
      actionMessage += `\n[TURN CONTEXT: It is now ${playerName}'s turn]`;
    }

    let dmText = "";
    const reply = await askDMStream(
      guildId,
      actionMessage,
      playerName,
      (text) => {
        dmText = text;
      },
      interaction.user.id
    );

    // Handle turn advancement via [ADVANCE_TURN] signal from LLM
    let finalReply = reply;
    const shouldAdvance = finalReply.includes('[ADVANCE_TURN]');
    finalReply = finalReply.replace(/\[ADVANCE_TURN\]/gi, '').trim();
    finalReply = finalReply.replace(/\[(NPC_NEW|DMG|HEAL|COND[+-]|NPC_DMG|NPC_HEAL|ITEM|ROLL_DMG|ROLL_HIT):[^\]]+\]/gi, '').trim();

    if (session.encounter.active && session.turnOrder.length > 1 && shouldAdvance) {
      // Send the DM's narration cleanly first
      addStoryEntry("dm", "Dungeon Master", finalReply);
      await sendDMResponseWithVoice(interaction, connection, finalReply, guildId);
      // Advance to next player and call on them naturally
      const nextPlayer = advanceTurn(guildId);
      if (nextPlayer) {
        const transition = pickTurnTransition(nextPlayer.characterName);
        addStoryEntry("dm", "Dungeon Master", transition);
        await sendDMResponseWithVoice(interaction, connection, transition, guildId);
      }
      return;
    } else {
      // Turn continues (mid-roll, mid-dialogue, or single player) — stay on current player
      resetTurnTimeout(guildId);
    }

    addStoryEntry("dm", "Dungeon Master", finalReply);
    await sendDMResponseWithVoice(interaction, connection, finalReply, guildId);
    return;
  }

  // ----------------------------------------------------------
  //  /roll [dice] — Roll dice and tell the DM
  // ----------------------------------------------------------
  if (commandName === "roll") {
    // custom dice expression overrides preset; both fall back to 1d20
    const diceArg = (interaction.options.getString("dice") || interaction.options.getString("preset") || "1d20").toLowerCase();
    const dcArg = interaction.options.getInteger("dc");
    const [numDice, diceSides] = diceArg.split("d").map(Number);

    if (!numDice || !diceSides || isNaN(numDice) || isNaN(diceSides)) {
      return interaction.reply(
        "❌ Invalid dice format. Try `/roll dice:2d6` or pick a preset."
      );
    }

    let total = 0;
    const rolls = [];

    // Consume any forced roll value set by /debug
    const forced = session.forcedRoll;
    if (forced !== null && numDice === 1) {
      // Only applies to single-die rolls; clamp to valid range
      const forcedVal = Math.min(Math.max(forced.value, 1), diceSides);
      rolls.push(forcedVal);
      total = forcedVal;
      session.forcedRoll = null;
    } else {
      session.forcedRoll = null; // clear stale forced value on multi-dice
      for (let i = 0; i < numDice; i++) {
        const roll = Math.floor(Math.random() * diceSides) + 1;
        rolls.push(roll);
        total += roll;
      }
    }

    // Build roll display with optional DC
    let rollText = `${playerName} rolled ${diceArg}: [${rolls.join(", ")}] = **${total}**`;
    if (dcArg !== null) {
      const difficulty = DND_DIFFICULTY_CLASSES[dcArg] || "Unknown";
      const result = total >= dcArg ? "✅ SUCCESS" : "❌ FAILURE";
      rollText += ` vs DC ${dcArg} (${difficulty}) — ${result}`;
    }

    await interaction.reply(`🎲 ${rollText}`);
    addDiceEntry(playerName, diceArg, rolls, total);

    // ===== INITIATIVE PHASE — collect rolls, don't send to DM yet =====
    if (session.initiativePhase) {
      session.initiativeRolls[interaction.user.id] = total;
      const needed = session.activePlayers.map(p => p.userId);
      const waiting = needed.filter(id => session.initiativeRolls[id] === undefined);

      if (waiting.length > 0) {
        const waitNames = waiting.map(id => session.players[id] || id).join(', ');
        interaction.channel.send(`📋 **${playerName}** rolled **${total}** for initiative. Waiting on: ${waitNames}`);
      } else {
        // Everyone has rolled — sort highest to lowest, set turn order
        const sorted = needed
          .map(id => ({ userId: id, name: session.players[id] || id, roll: session.initiativeRolls[id] }))
          .sort((a, b) => b.roll - a.roll);

        session.turnOrder = sorted.map(p => p.userId);
        session.currentTurnIndex = 0;
        session.initiativePhase = false;
        session.initiativeRolls = {};

        const orderStr = sorted.map((p, i) => `**${i + 1}.** ${p.name} (rolled ${p.roll})`).join('\n');
        const first = sorted[0];
        interaction.channel.send(`⚔️ **Initiative order set!**\n${orderStr}\n\n▶️ **${first.name}**, you go first — what do you do?`);
        resetTurnTimeout(guildId);
      }
      return;
    }

    // ===== ATTACK ROLL — check hit vs AC, then set up damage roll =====
    if (session.pendingAttackRoll && session.pendingAttackRoll.userId === interaction.user.id) {
      const { enemyName } = session.pendingAttackRoll;
      session.pendingAttackRoll = null;
      const enemy = findEnemyByName(guildId, enemyName);
      const ac = enemy ? enemy.ac : 10;
      const hit = total >= ac;
      console.log(`[ATTACK] ${playerName} rolled ${total} vs AC ${ac} (${enemyName}) — ${hit ? 'HIT' : 'MISS'}`);

      if (hit) {
        session.pendingDamageRoll = { enemyName: enemy ? enemy.name : enemyName, userId: interaction.user.id };
        const dmPrompt = `${playerName} rolled ${total} to hit ${enemyName} (AC ${ac}) — that's a HIT! Narrate the successful strike dramatically and tell the player to roll for damage.`;
        const reply = await askDM(guildId, dmPrompt, playerName);
        let finalReply = reply.replace(/\[(NPC_NEW|DMG|HEAL|COND[+-]|NPC_DMG|NPC_HEAL|ITEM|ROLL_DMG|ROLL_HIT):[^\]]+\]/gi, '').trim();
        addStoryEntry("dm", "Dungeon Master", finalReply);
        await sendDMResponseWithVoice(interaction, connections[guildId], finalReply, guildId);
      } else {
        const dmPrompt = `${playerName} rolled ${total} to hit ${enemyName} (AC ${ac}) — that's a MISS. Narrate the failed attack.`;
        const reply = await askDM(guildId, dmPrompt, playerName);
        let finalReply = reply.replace(/\[(NPC_NEW|DMG|HEAL|COND[+-]|NPC_DMG|NPC_HEAL|ITEM|ROLL_DMG|ROLL_HIT):[^\]]+\]/gi, '').trim();
        addStoryEntry("dm", "Dungeon Master", finalReply);
        await sendDMResponseWithVoice(interaction, connections[guildId], finalReply, guildId);
        if (session.encounter.active && session.turnOrder.length > 1) {
          const nextPlayer = advanceTurn(guildId);
          if (nextPlayer) {
            const transition = pickTurnTransition(nextPlayer.characterName);
            addStoryEntry("dm", "Dungeon Master", transition);
            await sendDMResponseWithVoice(interaction, connections[guildId], transition, guildId);
          }
        } else {
          resetTurnTimeout(guildId);
        }
      }
      return;
    }

    // ===== DAMAGE ROLL — auto-apply to enemy =====
    if (session.pendingDamageRoll && session.pendingDamageRoll.userId === interaction.user.id) {
      const { enemyName } = session.pendingDamageRoll;
      session.pendingDamageRoll = null;
      applyNpcDamage(guildId, enemyName, total);
      const enc = getSession(guildId).encounter;
      const enemy = enc.enemies.find(e => e.name.toLowerCase() === enemyName.toLowerCase());
      const hpText = enemy ? ` (${enemy.hp}/${enemy.maxHp} HP remaining)` : '';
      const dmPrompt = `${playerName} rolled ${total} for damage against ${enemyName}. Apply ${total} damage to ${enemyName}${hpText}. Narrate the hit dramatically.`;
      const reply = await askDM(guildId, dmPrompt, playerName);
      let finalReply = reply.replace(/\[(NPC_NEW|DMG|HEAL|COND[+-]|NPC_DMG|NPC_HEAL|ITEM|ROLL_DMG|ROLL_HIT):[^\]]+\]/gi, '').trim();
      addStoryEntry("dm", "Dungeon Master", finalReply);
      await sendDMResponseWithVoice(interaction, connections[guildId], finalReply, guildId);
      if (session.encounter.active && session.turnOrder.length > 1) {
        const nextPlayer = advanceTurn(guildId);
        if (nextPlayer) {
          const transition = pickTurnTransition(nextPlayer.characterName);
          addStoryEntry("dm", "Dungeon Master", transition);
          await sendDMResponseWithVoice(interaction, connections[guildId], transition, guildId);
        }
      } else {
        resetTurnTimeout(guildId);
      }
      return;
    }

    if (session.active && connections[guildId]) {
      // Store roll result for context
      session.lastRollResult = {
        playerName,
        dice: diceArg,
        total,
        dc: dcArg,
      };

      // Check if there's a pending action from roll prompt, or use DC flag if provided
      let dmPrompt = `I rolled ${diceArg} and got a ${total}.`;
      let expectedDC = null;

      if (session.pendingAction) {
        const pending = session.pendingAction;
        expectedDC = pending.expectedDC;
        const success = total >= pending.expectedDC;
        dmPrompt = `${pending.action}\n[ROLL RESULT: ${playerName} rolled ${total} vs DC ${pending.expectedDC} - ${success ? "SUCCESS" : "FAILURE"}]`;
        session.pendingAction = null;
      } else if (dcArg !== null) {
        // Use DC provided as flag
        expectedDC = dcArg;
        const success = total >= dcArg;
        dmPrompt = `I rolled ${diceArg} and got a ${total} vs DC ${dcArg}.\n[ROLL RESULT: ${playerName} rolled ${total} vs DC ${dcArg} - ${success ? "SUCCESS" : "FAILURE"}]`;
      }

      const reply = await askDM(
        guildId,
        dmPrompt,
        playerName
      );

      // Add next turn prompt if multiple players
      let finalReply = reply;
      if (session.turnOrder.length > 1) {
        const nextPlayer = advanceTurn(guildId);
        if (nextPlayer) {
          finalReply += `\n\nOkay, **${nextPlayer.characterName}**, what do you do?`;
        }
      } else {
        resetTurnTimeout(guildId);
      }

      addStoryEntry("dm", "Dungeon Master", finalReply);
      await sendDMResponseWithVoice(interaction, connections[guildId], finalReply, guildId);
    }
    return;
  }

  // ----------------------------------------------------------
  //  /pass — Pass your turn to the next player
  // ----------------------------------------------------------
  if (commandName === "pass") {
    if (!session.active) {
      return interaction.reply("No game is running!");
    }

    if (session.turnOrder.length <= 1) {
      return interaction.reply("You're the only player! No turn to pass to.");
    }

    const currentPlayer = getCurrentTurnPlayer(guildId);
    if (!currentPlayer || currentPlayer.userId !== interaction.user.id) {
      return interaction.reply("It's not your turn! Wait for your turn or use `/action` anyway for single-player mode.");
    }

    const nextPlayer = advanceTurn(guildId);
    interaction.reply(`✅ **${currentPlayer.characterName}** passes their turn to **${nextPlayer.characterName}**.`);
    
    // Notify the next player in the channel
    interaction.channel.send(`▶️ **${nextPlayer.characterName}**, it's your turn! What do you do?`);
    return;
  }

  // ----------------------------------------------------------
  //  /status — Show current game history summary
  // ----------------------------------------------------------
  if (commandName === "status") {
    const msgCount = session.history.length;
    const isActive = session.active ? "Active ⚔️" : "No game running";
    
    let statusMsg = `**Game Status:** ${isActive}\n**Story exchanges so far:** ${Math.floor(
      msgCount / 2
    )}\nType \`/action [what you do]\` to play.`;
    
    if (session.active && session.turnOrder.length > 1) {
      const currentPlayer = getCurrentTurnPlayer(guildId);
      statusMsg += `\n\n**Current Turn:** ${currentPlayer.characterName}`;
    }
    
    interaction.reply(statusMsg);
    return;
  }

  // ----------------------------------------------------------
  //  /resetgame — Wipe history and start fresh
  // ----------------------------------------------------------
  if (commandName === "resetgame") {
    await revertAllNicknames(interaction);
    sessions[guildId] = null;
    try { dbSession.clearSessionState(guildId); } catch (_) {}
    interaction.reply(
      "🗑️ Game state cleared. Type `/startgame` to begin a new adventure."
    );
    return;
  }

  // ----------------------------------------------------------
  //  /name [character] — Set character name and update nickname
  // ----------------------------------------------------------
  if (commandName === "name") {
    const characterName = interaction.options.getString("character");
    if (!characterName) {
      return interaction.reply("Tell me your character's name!");
    }
    await setPlayerName(interaction, characterName);
    
    // If we're in name collection mode, check if we should proceed
    if (session.nameCollectionActive) {
      const allNamesSet = session.activePlayers.every(p => session.players[p.userId]);
      
      if (allNamesSet) {
        // All players have set names, proceed immediately
        const connection = connections[guildId];
        if (connection) {
          await proceedAfterNames(interaction, guildId, connection);
        }
      } else if (session.activePlayers.length === 1) {
        // Only one player, proceed immediately
        const connection = connections[guildId];
        if (connection) {
          await proceedAfterNames(interaction, guildId, connection);
        }
      } else {
        // Multiple players, start a 10 second timer
        if (session.nameCollectionTimeout) {
          clearTimeout(session.nameCollectionTimeout);
        }
        
        session.nameCollectionTimeout = setTimeout(async () => {
          // Timer fired, proceed with remaining Discord names
          const connection = connections[guildId];
          if (connection && session.active && session.nameCollectionActive) {
            await proceedAfterNames(interaction, guildId, connection);
          }
        }, 10000);
      }
    }
    return;
  }

  // ----------------------------------------------------------
  //  /reloadnotes — Reload world_notes.txt without restarting
  // ----------------------------------------------------------
  if (commandName === "reloadnotes") {
    invalidateSystemPromptCache();
    reloadWorldNotes();
    const status = worldNotes
      ? `✅ World notes reloaded! (${worldNotes.length} characters loaded)`
      : "⚠️ No world_notes.txt found.";
    interaction.reply(status);
    return;
  }

  // ----------------------------------------------------------
  //  /character — Manage D&D character sheets
  // ----------------------------------------------------------
  if (commandName === "character") {
    try {
      const subcommand = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      if (subcommand === "create") {
        const className = interaction.options.getString("class");
        const characterName = interaction.options.getString("name");

        if (!characterName || characterName.length > 50) {
          return interaction.reply("❌ Character name is required and must be 50 chars or less!");
        }

        const template = loadCharacterTemplate(className);
        if (!template) {
          return interaction.reply(`❌ Unknown class: ${className}`);
        }

        // Create character from template
        const character = JSON.parse(JSON.stringify(template)); // Deep copy
        character.character.name = characterName;
        character.character.player = interaction.user.username;
        character.character.lastPlayed = new Date().toISOString();

        // Save character
        if (!saveCharacter(guildId, userId, character)) {
          return interaction.reply("❌ Failed to save character. Please try again.");
        }

        // Load into current session
        session.characterSheets[userId] = character;
        session.currentCharacters[userId] = characterName;
        syncPlayerToDash(userId, interaction.user.username, character);

        try {
          const embed = buildCharacterEmbed(character, interaction.user.username);
          interaction.reply({
            content: `✅ **${characterName}** the **${className}** has been created!`,
            embeds: [embed],
          });
        } catch (embedErr) {
          console.error("Embed error:", embedErr);
          interaction.reply(`✅ **${characterName}** the **${className}** has been created!`);
        }
        return;
      }

      if (subcommand === "select") {
        const characterName = interaction.options.getString("character");
        if (!characterName) {
          return interaction.reply("❌ Character name is required!");
        }

        const character = loadCharacter(guildId, userId, characterName);

        if (!character) {
          const available = listPlayerCharacters(guildId, userId);
          return interaction.reply(
            `❌ Character not found.\n\nYour characters: ${available.length > 0 ? available.join(", ") : "None yet"}`
          );
        }

        // Save old character if one is loaded
        if (session.currentCharacters[userId]) {
          const oldChar = session.characterSheets[userId];
          if (oldChar) {
            saveCharacter(guildId, userId, oldChar);
          }
        }

        // Load new character
        character.character.lastPlayed = new Date().toISOString();
        session.characterSheets[userId] = character;
        session.currentCharacters[userId] = characterName;
        syncPlayerToDash(userId, interaction.user.username, character);

        try {
          const embed = buildCharacterEmbed(character, interaction.user.username);
          interaction.reply({
            content: `✅ **${characterName}** loaded!`,
            embeds: [embed],
          });
        } catch (embedErr) {
          console.error("Embed error:", embedErr);
          interaction.reply(`✅ **${characterName}** loaded!`);
        }
        return;
      }

      if (subcommand === "view") {
        const userId = interaction.user.id;
        const characterName = session.currentCharacters[userId];
        if (!characterName) {
          return interaction.reply("❌ No character loaded. Use `/character select` or `/character create` first.");
        }

        const character = session.characterSheets[userId];
        if (!character) {
          return interaction.reply("❌ Character data not found. Please reload with `/character select`.");
        }

        try {
          const embed = buildCharacterEmbed(character, interaction.user.username);
          interaction.reply({ embeds: [embed] });
        } catch (embedErr) {
          console.error("Embed error:", embedErr);
          interaction.reply(`**${characterName}** the **${character.character.class}**\nLevel ${character.character.level}\nHP: ${character.combat.hp.current}/${character.combat.hp.max}`);
        }
        return;
      }

      if (subcommand === "list") {
        const userId = interaction.user.id;
        try {
          const characters = listPlayerCharacters(guildId, userId);
          if (characters.length === 0) {
            return interaction.reply("❌ You have no characters yet. Use `/character create` to make one!");
          }

          const list = characters.map((c, i) => `${i + 1}. **${c}**`).join("\n");
          interaction.reply(`📜 **Your Characters:**\n\n${list}`);
        } catch (listErr) {
          console.error("List characters error:", listErr);
          return interaction.reply("❌ Error listing characters. Please try again.");
        }
        return;
      }
    } catch (err) {
      console.error("Character command error:", err);
      return interaction.reply("❌ An error occurred processing your character command. Please try again.");
    }
  }

  // ----------------------------------------------------------
  //  /hp — Track HP and damage
  // ----------------------------------------------------------
  if (commandName === "hp") {
    try {
      const userId = interaction.user.id;
      const valueStr = interaction.options.getString("value");

      if (!valueStr) {
        return interaction.reply("❌ Value is required!");
      }

      if (!session.characterSheets[userId]) {
        return interaction.reply("❌ No character loaded! Use `/character select` or `/character create` first.");
      }

      const character = session.characterSheets[userId];
      if (!character.combat || !character.combat.hp) {
        return interaction.reply("❌ Character data invalid. Please reload with `/character select`.");
      }

      const hp = character.combat.hp;

      // Handle "max" syntax
      if (valueStr.toLowerCase().startsWith("max:")) {
        const newMax = parseInt(valueStr.slice(4).trim());
        if (isNaN(newMax) || newMax < 1) {
          return interaction.reply("❌ Invalid max HP value. Use: `/hp max:40`");
        }
        hp.max = newMax;
        hp.current = Math.min(hp.current, newMax);
        if (saveCharacter(guildId, userId, character)) {
          syncPlayerToDash(userId, interaction.user.username, character);
          return interaction.reply(`✅ Max HP set to **${newMax}**. Current: **${hp.current}/${hp.max}**`);
        } else {
          return interaction.reply("❌ Failed to save character.");
        }
      }

      // Handle damage/heal
      const value = parseInt(valueStr);
      if (isNaN(value)) {
        return interaction.reply("❌ Invalid value. Use: `/hp 5` to heal, `/hp -10` to damage, or `/hp max:40` to set max HP.");
      }

      const oldHp = hp.current;
      hp.current = Math.max(0, Math.min(hp.max, hp.current + value));

      const healthBar = "█".repeat(Math.ceil((hp.current / hp.max) * 20)) + 
                        "░".repeat(20 - Math.ceil((hp.current / hp.max) * 20));

      let message = `**${character.character.name}** `;
      if (value > 0) {
        message += `heals **+${value}** HP`;
      } else {
        message += `takes **${Math.abs(value)}** damage`;
      }
      message += `\n\n[${healthBar}] **${hp.current}/${hp.max}**`;

      if (hp.current === 0) {
        message += "\n\n☠️ **CHARACTER UNCONSCIOUS!**";
      }

      if (saveCharacter(guildId, userId, character)) {
        syncPlayerToDash(userId, interaction.user.username, character);
        interaction.reply(message);
      } else {
        interaction.reply("❌ Failed to save character HP change.");
      }
      return;
    } catch (err) {
      console.error("HP command error:", err);
      return interaction.reply("❌ An error occurred. Please try again.");
    }
  }

  // ----------------------------------------------------------
  //  /endgame — End the game gracefully with a DM farewell
  // ----------------------------------------------------------
  if (commandName === "endgame") {
    if (!session.active) {
      return interaction.reply(
        "No game is running. Type `/startgame` to begin."
      );
    }

    const connection = connections[guildId];
    
    // Clear the name collection timeout if active
    if (session.nameCollectionTimeout) {
      clearTimeout(session.nameCollectionTimeout);
    }

    await interaction.reply(
      "⚔️ **The adventure pauses...** Hear the DM's farewell."
    );

    // Get a random quirky remark
    const farewell = getRandomEndgameRemark();
    
    // Send as text and voice
    if (connection) {
      await sendDMResponseWithVoice(interaction, connection, farewell, guildId);
    } else {
      interaction.channel.send(`📜 *${farewell}*`);
    }

    // Revert nicknames
    await revertAllNicknames(interaction);

    // Reset game state
    session.active = false;
    session.nameCollectionActive = false;
    session.activePlayers = [];
    session.history = [];
    try { dbSession.clearSessionState(guildId); } catch (_) {}

    return;
  }

  // ----------------------------------------------------------
  //  /debug — Admin/dev testing tools
  // ----------------------------------------------------------
  if (commandName === "debug") {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: "❌ This command is restricted to server admins.", ephemeral: true });
    }

    const debugAction = interaction.options.getString("action");
    const debugValue = interaction.options.getString("value") || "";

    if (debugAction === "nat20") {
      session.forcedRoll = { value: 20 };
      return interaction.reply({ content: "🎯 **NAT 20 loaded.** The next `/roll` (single die) will land on 20.", ephemeral: true });
    }

    if (debugAction === "nat1") {
      session.forcedRoll = { value: 1 };
      return interaction.reply({ content: "💀 **NAT 1 loaded.** The next `/roll` (single die) will land on 1.", ephemeral: true });
    }

    if (debugAction === "spawn") {
      // Format: "Name HP AC"  e.g. "Goblin 15 12"
      const parts = debugValue.trim().split(/\s+/);
      const enemyName = parts[0] || "Test Enemy";
      const hp = parseInt(parts[1]) || 20;
      const ac = parseInt(parts[2]) || 12;
      spawnEnemy(guildId, enemyName, hp, ac);
      syncEncounterToDash(guildId);
      return interaction.reply({ content: `👹 Spawned **${enemyName}** (HP: ${hp}, AC: ${ac}) on the map.`, ephemeral: true });
    }

    if (debugAction === "startcombat") {
      if (!session.active) {
        return interaction.reply({ content: "❌ No game running. Start one with `/startgame` first.", ephemeral: true });
      }
      const enemyName = debugValue.trim() || "Goblin";
      spawnEnemy(guildId, enemyName, 20, 12);
      syncEncounterToDash(guildId);
      // Inject a combat-start message into DM history
      const combatPrompt = `[DEBUG: Admin has force-started a combat encounter. A ${enemyName} suddenly appears and attacks! Begin the combat immediately.]`;
      addToHistory(guildId, "user", combatPrompt);
      const reply = await askDM(guildId, combatPrompt, playerName || "Admin");
      addStoryEntry("dm", "Dungeon Master", reply);
      await sendDMResponseWithVoice(interaction, connections[guildId], reply, guildId);
      return;
    }

    if (debugAction === "status") {
      const lines = [
        `**Session active:** ${session.active}`,
        `**Players:** ${JSON.stringify(session.players)}`,
        `**Turn order:** ${session.turnOrder.join(", ") || "none"}`,
        `**Encounter enemies:** ${session.encounter.enemies.map(e => `${e.name} ${e.hp}/${e.maxHp} HP`).join(", ") || "none"}`,
        `**Forced roll:** ${session.forcedRoll ? session.forcedRoll.value : "none"}`,
        `**History entries:** ${session.history.length}`,
        `**Character sheets loaded:** ${Object.keys(session.characterSheets).length}`,
      ];
      return interaction.reply({ content: lines.join("\n"), ephemeral: true });
    }

    return interaction.reply({ content: "❓ Unknown debug action.", ephemeral: true });
  }

  // ----------------------------------------------------------
  //  /showworlds — List all available worlds
  // ----------------------------------------------------------
  if (commandName === "showworlds") {
    const worlds = getAllWorlds();
    if (worlds.length === 0) {
      return interaction.reply(
        "📖 No worlds found! Copy `worlds/TEMPLATE.txt` and give it a name to create a new world."
      );
    }
    
    const worldsList = worlds.map((world, idx) => {
      const title = getWorldTitle(path.join(WORLDS_PATH, world));
      return `${idx + 1}. **${title}** (\`${world}\`)`;
    }).join("\n");
    
     interaction.reply(`
📖 **Available Worlds:**

${worldsList}

Use \`/startgame world:[title or filename]\` to pick a specific world, or just \`/startgame\` for a random one.

Examples: \`/startgame world:aethoria\` or \`/startgame world:Aethoria - Chapter 1\`
    `.trim());
    return;
  }

  // ----------------------------------------------------------
  //  /help — Show all commands
  // ----------------------------------------------------------
  if (commandName === "help") {
    interaction.reply(`
**🎲 Dungeon Master Bot — Getting Started**

**QUICK START (3 steps):**
1️⃣ \`/join\` — Bot joins your voice channel
2️⃣ \`/startgame\` — DM introduces the setting and asks for your character names
3️⃣ \`/name [your character name]\` — Everyone sets their character name (one at a time)
   → DM greets you all by name and asks what you do first

Then use \`/action [what you do]\` to play!

---

**DETAILED COMMANDS:**

🎮 **Game Control**
\`/join\` — Bot joins your voice channel
\`/leave\` — Bot leaves voice and ends session
\`/startgame [world:name]\` — Start a new adventure (optionally pick a world by title or filename)
\`/endgame\` — End the game gracefully
\`/resetgame\` — Wipe game state and start fresh
\`/status\` — Check if a game is running

🎭 **Gameplay**
\`/name [character]\` — Set your character name (plays during /startgame)
\`/action [what]\` — Describe what your character does (main command)
\`/roll [dice]\` — Roll dice (e.g. \`/roll 1d20\`, \`/roll 2d6\`)

🌍 **Worlds & Settings**
\`/showworlds\` — List all available worlds
\`/reloadnotes\` — Reload world files without restarting

ℹ️ **Other**
\`/help\` — Show this message
    `.trim());
    return;
  }
});

client.login(DISCORD_TOKEN);
