'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  saintsForDate,
  saintsForYear,
  listAllSaints,
} = require('../src/calendar/saintsCalendar');

test('saintsForDate finds a saint by Old-Style date', () => {
  const rows = saintsForDate(11, 13, 'old', 2026);
  assert.strictEqual(rows.length, 1);
  assert.match(rows[0].name, /John Chrysostom/);
  assert.strictEqual(rows[0].date_os, '11-13');
});

test('saintsForDate computes the New-Style date (Julian + 13 days in 2026)', () => {
  // St. Nicholas: Dec 6 O.S. -> Dec 19 N.S. for the 1900-2099 era (+13).
  const rows = saintsForDate(12, 6, 'old', 2026);
  assert.strictEqual(rows.length, 1);
  assert.match(rows[0].name, /Nicholas/);
  assert.strictEqual(rows[0].new_style_iso, '2026-12-19');
  assert.match(rows[0].new_style, /December 19 N\.S\./);
});

test('saintsForDate new-style lookup matches the converted date', () => {
  // Querying the N.S. civil date Dec 19 should return St. Nicholas.
  const rows = saintsForDate(12, 19, 'new', 2026);
  assert.ok(rows.some((s) => /Nicholas/.test(s.name)));
});

test('saintsForDate returns empty array for an uncommemorated date', () => {
  const rows = saintsForDate(2, 3, 'old', 2026);
  assert.ok(Array.isArray(rows));
  assert.strictEqual(rows.length, 0);
});

test('saintsForYear returns all commemorations sorted by O.S. date', () => {
  const all = saintsForYear(2026);
  assert.ok(all.length >= 30);
  for (let i = 1; i < all.length; i += 1) {
    assert.ok(all[i - 1].date_os <= all[i].date_os, 'sorted by date_os');
  }
  // Every entry carries dual dates.
  assert.ok(all.every((s) => s.old_style && s.new_style && s.new_style_iso));
});

test('the Twelve Apostles are all represented in the seed data', () => {
  const names = listAllSaints().map((s) => s.name.toLowerCase()).join(' | ');
  const apostles = [
    'peter', 'andrew', 'james, son of alphaeus', 'john the theologian',
    'philip', 'bartholomew', 'thomas', 'matthew', 'thaddaeus',
    'simon the zealot', 'matthias',
  ];
  for (const a of apostles) {
    assert.ok(names.includes(a), `expected an apostle matching "${a}"`);
  }
});

test('every seed entry has the required fields and a valid feast_type', () => {
  const valid = new Set([
    'great_feast', 'major_saint', 'lesser_saint', 'martyr', 'confessor',
    'equal_to_apostles', 'unmercenary', 'fool_for_christ', 'new_martyr',
    'apostle', 'hierarch',
  ]);
  for (const s of listAllSaints()) {
    assert.match(s.date_os, /^\d{2}-\d{2}$/, `date_os MM-DD for ${s.name}`);
    assert.ok(typeof s.name === 'string' && s.name.length > 0);
    assert.ok(valid.has(s.feast_type), `valid feast_type for ${s.name}: ${s.feast_type}`);
    assert.ok(s.rank >= 1 && s.rank <= 6, `rank 1-6 for ${s.name}`);
  }
});
