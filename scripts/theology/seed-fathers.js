'use strict';

const { openDb, insertMany } = require('./_seed-lib');

// Representative patristic excerpts. Full CCEL API ingest deferred (network + ToS).
const FATHERS = [
  {
    category: 'patristic',
    subcategory: 'Chrysostom',
    reference_key: 'Chrysostom.OnMathew.1',
    title: 'St. John Chrysostom on Scripture',
    body: 'The Scriptures are a treasury from which we may draw inexhaustible riches, if we approach them with humility and the guidance of the Church.',
    source: 'St. John Chrysostom (representative excerpt)',
  },
  {
    category: 'patristic',
    subcategory: 'Basil',
    reference_key: 'Basil.OnSpirit.1',
    title: 'St. Basil the Great on the Holy Spirit',
    body: 'Through the Holy Spirit we are restored to paradise, led back to the kingdom of heaven, and adopted as children.',
    source: 'St. Basil the Great (representative excerpt)',
  },
];

const db = openDb();
console.log('Seeding Patristic Homilies (representative excerpts; CCEL API ingest deferred)...');
const n = insertMany(db, FATHERS);
console.log(`Fathers seed complete: ${n} rows inserted.`);
