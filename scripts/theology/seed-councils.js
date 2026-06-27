'use strict';

const { openDb, insertMany } = require('./_seed-lib');

const COUNCILS = [
  {
    category: 'council',
    subcategory: 'Nicaea I',
    reference_key: 'Nicaea.Creed.1',
    title: 'Nicene-Constantinopolitan Creed',
    body: 'I believe in one God, the Father Almighty, Maker of heaven and earth, and of all things visible and invisible. And in one Lord Jesus Christ, the Son of God, begotten of the Father before all ages; Light of Light, true God of true God, begotten, not made, of one essence with the Father.',
    source: 'First Ecumenical Council (325) / Second (381)',
  },
  {
    category: 'council',
    subcategory: 'Nicaea I',
    reference_key: 'Nicaea.Canon.1',
    title: 'Canon I of Nicaea',
    body: 'If any one in sickness has been subjected by physicians to a surgical operation, or if he has been castrated by barbarians, let him remain among the clergy; but if any one in sound health has castrated himself, it behoves that such an one, if already enrolled among the clergy, should cease from his ministry.',
    source: 'Canons of the Seven Ecumenical Councils',
  },
  {
    category: 'council',
    subcategory: 'Chalcedon',
    reference_key: 'Chalcedon.Definition.1',
    title: 'Chalcedonian Definition',
    body: 'We confess one and the same Son, our Lord Jesus Christ, the same perfect in Godhead and also perfect in manhood; truly God and truly man, of a rational soul and body; consubstantial with the Father according to the Godhead, and consubstantial with us according to the Manhood.',
    source: 'Fourth Ecumenical Council (451)',
  },
];

const db = openDb();
console.log('Seeding Canons of the Seven Ecumenical Councils (representative entries)...');
const n = insertMany(db, COUNCILS);
console.log(`Councils seed complete: ${n} rows inserted.`);
