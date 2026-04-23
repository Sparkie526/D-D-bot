# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node index.js          # Start the bot (runs both Discord bot + Express dashboard on port 3000)
npm run llm:sanity     # Smoke-test LLM provider connectivity
npm run check          # Verify voice dependencies (@discordjs/opus, @discordjs/voice)
node db/migrate.js     # Migrate existing YAML character sheets into SQLite (one-time, safe to re-run)

docker compose up --build          # Full Docker start
docker compose --profile ollama up --build  # Start with local Ollama sidecar
```

No test suite exists yet (`npm test` exits with error).

## Architecture

Everything lives in a single `index.js` (~2900 lines). There is no module split — Discord bot logic, Express HTTP server, Socket.IO, LLM calls, TTS, and dashboard state all run in the same process.

### Storage layers (three tiers)

**SQLite** (`db/bot.db`, via `better-sqlite3`) is the primary persistence layer, initialized on startup via `db.initializeDatabase()`:

- `character_sheets` table — full character JSON blobs, keyed by `(player_id, guild_id, character_name)`. Written by `saveCharacter()`, read by `loadCharacter()` and `listPlayerCharacters()`.
- `session_state` table — persisted game session snapshots per guild. Written by `persistSession()` after key state changes (history updates, name set, endgame/resetgame). Restored by `getSession()` on first access after restart.
- Relational tables (`characters`, `character_stats`, `inventory`, etc.) — populated by `db/migrate.js` from old YAML files; not yet used by the live bot for runtime reads.

**In-memory sessions** (`sessions` object, keyed by `guildId`) hold the live game state:
- `session.players` — `{ userId: characterName }` (set by `/name`)
- `session.characterSheets` — full character data loaded during play
- `session.activePlayers`, `session.encounter`, `session.turnOrder`, `session.forcedRoll`, etc.
- On first access, `getSession()` tries to restore from `session_state` table. After restore, character sheets are re-synced into `dashState.players`.

**Dashboard state** (`dashState` in memory, backed by `dnd-dashboard/game_state.json`) holds the web UI state:
- `dashState.players` — player HP/AC/class/level cards
- `dashState.location`, `dashState.tokens`, `dashState.storyFeed`, `dashState.diceLog`
- `syncPlayerToDash(userId, discordName, character)` pushes character sheet data into `dashState` and emits `state_update` via Socket.IO
- The `/api/state` GET endpoint merges live session character sheets on top of `dashState` so the dashboard is never stale

### db/ module structure

```
db/index.js      — re-exports everything
db/init.js       — schema + getDb() / initializeDatabase() / closeDatabase()
db/sheets.js     — saveSheet / loadSheet / listSheets / deleteSheet (character JSON blobs)
db/session.js    — saveSessionState / loadSessionState / clearSessionState
db/characters.js — full relational CRUD (used by migrate.js; not yet the main runtime path)
db/games.js      — game session / event CRUD (future use)
db/migrate.js    — one-time import of YAML files into relational tables
```

### Dashboard (web UI)

`index.js` starts an Express server on port 3000 serving `dnd-dashboard/public/`. A Cloudflare tunnel (`cloudflared`) is auto-spawned to expose it publicly. Socket.IO (`io`) is used for real-time push to all connected browsers.

Key dashboard sync functions in `index.js`:
- `addStoryEntry(type, name, text)` — appends to story feed, emits `story_entry`
- `addDiceEntry(name, dice, rolls, total)` — appends to dice log, emits `dice_entry`
- `syncPlayerToDash(userId, discordName, character)` — syncs HP/AC/class/level to `dashState.players`
- `syncEncounterToDash(guildId)` — pushes enemy tokens to dashboard

The `POST /api/player/:discordId` endpoint also writes HP/AC changes back into the live session's character sheet so bot and dashboard stay in sync bidirectionally.

### LLM / AI DM

`buildSystemPrompt()` constructs a large system prompt from world notes + character sheet summaries. It's cached in `cachedSystemPrompt` and invalidated by `invalidateSystemPromptCache()`.

`askDM(guildId, prompt, playerName)` streams from either OpenAI or Ollama, assembles the full reply, then calls `sanitizeLLMOutput()` to strip token markers before returning.

LLM token markers in DM output (parsed by `parseCombatTokens()`):
- `[NPC_NEW: Name|HP|AC]` — spawn enemy
- `[NPC_DMG: Name|amount]` — deal damage to NPC
- `[NPC_DEAD: Name]` — mark NPC dead
- `[ITEM_GIVE: Player|Item|qty]` — give item to player
- `[PLAYER_DMG: Name|amount]` / `[PLAYER_HEAL: Name|amount]`
- `[CONDITION: Name|condition|true/false]`

### Character sheets

Class templates are YAML files in `character_sheets/_global_templates/<Class>.yaml`. Loaded by `loadCharacterTemplate(className)` — still file-based, read-only.

Player character sheets are stored in SQLite (`character_sheets` table). `saveCharacter(guildId, userId, character)` writes to the db; `loadCharacter(guildId, userId, characterName)` reads from it. The in-memory format is the same nested object as the old YAML format: `character.character.name`, `character.combat.hp`, `character.abilities`, etc.

### Commands

All slash commands are handled in a single `interactionCreate` handler starting around line 2060. Commands are registered on bot startup via `REST.put()`.

Key commands:
- `/startgame` — collects voice channel members into `session.activePlayers`, sets `nameCollectionActive = true`, registers players in `dashState`
- `/name` — calls `setPlayerName()`, which deduplicates names, updates Discord nickname, upserts a `players` record in SQLite, and persists session
- `/action` — main gameplay loop; checks for roll prompts (`session.pendingAction`), calls `askDM()`, calls `parseCombatTokens()` on the reply
- `/roll` — `preset` picks a common die; `dice` overrides with custom expression; both default to `1d20`. Optional `dc` for pass/fail. Honors `session.forcedRoll` for debug overrides.
- `/character` — subcommands: `create`, `load`, `view`, `save`; saves/loads from SQLite
- `/hp` — adjust character HP; syncs to dashboard
- `/debug` — admin-only (guild owner + `ADMIN_IDS` env var); subcommands: `nat20`, `nat1`, `spawn`, `startcombat`, `status`

### Admin / debug

`ADMIN_IDS` env var: comma-separated Discord user IDs that can use `/debug`. Guild owner is always included. `isAdmin(interaction)` is the check function.

`session.forcedRoll = { value: N }` — set by `/debug nat20` or `/debug nat1`, consumed by the next single-die `/roll`.

### Worlds

World files live in `worlds/*.txt`. `getAllWorlds()` scans the directory. `loadWorld()` / `loadRandomWorld()` populate `worldNotes` and `currentWorldName`. `reloadWorldNotes()` force-reloads without restart. `WORLD_FILE` env var pins a specific world.

### Environment variables

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Required |
| `OPENAI_API_KEY` | Required when `LLM_PROVIDER=openai` |
| `OPENAI_MODEL` | Default `gpt-4o-mini` |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | TTS narration |
| `LLM_PROVIDER` | `openai` or `ollama` |
| `OLLAMA_URL` / `OLLAMA_MODEL` | When using local Ollama |
| `WORLD_FILE` | Lock to a specific world file |
| `ADMIN_IDS` | Comma-separated Discord user IDs allowed to use `/debug` |
