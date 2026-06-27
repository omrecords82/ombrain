'use strict';

const { openDb, insertMany } = require('./_seed-lib');

const NT = [
  {
    category: 'scripture',
    subcategory: 'NT',
    reference_key: 'John.1.1',
    title: 'John 1:1',
    body: 'In the beginning was the Word, and the Word was with God, and the Word was God.',
    source: 'KJV New Testament',
  },
  {
    category: 'scripture',
    subcategory: 'NT',
    reference_key: 'John.3.16',
    title: 'John 3:16',
    body: 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.',
    source: 'KJV New Testament',
  },
  {
    category: 'scripture',
    subcategory: 'NT',
    reference_key: 'Matt.28.19',
    title: 'Matthew 28:19',
    body: 'Go ye therefore, and teach all nations, baptizing them in the name of the Father, and of the Son, and of the Holy Ghost.',
    source: 'KJV New Testament',
  },
];

const db = openDb();
console.log('Seeding KJV New Testament (representative verses; full NT ingest deferred)...');
const n = insertMany(db, NT);
console.log(`NT seed complete: ${n} rows inserted.`);
