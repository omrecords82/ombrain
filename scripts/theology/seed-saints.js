'use strict';

const fs = require('fs');
const path = require('path');
const { openDb, insertMany } = require('./_seed-lib');

const saintsPath = path.join(__dirname, 'data', 'saints.json');
const saints = JSON.parse(fs.readFileSync(saintsPath, 'utf8'));

const rows = saints.map((s, i) => ({
  category: 'saint',
  subcategory: 'Calendar',
  reference_key: `Saint.${s.name.replace(/\s+/g, '.')}`,
  title: s.name,
  body: `${s.feast_day}: ${s.description}`,
  source: 'Orthodox Saints Calendar (sample)',
}));

const db = openDb();
console.log('Seeding Saints calendar...');
const n = insertMany(db, rows);
console.log(`Saints seed complete: ${n} rows inserted.`);
