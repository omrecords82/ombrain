'use strict';

const { openDb, insertMany } = require('./_seed-lib');

const CATECHISM = [
  {
    category: 'catechism',
    subcategory: 'Faith',
    reference_key: 'Catechism.Q1',
    title: 'What is the chief end of man?',
    body: 'The chief end of man is to glorify God and enjoy Him forever, living in communion with the Holy Trinity.',
    source: "St. Philaret's Longer Catechism",
  },
  {
    category: 'catechism',
    subcategory: 'Faith',
    reference_key: 'Catechism.Q47',
    title: 'What is the Church?',
    body: 'The Church is a society founded by our Lord Jesus Christ, united by one faith, one baptism, and participation in the Holy Mysteries.',
    source: "St. Philaret's Longer Catechism",
  },
  {
    category: 'catechism',
    subcategory: 'Prayer',
    reference_key: 'Catechism.Q180',
    title: 'Why do we pray?',
    body: 'We pray to glorify God, to give thanks, to seek forgiveness, and to ask for those things needful for soul and body.',
    source: "St. Philaret's Longer Catechism",
  },
];

const db = openDb();
console.log("Seeding St. Philaret's Longer Catechism (representative entries)...");
const n = insertMany(db, CATECHISM);
console.log(`Catechism seed complete: ${n} rows inserted.`);
