# D-D-Bot Architecture Analysis: Character Sheet Implementation Strategy

## Executive Summary

The D-D-bot is a Discord-based AI Dungeon Master with strong foundations for player data management, world state persistence, and extensible command architecture. The current design uses in-memory session storage per guild with LLM-driven gameplay mechanics and D&D 5e integration.

---

## 1. CURRENT PLAYER DATA STRUCTURE

### 1.1 Data Storage Location
- **Storage Type**: In-memory JavaScript objects per guild
- **Persistence Scope**: Session-based (lost on bot restart)
- **Scope**: Per guild via `guildId` parameter

### 1.2 Complete Session Structure
```javascript
sessions[guildId] = {
  // Player Identification
  history: [],                         // Chat history (max 20 messages)
  players: {},                         // { userId: characterName }
  originalNicknames: {},              // { userId: originalNickname } for reverting
  activePlayers: [],                  // Array of { userId, displayName, characterName }
  
  // Game State
  active: false,                      // Is a game running?
  nameCollectionActive: false,        // Waiting for player names?
  nameCollectionTimeout: null,        // Timer for auto-proceeding
  currentLocation: "generic",         // Location for ambient sounds
  ambientSoundPlayer: null,           // Currently playing sound
  
  // Turn-Taking System (Multiple Players)
  turnOrder: [],                      // Array of userId in turn order
  currentTurnIndex: 0,                // Index into turnOrder
  lastActionTime: null,               // Timestamp of last action
  turnTimeoutHandle: null,            // Handle for turn auto-advance timer (75s)
  lastRollResult: null,               // { playerName, dice, total } from last roll
  pendingAction: null,                // { action, playerName, expectedDC } waiting for roll
}
```

### 1.3 Player-Related Data Fields
```javascript
// Per player in session.players{}
userId: "Discord User ID"
characterName: "Character Name (max 32 chars, Discord nickname limit)"

// Per player in session.activePlayers[]
{
  userId: "Discord User ID",
  displayName: "Discord display name or username",
  characterName: null // Set by /name command
}

// Nickname reversion
originalNicknames[userId]: "Original Discord nickname or username"

// Roll history
lastRollResult: {
  playerName: string,
  dice: string,           // e.g., "1d20"
  total: number,
  dc: number || null
}
```

### 1.4 Data Granularity & Per-Player Capacity

| Aspect | Current Capacity | Notes |
|--------|------------------|-------|
| Character Name | 32 characters | Discord nickname limit |
| Number of Players | Unlimited (limited by Discord channel) | Turn order supports N players |
| Chat History | 20 messages (max 50KB lines) | Conversation context for LLM |
| Per-Player Fields | 3 base fields | userId, characterName, displayName |
| Memory per Session | ~1-10 KB baseline | Grows with history and player count |

### 1.5 Character Name Management
- **Setting Mechanism**: `/name [character]` slash command
- **Discord Integration**: Auto-updates Discord server nickname
- **Duplicate Handling**: Adds numeric suffixes (e.g., "Aragorn1", "Aragorn2")
- **Reversion**: Original nicknames stored and reverted on `/endgame` or `/leave`
- **Validation**: 32 character maximum (Discord limit)

---

## 2. GAME SESSION STATE MANAGEMENT

### 2.1 Session Lifecycle
```
1. /join       → Bot joins voice channel
2. /startgame  → Initialize session, detect players in voice
3. /name       → Player sets character name (name collection phase)
4. /action     → Active gameplay phase
5. /endgame    → Reset game state
6. /leave      → Destroy session
```

### 2.2 Session Persistence Model
- **Duration**: From `/join` to `/leave` or bot restart
- **Scope**: Per guild (multiple games possible across different guilds)
- **Cleanup**: On `/leave`, `/endgame`, or bot shutdown
- **History Trimming**: Keeps last 20 messages, drops older ones automatically

### 2.3 Game State Transitions
```
active = false (initial)
  ↓ /startgame
active = true, nameCollectionActive = true
  ↓ /name [character] x all players
active = true, nameCollectionActive = false
  ↓ /action or gameplay
(maintain active state)
  ↓ /endgame or /leave
active = false (reset)
```

### 2.4 Turn-Taking State
- **Initialization**: Triggered when `activePlayers.length > 1`
- **Mechanism**: Round-robin through `turnOrder` array
- **Auto-advance**: After 75 seconds of inactivity via `turnTimeoutHandle`
- **Manual advance**: Via `/action` (triggers) or `/pass` (explicit)

### 2.5 Conversation History Management
```javascript
// Storage
session.history = [
  { role: "user", content: "Player Name says: \"action\"" },
  { role: "assistant", content: "DM narration..." }
]

// Trimming Logic
if (history.length > MAX_HISTORY(20)) {
  history = history.slice(-MAX_HISTORY) // Keep last 20
}

// Usage
const messages = [
  { role: "system", content: buildSystemPrompt() },
  ...session.history
]
// Sent to LLM
```

---

## 3. VOICE CHANNEL INTEGRATION & FILE HANDLING

### 3.1 Voice Channel Operations
- **Library**: `@discordjs/voice` module
- **Connection Storage**: `connections[guildId]` stores active connections
- **Audio Format**: MP3 (from ElevenLabs) or WAV
- **Playback Mechanism**: `createAudioPlayer()` with `createAudioResource()`

### 3.2 Audio File Handling
```javascript
// TTS Cache
const TTS_CACHE_DIR = path.join(__dirname, "tts_cache");
function ttsCachePath(text) {
  return path.join(TTS_CACHE_DIR, `${ttsCacheKey(text)}.mp3`);
}
// Cache key = SHA256 hash (first 16 chars) of text

// Ambient Sounds
const AMBIENT_SOUNDS_DIR = path.join(__dirname, "ambient_sounds");
// Structure: ambient_sounds/{location}/{*.mp3|*.wav}
// Locations: dungeon, forest, tavern, town, cave, generic
```

### 3.3 Audio Processing Pipeline
1. **Text-to-Speech**: OpenAI text → ElevenLabs API → MP3 buffer
2. **Caching**: Hash text, check cache, write if new
3. **Playback**: Create audio resource, subscribe player, wait for idle
4. **Error Handling**: Fallback to text-only if voice fails

### 3.4 File Operations Capability
| Operation | Current Support | Notes |
|-----------|-----------------|-------|
| Read Files | ✅ Yes | fs.readFileSync, fs.readdirSync |
| Write Files | ✅ Yes | fs.writeFileSync (cache, temp files) |
| Delete Files | ✅ Yes | fs.unlinkSync (temp whisper files) |
| Directory Creation | ✅ Yes | fs.mkdirSync with recursive option |
| File Watching | ❌ No | Not implemented |
| Streaming | ✅ Partial | fs.createReadStream for audio |

### 3.5 World File Loading Pattern
```javascript
function loadWorld(worldFile) {
  const filePath = path.join(WORLDS_PATH, worldFile);
  
  // Check if file modified
  const stat = fs.statSync(filePath);
  if (lastWorldsMtimes[worldFile] === stat.mtimeMs) {
    return worldsCache[worldFile]; // Return cached
  }
  
  // Read and parse
  const content = fs.readFileSync(filePath, "utf-8").trim();
  const title = getWorldTitle(filePath); // Extract title from first match
  
  // Cache
  worldsCache[worldFile] = content;
  lastWorldsMtimes[worldFile] = stat.mtimeMs;
  
  return content;
}
```

---

## 4. WORLD FILE STRUCTURE

### 4.1 File Format
- **Location**: `worlds/` directory
- **Format**: Plain text with structured sections
- **Extension**: `.txt`
- **Title Parsing**: First `=== TITLE: ... ===` line
- **Encoding**: UTF-8

### 4.2 World File Sections (from TEMPLATE.txt)
```
=== TITLE: World Name ===
=== SETTING ===
=== CURRENT QUEST ===
=== MAP — MAJOR LOCATION X ===
  AREA/ROOM
    Description
    Exits
    Contains
    Secrets
=== NPCS ===
  NPC NAME (Role)
    Personality
    Knows
    Secret
    Will offer
=== BOSSES & ENCOUNTERS ===
=== HOUSE RULES ===
=== TONE NOTES FOR THE DM ===
```

### 4.3 System Prompt Integration
```javascript
function buildSystemPrompt() {
  const basePrompt = `... DM instructions ...`;
  
  if (!worldNotes) return basePrompt;
  
  return `${basePrompt}

============================
WORLD REFERENCE MATERIAL
(Use this to guide the story. Do not read this aloud directly.)
============================
${worldNotes}
============================`;
}
```
- **Caching**: `cachedSystemPrompt` invalidated on `/reloadnotes`
- **Usage**: Passed to every LLM call as system prompt
- **Token Impact**: Stays in context for all player messages

### 4.4 World Selection
```javascript
// Option 1: Random
loadRandomWorld(); // Pick from worlds/ folder

// Option 2: Environment Variable
WORLD_FILE=ashmore_keep.txt // Set in .env

// Option 3: Command Argument
/startgame world:aethoria // Find by title or filename
```

---

## 5. EXISTING FILE UPLOAD & PARSING MECHANISMS

### 5.1 Current Upload Capabilities
- **Direct Discord Upload**: ❌ Not implemented
- **File Attachment Parsing**: ❌ Not implemented
- **URL File Loading**: ❌ Not implemented
- **Web Form Upload**: ❌ Not implemented

### 5.2 Current File Input Methods
1. **World Files**: Manual file creation in `worlds/` directory
2. **Template Copying**: Copy `worlds/TEMPLATE.txt` to create new worlds
3. **Hot Reload**: `/reloadnotes` picks up changes without restart
4. **Environment Variables**: WORLD_FILE setting in `.env`

### 5.3 Existing File Parsing Patterns
```javascript
// Pattern 1: Regex title extraction
const match = content.match(/===\s*TITLE:\s*(.+?)\s*===/);
const title = match ? match[1] : fallback;

// Pattern 2: Directory listing with filtering
const files = fs.readdirSync(WORLDS_PATH)
  .filter(file => file.endsWith(".txt") && file !== "TEMPLATE.txt")
  .sort();

// Pattern 3: Full content loading
const content = fs.readFileSync(filePath, "utf-8").trim();
```

### 5.4 Data Format Constraints
- **World Notes Size**: No hard limit, but LLM context window (typical 4K tokens)
- **Character Name**: Max 32 characters (Discord limitation)
- **File Format**: Plain text, UTF-8 preferred
- **Line Length**: Code handles arbitrary line lengths (but LLM has context limits)

---

## 6. D&D 5E INTEGRATION ARCHITECTURE

### 6.1 Difficulty Classes (DC)
```javascript
const DND_DIFFICULTY_CLASSES = {
  5: "Very Easy",
  10: "Easy",
  12: "Medium",
  15: "Hard",
  20: "Very Hard",
  25: "Nearly Impossible"
};
```

### 6.2 Action Detection System
```javascript
const ACTION_KEYWORDS = {
  combat: ["attack", "hit", "stab", "slash", ...],
  dodge: ["dodge", "duck", "evade", ...],
  stealth: ["sneak", "hide", "creep", ...],
  // ... 11 more categories
};

// Default DC by action type
const DEFAULT_DCS = {
  attack: 10,
  dodge: 12,
  stealth: 12,
  // ... etc
};

function detectActionKeywords(actionText) {
  // Returns matching keywords from text
}

function getDefaultDCForAction(actionText) {
  // Returns suggested DC for roll
}
```

### 6.3 Roll Processing
```javascript
// /roll command extracts dice formula
const [numDice, diceSides] = diceArg.split("d").map(Number);
let total = 0;
for (let i = 0; i < numDice; i++) {
  total += Math.floor(Math.random() * diceSides) + 1;
}

// Comparison against DC
const success = total >= dcArg ? "SUCCESS" : "FAILURE";

// Pending action handling
session.pendingAction = { action, playerName, expectedDC };
// Later on /roll:
if (session.pendingAction) {
  const dmPrompt = `${action}\n[ROLL RESULT: ${playerName} rolled ${total} vs DC ${expectedDC} - ${success}]`;
}
```

### 6.4 System Prompt Roll Guidance
The system prompt includes D&D 5e roll resolution:
1. Ask player to roll if action requires check
2. Compare result to DC
3. Narrate success/failure based on ACTUAL roll, not preference
4. Track player names and consequences

---

## 7. ARCHITECTURE ANALYSIS FOR CHARACTER SHEETS

### 7.1 Recommended Storage Approach

**Option A: In-Memory with File Backup (Recommended)**
```javascript
// During game
const characterSheets = {};  // { guildId: { userId: sheetData } }

// Optional: Persist to file
function saveCharacterSheets(guildId) {
  const path = `character_sheets/${guildId}.json`;
  fs.writeFileSync(path, JSON.stringify(characterSheets[guildId], null, 2));
}
```
**Pros**: Fast, matches existing session pattern  
**Cons**: Lost on restart

**Option B: File-Based (Persistent)**
```javascript
// Load at startup
const sheetPath = `character_sheets/${guildId}/${userId}.json`;
const sheet = JSON.parse(fs.readFileSync(sheetPath, "utf-8"));
```
**Pros**: Persistent across restarts  
**Cons**: Slower I/O, requires file management

### 7.2 Suggested Character Sheet Data Structure
```javascript
{
  userId: "Discord User ID",
  characterName: "Character Name",
  
  // Basic Info
  class: "Rogue",
  race: "Elf",
  level: 1,
  alignment: "Chaotic Neutral",
  
  // Ability Scores (D&D 5e)
  abilities: {
    strength: 15,
    dexterity: 18,
    constitution: 13,
    intelligence: 10,
    wisdom: 12,
    charisma: 14
  },
  
  // Skills (derived from abilities + proficiencies)
  skills: {
    acrobatics: { mod: 4, proficient: true },
    animalHandling: { mod: 1, proficient: false },
    // ... 16 more skills
  },
  
  // Combat Stats
  stats: {
    hp: 8,
    maxHp: 8,
    ac: 15,
    initiativeBonus: 4,
    proficiencyBonus: 2
  },
  
  // Resources
  resources: {
    hitDice: { current: 1, max: 1 },
    spellSlots: {},
    abilities: []
  },
  
  // Equipment & Inventory
  equipment: [
    { name: "Shortsword", equipped: true },
    { name: "Thieves' Tools", equipped: false }
  ],
  
  // Personality
  personality: {
    traits: "...",
    ideals: "...",
    bonds: "...",
    flaws: "..."
  },
  
  // Metadata
  createdAt: "2026-04-11T...",
  lastModified: "2026-04-11T...",
  worldName: "Aethoria"
}
```

### 7.3 Data Input Methods for Discord Integration

**Pattern 1: Slash Command with Subcommands**
```javascript
/sheet view               // Display character sheet
/sheet set class:Rogue    // Set ability
/sheet import             // Upload JSON file
/sheet export             // Download as JSON
```

**Pattern 2: File Upload Support**
```javascript
// Discord.js supports file attachments:
interaction.attachments.get(attachmentId);
// Could parse JSON or special format
```

**Pattern 3: Multi-Step Modal Forms**
- Discord has modal (pop-up form) support
- Can collect 5 fields at once with `TextInputComponent`

### 7.4 Integration Points with Existing System

1. **LLM Prompt Enhancement**
   ```javascript
   // Add to system prompt during gameplay
   if (session.characterSheets && session.characterSheets[userId]) {
     systemPrompt += `\n\n[CHARACTER: ${sheet.characterName}, Level ${sheet.level} ${sheet.race} ${sheet.class}]`;
   }
   ```

2. **Roll Advantage/Disadvantage**
   ```javascript
   // In /roll handler
   if (skill && sheet.skills[skill].proficient) {
     // Add proficiency bonus to display
   }
   ```

3. **Action Validation**
   ```javascript
   // In checkAndPromptForRoll
   if (sheet && sheet.skills[skill]) {
     const expectedDC = calculateExpectedDC(action, sheet);
   }
   ```

4. **NPC Interaction**
   ```javascript
   // Reference sheet in DM context
   `${playerName} (${sheet.class}) attempts to persuade the innkeeper`
   ```

### 7.5 File Format Compatibility

**Best Format for Discord Integration: JSON**
- Native JavaScript support (JSON.parse/stringify)
- Human-readable for manual editing
- Works with standard tools (text editors, spreadsheets)
- Easy to upload/download
- Schema validation possible

**Alternative: YAML**
- More human-friendly
- Requires additional parsing library
- Not recommended for Discord constraints

**Alternative: CSV (Character Stats Only)**
- Works with spreadsheets
- Limited nesting capability
- Good for lightweight sheets

### 7.6 Slash Command Design Recommendations

```javascript
{
  name: "character",
  description: "Manage your character sheet",
  options: [
    {
      name: "view",
      description: "Display your character sheet",
      type: ApplicationCommandOptionType.Subcommand
    },
    {
      name: "create",
      description: "Create a new character",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "name",
          type: ApplicationCommandOptionType.String,
          required: true
        },
        {
          name: "class",
          type: ApplicationCommandOptionType.String,
          required: true
        }
      ]
    },
    {
      name: "import",
      description: "Import from JSON file",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "file",
          type: ApplicationCommandOptionType.Attachment,
          required: true
        }
      ]
    },
    {
      name: "export",
      description: "Export as JSON file",
      type: ApplicationCommandOptionType.Subcommand
    }
  ]
}
```

---

## 8. STORAGE CAPACITY ANALYSIS

### 8.1 Memory Budget (Single Guild)
```
Base session:           ~2 KB
Per player:             ~500 B
Character sheet:        ~5 KB
Chat history (20 msg):  ~10 KB
---
Per 4-player game:      ~35 KB
```

### 8.2 Disk I/O Patterns
Current:
- Read: World files on `/startgame` (cached)
- Write: TTS cache after each `/action`
- No persistent player data

Recommended:
- Read: Character sheets on `/startgame` or `/join`
- Write: Character sheets after `/character set` commands
- Consider: Periodic auto-save every 5 minutes during active game

### 8.3 LLM Context Window Impact
- System prompt: ~400-500 tokens
- World notes: ~100-1000 tokens (varies by world size)
- Chat history (20 msgs): ~200-300 tokens
- **Remaining for character data**: ~2700-3300 tokens available

**Character sheet representation for LLM**:
```
[CHARACTER SHEET SUMMARY]
Name: Aragorn the Ranger
Class: Ranger (Level 5)
Race: Human
HP: 45/45 | AC: 15

Skills (Proficient): Tracking +7, Survival +6, Stealth +5
Notable Equipment: Longbow, Longsword, Rope

[Key ability: High Dexterity (18), moderate Wisdom (14)]
```
Estimated impact: ~50-80 tokens (compact format)

---

## 9. CURRENT LIMITATIONS & CONSTRAINTS

### 9.1 Session Persistence
- ❌ No persistent storage of player data between sessions
- ❌ No automatic save/restore on bot restart
- ✅ Per-guild session isolation available

### 9.2 Data Size Constraints
- Discord nickname: 32 characters max
- Per-message content: No hard limit, but LLM has context window
- World notes: Practical limit ~50KB (before token overflow)

### 9.3 File System Access
- ✅ Full read/write to local filesystem
- ❌ No file watching/change detection
- ❌ No Discord file attachment streaming (need to download first)
- ✅ Async operations available (axios, fs promises)

### 9.4 Discord API Constraints
- ❌ No native PDF parsing
- ✅ Text file attachments can be read via download URL
- ✅ JSON attachments can be downloaded and parsed
- ⚠️ File size limit: 8MB (25MB with server boost)

---

## 10. RECOMMENDATIONS FOR CHARACTER SHEET IMPLEMENTATION

### 10.1 Short-Term (MVP)
1. **Storage**: In-memory per-session, matching existing pattern
2. **Input**: `/character create` slash command with subcommands
3. **Display**: `/character view` returns formatted embed
4. **Integration**: Reference sheet in LLM prompts for roleplay enhancement
5. **Format**: Simple JSON structure (8-10 key fields minimum)

### 10.2 Medium-Term
1. **Persistence**: Save to `character_sheets/` directory as JSON
2. **Auto-load**: Load saved sheets on `/startgame`
3. **Import/Export**: `/character import` and `/character export` commands
4. **Validation**: Schema validation for sheet data
5. **History**: Track modification timestamps

### 10.3 Long-Term
1. **Database**: Move to persistent storage (SQLite, PostgreSQL)
2. **Sharing**: Share sheets between guilds/users
3. **Version Control**: Track character progression (leveling, loot)
4. **API**: RESTful API for external sheet editors
5. **Integration**: Sync with Roll20, D&D Beyond API

### 10.4 Design Patterns to Leverage
- **Session Storage Pattern**: Use existing `sessions[guildId]` to store `characterSheets`
- **Command Structure**: Follow existing slash command pattern (subcommands)
- **File Management**: Use existing `path.join()` and `fs` patterns
- **Caching**: Apply world-notes caching pattern for frequently accessed sheets
- **Validation**: Use existing parameter validation from `/roll` and `/name` commands

---

## 11. CONCLUSION

The D-D-bot has a **well-structured architecture** optimized for immediate gameplay experience:

### Strengths
1. ✅ Clean separation of concerns (sessions, voice, LLM, worlds)
2. ✅ Discord.js slash command infrastructure ready for expansion
3. ✅ Proven file I/O patterns for world loading
4. ✅ Session management handles multiple games per guild
5. ✅ LLM integration flexible enough for enhanced prompts
6. ✅ Turn-taking system scales with player count

### Character Sheet Integration Sweet Spot
- **Data**: JSON structure, 5-10 KB per player, fits in memory and on disk
- **Input**: Slash commands with subcommands (proven pattern)
- **Storage**: File-based JSON in `character_sheets/` directory (matches world files)
- **LLM**: Compact summary format (~50 tokens) for context window
- **Discord**: Embeds for display, attachments for import/export

### Next Steps for Implementation
1. Define minimal viable character sheet structure (D&D 5e basics)
2. Create `/character` command group with subcommands
3. Implement JSON schema validation
4. Add character sheet lookup in LLM prompts
5. Create file import/export handlers
6. Add persistence layer (file-based before database)

