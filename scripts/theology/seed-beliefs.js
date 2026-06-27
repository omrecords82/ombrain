'use strict';

const { openDb, insertMany } = require('./_seed-lib');

const BELIEFS = [
  {
    category: 'belief',
    subcategory: 'Trinity',
    reference_key: 'Belief.Trinity.1',
    title: 'The Holy Trinity',
    body: 'We worship one God in Trinity, and Trinity in Unity, neither confounding the Persons nor dividing the Essence.',
    source: 'Orthodox Belief Taxonomy',
  },
  {
    category: 'belief',
    subcategory: 'Christology',
    reference_key: 'Belief.Christ.1',
    title: 'Two Natures of Christ',
    body: 'Our Lord Jesus Christ is perfect God and perfect Man, two natures unconfused, unchanged, undivided, and inseparable.',
    source: 'Orthodox Belief Taxonomy',
  },
  {
    category: 'belief',
    subcategory: 'Ecclesiology',
    reference_key: 'Belief.Church.1',
    title: 'The One Holy Church',
    body: 'The Orthodox Church is the One, Holy, Catholic, and Apostolic Church, preserving the fullness of the faith handed down from the Apostles.',
    source: 'Orthodox Belief Taxonomy',
  },
  {
    category: 'belief',
    subcategory: 'Sacraments',
    reference_key: 'Belief.Sacraments.1',
    title: 'Holy Mysteries',
    body: 'The Church administers seven Holy Mysteries: Baptism, Chrismation, Eucharist, Repentance, Holy Orders, Marriage, and Unction.',
    source: 'Orthodox Belief Taxonomy',
  },
  {
    category: 'belief',
    subcategory: 'Scripture',
    reference_key: 'Belief.Scripture.1',
    title: 'Scripture and Tradition',
    body: 'Holy Scripture is interpreted within Holy Tradition. The Church is the guardian and interpreter of both.',
    source: 'Orthodox Belief Taxonomy',
  },
];

const db = openDb();
console.log('Seeding Orthodox Belief Taxonomy...');
const n = insertMany(db, BELIEFS);
console.log(`Beliefs seed complete: ${n} rows inserted.`);
