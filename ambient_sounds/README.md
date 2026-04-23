# Ambient Sounds

This folder contains location-based ambient sound effects to play during D&D narration.

## Folder Structure

- `dungeon/` — Dungeon, catacombs, underground spaces
- `forest/` — Forest, wilderness, outdoor areas
- `tavern/` — Taverns, inns, bustling establishments
- `town/` — Town, city, marketplace
- `cave/` — Caves, caverns
- `village/` — Small villages, rural areas
- `generic/` — General ambiance (default fallback)

## File Format

- **Format**: MP3 or WAV
- **Duration**: 30-60 seconds ideal (will loop)
- **Volume**: Moderate (will be played quietly as background)
- **Naming**: `ambient_[description].mp3` (e.g., `ambient_dungeon_echo.mp3`)

## Adding Sounds

1. Find free ambient sounds from:
   - [Freesound.org](https://freesound.org) (search: "dungeon ambience", "forest ambient", etc.)
   - [Zapsplat](https://www.zapsplat.com/sound-effects/environment/) (free, no login required)
   - [BBC Sound Effects Library](https://sound-effects.bbcrewind.co.uk/)
   - [OpenGameArt.org](https://opengameart.org/content/type/audio)

2. Download the audio file

3. Place it in the appropriate subfolder (dungeon, forest, tavern, etc.)

4. The bot will automatically find and use it

## How It Works

- The bot tracks the current location during gameplay
- When a location is mentioned in a DM response, ambient sounds from that folder play quietly in the background
- Sounds loop seamlessly while the DM narrates
- Different locations have different atmospheres

## Example Sounds to Download

### Dungeon
- Stone dungeon ambience with dripping water
- Echoing footsteps in empty halls
- Torch flickering

### Forest
- Birds chirping, wind in trees
- Forest ambience with insects
- Rain in forest

### Tavern
- Tavern chatter and clinking mugs
- Fireplace crackling
- Distant laughter

### Town/Village
- Marketplace sounds, vendor calls
- Footsteps on cobblestone
- Town bells

## Notes

- Ambient sounds are optional — the bot works fine without them
- Only one ambient sound plays at a time (rotates based on location)
- Sounds are muted if bot is not in a voice channel
- Users can add/remove sounds by editing these folders
