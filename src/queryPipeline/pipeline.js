'use strict';

/**
 * Query Pipeline (Phase 9)
 *
 * PATCH P0-1 / P0-3 (2026-06-27):
 *   - BUG FIX: getMoveableFeasts() and getFixedFeasts() return objects, not arrays.
 *     `feasts.length` and `fixed.length` were always undefined.
 *     Fixed to use Object.keys(feasts).length and Object.keys(fixed).length.
 *   - BUG FIX: Church handler default proxy URL was 'http://192.168.1.242:3001'
 *     (OMStudio, which is closed on that port). Corrected to
 *     'http://192.168.1.239:7060' (OMAI ops server, which hosts /api/brain/*).
 *   - All other logic is unchanged from the deployed version.
 *
 * Wires the modes engine to the OMStudio client for end-to-end query processing:
 *   1. Poll OMStudio for pending user queries
 *   2. Acknowledge each query (mark as received)
 *   3. Classify the query with classifyIntent → mode id
 *   4. Route to the correct subsystem handler
 *   5. Report the answer back to OMStudio
 */

const { classifyIntent } = require('../modes/index');
const { getPascha, getMoveableFeasts, getFixedFeasts, getFastingRule } = require('../calendar/index');
const { search: docSearch, getBySlug, parseReference, extractReferences } = require('../theology/index');
const { ChurchFinder } = require('../churchFinder/index');

// ---------------------------------------------------------------------------
// Subsystem handlers
// ---------------------------------------------------------------------------

/**
 * Calendar handler — answers questions about feasts, fasting, Pascha.
 * Returns a structured answer object.
 */
async function handleCalendar(query) {
  const lower = query.toLowerCase();
  const yearMatch = query.match(/\b(20\d{2})\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

  // Pascha date
  if (lower.includes('pascha') || lower.includes('easter')) {
    const pascha = getPascha(year);
    return {
      type:   'calendar.pascha',
      year,
      pascha: pascha instanceof Date ? pascha.toISOString().slice(0, 10) : String(pascha),
      answer: `Pascha (Easter) in ${year} falls on ${pascha instanceof Date ? pascha.toDateString() : pascha} (Gregorian calendar, Julian reckoning).`,
    };
  }

  // Fasting rule for today or a specific date
  if (lower.includes('fast') || lower.includes('can i eat') || lower.includes('is today')) {
    const dateMatch = query.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    const date = dateMatch ? new Date(dateMatch[1] + 'T12:00:00Z') : new Date();
    const rule = getFastingRule(date);
    return {
      type:   'calendar.fasting',
      date:   date.toISOString().slice(0, 10),
      ...rule,
      answer: `On ${date.toDateString()}: ${rule.reason} (fast level: ${rule.level}).`,
    };
  }

  // Moveable feasts for a year
  // FIX: getMoveableFeasts / getFixedFeasts return plain objects, not arrays.
  // Use Object.keys().length for counts and convert to arrays for the response.
  if (lower.includes('feast') || lower.includes('feasts')) {
    const feasts = getMoveableFeasts(year);
    const fixed  = getFixedFeasts(year);
    const moveableEntries = Object.entries(feasts).map(([name, date]) => ({
      name,
      date: date instanceof Date ? date.toISOString().slice(0, 10) : String(date),
    }));
    const fixedEntries = Object.entries(fixed).map(([name, date]) => ({
      name,
      date: date instanceof Date ? date.toISOString().slice(0, 10) : String(date),
    }));
    return {
      type:          'calendar.feasts',
      year,
      moveableCount: moveableEntries.length,
      fixedCount:    fixedEntries.length,
      answer:        `In ${year} there are ${moveableEntries.length} moveable feasts and ${fixedEntries.length} fixed Great Feasts.`,
      moveableFeasts: moveableEntries,
      fixedFeasts:    fixedEntries,
    };
  }

  // Generic calendar answer
  const feasts = getMoveableFeasts(year);
  const moveableCount = Object.keys(feasts).length;
  return {
    type:   'calendar.general',
    year,
    answer: `The Orthodox calendar for ${year} has ${moveableCount} moveable feasts. Ask about Pascha, fasting rules, or specific feasts for details.`,
  };
}

/**
 * Study handler — answers doctrine and scripture questions.
 */
async function handleStudy(query) {
  const refs = extractReferences(query);
  if (refs.length > 0) {
    return {
      type:       'study.scripture',
      references: refs,
      answer:     `Found ${refs.length} scripture reference(s): ${refs.map(r => r.raw).join(', ')}.`,
    };
  }

  const singleRef = parseReference(query.trim());
  if (singleRef) {
    return {
      type:      'study.scripture',
      reference: singleRef,
      answer:    `Parsed reference: ${singleRef.book} ${singleRef.chapter}${singleRef.verse ? ':' + singleRef.verse : ''}.`,
    };
  }

  const entries = docSearch(query);
  if (entries.length > 0) {
    return {
      type:    'study.doctrine',
      entries,
      answer:  `Found ${entries.length} doctrine entry(ies) matching "${query}": ${entries.map(e => e.title).join(', ')}.`,
    };
  }

  return {
    type:   'study.general',
    answer: `No specific doctrine or scripture entry found for "${query}". Please ask about a specific Orthodox teaching, doctrine, or scripture reference.`,
  };
}

/**
 * Church handler — finds Orthodox churches by text query.
 *
 * FIX: Default proxy URL corrected from 'http://192.168.1.242:3001' (OMStudio,
 * closed port) to 'http://192.168.1.239:7060' (OMAI ops server, which hosts
 * the /api/brain/places/* proxy routes).
 */
async function handleChurch(query, config = {}) {
  const cf = new ChurchFinder({
    proxyBaseUrl: config.omaiProxyUrl || process.env.OMAI_PROXY_URL || 'http://192.168.1.239:7060',
    googleApiKey: config.googleApiKey || process.env.GOOGLE_PLACES_API_KEY || '',
    timeoutMs:    config.timeoutMs    || 8000,
    logger:       config.logger       || { info: () => {}, error: () => {} },
  });

  const result = await cf.searchByText({ query, limit: 5 });

  if (result.error) {
    return {
      type:   'church.error',
      error:  result.error,
      answer: `Church finder is currently unavailable (${result.error}). Please try again later.`,
    };
  }

  const churches = result.results || [];
  if (churches.length === 0) {
    return {
      type:   'church.empty',
      answer: `No Orthodox churches found for "${query}". Try a different location or jurisdiction.`,
    };
  }

  return {
    type:    'church.results',
    count:   churches.length,
    results: churches,
    answer:  `Found ${churches.length} Orthodox church(es) for "${query}": ${churches.map(c => c.name).join(', ')}.`,
  };
}

/**
 * Prayer handler — static guidance on prayer rules and practices.
 */
async function handlePrayer(query) {
  const lower = query.toLowerCase();

  if (lower.includes('jesus prayer') || lower.includes('lord have mercy')) {
    return {
      type:   'prayer.jesus_prayer',
      answer: 'The Jesus Prayer is: "Lord Jesus Christ, Son of God, have mercy on me, a sinner." It is prayed continuously, coordinated with breathing, as the foundation of hesychast practice.',
    };
  }

  if (lower.includes('morning') || lower.includes('evening')) {
    const time = lower.includes('morning') ? 'morning' : 'evening';
    return {
      type:   `prayer.${time}_rule`,
      answer: `The standard Orthodox ${time} prayer rule includes the ${time} prayers from the Orthodox Prayer Book, the Trisagion, the Lord's Prayer, and selected troparia. A full rule also includes a portion of the Psalter (kathisma).`,
    };
  }

  if (lower.includes('hesychasm') || lower.includes('noetic')) {
    return {
      type:   'prayer.hesychasm',
      answer: 'Hesychasm is the Orthodox tradition of inner stillness (hesychia) and noetic prayer. It involves the unceasing practice of the Jesus Prayer, purification of the nous (mind/heart), and theosis through divine grace.',
    };
  }

  return {
    type:   'prayer.general',
    answer: 'Orthodox prayer life centers on the Divine Liturgy, the Daily Hours (Vespers, Compline, Matins), the Jesus Prayer, and personal prayer rules. Ask about a specific prayer practice for more detail.',
  };
}

// ---------------------------------------------------------------------------
// QueryPipeline class
// ---------------------------------------------------------------------------

class QueryPipeline {
  /**
   * @param {object} config
   * @param {object} config.omstudioClient  - OMStudioClient instance
   * @param {object} [config.orchestrator]  - LLM orchestrator for general mode
   * @param {object} [config.logger]
   * @param {object} [config.churchConfig]  - Config passed to church handler
   */
  constructor(config = {}) {
    this.client       = config.omstudioClient;
    this.orchestrator = config.orchestrator || null;
    this.logger       = config.logger       || console;
    this.churchConfig = config.churchConfig || {};

    if (!this.client) throw new Error('QueryPipeline requires an omstudioClient');
  }

  /**
   * Process a single query object from OMStudio.
   *
   * @param {{ id: string, query: string, userId?: string }} queryObj
   * @returns {Promise<{ queryId: string, mode: string, answer: object }>}
   */
  async processQuery(queryObj) {
    const { id: queryId, query } = queryObj;

    // 1. Acknowledge
    try { await this.client.acknowledgeQuery(queryId); } catch (_) {}

    // 2. Classify
    const mode = classifyIntent(query);
    this.logger.info({ event: 'pipeline_query_classified', queryId, mode, query: query.slice(0, 80) });

    // 3. Route
    let answer;
    try {
      if      (mode === 'calendar') answer = await handleCalendar(query);
      else if (mode === 'study')    answer = await handleStudy(query);
      else if (mode === 'church')   answer = await handleChurch(query, this.churchConfig);
      else if (mode === 'prayer')   answer = await handlePrayer(query);
      else {
        // general → LLM orchestrator
        if (this.orchestrator && typeof this.orchestrator.ask === 'function') {
          const llmResult = await this.orchestrator.ask(query);
          answer = { type: 'general.llm', answer: llmResult };
        } else {
          answer = { type: 'general.unavailable', answer: 'General query routing requires the LLM orchestrator. Please ask a specific Orthodox question.' };
        }
      }
    } catch (err) {
      this.logger.error({ event: 'pipeline_handler_error', queryId, mode, error: err.message });
      answer = { type: `${mode}.error`, error: err.message, answer: `An error occurred processing your ${mode} query. Please try again.` };
    }

    // 4. Report result
    try {
      await this.client.reportQueryResult(queryId, { mode, ...answer });
    } catch (err) {
      this.logger.error({ event: 'pipeline_report_error', queryId, error: err.message });
    }

    this.logger.info({ event: 'pipeline_query_complete', queryId, mode, type: answer.type });
    return { queryId, mode, answer };
  }

  /**
   * Poll OMStudio for pending queries and process all of them.
   *
   * @param {number} [limit] - Max queries to fetch per poll (default: 10)
   * @returns {Promise<Array>} Processed results
   */
  async poll(limit = 10) {
    const queries = await this.client.fetchPendingQueries(limit);
    if (queries.length === 0) {
      this.logger.info({ event: 'pipeline_poll_empty' });
      return [];
    }

    this.logger.info({ event: 'pipeline_poll_start', count: queries.length });
    const results = [];
    for (const q of queries) {
      const result = await this.processQuery(q);
      results.push(result);
    }
    this.logger.info({ event: 'pipeline_poll_complete', processed: results.length });
    return results;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  QueryPipeline,
  handleCalendar,
  handleStudy,
  handleChurch,
  handlePrayer,
};
