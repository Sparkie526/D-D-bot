# D&D Discord Bot

An AI-powered Dungeon Master for Discord that runs in your voice channel, narrates your adventure, and generates voices with ElevenLabs.

## Before You Start

You'll need:
- **Discord Bot Token** (from Discord Developer Portal)
- **OpenAI API Key** (for the AI Dungeon Master)
- **ElevenLabs API Key + Voice ID** (for voice narration)
- **Docker Desktop** (Windows/Mac) or Docker (Linux)

---

## Setup (Windows with Docker Desktop)

### Step 1: Download & Unzip the Bot

1. Download this repository as a ZIP file
2. Unzip it to a folder (e.g., `C:\Users\YourName\D-D-bot`)

### Step 2: Install Docker Desktop

1. Go to [Docker Desktop](https://www.docker.com/products/docker-desktop)
2. Download and install for Windows
3. Start Docker Desktop (it'll run in the background)

### Step 3: Create the `.env` File

1. Open the bot folder in File Explorer
2. Find `.env.example` and copy it
3. Rename the copy to `.env`
4. Right-click `.env` and open with Notepad
5. Fill in your credentials:

```
DISCORD_TOKEN=your_discord_bot_token_here
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4o
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
ELEVENLABS_VOICE_ID=your_voice_id_here
LLM_PROVIDER=openai
```

Save and close.

### Step 4: Start the Bot

1. Open PowerShell in your bot folder:
   - Shift + Right-click in the folder → "Open PowerShell window here"
2. Run:
```powershell
docker compose up --build
```

3. Wait for the message: **"✅ OpenAI is reachable and ready!"**
4. The bot is now running!

### Step 5: Use the Bot in Discord

In your Discord server:
1. `/join` → Bot joins your voice channel
2. `/startgame` → DM introduces the setting
3. `/name [your_character_name]` → Set your character name
4. `/action [what you do]` → Take actions in the game
5. `/endgame` → End the adventure gracefully

### Stop the Bot

In PowerShell, press `Ctrl+C` or run:
```powershell
docker compose down
```

---

## Getting Your API Keys

### Discord Token
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create New Application
3. Go to "Bot" → "Add Bot"
4. Copy the token under "TOKEN"

### OpenAI API Key
1. Go to [OpenAI Platform](https://platform.openai.com)
2. Click your account → "API keys"
3. Create new secret key
4. Copy it immediately (you can't see it again)

### ElevenLabs
1. Go to [ElevenLabs](https://elevenlabs.io)
2. Sign up → Dashboard
3. Go to "API" → Copy API key
4. Go to "Voices" → Pick a voice → Copy the Voice ID

---

## All Commands

- `/join` — Bot joins your voice channel
- `/leave` — Bot leaves voice (ends session)
- `/startgame` — Begin the adventure
- `/name [character]` — Set your character name
- `/action [what you do]` — Main gameplay command
- `/roll [dice]` — Roll dice (e.g., `/roll 1d20`)
- `/status` — Check game status
- `/endgame` — End game gracefully
- `/resetgame` — Wipe game state and start fresh
- `/reloadnotes` — Reload world settings
- `/help` — Show all commands in Discord

---

## Customize Your World

Edit `world_notes.txt` to add:
- Custom locations
- NPCs and villains
- Lore and secrets
- Your own maps

Changes take effect immediately with `/reloadnotes` (no restart needed).

---

## Troubleshooting

**Bot not responding?**
- Make sure Docker Desktop is running
- Check that all API keys are correct in `.env`
- Restart: `docker compose down` then `docker compose up --build`

**"Bot lacks permission to update your Discord nickname"?**
- Go to Server Settings → Roles
- Give the bot role "Change Nickname" permission

**Can't see `/endgame` command?**
- Wait 1-2 minutes and try typing `/` again
- Restart your Discord app

---

## Need Help?

Check the troubleshooting section above or open an issue on GitHub.

Enjoy your adventure! 🎲
