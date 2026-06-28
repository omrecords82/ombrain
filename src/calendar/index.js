'use strict';

const calendar = require('./calendar');
const fasting = require('./fasting');
const saints = require('./saintsCalendar');

module.exports = {
  ...calendar,
  ...fasting,
  ...saints,
};
