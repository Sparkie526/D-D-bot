# D-D-bot

Discord D&D "AI Dungeon Master" bot.

## Requirements

- Node.js >= 22.12.0
- ffmpeg on PATH (required for voice playback)
- Ollama running locally (the bot calls `http://localhost:11434/api/chat`)
- Discord bot token + ElevenLabs API key/voice id

## Setup

1. Install dependencies (make sure optional/native deps are included):

```bash
npm ci --include=optional
```

2. Create `.env` (see `.env.example`).

3. Run Ollama:

```bash
ollama serve
```

4. Start the bot:

```bash
npm start
```

## Docker

1. Install [Docker](https://docs.docker.com/get-docker/) (Docker Desktop or Docker Engine).

2. Create `.env` next to `docker-compose.yml`:

   - Copy `.env.example` to `.env`.
   - Fill in:
     - `DISCORD_TOKEN`
     - `ELEVENLABS_API_KEY`
     - `ELEVENLABS_VOICE_ID`
   - For the bundled Ollama service set:
     - `OLLAMA_URL=http://ollama:11434/api/chat`
     - `OLLAMA_MODEL=llama3`

3. Start the stack (builds the bot image, starts bot + Ollama):

```bash
docker compose up --build
```

4. First-time only — pull the model into the Ollama container:

```bash
docker compose exec ollama ollama pull llama3
```

5. To stop:

```bash
docker compose down
```

### Notes

- Inside Docker, `localhost` refers to the container itself.
  - Use `http://ollama:11434/api/chat` when running the bundled Ollama service.
  - Use `http://host.docker.internal:11434/api/chat` to reach Ollama on your host machine.
- To use a remote Ollama instance, set `OLLAMA_URL` in `.env`.

## Discord Commands

- `!join` join the caller's voice channel
- `!leave` leave voice and end the session
- `!startgame` start a new adventure (requires `!join` first)
- `!action <text>` main gameplay input
- `!roll 1d20` (or `2d6`, etc)
- `!status` show session status
- `!resetgame` clear session state
- `!reloadnotes` reload `world_notes.txt`

## Notes

- `node_modules/` is intentionally not committed. The Docker image handles all native dependency compilation.
- If running outside Docker, install with `npm ci --include=optional` (required for the native `@discordjs/opus` binding).
- If you see a native-binding error after install, wipe `node_modules/` and reinstall.
