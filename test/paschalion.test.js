'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  getPascha,
  westernEaster,
  paschaYear,
  paschalCycles,
  calendarForYear,
  julianToGregorian,
  julianPascha,
} = require('../src/calendar/calendar');
const { fastingCalendar } = require('../src/calendar/fasting');

const iso = (d) => d.toISOString().slice(0, 10);

// Reference Orthodox Pascha (Gregorian civil) — published tables.
const ORTHODOX = {
  2010: '2010-04-04',
  2013: '2013-05-05',
  2014: '2014-04-20',
  2015: '2015-04-12',
  2018: '2018-04-08',
  2024: '2024-05-05',
  2025: '2025-04-20',
  2026: '2026-04-12',
  2029: '2029-04-08',
};

const WESTERN = {
  2014: '2014-04-20',
  2024: '2024-03-31',
  2025: '2025-04-20',
  2026: '2026-04-05',
};

test('getPascha matches published Orthodox Pascha dates', () => {
  for (const [y, expected] of Object.entries(ORTHODOX)) {
    assert.strictEqual(iso(getPascha(Number(y))), expected, `Orthodox Pascha ${y}`);
  }
});

test('regression: julianToGregorian no longer adds a spurious +7 in March', () => {
  // 2015 Julian Pascha is March 30; +13 offset => April 12 (NOT April 19).
  const j = julianPascha(2015);
  assert.strictEqual(j.month, 3);
  assert.strictEqual(iso(julianToGregorian(j)), '2015-04-12');
});

test('westernEaster matches published Gregorian Easter dates', () => {
  for (const [y, expected] of Object.entries(WESTERN)) {
    assert.strictEqual(iso(westernEaster(Number(y))), expected, `Western Easter ${y}`);
  }
});

test('2025 is a year where Orthodox and Western coincide', () => {
  const p = paschaYear(2025);
  assert.strictEqual(p.same_day, true);
  assert.strictEqual(p.gap_days, 0);
});

test('paschaYear reports a positive gap when Orthodox is later (2024)', () => {
  const p = paschaYear(2024);
  assert.strictEqual(p.gap_days, 35);
  assert.strictEqual(p.same_day, false);
  assert.match(p.orthodox.old_style, /O\.S\./);
  assert.match(p.orthodox.new_style, /N\.S\./);
});

test('paschalCycles are in range', () => {
  for (let y = 2000; y <= 2030; y += 1) {
    const c = paschalCycles(y);
    assert.ok(c.indiction >= 1 && c.indiction <= 15, `indiction ${y}`);
    assert.ok(c.solarCycle >= 1 && c.solarCycle <= 28, `solar ${y}`);
    assert.ok(c.lunarCycle >= 1 && c.lunarCycle <= 19, `lunar ${y}`);
  }
});

test('calendarForYear aggregates pascha + feasts', () => {
  const c = calendarForYear(2026);
  assert.strictEqual(c.year, 2026);
  assert.strictEqual(c.calendar_type, 'new');
  assert.strictEqual(c.pascha.orthodox.new_style_iso, '2026-04-12');
  assert.ok(Object.keys(c.moveable_feasts).length > 10);
  assert.ok(Object.keys(c.fixed_feasts).length >= 10);
  // moveable feasts are ISO strings
  assert.match(c.moveable_feasts.pascha, /^\d{4}-\d{2}-\d{2}$/);
});

test('fastingCalendar returns the four canonical fasts', () => {
  const f = fastingCalendar(2026);
  const keys = f.periods.map((p) => p.key);
  for (const k of ['great_lent', 'apostles_fast', 'dormition_fast', 'nativity_fast']) {
    assert.ok(keys.includes(k), `has ${k}`);
  }
  // Great Lent ends the day before Pascha (2026-04-11).
  const lent = f.periods.find((p) => p.key === 'great_lent');
  assert.strictEqual(lent.end, '2026-04-11');
  // Dormition fast is fixed Aug 1-14 O.S. => Aug 14-28 N.S. in 2026.
  const dorm = f.periods.find((p) => p.key === 'dormition_fast');
  assert.strictEqual(dorm.start, '2026-08-14');
  assert.strictEqual(dorm.end, '2026-08-27');
  assert.ok(f.strict_single_days.length >= 3);
});
