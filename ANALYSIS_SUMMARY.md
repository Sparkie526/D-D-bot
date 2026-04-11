# D-D-Bot Codebase Analysis - Executive Summary

## Overview

A comprehensive analysis of the D-D-bot architecture revealing a well-designed, extensible system optimized for immediate Discord gameplay with clear patterns for feature implementation.

**Analysis Date**: April 11, 2026  
**Codebase Size**: 1,805 lines (index.js)  
**Key Technologies**: Discord.js, OpenAI/Ollama, ElevenLabs, Node.js  
**Deployment**: Docker (Windows/Mac/Linux compatible)

---

## 1. PLAYER DATA STORAGE

### Current State
- **Location**: In-memory JavaScript objects (`sessions[guildId]`)
- **Persistence**: Session-based (lost on bot restart)
- **Per-Player Fields**: 3 base fields (userId, characterName, displayName)
- **Data Per Player**: ~500 bytes baseline
- **Character Names**: Max 32 characters (Discord limitation)

### Session Structure
```javascript
sessions[guildId] = {
  players: {},              // userId → characterName mapping
  activePlayers: [],        // Full player objects with display info
  history: [],              // Chat history (capped at 20 messages)
  originalNicknames: {},    // For reverting Discord nicknames
  turnOrder: [],            // Multi-player turn sequence
  // ... 8 more state fields
}
```

### Capacity Per Game
- 4-player session: ~35-50 KB memory
- 10-player session: ~80-100 KB memory
- Single message: 200-300 bytes average
- Grows linearly with player count and history

---

## 2. GAME SESSION STATE MANAGEMENT

### Session Lifecycle
```
/join → /startgame → /name (collection) → /action (gameplay) → /endgame → /leave
```

### State Tracking
- ✅ Active game flag
- ✅ Player identification and naming
- ✅ Turn-taking system (multi-player)
- ✅ Conversation history
- ✅ Roll results and pending actions
- ✅ Location-based state (for ambient sounds)

### Turn-Taking Features
- Automatic 75-second timeout for inactive players
- Round-robin turn order
- Turn advancement via `/action` or `/pass`
- Support for unlimited players

---

## 3. VOICE & FILE HANDLING

### Voice Integration
- **Library**: @discordjs/voice
- **Audio Formats**: MP3 (TTS), WAV (ambient)
- **Caching**: SHA256-based filename hashing
- **Fallback**: Text-only mode if voice fails

### File I/O Capabilities
| Operation | Supported | Used For |
|-----------|-----------|----------|
| Read | ✅ | World files, assets |
| Write | ✅ | TTS cache, temp files |
| Directory ops | ✅ | Cache/world management |
| Streaming | ✅ Partial | Audio playback |
| File watching | ❌ | Not implemented |

### Directory Structure
```
/worlds           - Campaign settings
/tts_cache        - Audio cache (SHA256 keys)
/ambient_sounds   - Location-based ambiance
/character_sheets - [Recommended] Player character data
```

---

## 4. WORLD FILE ARCHITECTURE

### Format & Structure
- **Location**: `worlds/` directory
- **Format**: Plain text with sectioned markers
- **Parsing**: Regex title extraction + content loading
- **Caching**: Mtime-based invalidation (no reload if unchanged)
- **Template**: `worlds/TEMPLATE.txt` provided for new worlds

### Section Organization
```
=== TITLE: ... ===
=== SETTING ===
=== CURRENT QUEST ===
=== MAP — LOCATION ===
=== NPCS ===
=== BOSSES & ENCOUNTERS ===
=== HOUSE RULES ===
=== TONE NOTES FOR THE DM ===
```

### World Integration
- Loaded into system prompt for every LLM call
- Token usage: 100-1000 tokens per world
- Supports random selection or specific world locking
- Hot reload via `/reloadnotes` (no restart needed)

---

## 5. FILE UPLOAD & PARSING MECHANISMS

### Current Capabilities
- ❌ Discord file attachment parsing (not implemented)
- ❌ URL-based file loading
- ✅ Local filesystem read/write
- ✅ Text file handling

### File Format Support
- ✅ Plain text (.txt)
- ✅ JSON (can be implemented)
- ❌ Binary formats (need workaround)
- ❌ PDF parsing

### Recommended Approach for Character Sheets
- **Format**: JSON (native JavaScript support)
- **Location**: `character_sheets/{guildId}/{userId}.json`
- **Size Limit**: 8 MB per file (Discord's default)
- **Validation**: Schema-based (can add after parsing)

---

## 6. D&D 5E INTEGRATION

### Difficulty Classes
- 5 (Very Easy) through 25 (Nearly Impossible)
- Hardcoded in `DND_DIFFICULTY_CLASSES` object
- Used for roll result interpretation

### Action Detection System
```javascript
// 14 action categories with keywords
ACTION_KEYWORDS = {
  combat, dodge, grapple, stealth, climb, swim, acrobatics,
  persuade, deception, intimidate, seduce, disable, pick, heal
}

// Automatic DC suggestion
getDefaultDCForAction(action) → DC value
```

### Roll Processing
1. Detect action keywords
2. Suggest DC based on action type
3. Prompt for roll if needed
4. Store pending action + expected DC
5. Process roll result
6. Pass success/failure to LLM for narrative

---

## 7. CHARACTER SHEET IMPLEMENTATION STRATEGY

### Recommended Storage Approach
**Option A: In-Memory with File Backup (MVP)**
- Fast access, matches session pattern
- Optional file persistence
- Lost on restart

**Option B: File-Based Persistent**
- Survives bot restart
- Slower I/O (can be mitigated with caching)
- Requires directory management

### Suggested Data Structure
```javascript
{
  userId, characterName,
  class, race, level, alignment,
  abilities: { strength, dexterity, constitution, ... },
  skills: { acrobatics: { mod, proficient }, ... },
  stats: { hp, maxHp, ac, initiative, proficiency },
  resources: { hitDice, spellSlots, abilities },
  equipment: [{ name, equipped }, ...],
  personality: { traits, ideals, bonds, flaws },
  metadata: { createdAt, lastModified, worldName }
}
```

### Integration Points
1. **LLM Prompt**: Add compact summary (~50 tokens)
2. **Roll Results**: Include skill proficiency modifiers
3. **Action Validation**: Reference sheet skills for DC calculation
4. **NPC Interaction**: Include character class/race in narration

### Slash Command Design
```
/character view          - Display sheet as embed
/character create        - Guided sheet creation
/character set [field]   - Update specific field
/character import        - Upload JSON file
/character export        - Download as JSON
```

---

## 8. STORAGE & MEMORY ANALYSIS

### Memory Budget Per Guild
```
Base session:      2-5 KB
Per player:        500 B
Per message:       200-300 B
Character sheet:   5-10 KB
---
Total (4 players): 35-50 KB
```

### LLM Context Window (4K tokens typical)
```
System prompt:     400-500 tokens (40% capacity)
World notes:       100-1000 tokens (variable)
Chat history:      200-300 tokens
Available:         ~2700 tokens for features
Character data:    ~50-80 tokens (compact format)
```

### Disk I/O Patterns
- **Read**: World files on `/startgame` (cached)
- **Write**: TTS cache after each narration
- **Optimization**: mtime checking prevents re-reads
- **No persistence**: Player data currently not persisted

---

## 9. CURRENT LIMITATIONS & GAPS

| Limitation | Impact | Workaround |
|-----------|--------|-----------|
| No persistent player data | Lost between sessions | File-based backup |
| No character sheets | Limited roleplay support | Implement character system |
| No Discord attachments | Can't import from files | Use JSON in text commands |
| No database | Single-bot only | Add SQLite/PostgreSQL later |
| Fixed context window | Large worlds reduce history | Compress character data |
| No file watching | Manual reload required | Works with `/reloadnotes` |

---

## 10. IMPLEMENTATION ROADMAP

### Phase 1: MVP (Minimal Viable Product)
1. Define character sheet JSON schema
2. Create `/character` command group with subcommands
3. In-memory storage (session-based)
4. Display via Discord embeds
5. Integration with LLM prompts

### Phase 2: Persistence
1. File-based JSON storage
2. Auto-load on `/startgame`
3. Import/export functionality
4. Schema validation
5. Modification timestamps

### Phase 3: Advanced
1. Database migration (SQLite)
2. Character progression (leveling)
3. Inventory management
4. Spell/ability tracking
5. Cross-guild sharing

---

## 11. KEY DESIGN PATTERNS

### Pattern 1: Slash Commands
```javascript
// Define → Register → Handle
const commands = [{ name, description, options }];
rest.put(Routes.applicationCommands(...), { body: commands });
if (commandName === "name") { /* handle */ }
```

### Pattern 2: Session Management
```javascript
getSession(guildId);  // Create if missing
session.active;       // Check game state
session.history;      // Access conversation
```

### Pattern 3: File Caching
```javascript
if (cache[filename] && cache.mtime === stat.mtimeMs) {
  return cache[filename];  // Return cached
}
// Else: read, cache, return
```

### Pattern 4: LLM Integration
```javascript
// Prompt = system + world + history
const messages = [
  { role: "system", content: buildSystemPrompt() },
  ...session.history
];
// Send to LLM, get narration
```

---

## 12. RECOMMENDATIONS

### For Character Sheet Implementation
1. ✅ Use JSON format (matches world files pattern)
2. ✅ Start with in-memory storage
3. ✅ Add file persistence in phase 2
4. ✅ Integrate with existing slash command pattern
5. ✅ Keep compact format for LLM context
6. ✅ Validate schema before storage

### For Architecture Health
1. ✅ Clear separation of concerns (observed)
2. ✅ Extensible command structure (ready)
3. ✅ File I/O patterns established (reusable)
4. ✅ Session management solid (scales well)
5. ⚠️ Add unit tests before major changes
6. ⚠️ Document new features in code

---

## 13. CONCLUSION

The D-D-bot has **excellent architecture for immediate implementation** of character sheets:

### Strengths
- Clean session-based state management
- Proven slash command infrastructure
- Established file I/O patterns
- LLM integration flexible and extensible
- Support for multiple games per guild
- Turn-taking system handles variable player counts

### Best Fit for Character Sheets
- **Data Format**: JSON (5-10 KB per character)
- **Storage**: File-based in `character_sheets/` (matches world files)
- **Input**: Slash commands with subcommands (proven pattern)
- **LLM Integration**: Compact summary (~50 tokens) fits context
- **Discord**: Embeds for display, attachments for import/export

### Next Steps
1. Define minimal character sheet structure
2. Create `/character` command group
3. Implement session-based storage
4. Add LLM prompt integration
5. Create file import/export handlers
6. Add persistence layer

---

## Files Generated

This analysis generated three documentation files:

1. **ARCHITECTURE_ANALYSIS.md** (22 KB) - Comprehensive technical analysis
2. **QUICK_REFERENCE.md** (7 KB) - Quick lookup guide and checklists
3. **ARCHITECTURE_DIAGRAM.txt** - ASCII architecture visualization

All files saved to `/root/dd/D-D-bot/` repository.

