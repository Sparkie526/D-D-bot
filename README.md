# D-D-bot

Discord D&D "AI Dungeon Master" bot with Ollama AI integration and ElevenLabs voice synthesis.

## Quick Start (Docker)

**Recommended:** Run everything in Docker for easy setup and reproducibility.

### Requirements

- [Docker](https://docs.docker.com/get-docker/) (Docker Desktop or Docker Engine)
- Discord bot token
- ElevenLabs API key and voice ID

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
   - `OLLAMA_URL` - Leave as `http://ollama:11434/api/chat` (internal Docker network)
   - `OLLAMA_MODEL` - Set to `mistral` (or your preferred model)

4. Start everything:

```bash
docker compose up --build
```

5. On first run, pull the Ollama model (one-time):

```bash
docker compose exec ollama ollama pull mistral
```

6. Check that the bot is online in your Discord server.

7. To stop:

```bash
docker compose down
```

## Docker Details

- **Ollama service**: Automatically manages the AI model
- **Bot service**: Runs the Discord bot connected to Ollama
- **Auto-restart**: Both services restart automatically on failure
- **Data persistence**: Ollama model data is stored in a Docker volume

For a remote Ollama instance, override `OLLAMA_URL` in `.env`.

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
