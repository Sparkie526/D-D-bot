const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const db = require('./index');

const CHARACTER_SHEETS_PATH = path.join(__dirname, '..', 'character_sheets');

async function migrateCharacters() {
  console.log('Starting character migration...');
  
  db.initializeDatabase();
  
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  function scanDirectory(dirPath, guildId = null) {
    if (!fs.existsSync(dirPath)) return;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (guildId === null) {
          scanDirectory(path.join(dirPath, entry.name), entry.name);
        } else {
          scanDirectory(path.join(dirPath, entry.name), guildId);
        }
      } else if (entry.name.endsWith('.yaml') && !entry.name.startsWith('.')) {
        const filePath = path.join(dirPath, entry.name);
        
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const data = yaml.load(content);
          
          if (!data.character || !data.character.name) {
            console.log(`⚠️ Skipping invalid file: ${filePath}`);
            skipped++;
            continue;
          }

          const playerId = guildId || 'global';
          const existing = db.characters.getCharacterByName(playerId, guildId || 'default', data.character.name);
          
          if (existing) {
            console.log(`⏭️ Character already exists: ${data.character.name} (${playerId}/${guildId})`);
            skipped++;
            continue;
          }

          const characterData = {
            username: data.character.player || 'unknown',
            level: data.character.level || 1,
            experience: data.character.experience || 0,
            background: data.character.background || null,
            alignment: data.character.alignment || null,
            stats: {
              strength: data.abilities?.strength || 10,
              dexterity: data.abilities?.dexterity || 10,
              constitution: data.abilities?.constitution || 10,
              intelligence: data.abilities?.intelligence || 10,
              wisdom: data.abilities?.wisdom || 10,
              charisma: data.abilities?.charisma || 10,
              ac: data.combat?.ac || 10,
              hp: data.combat?.hp || { current: 10, max: 10 },
              initiative: data.combat?.initiative || 0,
              proficiency_bonus: data.combat?.proficiencyBonus || 2,
              conditions: data.conditions || {}
            },
            skills: data.skills || {},
            saves: data.saves || {},
            inventory: data.equipment?.inventory || [],
            features: data.features || []
          };

          if (data.equipment?.weapons) {
            for (const weapon of data.equipment.weapons) {
              characterData.inventory.push(weapon);
            }
          }

          const newChar = db.characters.createCharacter(
            playerId,
            guildId || 'default',
            data.character.name,
            data.character.class || 'Fighter',
            characterData
          );

          console.log(`✅ Migrated: ${data.character.name} (${data.character.class} Lv${characterData.level})`);
          migrated++;
        } catch (err) {
          console.error(`❌ Error migrating ${filePath}:`, err.message);
          errors++;
        }
      }
    }
  }

  scanDirectory(CHARACTER_SHEETS_PATH);
  
  console.log('\n=== Migration Complete ===');
  console.log(`Migrated: ${migrated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  console.log(`Database: ${db.DB_PATH}`);
  
  db.closeDatabase();
  
  return { migrated, skipped, errors };
}

if (require.main === module) {
  migrateCharacters().catch(console.error);
}

module.exports = { migrateCharacters };
