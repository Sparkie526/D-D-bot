# GitHub Release Instructions - v0.1.0-beta

To complete the GitHub release, follow these manual steps:

## Files Ready for Release

- `d-d-bot-v0.1.0-beta.tar` (376 MB) - Prebuilt Docker image
- `setup-windows.bat` - Windows setup automation script
- Release notes: See below

## Creating the Release on GitHub

### Option 1: Using GitHub Web UI (Easiest)

1. Go to: https://github.com/Sparkie526/D-D-bot/releases
2. Click "Draft a new release"
3. Fill in:
   - **Tag**: `v0.1.0-beta`
   - **Release title**: `🎲 D&D Discord Bot v0.1.0-beta`
   - **Description**: Copy the content from the "Release Notes" section below
4. Click "Attach binaries by dropping them here or selecting them"
   - Upload: `d-d-bot-v0.1.0-beta.tar`
   - Upload: `setup-windows.bat`
5. Click "Publish release"

### Option 2: Using GitHub CLI

```bash
gh release create v0.1.0-beta \
  --title "🎲 D&D Discord Bot v0.1.0-beta" \
  --notes-file release-notes.txt \
  d-d-bot-v0.1.0-beta.tar \
  setup-windows.bat
```

## Release Notes

Copy the following markdown to the GitHub release description:

---

# 🎲 D&D Discord Bot v0.1.0-beta

Welcome to the first official beta release of the D&D Discord Bot! An AI-powered Dungeon Master that brings your D&D campaigns to life with immersive voice narration and dynamic storytelling.

## ✨ Features

### 🎭 AI Dungeon Master
- Powered by OpenAI's GPT-4o-mini for fast, intelligent narration
- Natural storytelling that varies responses (no repetitive prompts)
- Tracks character names and actions throughout the story
- Reads from customizable world files for consistent lore

### 🎙️ Voice Narration
- ElevenLabs text-to-speech for immersive voice narration
- Audio caching for instant playback of repeated responses
- Voice plays automatically in Discord voice channels

### 🌍 Multiple Campaign Worlds
- Create and manage multiple D&D campaign worlds
- Template system makes it easy to build new campaigns
- Supports random world selection or lock to a specific world
- Default world included: "The Curse of Ashmore Keep"

### 🎪 Character System
- Players set character names with `/name` command
- Bot automatically updates Discord nicknames
- Tracks player actions and maintains story consistency
- Nicknames revert when game ends

### 🎲 Full Dice Support
- Roll any combination of dice: `/roll 1d20`, `/roll 2d6`, etc.
- Natural DM narration for rolls
- Integrated into the story flow

### 🎬 Ambient Sounds (Ready)
- Location-based ambient sound system
- Detects scene location from DM narration
- Ready for you to add MP3/WAV files to `ambient_sounds/` folders
- Free sound libraries: Freesound.org, Zapsplat, BBC Sound Effects

### 💾 Persistent Stories
- Conversation history maintains narrative continuity
- Up to 20 turns of history kept in context
- Easy to reset and start fresh with `/resetgame`

## 🚀 Quick Start (Windows Docker Desktop)

1. **Install Docker Desktop** (if not already installed)
   - Download from: https://www.docker.com/products/docker-desktop

2. **Download This Release**
   - Extract the ZIP file to any folder

3. **Run setup-windows.bat**
   - Double-click `setup-windows.bat`
   - It will:
     - Check Docker is installed and running
     - Import the prebuilt Docker image
     - Create `.env` file (you fill in API keys)
     - Start the bot

4. **Add Your API Keys**
   - Edit `.env` file with your keys:
     - `DISCORD_TOKEN` (Discord Developer Portal)
     - `OPENAI_API_KEY` (OpenAI Platform)
     - `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` (ElevenLabs)

5. **Start Playing**
   - Use `/help` in Discord for all commands
   - `/join` → `/startgame` → `/name [character]` → `/action` to play

## 📋 All Commands

**Game Control:**
- `/join` — Bot joins your voice channel
- `/startgame` — Begin a new adventure
- `/endgame` — End the game with a funny DM farewell
- `/leave` — Bot leaves voice channel
- `/resetgame` — Clear game state and start fresh

**Gameplay:**
- `/name [character]` — Set your character name
- `/action [what]` — Describe what your character does
- `/roll [dice]` — Roll dice (e.g., `/roll 1d20`)

**Worlds & Settings:**
- `/showworlds` — List all available worlds
- `/reloadnotes` — Reload world files

**Help:**
- `/help` — Show all commands in Discord

## 🌍 Create Your Own Worlds

1. Copy `worlds/TEMPLATE.txt`
2. Create your own world with locations, NPCs, and lore
3. Use `/showworlds` to see available worlds
4. Lock to a world by setting `WORLD_FILE=your_world.txt` in `.env`

## 🎬 Add Ambient Sounds

1. Find free ambient sounds from:
   - [Freesound.org](https://freesound.org) (search: "dungeon ambience")
   - [Zapsplat](https://www.zapsplat.com)
   - [BBC Sound Effects Library](https://sound-effects.bbcrewind.co.uk/)

2. Place MP3/WAV files in appropriate folders:
   - `ambient_sounds/dungeon/`
   - `ambient_sounds/forest/`
   - `ambient_sounds/tavern/`
   - `ambient_sounds/town/`
   - (etc.)

3. Bot will auto-detect location and play matching ambient sounds!

## 📦 What's Included

- **d-d-bot-v0.1.0-beta.tar** (376 MB)
  - Prebuilt Docker image ready to import
  - Node.js 22.12.0 with all dependencies
  - Ready to run on Windows Docker Desktop

- **setup-windows.bat**
  - Automated setup script for Windows
  - Checks Docker installation
  - Imports image and starts bot
  - Creates `.env` file

## ⚠️ Known Limitations (Beta)

- Ambient sounds system is ready but no default audio files included (you add your own)
- Voice synthesis requires ElevenLabs API credits
- Ollama support available but Docker Hub image is OpenAI-focused
- Single guild/server support per bot instance

## 🐛 Reporting Issues

Found a bug? Please [open an issue on GitHub](https://github.com/Sparkie526/D-D-bot/issues)

Include:
- What happened
- What you expected
- Steps to reproduce
- Docker/OS version

## 📚 Documentation

- **README.md** — Full setup and usage guide
- **worlds/TEMPLATE.txt** — Template for creating worlds
- **ambient_sounds/README.md** — How to add sound files
- Use `/help` in Discord for command reference

## 🎮 Example Play Session

```
You: /join
You: /startgame
DM: "Welcome, brave adventurers! The town of Millhaven sits on the edge of a cursed forest..."

You: /name Dex
DM: "Greetings, Dex, and welcome. What shall you do first?"

You: /action I approach the innkeeper and ask about the disappearances
DM: "The innkeeper's eyes widen. 'You've heard about the missing folk? It's been happening for weeks...'"

You: /roll 1d20
You rolled a 20! Critical success!
DM: "The innkeeper trusts you completely..."
```

## 🙏 Credits

- Built with [Discord.js](https://discord.js.org/)
- AI powered by [OpenAI](https://openai.com/)
- Voice synthesis by [ElevenLabs](https://elevenlabs.io/)
- Docker for easy deployment

## 📝 What's Next?

Future versions may include:
- Ambient sound playback during narration
- Multi-server support
- Web UI for world editor
- Combat automation
- Character sheet tracking
- More world templates
- Ollama/local model improvements

## 🎲 Enjoy Your Adventure!

This is a beta release, so expect occasional quirks or areas for improvement. We're actively developing and your feedback helps make it better!

Have fun, and may your dice rolls be blessed! 🎲✨

---

## Summary

The prebuilt Docker image and Windows setup script are now ready for download! Users can get the bot running with just:
1. Download the release ZIP
2. Double-click `setup-windows.bat`
3. Add API keys to `.env`
4. Done!

No Docker knowledge required on the user's end.
