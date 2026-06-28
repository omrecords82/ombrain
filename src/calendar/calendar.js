'use strict';

/**
 * Orthodox Paschalion and feast engine (Julian reckoning, Gregorian civil output).
 * Algorithms: Meeus/Jones/Butcher Julian Easter; century-aware Gregorian conversion.
 */

function julianPascha(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return { year, month, day, calendar: 'julian' };
}

function gregorianDelta(year) {
  if (year < 1583) return 0;
  if (year < 1700) return 10;
  if (year < 1800) return 11;
  if (year < 1900) return 12;
  if (year < 2100) return 13;
  if (year < 2200) return 14;
  return 15;
}

function julianToGregorian(julianDate) {
  // Convert a Julian (Old-Style) calendar date to its Gregorian (New-Style)
  // civil date by adding the century-aware Julian->Gregorian offset. This is a
  // pure date shift: the same wall-clock day expressed on the other calendar.
  //
  // HISTORICAL NOTE: a previous version added a spurious `+7` whenever the
  // Julian Pascha fell in March. That nudge produced a one-week error for years
  // such as 2010, 2015, 2018, and 2029 (verified against published Pascha
  // tables via scripts/validate-paschalion.js). The correct conversion is the
  // offset alone.
  const { year, month, day } = julianDate;
  const delta = gregorianDelta(year);
  return new Date(Date.UTC(year, month - 1, day + delta));
}

function getPascha(year) {
  return julianToGregorian(julianPascha(year));
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function getMoveableFeasts(year) {
  const pascha = getPascha(year);
  const offsets = {
    publicanAndPharisee: -35,
    prodigalSon: -28,
    meatfareSunday: -21,
    cheesefareSunday: -14,
    cleanMonday: -48,
    lazarusSaturday: -8,
    palmSunday: -7,
    pascha: 0,
    thomasSunday: 7,
    midPentecost: 24,
    ascension: 39,
    pentecost: 49,
    allSaints: 56,
    zacchaeusSunday: -37,
    orthodoxySunday: -42,
    gregoryPalamasSunday: -35,
    venerationOfCrossSunday: -28,
    johnClimacusSunday: -21,
    maryOfEgyptSunday: -14,
    holyMonday: -6,
    holyTuesday: -5,
    holyWednesday: -4,
    holyThursday: -3,
    holyFriday: -2,
    holySaturday: -1,
    brightMonday: 1,
    brightTuesday: 2,
    brightWednesday: 3,
    brightThursday: 4,
    brightFriday: 5,
    brightSaturday: 6,
    samaritanWomanSunday: 28,
    blindManSunday: 35,
    holySpiritMonday: 50,
  };

  const feasts = {};
  for (const [name, offset] of Object.entries(offsets)) {
    feasts[name] = addDays(pascha, offset);
  }
  return feasts;
}

function getFixedFeasts(year) {
  const delta = gregorianDelta(year);
  const mk = (name, month, day) => {
    const d = new Date(Date.UTC(year, month - 1, day + delta));
    return d;
  };

  return {
    nativity: mk('nativity', 12, 25),
    theophany: mk('theophany', 1, 6),
    meetingOfTheLord: mk('meetingOfTheLord', 2, 2),
    annunciation: mk('annunciation', 3, 25),
    transfiguration: mk('transfiguration', 8, 6),
    dormition: mk('dormition', 8, 15),
    nativityOfTheotokos: mk('nativityOfTheotokos', 9, 8),
    exaltationOfCross: mk('exaltationOfCross', 9, 14),
    presentationOfTheotokos: mk('presentationOfTheotokos', 11, 21),
    circumcision: mk('circumcision', 1, 1),
    nativityOfForerunner: mk('nativityOfForerunner', 6, 24),
    peterAndPaul: mk('peterAndPaul', 6, 29),
    beheadingOfForerunner: mk('beheadingOfForerunner', 8, 29),
    protectionOfTheotokos: mk('protectionOfTheotokos', 10, 1),
    conceptionOfTheotokos: mk('conceptionOfTheotokos', 12, 9),
    conceptionOfForerunner: mk('conceptionOfForerunner', 9, 23),
  };
}

/**
 * westernEaster — Gregorian (Western) Easter via the Anonymous Gregorian
 * ("Meeus/Jones/Butcher") algorithm. Returns a UTC Date. Useful for comparison
 * with the Orthodox Pascha and for years where they coincide.
 */
function westernEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * indiction / solar cycle / lunar cycle — the classic Paschalion cycles.
 *   - Indiction: 15-year Roman tax cycle, (year + 3) mod 15, 1..15.
 *   - Solar cycle: 28-year cycle, (year + 8) mod 28 (Byzantine: (year+5099?) — we
 *     use the conventional (year mod 28) + 1 reckoning from the creation era as
 *     (year + 8) mod 28, 1..28).
 *   - Lunar cycle (Golden Number / Metonic): (year mod 19) + 1, 1..19.
 */
function paschalCycles(year) {
  const indiction = ((year + 2) % 15) + 1;
  const solarCycle = ((year + 8) % 28) + 1;
  const lunarCycle = (year % 19) + 1; // Golden Number
  return { indiction, solarCycle, lunarCycle };
}

function fmtOldStyle(julianDate) {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${MONTHS[julianDate.month - 1]} ${julianDate.day} O.S. (Julian)`;
}

function fmtNewStyle(date) {
  return `${date.toISOString().slice(0, 10)} N.S. (Gregorian)`;
}

/**
 * paschaYear — full Paschalion record for a civil year: Orthodox Pascha in both
 * Old-Style (Julian) and New-Style (Gregorian) forms, the Western Easter, the
 * gap in days between them, and the lunar/solar/indiction cycles.
 */
function paschaYear(year) {
  const julian = julianPascha(year);
  const orthodoxNs = getPascha(year);
  const western = westernEaster(year);
  const cycles = paschalCycles(year);
  const gapDays = Math.round((orthodoxNs.getTime() - western.getTime()) / 86400000);
  return {
    year,
    orthodox: {
      old_style: fmtOldStyle(julian),
      old_style_julian: julian,
      new_style: fmtNewStyle(orthodoxNs),
      new_style_iso: orthodoxNs.toISOString().slice(0, 10),
    },
    western_easter: {
      new_style: fmtNewStyle(western),
      new_style_iso: western.toISOString().slice(0, 10),
    },
    same_day: gapDays === 0,
    gap_days: gapDays,
    cycles,
  };
}

/**
 * calendarForYear — aggregate Pascha + moveable + fixed feasts for a year.
 * `calendarType` selects how dates are returned:
 *   - 'new' (default): Gregorian civil ISO strings (what most people read).
 *   - 'iso': alias of 'new'.
 * (Fixed feasts are computed from the Julian date + offset, so they already
 *  reflect the chosen civil presentation.)
 */
function calendarForYear(year, calendarType = 'new') {
  const pascha = paschaYear(year);
  const toIso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
  const moveable = {};
  for (const [k, v] of Object.entries(getMoveableFeasts(year))) moveable[k] = toIso(v);
  const fixed = {};
  for (const [k, v] of Object.entries(getFixedFeasts(year))) fixed[k] = toIso(v);
  return {
    year,
    calendar_type: calendarType === 'iso' ? 'new' : calendarType,
    pascha,
    moveable_feasts: moveable,
    fixed_feasts: fixed,
  };
}

module.exports = {
  julianPascha,
  julianToGregorian,
  getPascha,
  getMoveableFeasts,
  getFixedFeasts,
  addDays,
  gregorianDelta,
  westernEaster,
  paschalCycles,
  paschaYear,
  calendarForYear,
};
