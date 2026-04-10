# D-D-bot

Discord D&D "AI Dungeon Master" bot with OpenAI or Ollama (optional) and ElevenLabs voice synthesis.

## Quick Start (Docker)

**Recommended:** Run everything in Docker for easy setup and reproducibility.

### Requirements

- [Docker](https://docs.docker.com/get-docker/) (Docker Desktop or Docker Engine)
- Discord bot token
- ElevenLabs API key and voice ID
- OpenAI API key (recommended for sanity testing)

### Setup

1. Clone the repository and enter the directory:

```bash
git clone <repo-url>
cd D-D-bot
```

2. Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

3. Edit `.env` and fill in:
   - `DISCORD_TOKEN` - Your Discord bot token
   - `ELEVENLABS_API_KEY` - Your ElevenLabs API key
   - `ELEVENLABS_VOICE_ID` - Your ElevenLabs voice ID
    - `LLM_PROVIDER` - Set to `openai` (recommended) or `ollama`
    - `OPENAI_API_KEY` - Your OpenAI API key (required when `LLM_PROVIDER=openai`)
    - `OPENAI_MODEL` - Default is `gpt-4o-mini`
    - `OLLAMA_URL` - Only needed when `LLM_PROVIDER=ollama` (Compose default: `http://ollama:11434/api/chat`)
    - `OLLAMA_MODEL` - Only needed when `LLM_PROVIDER=ollama` (e.g. `mistral`)

4. Start everything:

```bash
docker compose up --build
```

Optional: sanity-check the LLM without Discord:

```bash
docker compose run --rm bot npm run llm:sanity
```

If you want to run Ollama in Docker too:

```bash
docker compose --profile ollama up --build
```

5. If you're using Ollama, pull the model (one-time):

```bash
docker compose exec ollama ollama pull mistral
```

6. Check that the bot is online in your Discord server.

7. To stop:

```bash
docker compose down
```

## Docker Details

- **Ollama service**: Optional (disabled by default). Enable with `--profile ollama`.
- **Bot service**: Runs the Discord bot (uses OpenAI or Ollama for the DM text)
- **Auto-restart**: Both services restart automatically on failure
- **Data persistence**: Ollama model data is stored in a Docker volume

For a remote Ollama instance, override `OLLAMA_URL` in `.env` and set `LLM_PROVIDER=ollama`.

## Commands (Discord Slash Commands)

- `/join` - Join the caller's voice channel
- `/leave` - Leave voice and end the session
- `/startgame` - Start a new adventure (requires `/join` first)
- `/action <text>` - Main gameplay input
- `/roll <dice>` - Roll dice (e.g., `1d20`, `2d6`)
- `/status` - Show session status
- `/resetgame` - Clear session state
- `/reloadnotes` - Reload `world_notes.txt`

## Development (Local Setup)

If you want to run the bot locally without Docker (for development):

1. Install Node.js >= 22.12.0
2. Install ffmpeg: `apt install ffmpeg` (Linux) or `brew install ffmpeg` (macOS)
3. Run Ollama separately: `ollama serve`
4. Install dependencies: `npm ci --include=optional`
5. Update `.env`: `OLLAMA_URL=http://localhost:11434/api/chat`
6. Start the bot: `npm start`

**Note:** This requires managing Ollama and Node.js separately. Docker is recommended for consistency.

## Notes

- `node_modules/` is intentionally not committed. Docker handles all native dependency compilation.
- The bot writes `dm_response.mp3` at runtime for voice synthesis.
- Edit `world_notes.txt` to customize world lore, NPCs, and maps.

## Optimizations

The bot uses several techniques to keep responses fast and costs low:

- **World notes in-memory cache** — `world_notes.txt` is read once and cached in memory. Use `/reloadnotes` to pick up changes mid-session without restarting.
- **System prompt caching** — The compiled system prompt is cached and only rebuilt when `world_notes.txt` changes. With OpenAI, the system message is also sent with `cache_control` for additional prompt-caching savings.
- **TTS audio caching** — Repeated DM responses (identical text) are served from `tts_cache/` without calling ElevenLabs. Cache files are keyed by SHA-256 hash of the text.
- **Streaming LLM responses** — Both OpenAI and Ollama use streaming (`stream: true`). Tokens arrive progressively, reducing perceived latency on long responses.
- **History truncation** — Conversation history is capped at 20 messages. Older turns are dropped from the tail to stay within context limits.
