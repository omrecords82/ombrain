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
const { getPascha, getMoveableFeasts, getFixedFeasts, getFastingRule, saintsForDate, saintsForYear } = require('../calendar/index');

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
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

  // Saints commemorated on a date (e.g. "which saints on August 6", "saint of the day")
  if (lower.includes('saint')) {
    let month = null;
    let day = null;
    // "August 6" / "Aug 6" style
    const mdMatch = lower.match(/\b([a-z]{3,9})\s+(\d{1,2})\b/);
    if (mdMatch) {
      const mi = MONTH_NAMES.findIndex((m) => m.startsWith(mdMatch[1]));
      if (mi >= 0) { month = mi + 1; day = parseInt(mdMatch[2], 10); }
    }
    // numeric "8/6" or "8-6"
    if (month == null) {
      const numMatch = lower.match(/\b(\d{1,2})[\/-](\d{1,2})\b/);
      if (numMatch) { month = parseInt(numMatch[1], 10); day = parseInt(numMatch[2], 10); }
    }
    if (month != null && day != null && typeof saintsForDate === 'function') {
      const calendar = lower.includes('new style') || lower.includes('n.s.') ? 'new' : 'old';
      const saints = saintsForDate(month, day, calendar, year);
      return {
        type: 'calendar.saints',
        year,
        calendar,
        count: saints.length,
        saints,
        answer: saints.length
          ? `On ${MONTH_NAMES[month - 1]} ${day} (${calendar === 'new' ? 'N.S.' : 'O.S.'}) the Church commemorates: ${saints.map((s) => s.name).join('; ')}.`
          : `No saints are recorded in the Brain's calendar for ${MONTH_NAMES[month - 1]} ${day} (${calendar === 'new' ? 'N.S.' : 'O.S.'}). The seed set is representative, not exhaustive.`,
      };
    }
    // No date given: summarise the year's commemorations.
    if (typeof saintsForYear === 'function') {
      const all = saintsForYear(year);
      return {
        type: 'calendar.saints.year',
        year,
        count: all.length,
        answer: `The Brain's calendar records ${all.length} principal commemorations for ${year}. Ask about a specific date (e.g. "saints on November 13") for details.`,
      };
    }
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

/**
 * Pastoral handler — spiritual-counsel guidance on confession, repentance,
 * grief, temptation, and the passions.
 *
 * REBUILD NOTE (2026-06-28): originally introduced in the closed PR #282.
 * Re-implemented here. This handler is strictly INFORMATIONAL and always
 * directs the user to a priest / spiritual father for actual confession and
 * spiritual direction. It must never present itself as clergy.
 */
async function handlePastoral(query) {
  const lower = String(query || '').toLowerCase();
  const referral =
    'This is informational guidance from Orthodox tradition and is not a substitute ' +
    'for confession or the counsel of your priest or spiritual father. Please speak ' +
    'with a priest for confession and personal spiritual direction.';

  if (lower.includes('confess')) {
    return {
      type: 'pastoral.confession',
      referral,
      answer:
        'Preparation for confession in the Orthodox tradition includes prayerful self-examination ' +
        'against the commandments and the teachings of the Church, genuine repentance (metanoia — ' +
        'a turning of the whole self toward God), and the intention to amend one\'s life. Many find ' +
        'it helpful to use a pre-confession examination of conscience and to fast or pray beforehand. ' +
        'Confession itself is made before God in the presence of a priest, who is a witness and not the judge. ' +
        referral,
    };
  }

  if (lower.includes('grief') || lower.includes('griev') || lower.includes('mourn')) {
    return {
      type: 'pastoral.grief',
      referral,
      answer:
        'The Orthodox Church meets grief with hope in the Resurrection. We mourn, yet "not as those who have no hope" ' +
        '(1 Thess. 4:13). The Church prays for the departed, offers memorial services (Panikhida), and commends ' +
        'the grieving to the comfort of Christ, who Himself wept at the tomb of Lazarus. Lean on prayer, the ' +
        'sacraments, and your parish community. ' + referral,
    };
  }

  if (lower.includes('temptation') || lower.includes('passion') || lower.includes('despair') || lower.includes('acedia')) {
    return {
      type: 'pastoral.struggle',
      referral,
      answer:
        'The Fathers teach that struggle against the passions and temptations is the normal path of the Christian ' +
        'life, not a sign of failure. Watchfulness (nepsis), the Jesus Prayer, frequent confession and communion, ' +
        'and humility before God are the tradition\'s remedies. Despair (and its cousin acedia) is itself a ' +
        'temptation to be resisted through hope in God\'s mercy. ' + referral,
    };
  }

  if (lower.includes('forgiv')) {
    return {
      type: 'pastoral.forgiveness',
      referral,
      answer:
        'Forgiveness is central to Orthodox life: we ask God\'s forgiveness and extend it to others, as in the ' +
        'Lord\'s Prayer and the rite of Forgiveness Sunday before Great Lent. Forgiving does not always mean ' +
        'forgetting harm, but releasing the desire for vengeance and entrusting judgment to God. ' + referral,
    };
  }

  return {
    type: 'pastoral.general',
    referral,
    answer:
      'Orthodox pastoral life is grounded in repentance, prayer, the sacraments (especially Confession and the ' +
      'Eucharist), and the guidance of a spiritual father within a parish community. ' + referral,
  };
}

/**
 * Ops handler — operational / governance / infrastructure queries.
 *
 * REBUILD NOTE (2026-06-28): originally introduced in the closed PR #282.
 * Re-implemented here. For action-oriented operational questions (restart,
 * deploy, incident) it defers to the governance diagnose() flow via the
 * orchestrator; the pipeline-level handler returns a structured, read-only
 * summary plus current fleet-health context when an inventory snapshot is
 * available. It NEVER executes infrastructure actions itself.
 *
 * @param {string} query
 * @param {object} [config]
 * @param {object} [config.inventorySummary] - latest inventory summary, if any
 */
async function handleOps(query, config = {}) {
  const { computeFleetHealthFromSummary } = require('../util/platformHealth');
  const summary = config.inventorySummary || null;
  const health = computeFleetHealthFromSummary(summary);

  const lower = String(query || '').toLowerCase();
  const isAction = /\b(restart|reboot|deploy|rollback|provision|stop|start service|kill)\b/.test(lower);

  const healthLine = health.score == null
    ? 'Fleet health is currently unknown (no inventory snapshot available).'
    : `Fleet health: ${health.score}/100 (${health.severity}) — ${health.detail}.`;

  if (isAction) {
    return {
      type: 'ops.action_advisory',
      requiresGovernance: true,
      health,
      answer:
        `${healthLine} This is an action-class operational request and must go through the OM Brain ` +
        'governance flow (diagnose → audit → approval) before any change is made. The Brain observes, ' +
        'analyzes, explains, and recommends; it does not execute infrastructure actions autonomously.',
    };
  }

  return {
    type: 'ops.status',
    health,
    answer:
      `${healthLine} Ask about a specific host, service, or incident for more detail, or submit an ` +
      'action request (restart/deploy) to receive a governed recommendation.',
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
      else if (mode === 'pastoral') answer = await handlePastoral(query);
      else if (mode === 'ops')      answer = await handleOps(query, { inventorySummary: this.inventorySummary });
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
  handlePastoral,
  handleOps,
};
