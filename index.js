// ============================================================
//  D&D AI Dungeon Master Bot
//  Requirements: Node.js, Ollama running locally, ElevenLabs
// ============================================================

require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Events,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { createWriteStream } = require("fs");
const prism = require("prism-media");
const express = require("express");
const http = require("http");
const { Server: SocketServer } = require("socket.io");
const multer = require("multer");

// ============================================================
//  CONFIG
// ============================================================

const OLLAMA_URL = "http://localhost:11434/api/chat";
const OLLAMA_MODEL = "llama3";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const MAX_HISTORY = 20;

// ============================================================
//  DASHBOARD SERVER
// ============================================================

const expressApp = express();
const httpServer = http.createServer(expressApp);
const io = new SocketServer(httpServer, { cors: { origin: "*" } });

expressApp.use(express.json());
expressApp.use(express.static(path.join(__dirname, "dnd-dashboard/public")));

// Uploads folder for map images
const UPLOADS_DIR = path.join(__dirname, "dnd-dashboard/public/uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
expressApp.use("/uploads", express.static(UPLOADS_DIR));

const mapUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".png";
      cb(null, `map_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"), false);
  },
});

const GAME_STATE_PATH = path.join(__dirname, "dnd-dashboard/game_state.json");

function loadDashboardState() {
  try {
    if (fs.existsSync(GAME_STATE_PATH)) {
      const s = JSON.parse(fs.readFileSync(GAME_STATE_PATH, "utf-8"));
      if (!s.tokens) s.tokens = [];
      return s;
    }
  } catch (e) {
    console.error("Dashboard state load error:", e.message);
  }
  return {
    location: { name: "The Adventure Begins", description: "Your journey starts here...", mapImage: null },
    players: {},
    storyFeed: [],
    diceLog: [],
    tokens: [],
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

// REST — full state
expressApp.get("/api/state", (req, res) => res.json(dashState));

// REST — create a new character directly from the dashboard (MUST be before /:discordId)
expressApp.post("/api/player/new", (req, res) => {
  const { discordId, discordName, characterName } = req.body;
  if (!discordId || !characterName) {
    return res.status(400).json({ error: "discordId and characterName are required" });
  }
  if (!dashState.players[discordId]) {
    dashState.players[discordId] = {
      discordId,
      discordName: discordName || characterName,
      characterName,
      hp: 10, maxHp: 10, ac: 10,
      class: "Adventurer", level: 1,
      image: null, inventory: [], spells: [],
      features: [], conditions: {},
    };
  } else {
    dashState.players[discordId].characterName = characterName;
    dashState.players[discordId].discordName   = discordName || characterName;
  }
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true, player: dashState.players[discordId] });
});

// REST — update a player (called from dashboard UI)
expressApp.post("/api/player/:discordId", (req, res) => {
  const { discordId } = req.params;
  if (!dashState.players[discordId]) {
    return res.status(404).json({ error: "Player not found" });
  }
  Object.assign(dashState.players[discordId], req.body);
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true });
});

// REST — update location (called from dashboard UI)
expressApp.post("/api/location", (req, res) => {
  Object.assign(dashState.location, req.body);
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true });
});

// REST — upload a map image file
expressApp.post("/api/upload/map", mapUpload.single("map"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });
  dashState.location.mapImage = `/uploads/${req.file.filename}`;
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true, url: dashState.location.mapImage });
});

// REST — add a token to the map
expressApp.post("/api/tokens", (req, res) => {
  const { id, label, type, shape, color, image, x, y, owner } = req.body;
  if (!id) return res.status(400).json({ error: "id required" });
  dashState.tokens = dashState.tokens.filter(t => t.id !== id);
  dashState.tokens.push({ id, label: label || "", type: type || "shape", shape: shape || "circle", color: color || "#8b1a1a", image: image || null, x: x ?? 0.5, y: y ?? 0.5, owner: owner || null });
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true });
});

// REST — move a token
expressApp.post("/api/tokens/:id/move", (req, res) => {
  const token = dashState.tokens.find(t => t.id === req.params.id);
  if (!token) return res.status(404).json({ error: "Token not found" });
  token.x = req.body.x ?? token.x;
  token.y = req.body.y ?? token.y;
  saveDashboardState();
  io.emit("token_move", { id: token.id, x: token.x, y: token.y });
  res.json({ ok: true });
});

// REST — remove a token
expressApp.delete("/api/tokens/:id", (req, res) => {
  dashState.tokens = dashState.tokens.filter(t => t.id !== req.params.id);
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true });
});

// REST — delete a player
expressApp.delete("/api/player/:discordId", (req, res) => {
  const { discordId } = req.params;
  if (!dashState.players[discordId]) {
    return res.status(404).json({ error: "Player not found" });
  }
  delete dashState.players[discordId];
  // Also remove any tokens owned by this player
  dashState.tokens = dashState.tokens.filter(t => t.owner !== discordId);
  saveDashboardState();
  io.emit("state_update", dashState);
  res.json({ ok: true });
});


// Track which discordIds are currently active: socketId → discordId
const activeSessions = new Map();

function broadcastActivePlayers() {
  const active = [...new Set(activeSessions.values())];
  io.emit("active_players", active);
}

io.on("connection", (socket) => {
  console.log("🖥️  Dashboard client connected");
  socket.emit("state_update", dashState);
  // Send current active players to the new client
  socket.emit("active_players", [...new Set(activeSessions.values())]);

  socket.on("player_active", (discordId) => {
    if (discordId) {
      activeSessions.set(socket.id, discordId);
      broadcastActivePlayers();
    }
  });

  socket.on("player_inactive", (discordId) => {
    activeSessions.delete(socket.id);
    broadcastActivePlayers();
  });

  socket.on("disconnect", () => {
    activeSessions.delete(socket.id);
    broadcastActivePlayers();
  });
});

httpServer.listen(3000, () => {
  console.log("🗺️  Dashboard running at http://localhost:3000");
});

// ── Story / Dice feed helpers ─────────────────────────────

function addStoryEntry(type, name, text) {
  const entry = { type, name, text, timestamp: new Date().toISOString() };
  dashState.storyFeed.push(entry);
  if (dashState.storyFeed.length > 150) {
    dashState.storyFeed = dashState.storyFeed.slice(-150);
  }
  saveDashboardState();
  io.emit("story_entry", entry);
}

function addDiceEntry(name, dice, rolls, total) {
  const entry = { name, dice, rolls, total, timestamp: new Date().toISOString() };
  dashState.diceLog.unshift(entry);
  if (dashState.diceLog.length > 20) {
    dashState.diceLog = dashState.diceLog.slice(0, 20);
  }
  saveDashboardState();
  io.emit("dice_entry", entry);
}

// ============================================================
//  WORLD NOTES — Load from world_notes.txt
// ============================================================

const WORLD_NOTES_PATH = path.join(__dirname, "world_notes.txt");
let worldNotes = "";

function loadWorldNotes() {
  try {
    if (fs.existsSync(WORLD_NOTES_PATH)) {
      worldNotes = fs.readFileSync(WORLD_NOTES_PATH, "utf-8").trim();
      console.log(`📖 World notes loaded (${worldNotes.length} characters)`);
    } else {
      console.log("📖 No world_notes.txt found — starting with no reference material.");
      console.log("   Create a world_notes.txt file in your bot folder to add maps, NPCs, lore etc.");
    }
  } catch (err) {
    console.error("Failed to load world_notes.txt:", err.message);
  }
}

function reloadWorldNotes() {
  loadWorldNotes();
}

loadWorldNotes();

// ============================================================
//  BUILD SYSTEM PROMPT — Combines DM personality + world notes
// ============================================================

function buildSystemPrompt() {
  const basePrompt = `You are an experienced, dramatic, and immersive Dungeon Master running a D&D 5e campaign.
Your personality is wise, mysterious, and theatrical — like a storyteller around a campfire.
Keep your responses concise (2-4 sentences max) since they will be spoken aloud in a voice chat.
Always end your response by either:
  - Describing what happens next and asking what the players do, OR
  - Asking for a dice roll (e.g. "Roll for Perception")
Track player names, their actions, and the consequences in the story.
When a player rolls dice, acknowledge the result dramatically and narrate the outcome.
Never break character. Never mention being an AI.
The adventure begins when someone says "start game" or "begin".
IMPORTANT: Use the world reference material below to stay consistent with locations, NPCs, secrets, and lore.
Only reveal secrets when players discover them through actions or rolls — do not volunteer hidden information.

CRITICAL SPEAKING RULES — YOU MUST FOLLOW THESE:
- You are SPEAKING out loud directly to the players. Never describe yourself speaking.
- NEVER write things like "I say in a low voice", "I whisper", "the DM says", "I tell you", "I respond", "I lean forward and say", or any similar self-narration.
- NEVER use asterisks to describe your own actions like *leans in* or *speaks gravely*.
- Just speak directly. Instead of writing: "I say in a dark tone: the castle looms ahead" — just say: "The castle looms ahead."
- Your words ARE the narration. Speak them, do not describe yourself speaking them.
- If an NPC is talking, introduce them with their name once, then speak as them directly.`;

  if (worldNotes) {
    return `${basePrompt}

============================
WORLD REFERENCE MATERIAL
(Use this to guide the story. Do not read this aloud directly.)
============================
${worldNotes}
============================`;
  }

  return basePrompt;
}

// ============================================================
//  GAME STATE
// ============================================================

const sessions = {};

function getSession(guildId) {
  if (!sessions[guildId]) {
    sessions[guildId] = {
      history: [],
      players: {},
      active: false,
    };
  }
  return sessions[guildId];
}

function addToHistory(guildId, role, content) {
  const session = getSession(guildId);
  session.history.push({ role, content });
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
}

// ============================================================
//  OLLAMA — AI BRAIN
// ============================================================

async function askDM(guildId, userMessage, playerName) {
  const session = getSession(guildId);

  const fullMessage = `${playerName} says: "${userMessage}"`;
  addToHistory(guildId, "user", fullMessage);

  try {
    const response = await axios.post(OLLAMA_URL, {
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        ...session.history,
      ],
      stream: false,
    });

    const reply = response.data.message.content;
    addToHistory(guildId, "assistant", reply);
    return reply;

  } catch (err) {
    console.error("Ollama error:", err.message);
    return "The ancient tomes are silent... (Ollama may not be running. Try: ollama serve)";
  }
}

// ============================================================
//  ELEVENLABS — DM VOICE
// ============================================================

async function textToSpeech(text) {
  const outputPath = path.join(__dirname, "dm_response.mp3");

  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        text,
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

// ============================================================
//  DISCORD VOICE — PLAYBACK
// ============================================================

async function speakInVoice(connection, audioFilePath) {
  return new Promise((resolve, reject) => {
    const player = createAudioPlayer();
    const resource = createAudioResource(audioFilePath);

    player.play(resource);
    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
      resolve();
    });

    player.on("error", (err) => {
      console.error("Audio player error:", err.message);
      reject(err);
    });
  });
}

// ============================================================
//  DISCORD VOICE — LISTENING (Speech-to-Text via Whisper)
// ============================================================

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

const connections = {};

// ============================================================
//  BOT READY
// ============================================================

client.once(Events.ClientReady, (c) => {
  console.log(`\n🎲 Dungeon Master Bot is online as ${c.user.tag}`);
  console.log(`   Ollama model: ${OLLAMA_MODEL}`);
  console.log(`   Make sure "ollama serve" is running!`);
  console.log(`   Edit world_notes.txt to add your maps, NPCs, and lore.\n`);
});

// ============================================================
//  MESSAGE HANDLER — Text Commands
// ============================================================

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const guildId = message.guild?.id;
  if (!guildId) return;

  const session = getSession(guildId);
  const content = message.content.trim();
  const playerName = message.member?.displayName || message.author.username;
  const userId = message.author.id;

  // ----------------------------------------------------------
  //  !join — Bot joins your voice channel
  // ----------------------------------------------------------
  if (content.toLowerCase() === "!join") {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply("You need to be in a voice channel first!");
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      connections[guildId] = connection;

      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
      message.reply(`🎲 The Dungeon Master has entered **${voiceChannel.name}**! Type \`!startgame\` to begin your adventure.`);

    } catch (err) {
      console.error("Voice join error:", err);
      message.reply("Couldn't join the voice channel. Check bot permissions.");
    }
    return;
  }

  // ----------------------------------------------------------
  //  !leave — Bot leaves voice channel
  // ----------------------------------------------------------
  if (content.toLowerCase() === "!leave") {
    const connection = connections[guildId];
    if (connection) {
      connection.destroy();
      delete connections[guildId];
      sessions[guildId] = null;
      message.reply("The Dungeon Master has departed. Farewell, adventurers.");
    } else {
      message.reply("I'm not in a voice channel.");
    }
    return;
  }

  // ----------------------------------------------------------
  //  !startgame — Begin the campaign
  // ----------------------------------------------------------
  if (content.toLowerCase() === "!startgame") {
    const connection = connections[guildId];
    if (!connection) {
      return message.reply("Type `!join` first so I can speak in your voice channel.");
    }

    session.active = true;
    session.history = [];

    // Reset story feed for new game but keep player registrations
    dashState.storyFeed = [];
    saveDashboardState();
    io.emit("state_update", dashState);

    message.channel.send("⚔️ **The adventure begins...** Listen closely, adventurers.");

    const intro = await askDM(
      guildId,
      "Begin the adventure. Introduce the setting dramatically and ask the players who they are.",
      "Game Master"
    );

    const audioFile = await textToSpeech(intro);
    if (audioFile) {
      await speakInVoice(connection, audioFile);
    }

    addStoryEntry("dm", "Dungeon Master", intro);
    message.channel.send(`📜 *${intro}*`);
    return;
  }

  // ----------------------------------------------------------
  //  !action [what you do] — Main gameplay command
  // ----------------------------------------------------------
  if (content.toLowerCase().startsWith("!action ")) {
    if (!session.active) {
      return message.reply("No game is running. Type `!startgame` to begin.");
    }

    const connection = connections[guildId];
    if (!connection) {
      return message.reply("Bot isn't in a voice channel. Type `!join` first.");
    }

    const action = content.slice(8).trim();
    if (!action) return message.reply("Tell me what you want to do! e.g. `!action I search the room for traps`");

    message.channel.send(`⚔️ *${playerName}: "${action}"*`);
    addStoryEntry("player", playerName, action);

    const dmResponse = await askDM(guildId, action, playerName);

    const audioFile = await textToSpeech(dmResponse);
    if (audioFile) {
      await speakInVoice(connection, audioFile);
    }

    addStoryEntry("dm", "Dungeon Master", dmResponse);
    message.channel.send(`📜 **DM:** *${dmResponse}*`);
    return;
  }

  // ----------------------------------------------------------
  //  !roll [dice] — Roll dice and tell the DM
  // ----------------------------------------------------------
  if (content.toLowerCase().startsWith("!roll")) {
    const diceArg = content.split(" ")[1] || "1d20";
    const [numDice, diceSides] = diceArg.toLowerCase().split("d").map(Number);

    if (!numDice || !diceSides) {
      return message.reply("Invalid dice format. Try `!roll 1d20` or `!roll 2d6`");
    }

    let total = 0;
    const rolls = [];
    for (let i = 0; i < numDice; i++) {
      const roll = Math.floor(Math.random() * diceSides) + 1;
      rolls.push(roll);
      total += roll;
    }

    const rollText = `${playerName} rolled ${diceArg}: [${rolls.join(", ")}] = **${total}**`;
    message.channel.send(`🎲 ${rollText}`);
    addDiceEntry(playerName, diceArg, rolls, total);

    if (session.active && connections[guildId]) {
      const dmResponse = await askDM(
        guildId,
        `I rolled ${diceArg} and got a ${total}.`,
        playerName
      );

      const audioFile = await textToSpeech(dmResponse);
      if (audioFile) {
        await speakInVoice(connections[guildId], audioFile);
      }

      addStoryEntry("dm", "Dungeon Master", dmResponse);
      message.channel.send(`📜 **DM:** *${dmResponse}*`);
    }
    return;
  }

  // ----------------------------------------------------------
  //  !status — Show current game status
  // ----------------------------------------------------------
  if (content.toLowerCase() === "!status") {
    const msgCount = session.history.length;
    const isActive = session.active ? "Active ⚔️" : "No game running";
    message.reply(`**Game Status:** ${isActive}\n**Story exchanges so far:** ${msgCount / 2}\nType \`!action [what you do]\` to play.`);
    return;
  }

  // ----------------------------------------------------------
  //  !resetgame — Wipe history and start fresh
  // ----------------------------------------------------------
  if (content.toLowerCase() === "!resetgame") {
    sessions[guildId] = null;
    dashState.storyFeed = [];
    dashState.diceLog = [];
    dashState.location = {
      name: "The Adventure Begins",
      description: "Your journey starts here...",
      mapImage: null,
    };
    saveDashboardState();
    io.emit("state_update", dashState);
    message.reply("🗑️ Game state cleared. Type `!startgame` to begin a new adventure.");
    return;
  }

  // ----------------------------------------------------------
  //  !reloadnotes — Reload world_notes.txt without restarting
  // ----------------------------------------------------------
  if (content.toLowerCase() === "!reloadnotes") {
    reloadWorldNotes();
    const status = worldNotes
      ? `✅ World notes reloaded! (${worldNotes.length} characters loaded)`
      : "⚠️ No world_notes.txt found. Create one in your bot folder.";
    message.reply(status);
    return;
  }

  // ----------------------------------------------------------
  //  DASHBOARD COMMANDS
  // ----------------------------------------------------------

  // !register [character name] — Register yourself in the dashboard
  if (content.toLowerCase().startsWith("!register ")) {
    const charName = content.slice(10).trim();
    if (!charName) return message.reply("Usage: `!register Aldric the Bold`");

    if (!dashState.players[userId]) {
      dashState.players[userId] = {
        discordId: userId,
        discordName: playerName,
        characterName: charName,
        hp: 20,
        maxHp: 20,
        ac: 10,
        class: "Adventurer",
        level: 1,
        image: null,
        inventory: [],
        spells: [],
      };
    } else {
      dashState.players[userId].characterName = charName;
      dashState.players[userId].discordName = playerName;
    }

    saveDashboardState();
    io.emit("state_update", dashState);
    message.reply(`✅ **${charName}** is now on the campaign dashboard! Open the dashboard to set your stats, image, inventory, and spells.`);
    return;
  }

  // !hp [current]/[max] — Update HP  e.g. !hp 15/30
  if (content.toLowerCase().startsWith("!hp ")) {
    if (!dashState.players[userId]) {
      return message.reply("You're not registered. Type `!register [character name]` first.");
    }
    const hpArg = content.slice(4).trim();
    const parts = hpArg.split("/").map(n => parseInt(n.trim()));
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
      return message.reply("Usage: `!hp 15/30` (current/max)");
    }
    dashState.players[userId].hp = parts[0];
    dashState.players[userId].maxHp = parts[1];
    saveDashboardState();
    io.emit("state_update", dashState);
    message.reply(`❤️ HP updated: **${parts[0]}/${parts[1]}**`);
    return;
  }

  // !setclass [class] [level] — e.g. !setclass Fighter 3
  if (content.toLowerCase().startsWith("!setclass ")) {
    if (!dashState.players[userId]) {
      return message.reply("You're not registered. Type `!register [character name]` first.");
    }
    const args = content.slice(10).trim().split(" ");
    const level = parseInt(args[args.length - 1]);
    const hasLevel = !isNaN(level);
    const className = hasLevel ? args.slice(0, -1).join(" ") : args.join(" ");

    dashState.players[userId].class = className;
    if (hasLevel) dashState.players[userId].level = level;
    saveDashboardState();
    io.emit("state_update", dashState);
    message.reply(`✅ Class set to **${className}${hasLevel ? ` Level ${level}` : ""}**`);
    return;
  }

  // !setac [number] — Set armor class
  if (content.toLowerCase().startsWith("!setac ")) {
    if (!dashState.players[userId]) {
      return message.reply("You're not registered. Type `!register [character name]` first.");
    }
    const ac = parseInt(content.slice(7).trim());
    if (isNaN(ac)) return message.reply("Usage: `!setac 16`");
    dashState.players[userId].ac = ac;
    saveDashboardState();
    io.emit("state_update", dashState);
    message.reply(`🛡️ AC set to **${ac}**`);
    return;
  }

  // !setimage [url] — Set character portrait
  if (content.toLowerCase().startsWith("!setimage ")) {
    if (!dashState.players[userId]) {
      return message.reply("You're not registered. Type `!register [character name]` first.");
    }
    const imgUrl = content.slice(10).trim();
    dashState.players[userId].image = imgUrl || null;
    saveDashboardState();
    io.emit("state_update", dashState);
    message.reply(`🖼️ Character portrait updated on the dashboard.`);
    return;
  }

  // !additem [item] — Add to inventory
  if (content.toLowerCase().startsWith("!additem ")) {
    if (!dashState.players[userId]) {
      return message.reply("You're not registered. Type `!register [character name]` first.");
    }
    const item = content.slice(9).trim();
    if (!item) return message.reply("Usage: `!additem Health Potion`");
    dashState.players[userId].inventory.push(item);
    saveDashboardState();
    io.emit("state_update", dashState);
    message.reply(`🎒 **${item}** added to your inventory.`);
    return;
  }

  // !removeitem [item] — Remove from inventory
  if (content.toLowerCase().startsWith("!removeitem ")) {
    if (!dashState.players[userId]) {
      return message.reply("You're not registered. Type `!register [character name]` first.");
    }
    const item = content.slice(12).trim().toLowerCase();
    const inv = dashState.players[userId].inventory;
    const idx = inv.findIndex(i => i.toLowerCase() === item);
    if (idx === -1) return message.reply(`❌ Item not found in inventory.`);
    inv.splice(idx, 1);
    saveDashboardState();
    io.emit("state_update", dashState);
    message.reply(`🗑️ Item removed from inventory.`);
    return;
  }

  // !addspell [spell or ability] — Add to spells/abilities
  if (content.toLowerCase().startsWith("!addspell ")) {
    if (!dashState.players[userId]) {
      return message.reply("You're not registered. Type `!register [character name]` first.");
    }
    const spell = content.slice(10).trim();
    if (!spell) return message.reply("Usage: `!addspell Fireball`");
    dashState.players[userId].spells.push(spell);
    saveDashboardState();
    io.emit("state_update", dashState);
    message.reply(`✨ **${spell}** added to your spells/abilities.`);
    return;
  }

  // !setlocation [name] | [description] — DM updates location
  // Example: !setlocation The Dark Forest | Ancient trees loom overhead, their branches blocking the moonlight.
  if (content.toLowerCase().startsWith("!setlocation ")) {
    const locContent = content.slice(13).trim();
    const parts = locContent.split("|");
    dashState.location.name = parts[0].trim();
    dashState.location.description = parts[1] ? parts[1].trim() : "";
    saveDashboardState();
    io.emit("state_update", dashState);
    addStoryEntry("system", "Location", `The party arrives at: ${dashState.location.name}`);
    message.reply(`🗺️ Location updated to **${dashState.location.name}**`);
    return;
  }

  // !setmap [url] — Set map image
  if (content.toLowerCase().startsWith("!setmap ")) {
    const mapUrl = content.slice(8).trim();
    dashState.location.mapImage = mapUrl || null;
    saveDashboardState();
    io.emit("state_update", dashState);
    message.reply(`🗺️ Map updated on the dashboard.`);
    return;
  }

  // ----------------------------------------------------------
  //  !help — Show all commands
  // ----------------------------------------------------------
  if (content.toLowerCase() === "!help") {
    message.reply(`
**🎲 Dungeon Master Bot Commands**

**Game**
\`!join\` — Bot joins your voice channel
\`!leave\` — Bot leaves and ends the session
\`!startgame\` — Start a new adventure
\`!action [text]\` — Declare what your character does
\`!roll [dice]\` — Roll dice (e.g. \`!roll 1d20\`, \`!roll 2d6\`)
\`!status\` — Check if a game is running
\`!resetgame\` — Wipe the current game and start fresh
\`!reloadnotes\` — Reload world_notes.txt without restarting

**Dashboard**
\`!register [name]\` — Register your character on the dashboard
\`!hp [current]/[max]\` — Update your HP (e.g. \`!hp 15/30\`)
\`!setclass [class] [level]\` — Set class (e.g. \`!setclass Fighter 3\`)
\`!setac [number]\` — Set your Armor Class
\`!setimage [url]\` — Set your character portrait URL
\`!additem [item]\` — Add item to your inventory
\`!removeitem [item]\` — Remove item from inventory
\`!addspell [spell]\` — Add a spell or ability
\`!setlocation [name] | [description]\` — Update current location
\`!setmap [url]\` — Set the map image on the dashboard
    `.trim());
    return;
  }
});

// ============================================================
//  LOGIN
// ============================================================

client.login(DISCORD_TOKEN);
