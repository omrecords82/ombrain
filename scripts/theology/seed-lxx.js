'use strict';

const { openDb, insertMany } = require('./_seed-lib');

const LXX = [
  {
    category: 'scripture',
    subcategory: 'OT',
    reference_key: 'Gen.1.1',
    title: 'Genesis 1:1 (LXX)',
    body: 'In the beginning God made the heaven and the earth.',
    source: 'Brenton LXX 1851',
  },
  {
    category: 'scripture',
    subcategory: 'OT',
    reference_key: 'Gen.1.2',
    title: 'Genesis 1:2 (LXX)',
    body: 'But the earth was unsightly and unfurnished, and darkness was over the deep, and the Spirit of God moved over the water.',
    source: 'Brenton LXX 1851',
  },
  {
    category: 'scripture',
    subcategory: 'OT',
    reference_key: 'Ps.23.1',
    title: 'Psalm 22:1 (LXX numbering)',
    body: 'The Lord tends me as a shepherd, and I shall want nothing.',
    source: 'Brenton LXX 1851',
  },
];

const db = openDb();
console.log('Seeding LXX Septuagint (representative verses; full Brenton ingest deferred)...');
const n = insertMany(db, LXX);
console.log(`LXX seed complete: ${n} rows inserted.`);
