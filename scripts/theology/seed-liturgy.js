'use strict';

const { openDb, insertMany } = require('./_seed-lib');

const LITURGY = [
  {
    category: 'liturgy',
    subcategory: 'Divine Liturgy',
    reference_key: 'Liturgy.Trisagion',
    title: 'Trisagion Hymn',
    body: 'Holy God, Holy Mighty, Holy Immortal, have mercy on us. (Thrice)',
    source: 'Divine Liturgy of St. John Chrysostom',
  },
  {
    category: 'liturgy',
    subcategory: 'Divine Liturgy',
    reference_key: 'Liturgy.LordsPrayer',
    title: "The Lord's Prayer",
    body: 'Our Father, who art in heaven, hallowed be Thy name. Thy kingdom come. Thy will be done, on earth as it is in heaven. Give us this day our daily bread. And forgive us our trespasses, as we forgive those who trespass against us. And lead us not into temptation, but deliver us from evil.',
    source: 'Divine Liturgy of St. John Chrysostom',
  },
  {
    category: 'liturgy',
    subcategory: 'Divine Liturgy',
    reference_key: 'Liturgy.Cherubic',
    title: 'Cherubic Hymn',
    body: 'Let us who mystically represent the Cherubim, and who sing to the Life-giving Trinity the thrice-holy hymn, now lay aside all earthly cares, that we may receive the King of all, who comes invisibly upborne by the angelic hosts. Alleluia.',
    source: 'Divine Liturgy of St. John Chrysostom',
  },
];

const db = openDb();
console.log('Seeding Divine Liturgy of St. John Chrysostom (representative entries)...');
const n = insertMany(db, LITURGY);
console.log(`Liturgy seed complete: ${n} rows inserted.`);
