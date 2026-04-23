// Quick sanity check for the configured LLM provider.
// Usage (OpenAI):
//   OPENAI_API_KEY=... LLM_PROVIDER=openai node scripts/llm_sanity.js
// Usage (Ollama):
//   LLM_PROVIDER=ollama OLLAMA_URL=http://localhost:11434/api/chat OLLAMA_MODEL=mistral node scripts/llm_sanity.js

require("dotenv").config();

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const LLM_PROVIDER = (process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "ollama")).toLowerCase();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/chat";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "mistral";

const WORLD_NOTES_PATH = path.join(__dirname, "..", "world_notes.txt");

function buildSystemPrompt() {
  const basePrompt = `You are an experienced, dramatic, and immersive Dungeon Master running a D&D 5e campaign.
Your personality is wise, mysterious, and theatrical — like a storyteller around a campfire.
Keep your responses concise (2-4 sentences max) since they will be spoken aloud in a voice chat.
Always end your response by either:
  - Describing what happens next and asking what the players do, OR
  - Asking for a dice roll (e.g. "Roll for Perception")
Track player names, their actions, and the consequences in the story.
When a player rolls dice, acknowledge the result dramatically and narrate the outcome.
Never break character. Never mention being an AI.`;

  try {
    if (fs.existsSync(WORLD_NOTES_PATH)) {
      const worldNotes = fs.readFileSync(WORLD_NOTES_PATH, "utf-8").trim();
      if (worldNotes) {
        return `${basePrompt}

============================
WORLD REFERENCE MATERIAL
(Use this to guide the story. Do not read this aloud directly.)
============================
${worldNotes}
============================`;
      }
    }
  } catch (_) {}

  return basePrompt;
}

async function askOpenAI(messages) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  const response = await axios.post(
    `${OPENAI_BASE_URL}/chat/completions`,
    {
      model: OPENAI_MODEL,
      messages,
      max_tokens: 16,
      temperature: 0,
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
      timeout: 5 * 60 * 1000,
    }
  );
  const content = response?.data?.message?.content;
  if (!content) throw new Error("Ollama returned no message content");
  return content.trim();
}

(async () => {
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: "Reply with only OK." },
  ];

  const reply =
    LLM_PROVIDER === "openai" ? await askOpenAI(messages) : await askOllama(messages);

  console.log(reply);
})().catch((err) => {
  console.error("Sanity check failed:", err.message);
  process.exit(1);
});
