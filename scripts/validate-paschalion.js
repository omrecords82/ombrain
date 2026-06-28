#!/usr/bin/env node
'use strict';

/**
 * validate-paschalion.js — cross-check the computed Orthodox Pascha (New-Style /
 * Gregorian civil) and Western Easter against a hard-coded reference table of
 * known-good dates. Pure offline verification — no network, no LLM.
 *
 * USAGE:
 *   node scripts/validate-paschalion.js            # check the reference table
 *   node scripts/validate-paschalion.js --range 1900 2100   # print every year
 *
 * EXIT: 0 = all reference years match · 1 = one or more mismatches.
 *
 * Reference Orthodox Pascha (Gregorian civil) and Western Easter dates are
 * widely published (e.g. OrthodoxWiki Pascha tables, the GOARCH calendar, and
 * the US Naval Observatory for Western Easter). Spot-checked against multiple
 * sources; see deploy/CALENDAR_SOURCES.md.
 */

const { getPascha, westernEaster, paschaYear } = require('../src/calendar/calendar');

// year: [orthodoxPaschaNS 'MM-DD', westernEaster 'MM-DD']
const REFERENCE = {
  2010: ['04-04', '04-04'],
  2011: ['04-24', '04-24'],
  2012: ['04-15', '04-08'],
  2013: ['05-05', '03-31'],
  2014: ['04-20', '04-20'],
  2015: ['04-12', '04-05'],
  2016: ['05-01', '03-27'],
  2017: ['04-16', '04-16'],
  2018: ['04-08', '04-01'],
  2019: ['04-28', '04-21'],
  2020: ['04-19', '04-12'],
  2021: ['05-02', '04-04'],
  2022: ['04-24', '04-17'],
  2023: ['04-16', '04-09'],
  2024: ['05-05', '03-31'],
  2025: ['04-20', '04-20'],
  2026: ['04-12', '04-05'],
  2027: ['05-02', '03-28'],
  2028: ['04-16', '04-16'],
  2029: ['04-08', '04-01'],
  2030: ['04-28', '04-21'],
};

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function mmdd(d) {
  return iso(d).slice(5);
}

function checkTable() {
  let failures = 0;
  console.log('Year |  Orthodox NS | exp |  Western   | exp | cycles');
  console.log('-----+--------------+-----+------------+-----+-----------------------');
  for (const [yStr, [oExp, wExp]] of Object.entries(REFERENCE)) {
    const year = parseInt(yStr, 10);
    const o = mmdd(getPascha(year));
    const w = mmdd(westernEaster(year));
    const okO = o === oExp;
    const okW = w === wExp;
    if (!okO || !okW) failures += 1;
    const cyc = paschaYear(year).cycles;
    const mark = (okO && okW) ? 'ok ' : 'BAD';
    console.log(
      `${year} | ${o} ${okO ? '✓' : '✗'} | ${oExp} | ${w} ${okW ? '✓' : '✗'} | ${wExp} | ` +
      `L${cyc.lunarCycle} S${cyc.solarCycle} I${cyc.indiction} [${mark}]`,
    );
  }
  return failures;
}

function printRange(from, to) {
  for (let y = from; y <= to; y += 1) {
    const p = paschaYear(y);
    console.log(`${y}\tOrthodox ${p.orthodox.new_style_iso}\tWestern ${p.western_easter.new_style_iso}\tgap ${p.gap_days}d`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const rangeIdx = argv.indexOf('--range');
  if (rangeIdx >= 0) {
    const from = parseInt(argv[rangeIdx + 1], 10) || 1900;
    const to = parseInt(argv[rangeIdx + 2], 10) || 2100;
    printRange(from, to);
    return 0;
  }
  const failures = checkTable();
  if (failures === 0) {
    console.log(`\nAll ${Object.keys(REFERENCE).length} reference years match. ✓`);
    return 0;
  }
  console.error(`\n${failures} reference year(s) MISMATCH. ✗`);
  return 1;
}

process.exit(main());
