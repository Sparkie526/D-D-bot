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
const { pipeline } = require("stream/promises");
const { createWriteStream } = require("fs");
// NOTE: prism-media is pulled in via @discordjs/voice. If we need it later for
// transcoding/decoding incoming voice, add it as a direct dependency.

// ============================================================
//  CONFIG
// ============================================================

// In Docker, "localhost" points at the container, so allow overriding.
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3"; // e.g. mistral
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// How many past messages to remember (keeps token use low)
const MAX_HISTORY = 20;

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

// Call this to reload notes mid-session without restarting the bot
function reloadWorldNotes() {
  loadWorldNotes();
}

// Load notes on startup
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
Only reveal secrets when players discover them through actions or rolls — do not volunteer hidden information.`;

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

// Stores conversation history and player info per Discord server
const sessions = {};

function getSession(guildId) {
  if (!sessions[guildId]) {
    sessions[guildId] = {
      history: [],       // Chat history sent to Ollama
      players: {},       // { userId: characterName }
      active: false,     // Is a game running?
    };
  }
  return sessions[guildId];
}

function addToHistory(guildId, role, content) {
  const session = getSession(guildId);
  session.history.push({ role, content });
  // Trim old messages to keep context window manageable
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

// Store active voice connections per guild
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
  console.log(`   Ollama model: ${OLLAMA_MODEL}`);
  console.log(`   Make sure "ollama serve" is running!`);
  console.log(`   Edit world_notes.txt to add your maps, NPCs, and lore.\n`);

  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationCommands(c.user.id),
      { body: commands }
    );
    console.log("Slash commands registered globally ✅");
  } catch (err) {
    console.error("Failed to register commands:", err.message);
  }
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
  const playerName = interaction.member?.displayName || interaction.user.username;
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
        guildId: guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      connections[guildId] = connection;
      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
      interaction.reply(`🎲 The Dungeon Master has entered **${voiceChannel.name}**! Type \`/startgame\` to begin your adventure.`);

    } catch (err) {
      console.error("Voice join error:", err);
      interaction.reply("Couldn't join the voice channel. Check bot permissions.");
    }
    return;
  }

  // ----------------------------------------------------------
  //  /leave — Bot leaves voice channel
  // ----------------------------------------------------------
  if (commandName === "leave") {
    const connection = connections[guildId];
    if (connection) {
      connection.destroy();
      delete connections[guildId];
      sessions[guildId] = null;
      interaction.reply("The Dungeon Master has departed. Farewell, adventurers.");
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
      return interaction.reply("Type `/join` first so I can speak in your voice channel.");
    }

    session.active = true;
    session.history = [];

    await interaction.reply("⚔️ **The adventure begins...** Listen closely, adventurers.");

    const intro = await askDM(
      guildId,
      "Begin the adventure. Introduce the setting dramatically and ask the players who they are.",
      "Game Master"
    );

    const audioFile = await textToSpeech(intro);
    if (audioFile) {
      await speakInVoice(connection, audioFile);
    }

    interaction.channel.send(`📜 *${intro}*`);
    return;
  }

  // ----------------------------------------------------------
  //  /action [what you do] — Main gameplay command
  // ----------------------------------------------------------
  if (commandName === "action") {
    if (!session.active) {
      return interaction.reply("No game is running. Type `/startgame` to begin.");
    }

    const connection = connections[guildId];
    if (!connection) {
      return interaction.reply("Bot isn't in a voice channel. Type `/join` first.");
    }

    const action = interaction.options.getString("what");
    if (!action) return interaction.reply("Tell me what you want to do!");

    await interaction.reply(`⚔️ *${playerName}: "${action}"*`);

    const dmResponse = await askDM(guildId, action, playerName);

    const audioFile = await textToSpeech(dmResponse);
    if (audioFile) {
      await speakInVoice(connection, audioFile);
    }

    interaction.channel.send(`📜 **DM:** *${dmResponse}*`);
    return;
  }

  // ----------------------------------------------------------
  //  /roll [dice] — Roll dice and tell the DM
  // ----------------------------------------------------------
  if (commandName === "roll") {
    const diceArg = interaction.options.getString("dice") || "1d20";
    const [numDice, diceSides] = diceArg.toLowerCase().split("d").map(Number);

    if (!numDice || !diceSides) {
      return interaction.reply("Invalid dice format. Try `/roll 1d20` or `/roll 2d6`");
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
      const dmResponse = await askDM(
        guildId,
        `I rolled ${diceArg} and got a ${total}.`,
        playerName
      );

      const audioFile = await textToSpeech(dmResponse);
      if (audioFile) {
        await speakInVoice(connections[guildId], audioFile);
      }

      interaction.channel.send(`📜 **DM:** *${dmResponse}*`);
    }
    return;
  }

  // ----------------------------------------------------------
  //  /status — Show current game history summary
  // ----------------------------------------------------------
  if (commandName === "status") {
    const msgCount = session.history.length;
    const isActive = session.active ? "Active ⚔️" : "No game running";
    interaction.reply(`**Game Status:** ${isActive}\n**Story exchanges so far:** ${msgCount / 2}\nType \`/action [what you do]\` to play.`);
    return;
  }

  // ----------------------------------------------------------
  //  /resetgame — Wipe history and start fresh
  // ----------------------------------------------------------
  if (commandName === "resetgame") {
    sessions[guildId] = null;
    interaction.reply("🗑️ Game state cleared. Type `/startgame` to begin a new adventure.");
    return;
  }

  // ----------------------------------------------------------
  //  /reloadnotes — Reload world_notes.txt without restarting
  // ----------------------------------------------------------
  if (commandName === "reloadnotes") {
    reloadWorldNotes();
    const status = worldNotes
      ? `✅ World notes reloaded! (${worldNotes.length} characters loaded)`
      : "⚠️ No world_notes.txt found. Create one in your bot folder.";
    interaction.reply(status);
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
\`/action [what]\` — Declare what your character does
\`/roll [dice]\` — Roll dice (e.g. \`/roll 1d20\`, \`/roll 2d6\`)
\`/status\` — Check if a game is running
\`/resetgame\` — Wipe the current game and start fresh
\`/reloadnotes\` — Reload world_notes.txt without restarting the bot
\`/help\` — Show this message
    `.trim());
    return;
  }
});

// ============================================================
//  LOGIN
// ============================================================

client.login(DISCORD_TOKEN);
