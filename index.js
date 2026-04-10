// ============================================================
//  D&D AI Dungeon Master Bot
//  Requirements: Node.js, Ollama running locally, ElevenLabs
// ============================================================

require("dotenv").config();
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

  const basePrompt = `You are an experienced, dramatic, and immersive Dungeon Master running a D&D 5e campaign.
Your personality is wise, mysterious, and theatrical — like a storyteller around a campfire.
Keep your responses concise (2-4 sentences max) since they will be spoken aloud in a voice chat.
IMPORTANT: Prioritize grammatically correct, complete sentences above all else. Ensure every response is polished and flows naturally.
Always address ONLY the players present in the game. Do not mention or reference any NPCs or players who are not actively participating.
Always end your response by either:
   - Describing what happens next and asking what the players do, OR
   - Asking for a dice roll (e.g. "Roll for Perception")
Track player names, their actions, and the consequences in the story.
When a player rolls dice, acknowledge the result dramatically and narrate the outcome.
Never break character. Never mention being an AI.
The adventure begins when someone says "start game" or "begin".
IMPORTANT: Use the world reference material below to stay consistent with locations, NPCs, secrets, and lore.
Only reveal secrets when players discover them through actions or rolls — do not volunteer hidden information.`;

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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================
//  GAME STATE
// ============================================================

// Stores conversation history and player info per Discord server.
const sessions = {};

function getSession(guildId) {
  if (!sessions[guildId]) {
    sessions[guildId] = {
      history: [],       // Chat history sent to LLM
      players: {},        // { userId: characterName }
      originalNicknames: {}, // { userId: originalNickname } for reverting
      activePlayers: [],  // Array of { userId, displayName, characterName } currently in voice channel
      active: false,      // Is a game running?
      nameCollectionActive: false, // Currently waiting for player names
      nameCollectionTimeout: null, // Timer for auto-proceeding with missing names
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

function getPlayerDisplayName(guildId, userId) {
  const session = getSession(guildId);
  // Return character name if set, otherwise return Discord display name
  return session.players[userId] || null;
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
  
  // Build final player names list
  const playerNames = session.activePlayers.map(p => session.players[p.userId]).join(" and ");
  
  // DM addresses players by name and asks for first action
  const reply = await askDM(
    guildId,
    `The players have introduced themselves as: ${playerNames}. Greet them warmly by their names and set the opening scene. Ask them what they would like to do first.`,
    "Game Master"
  );
  
  await sendDMResponseWithVoice(interaction, connection, reply);
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

async function sendDMResponseWithVoice(interaction, connection, dmText) {
  // Send the text response
  interaction.channel.send(`📜 **DM:** *${dmText}*`);
  
  // Try to send voice
  const audioFile = await textToSpeech(dmText);
  if (audioFile) {
    try {
      await speakInVoice(connection, audioFile);
    } catch (err) {
      console.error("Voice playback error:", err.message);
      interaction.channel.send("⚠️ *Voice playback failed, but the narration continues...*");
    }
  } else {
    // Voice synthesis failed
    interaction.channel.send("⚠️ *Voice synthesis failed (service unavailable), but the narration continues...*");
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
async function askDMStream(guildId, userMessage, playerName, onToken) {
  const session = getSession(guildId);
  const fullMessage = `${playerName} says: "${userMessage}"`;
  addToHistory(guildId, "user", fullMessage);

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...session.history,
  ];

  let fullText = "";

  try {
    // Use non-streaming mode to avoid token concatenation issues
    fullText = LLM_PROVIDER === "openai" 
      ? await askOpenAI(messages) 
      : await askOllama(messages);

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

  // Try to update Discord nickname
  try {
    await member.setNickname(nameWithSuffix);
    const suffix_msg = suffix > 0 ? ` (numbered as "${nameWithSuffix}" because another player shares that name)` : '';
    interaction.reply(`✅ You are now **${nameWithSuffix}**${suffix_msg}!`);
  } catch (err) {
    console.warn(`Failed to set nickname for ${userId}:`, err.message);
    session.players[userId] = nameWithSuffix;
    const suffix_msg = suffix > 0 ? ` (numbered as "${nameWithSuffix}" because another player shares that name)` : '';
    interaction.reply(`✅ Character name set to **${nameWithSuffix}**${suffix_msg}! (⚠️ Bot lacks permission to update your Discord nickname, but your character name is saved.)`);
  }
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
    ],
  },
  {
    name: "roll",
    description: "Roll dice (e.g. 1d20, 2d6)",
    options: [
      {
        name: "dice",
        description: "Dice to roll (e.g. 1d20)",
        type: ApplicationCommandOptionType.String,
        required: true,
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
    name: "endgame",
    description: "End the current game gracefully with a DM farewell",
  },
  {
    name: "showworlds",
    description: "List all available worlds",
  },
  {
    name: "help",
    description: "Show all commands",
  },
];

const rest = new REST().setToken(DISCORD_TOKEN);

// ============================================================
//  BOT READY
// ============================================================

client.once(Events.ClientReady, async (c) => {
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

    await interaction.reply(
      "⚔️ **The adventure begins...** Listen closely, adventurers."
    );

    // DM intro asking for character names
    const reply = await askDM(
      guildId,
      `Begin the adventure. Ask the players to introduce themselves with their character names. The players here are: ${session.activePlayers.map(p => p.displayName).join(", ")}. Ask them to declare their names.`,
      "Game Master"
    );

    // Send response with voice
    await sendDMResponseWithVoice(interaction, connection, reply);
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

    const action = interaction.options.getString("what");
    if (!action) return interaction.reply("Tell me what you want to do!");

    await interaction.reply(`⚔️ *${playerName}: "${action}"*`);

    let dmText = "";
    const reply = await askDMStream(
      guildId,
      action,
      playerName,
      (text) => {
        dmText = text;
      }
    );

    await sendDMResponseWithVoice(interaction, connection, reply);
    return;
  }

  // ----------------------------------------------------------
  //  /roll [dice] — Roll dice and tell the DM
  // ----------------------------------------------------------
  if (commandName === "roll") {
    const diceArg = interaction.options.getString("dice") || "1d20";
    const [numDice, diceSides] = diceArg.toLowerCase().split("d").map(Number);

    if (!numDice || !diceSides) {
      return interaction.reply(
        "Invalid dice format. Try `/roll 1d20` or `/roll 2d6`"
      );
    }

    let total = 0;
    const rolls = [];
    for (let i = 0; i < numDice; i++) {
      const roll = Math.floor(Math.random() * diceSides) + 1;
      rolls.push(roll);
      total += roll;
    }

    const rollText = `${playerName} rolled ${diceArg}: [${rolls.join(", ")}] = **${total}**`;
    await interaction.reply(`🎲 ${rollText}`);

    if (session.active && connections[guildId]) {
      const reply = await askDM(
        guildId,
        `I rolled ${diceArg} and got a ${total}.`,
        playerName
      );

      await sendDMResponseWithVoice(interaction, connections[guildId], reply);
    }
    return;
  }

  // ----------------------------------------------------------
  //  /status — Show current game history summary
  // ----------------------------------------------------------
  if (commandName === "status") {
    const msgCount = session.history.length;
    const isActive = session.active ? "Active ⚔️" : "No game running";
    interaction.reply(
      `**Game Status:** ${isActive}\n**Story exchanges so far:** ${Math.floor(
        msgCount / 2
      )}\nType \`/action [what you do]\` to play.`
    );
    return;
  }

  // ----------------------------------------------------------
  //  /resetgame — Wipe history and start fresh
  // ----------------------------------------------------------
  if (commandName === "resetgame") {
    await revertAllNicknames(interaction);
    sessions[guildId] = null;
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
      await sendDMResponseWithVoice(interaction, connection, farewell);
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
    
    return;
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

Use \`/startgame\` to start with a random world, or set \`WORLD_FILE\` in your .env to choose a specific one (e.g., \`ashmore_keep.txt\`).
    `.trim());
    return;
  }

  // ----------------------------------------------------------
  //  /help — Show all commands
  // ----------------------------------------------------------
  if (commandName === "help") {
    interaction.reply(`
**🎲 Dungeon Master Bot Commands**

\`/join\` — Bot joins your voice channel
\`/leave\` — Bot leaves and ends the session
\`/startgame\` — Start a new adventure
\`/name [character]\` — Set your character name and update your Discord nickname
\`/action [what]\` — Declare what your character does
\`/roll [dice]\` — Roll dice (e.g. \`/roll 1d20\`, \`/roll 2d6\`)
\`/status\` — Check if a game is running
\`/endgame\` — End the game gracefully with a DM farewell
\`/resetgame\` — Wipe the current game and start fresh
\`/showworlds\` — List all available worlds
\`/reloadnotes\` — Reload world files without restarting the bot
\`/help\` — Show this message
    `.trim());
    return;
  }
});

client.login(DISCORD_TOKEN);
