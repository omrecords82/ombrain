'use strict';

const { getPascha, getMoveableFeasts, gregorianDelta } = require('./calendar');

function sameDay(a, b) {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function inRange(date, start, end) {
  const t = date.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function getFastingRule(date) {
  const year = date.getUTCFullYear();
  const pascha = getPascha(year);
  const m = getMoveableFeasts(year);
  const delta = gregorianDelta(year);

  const cleanMonday = m.cleanMonday;
  const holySaturday = addDays(pascha, -1);
  const brightSaturday = addDays(pascha, 6);
  const thomasSunday = m.thomasSunday;
  const pentecost = m.pentecost;
  const allSaints = m.allSaints;

  if (inRange(date, cleanMonday, holySaturday)) {
    return { level: 'strict_fast', reason: 'Great Lent / Holy Week' };
  }

  if (inRange(date, pascha, brightSaturday)) {
    return { level: 'no_fast', reason: 'Bright Week (fast-free)' };
  }

  if (inRange(date, m.publicanAndPharisee, addDays(m.prodigalSon, -1))) {
    return { level: 'no_fast', reason: 'Publican and Pharisee Week (fast-free)' };
  }

  if (inRange(date, addDays(m.cheesefareSunday, -6), m.cheesefareSunday)) {
    return { level: 'no_fast', reason: 'Cheesefare Week (fast-free)' };
  }

  if (inRange(date, pentecost, allSaints)) {
    return { level: 'no_fast', reason: 'Pentecost Week (fast-free)' };
  }

  const dormitionStart = new Date(Date.UTC(year, 7, 1 + delta));
  const dormitionEnd = new Date(Date.UTC(year, 7, 14 + delta));
  if (inRange(date, dormitionStart, dormitionEnd)) {
    return { level: 'strict_fast', reason: 'Dormition Fast' };
  }

  const nativityFastStart = new Date(Date.UTC(year, 10, 15 + delta));
  const nativityFastEnd = new Date(Date.UTC(year, 11, 24 + delta));
  if (inRange(date, nativityFastStart, nativityFastEnd)) {
    return { level: 'strict_fast', reason: 'Nativity Fast (Advent)' };
  }

  const apostlesStart = addDays(allSaints, 1);
  const apostlesEnd = new Date(Date.UTC(year, 5, 28 + delta));
  if (inRange(date, apostlesStart, apostlesEnd)) {
    return { level: 'strict_fast', reason: "Apostles' Fast" };
  }

  const theophanyEve = new Date(Date.UTC(year, 0, 5 + delta));
  if (sameDay(date, theophanyEve)) {
    return { level: 'strict_fast', reason: 'Eve of Theophany' };
  }

  const beheading = new Date(Date.UTC(year, 7, 29 + delta));
  if (sameDay(date, beheading)) {
    return { level: 'strict_fast', reason: 'Beheading of St. John the Forerunner' };
  }

  const exaltation = new Date(Date.UTC(year, 8, 14 + delta));
  if (sameDay(date, exaltation)) {
    return { level: 'strict_fast', reason: 'Exaltation of the Holy Cross' };
  }

  const dow = date.getUTCDay();
  if (dow === 3 || dow === 5) {
    return { level: 'strict_fast', reason: 'Wednesday / Friday fast' };
  }

  return { level: 'no_fast', reason: 'No fasting rule applies' };
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

module.exports = { getFastingRule };
