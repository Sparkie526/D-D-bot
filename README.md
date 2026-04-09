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

### Docker Desktop (Windows) step-by-step

1. Install Docker Desktop.

2. Ensure WSL 2 backend is enabled:

- Docker Desktop -> Settings -> General -> Enable "Use the WSL 2 based engine".

3. Open a terminal in the repo folder.

- PowerShell: right-click in the folder -> "Open in Terminal".
- Or use a WSL terminal if you already work in WSL.

4. Create `.env` next to `docker-compose.yml`.

- Copy `.env.example` to `.env`.
- Fill in:
  - `DISCORD_TOKEN`
  - `ELEVENLABS_API_KEY`
  - `ELEVENLABS_VOICE_ID`
- For Docker Compose + Ollama service, set:
  - `OLLAMA_URL=http://ollama:11434/api/chat`
  - `OLLAMA_MODEL=llama3`

5. Start the stack (build + run bot + run Ollama):

```bash
docker compose up --build
```

6. First-time only: download the Ollama model into the Ollama container:

```bash
docker compose exec ollama ollama pull llama3
```

7. To stop:

```bash
docker compose down
```

### Notes

- Inside Docker, `localhost` means "inside the container".
  - If you use the compose `ollama` service, `OLLAMA_URL` must be `http://ollama:11434/api/chat`.
  - If you run Ollama on your host, use `http://host.docker.internal:11434/api/chat`.
- To use a remote Ollama instead of the compose service, set `OLLAMA_URL` in `.env`.

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

- `node_modules/` is intentionally not committed. Install with `npm ci --include=optional` per platform.
- If you see a native-binding error from `@snazzah/davey` after install, wipe `node_modules/` and reinstall.
