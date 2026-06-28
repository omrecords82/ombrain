'use strict';

/**
 * Knowledge handler (master TODO §8).
 *
 * The "knowledge" communication mode covers durable, doctrinal, and reference
 * questions: Orthodox calendar, scripture/doctrine study, prayer practice,
 * church finding, and pastoral guidance. It does NOT cover live operational /
 * infrastructure questions (that is the `technical`/`ops` lane).
 *
 * This handler does not re-implement any subsystem; it classifies the query
 * against the existing subsystem classifier and delegates to the existing
 * queryPipeline handlers, then stamps a mode label/description on the result.
 */

const { classifyIntent } = require('../modes/index');
const {
  handleCalendar,
  handleStudy,
  handlePrayer,
  handleChurch,
  handlePastoral,
} = require('../queryPipeline/pipeline');

const MODE_LABEL = 'Knowledge';
const MODE_DESCRIPTION =
  'Durable Orthodox knowledge: calendar, scripture and doctrine, prayer, '
  + 'church finding, and pastoral guidance.';

/**
 * handleKnowledge — route a knowledge-mode query to the right subsystem.
 *
 * @param {string} query
 * @param {object} [opts] { db, ai, sessionId, omaiProxyUrl }
 * @returns {Promise<object>} { ok, mode_label, mode_description, submode, answer, detail }
 */
async function handleKnowledge(query, opts = {}) {
  const q = String(query || '').trim();
  const submode = classifyIntent(q);

  let detail;
  switch (submode) {
    case 'calendar':
      detail = await handleCalendar(q);
      break;
    case 'prayer':
      detail = await handlePrayer(q);
      break;
    case 'church':
      detail = await handleChurch(q, { omaiProxyUrl: opts.omaiProxyUrl });
      break;
    case 'pastoral':
      detail = await handlePastoral(q);
      break;
    case 'study':
    case 'general':
    default:
      detail = await handleStudy(q);
      break;
  }

  return {
    ok: true,
    mode: 'knowledge',
    mode_label: MODE_LABEL,
    mode_description: MODE_DESCRIPTION,
    submode,
    answer: detail && detail.answer,
    detail,
  };
}

module.exports = { handleKnowledge, MODE_LABEL, MODE_DESCRIPTION };
