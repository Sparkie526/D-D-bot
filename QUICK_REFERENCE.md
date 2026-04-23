# D-D-Bot Architecture: Quick Reference Guide

## Current Data Flow

```
Discord User
    ↓
/slash command → slash handler → Session lookup
    ↓
Discord Session {
  players: { userId → characterName }
  activePlayers: [{ userId, displayName, characterName }]
  history: [{ role, content }, ...] (max 20)
  turnOrder: [userId, userId, ...] (multiple players)
}
    ↓
LLM Handler → askDM() → buildSystemPrompt() + world notes + history
    ↓
LLM Response → sendDMResponseWithVoice()
    ↓
text → Discord chat
mp3 → TTS cache → voice channel
```

---

## Session Structure (Summary)

| Component | Type | Example | Notes |
|-----------|------|---------|-------|
| `players` | Object | `{123: "Aragorn"}` | userId → characterName |
| `activePlayers` | Array | `[{userId, displayName, characterName}]` | Players in voice |
| `history` | Array | `[{role, content}]` | Last 20 messages |
| `turnOrder` | Array | `[userId1, userId2]` | Multi-player turn sequence |
| `currentTurnIndex` | Number | `0` | Current player in turn order |

---

## World File Structure

```
worlds/
├── TEMPLATE.txt (copy this to create worlds)
├── aethoria.txt
└── ashmore_keep.txt

Each file:
=== TITLE: World Name ===
=== SETTING ===
=== CURRENT QUEST ===
=== MAP — LOCATION ===
=== NPCS ===
=== BOSSES & ENCOUNTERS ===
=== HOUSE RULES ===
=== TONE NOTES FOR THE DM ===
```

**Integration**: Loaded into `buildSystemPrompt()` as context for all LLM calls

---

## File I/O Capabilities

| Operation | Available | Used For | Pattern |
|-----------|-----------|----------|---------|
| fs.readFileSync | ✅ | World files | loadWorld(), getWorldTitle() |
| fs.writeFileSync | ✅ | TTS cache | textToSpeech() |
| fs.readdirSync | ✅ | World listing | getAllWorlds() |
| fs.mkdirSync | ✅ | Cache dir | initTTSCache() |
| fs.unlinkSync | ✅ | Temp files | transcribeAudio() |
| fs.statSync | ✅ | Cache invalidation | loadWorld() mtime check |

---

## Command Structure Pattern

```javascript
const commands = [
  {
    name: "commandname",
    description: "What it does",
    options: [
      {
        name: "param1",
        description: "Description",
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  }
];

// Handler
if (commandName === "commandname") {
  const param = interaction.options.getString("param1");
  // ... logic
  interaction.reply(message);
}
```

---

## D&D 5e Integration Points

### Action Detection
```javascript
detectActionKeywords("I attack the goblin")
→ returns: ["attack"]
→ getDefaultDCForAction() → DC 10
```

### Roll Handling
```javascript
/roll 1d20 dc:12
→ total = 15
→ 15 >= 12 → SUCCESS
→ [ROLL RESULT: Player rolled 15 vs DC 12 - SUCCESS]
```

### Pending Actions
```javascript
/action attack the goblin
→ requiresRoll = true, expectedDC = 10
→ "Roll 1d20 to attempt it"
→ /roll 1d20
→ Result combined with action in LLM prompt
```

---

## Character Sheet Integration Points

### Recommended Locations

1. **Storage**
   ```
   character_sheets/
   ├── {guildId}/
   │   ├── {userId}.json
   │   └── {userId}.json
   ```

2. **In-Memory Cache**
   ```javascript
   session.characterSheets = {
     userId: { characterName, class, race, ... }
   }
   ```

3. **LLM Prompt Integration**
   ```javascript
   systemPrompt += `[CHARACTER: ${sheet.characterName}, ${sheet.race} ${sheet.class}]`
   ```

---

## Key Files & Lines

| File | Purpose | Key Sections |
|------|---------|--------------|
| index.js:386-410 | Session management | getSession() structure |
| index.js:82-89 | D&D DCs | DND_DIFFICULTY_CLASSES |
| index.js:92-120 | Action keywords | ACTION_KEYWORDS, detectActionKeywords() |
| index.js:173-286 | World loading | loadWorld(), loadRandomWorld() |
| index.js:298-366 | System prompt | buildSystemPrompt() |
| index.js:412-418 | History tracking | addToHistory() |
| index.js:439-459 | Turn system | getCurrentTurnPlayer(), advanceTurn() |
| index.js:573-629 | Voice/TTS | textToSpeech(), sendDMResponseWithVoice() |
| index.js:1104-1203 | Command definitions | commands array |
| index.js:1258-1803 | Command handlers | InteractionCreate event |

---

## Storage & Memory Analysis

### Per Guild Session
```
Base:              2-5 KB
Per player:        500 B
Per message:       200-300 B
Character sheet:   5-10 KB (recommended)
---
4-player game:     ~35-50 KB
10-player game:    ~80-100 KB
```

### LLM Context Window (4K tokens)
```
System prompt:     400-500 tokens
World notes:       100-1000 tokens (variable)
Chat history:      200-300 tokens
Available:         ~2700-3300 tokens
Character data:    ~50-100 tokens (if included)
```

---

## Quick Start: Adding a Feature

### Step 1: Define Command
```javascript
{
  name: "mycommand",
  description: "What it does",
  options: [...]
}
```

### Step 2: Add to List
```javascript
const commands = [ ..., { name: "mycommand", ... } ];
```

### Step 3: Add Handler
```javascript
if (commandName === "mycommand") {
  const param = interaction.options.getString("param");
  // Logic here
  const result = await someAsyncFunc();
  interaction.reply(result);
}
```

### Step 4: Register
Automatically registered in ClientReady event via:
```javascript
await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
```

---

## Common Patterns to Reuse

### 1. Get Current Player
```javascript
const playerName = session.players[userId] || interaction.user.username;
```

### 2. Add to History
```javascript
addToHistory(guildId, "user", `${playerName} says: "${action}"`);
const reply = await askDM(guildId, action, playerName);
addToHistory(guildId, "assistant", reply);
```

### 3. Get Session Data
```javascript
const session = getSession(guildId);
const isActive = session.active;
const playerCount = session.activePlayers.length;
```

### 4. Turn Order Check
```javascript
if (session.turnOrder.length > 1) {
  const currentPlayer = getCurrentTurnPlayer(guildId);
  if (currentPlayer.userId !== interaction.user.id) {
    return interaction.reply("It's not your turn!");
  }
}
```

### 5. Load World File
```javascript
const worldFile = findWorldByTitleOrFilename(query);
const content = loadWorld(worldFile);
```

---

## Implementation Checklist for Character Sheets

- [ ] Define character sheet JSON schema
- [ ] Create `/character` command with subcommands (view, create, set, import, export)
- [ ] Add character sheet storage to `session` object
- [ ] Implement file I/O for persistence (character_sheets/ directory)
- [ ] Add sheet summary to LLM system prompt during gameplay
- [ ] Integrate skill modifiers with /roll command
- [ ] Add input validation for character sheet fields
- [ ] Create Discord embed for character sheet display
- [ ] Implement import from JSON attachment
- [ ] Implement export to JSON file attachment
- [ ] Add skill proficiency bonuses to rolls
- [ ] Test multi-player session with multiple character sheets
- [ ] Add auto-save on character modifications
- [ ] Create character sheet template (like world template)

