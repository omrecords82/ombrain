# Orthodox Calendar Engine — Sources and Methodology

This document records the algorithms, reference data, and validation method behind the om-brain Orthodox calendar engine (`src/calendar/`). Everything in the engine is **deterministic**: no LLM and no network access are involved in computing any date.

## Paschalion (the date of Pascha)

The date of Orthodox Pascha is computed on the **Julian (Old-Style) calendar** using the classical Meeus/Jones/Butcher Julian Easter algorithm (`julianPascha`), then converted to the **Gregorian (New-Style) civil calendar** by adding the century-aware Julian→Gregorian offset (`gregorianDelta`). For the years 1900–2099 that offset is 13 days.

The conversion (`julianToGregorian`) is a pure date shift. An earlier implementation added a spurious extra week whenever the Julian Pascha fell in March; this produced a one-week error in 2010, 2015, 2018, and 2029 and has been removed. The current output is validated against published tables (see below).

**Western (Gregorian) Easter** is computed with the Anonymous Gregorian algorithm (`westernEaster`) so the engine can report the gap between the two reckonings and flag years in which they coincide (e.g. 2025).

## Moveable and fixed feasts

Moveable feasts are computed as day-offsets from Pascha (`getMoveableFeasts`). Fixed feasts (`getFixedFeasts`) and the saints' commemorations are stored on their **Old-Style** date and converted to the civil calendar with the same offset, so the dual O.S./N.S. presentation stays correct across centuries.

## Fasting

`getFastingRule(date)` classifies a single date; `fastingCalendar(year)` returns the four canonical multi-day fasts (Great Lent + Holy Week, the Apostles' Fast, the Dormition Fast, and the Nativity Fast), the strict single days (Eve of Theophany, Beheading of the Forerunner, Exaltation of the Cross), and the standing Wednesday/Friday rule.

## Saints

`src/calendar/data/saints.json` holds principal commemorations keyed by Old-Style `MM-DD` with a `feast_type` and a Typikon `rank` (1–6). The set is representative of the major feasts and all Twelve Apostles; it is not the exhaustive daily Menaion, and the handlers say so when a queried date has no entry. The data layer can be expanded without code changes.

## Reference sources

| Source | Used for |
| --- | --- |
| Wikipedia, "List of dates for Easter" | Cross-check of Orthodox (Julian) and Western (Gregorian) Easter dates, 2010–2035 |
| GOARCH liturgical calendar | Spot-check of feast and fasting dates |
| OrthodoxWiki Menaion / Synaxarion | Saints' commemorations and ranks |
| Brenton Septuagint (1851, public domain) | Scripture references (theology layer) |

## Validation

`scripts/validate-paschalion.js` cross-checks the computed Orthodox Pascha and Western Easter against a hard-coded reference table (2010–2030) and exits non-zero on any mismatch. Run it after any change to the calendar core:

```bash
node scripts/validate-paschalion.js              # check reference table
node scripts/validate-paschalion.js --range 1900 2100   # dump every year
```

Unit coverage lives in `test/paschalion.test.js` and `test/saints-calendar.test.js`.

## Configuration

The calendar surface is gated by `BRAIN_CALENDAR_ENABLED` (default `true`). When disabled, the calendar HTTP routes still load but operators may choose to hide them; the deterministic functions remain importable for internal use.
