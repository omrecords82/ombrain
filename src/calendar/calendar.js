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
  const { year, month, day } = julianDate;
  const delta = gregorianDelta(year);
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  if (month === 3) d.setUTCDate(d.getUTCDate() + 7);
  return d;
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

module.exports = {
  julianPascha,
  julianToGregorian,
  getPascha,
  getMoveableFeasts,
  getFixedFeasts,
  addDays,
  gregorianDelta,
};
