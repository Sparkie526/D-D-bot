# D&D Discord Bot

An AI-powered Dungeon Master for Discord that runs in your voice channel, narrates your adventure with natural storytelling, and generates voice narration with ElevenLabs.

**Features:**
- 🎭 **AI Dungeon Master** using GPT-4o-mini for natural, varied narration
- 🎙️ **Voice Synthesis** with ElevenLabs for immersive storytelling
- 🌍 **Multiple Worlds** - Create and switch between different campaign worlds
- 🎲 **Full Dice Support** - Roll any dice combination (1d20, 2d6, etc.)
- 🎪 **Character Names** - Auto-updates Discord nicknames to match character names
- 🎬 **Ambient Sounds** - Location-based background ambiance (ready for your sound files)
- 💾 **Persistent Stories** - Conversation history keeps the narrative flowing
- ⚡ **Fast Setup** - Docker-based, runs on any machine

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

**First Game:**
1. `/join` → Bot joins your voice channel
2. `/startgame` → DM introduces the setting and asks for your character names
3. `/name [your_character_name]` → Set your character name (one player at a time)
   - The DM will greet you all and ask what you do first
4. `/action [what you do]` → Take actions in the game
5. `/roll [dice]` → Roll dice when needed
6. `/endgame` → End the adventure when done

**See `/help` in Discord for all commands and quick-start guide.**

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

## Game Startup (Quick Guide)

1. **`/join`** → Bot joins your voice channel
2. **`/startgame`** → DM introduces the setting and asks for character names
3. **`/name [character]`** → Each player sets their character name (one at a time)
   - DM greets everyone by name and asks what you do first
4. **`/action [what you do]`** → Main gameplay command - describe your actions

---

## All Commands

**Game Control**
- `/join` — Bot joins your voice channel
- `/leave` — Bot leaves voice and ends session
- `/startgame` — Begin a new adventure
- `/endgame` — End the game gracefully with a DM farewell
- `/resetgame` — Wipe game state and start fresh
- `/status` — Check if a game is running

**Gameplay**
- `/name [character]` — Set your character name (updates your Discord nickname)
- `/action [what]` — Declare what your character does (main command during play)
- `/roll [dice]` — Roll dice (e.g., `/roll 1d20`, `/roll 2d6`)

**Worlds & Settings**
- `/showworlds` — List all available worlds
- `/reloadnotes` — Reload world files without restarting the bot

**Help**
- `/help` — Show all commands with quick-start guide in Discord

---

## Customize Your Worlds

### Create New Worlds

1. Copy `worlds/TEMPLATE.txt` to create a new world file (e.g., `my_world.txt`)
2. Edit it with your own:
   - Campaign name and setting
   - Locations and maps
   - NPCs and villains
   - Lore, secrets, and quests
   - House rules and tone notes

3. Use `/showworlds` to see all available worlds
4. Set `WORLD_FILE=my_world.txt` in `.env` to lock in a specific world, or let it pick randomly

Changes take effect immediately with `/reloadnotes` (no restart needed).

### Add Ambient Sounds

1. Place MP3/WAV files in `ambient_sounds/` folders:
   - `ambient_sounds/dungeon/` — Dungeon ambience
   - `ambient_sounds/forest/` — Forest ambience
   - `ambient_sounds/tavern/` — Tavern ambience
   - `ambient_sounds/town/` — Town ambience
   - `ambient_sounds/cave/` — Cave ambience
   - `ambient_sounds/village/` — Village ambience

2. Find free sounds at:
   - [Freesound.org](https://freesound.org)
   - [Zapsplat](https://www.zapsplat.com)
   - [BBC Sound Effects Library](https://sound-effects.bbcrewind.co.uk/)

3. Bot will automatically detect the location from the DM's narration and play matching ambient sounds!

---

## How It Works

**AI Dungeon Master:**
- Uses OpenAI's GPT-4o-mini for fast, intelligent narration
- Naturally varies its responses (no repetitive "what do you do?" prompts)
- Tracks your character names and actions throughout the story
- Reads from your world files to stay consistent with lore

**Voice Narration:**
- ElevenLabs converts the DM's narration to speech
- Caches audio so identical responses play instantly
- Only plays voice when bot is in your voice channel

**Worlds System:**
- Create multiple campaigns using the template
- Each world has its own NPCs, locations, and secrets
- Supports random world selection or specific world locking

**Character Names:**
- Players set their character name with `/name`
- Bot automatically updates Discord nicknames
- Reverts nicknames when game ends

---

## Troubleshooting

**Bot not responding?**
- Make sure Docker Desktop is running
- Check that all API keys are correct in `.env`
- Restart: `docker compose down` then `docker compose up --build`

**"Bot lacks permission to update your Discord nickname"?**
- Go to Server Settings → Roles
- Give the bot role the "Change Nickname" permission
- Run `/name [character]` again

**No voice output?**
- Check you have ElevenLabs credits remaining
- Make sure bot is in your voice channel
- Bot will show a warning if voice synthesis fails

**Can't see `/endgame` or other commands?**
- Wait 1-2 minutes and try typing `/` again
- Restart your Discord app
- Discord caches commands client-side

**My world sounds aren't playing?**
- Add MP3/WAV files to the appropriate `ambient_sounds/` folder
- Bot will automatically detect and play them based on location keywords
- See "Customize Your Worlds" section above

---

## Advanced Configuration

**Environment Variables** (in `.env`):
- `OPENAI_MODEL` — Change AI model (default: `gpt-4o-mini`)
- `OPENAI_API_KEY` — Your OpenAI API key (required)
- `ELEVENLABS_API_KEY` — Your ElevenLabs API key
- `ELEVENLABS_VOICE_ID` — Voice ID to use for narration
- `LLM_PROVIDER` — `openai` or `ollama` (default: `openai`)
- `WORLD_FILE` — Lock to specific world (optional, e.g., `ashmore_keep.txt`)

**Docker Compose:**
- Run `docker compose up --build` to start the bot
- Run `docker compose down` to stop the bot
- Add `--profile ollama` to also run local Ollama: `docker compose --profile ollama up --build`

---

## Need Help?

- Check the troubleshooting section above
- Use `/help` in Discord for command reference
- Open an issue on GitHub

Enjoy your adventure! 🎲
