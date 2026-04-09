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
