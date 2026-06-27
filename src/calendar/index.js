'use strict';

const calendar = require('./calendar');
const fasting = require('./fasting');

module.exports = {
  ...calendar,
  ...fasting,
};
