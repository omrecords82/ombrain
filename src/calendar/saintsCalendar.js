'use strict';

/**
 * Orthodox Saints' day engine (§6e of the master TODO).
 *
 * Saints are stored keyed by their Old-Style (Julian) calendar date "MM-DD".
 * For a given civil year we compute the New-Style (Gregorian civil) date using
 * the same century-aware Julian->Gregorian offset used by the Paschalion engine
 * (`gregorianDelta`). All calculations are deterministic — no LLM, no network.
 *
 * Public API:
 *   saintsForDate(month, day, calendar='old', year=currentYear)
 *   saintsForYear(year)
 *   listAllSaints()
 */

const fs = require('fs');
const path = require('path');
const { gregorianDelta } = require('./calendar');

let _cache = null;

function loadSaints() {
  if (_cache) return _cache;
  const file = path.join(__dirname, 'data', 'saints.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  _cache = Array.isArray(raw) ? raw : (raw.saints || []);
  return _cache;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Given an Old-Style "MM-DD" and a civil year, return both the O.S. and the
 * N.S. (Gregorian civil) calendar dates for that year.
 */
function resolveDates(dateOs, year) {
  const [moStr, dyStr] = dateOs.split('-');
  const month = parseInt(moStr, 10); // 1-12
  const day = parseInt(dyStr, 10);
  const delta = gregorianDelta(year);
  // N.S. is the Gregorian civil date on which the Julian date falls.
  const ns = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    os: { month, day, dateString: `${monthName(month)} ${day} O.S.` },
    ns: {
      iso: ns.toISOString().slice(0, 10),
      month: ns.getUTCMonth() + 1,
      day: ns.getUTCDate(),
      dateString: `${monthName(ns.getUTCMonth() + 1)} ${ns.getUTCDate()} N.S.`,
    },
  };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function monthName(m) {
  return MONTHS[(m - 1 + 12) % 12];
}

function decorate(entry, year) {
  const dates = resolveDates(entry.date_os, year);
  return {
    name: entry.name,
    feast_type: entry.feast_type,
    rank: entry.rank,
    notes: entry.notes || null,
    troparion_ref: entry.troparion_ref || null,
    date_os: entry.date_os,
    old_style: dates.os.dateString,
    new_style: dates.ns.dateString,
    new_style_iso: dates.ns.iso,
  };
}

/**
 * saintsForDate — return all saints commemorated on a given month/day.
 *
 * @param {number} month 1-12
 * @param {number} day 1-31
 * @param {'old'|'new'} calendar  Interpret (month,day) as the O.S. Julian date
 *                                ('old') or as the N.S. Gregorian civil date
 *                                ('new'). Default 'old'.
 * @param {number} [year] civil year used for O.S.<->N.S. conversion
 */
function saintsForDate(month, day, calendar = 'old', year = new Date().getUTCFullYear()) {
  const saints = loadSaints();
  const m = Number(month);
  const d = Number(day);

  if (calendar === 'old') {
    const key = `${pad2(m)}-${pad2(d)}`;
    return saints.filter((s) => s.date_os === key).map((s) => decorate(s, year));
  }

  // 'new': match against the computed N.S. date for the given year.
  return saints
    .map((s) => decorate(s, year))
    .filter((s) => s.new_style_iso.slice(5) === `${pad2(m)}-${pad2(d)}`);
}

/**
 * saintsForYear — return the full commemorated set for a civil year, sorted by
 * Old-Style date, each with both O.S. and N.S. dates.
 */
function saintsForYear(year = new Date().getUTCFullYear()) {
  const saints = loadSaints();
  return saints
    .map((s) => decorate(s, year))
    .sort((a, b) => a.date_os.localeCompare(b.date_os));
}

/** listAllSaints — raw list (no date resolution), useful for inventory. */
function listAllSaints() {
  return loadSaints().slice();
}

module.exports = {
  saintsForDate,
  saintsForYear,
  listAllSaints,
  resolveDates,
  monthName,
};
