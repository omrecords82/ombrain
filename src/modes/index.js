'use strict';

/**
 * Modes engine — intent classifier for the OM Brain query pipeline.
 *
 * Modes:
 *   - calendar : Orthodox calendar, feasts, fasting, Pascha
 *   - study    : doctrine, scripture, theological study
 *   - prayer   : prayer rules and hesychast practice
 *   - church   : Orthodox church finder by location
 *   - pastoral : pastoral / spiritual-counsel questions (confession, repentance,
 *                grief, temptation, spiritual struggle) — informational, NOT a
 *                substitute for a priest/spiritual father
 *   - ops      : operational / governance / infrastructure queries (health,
 *                deploys, incidents, restarts, service status)
 *   - general  : fallback
 *
 * REBUILD NOTE (2026-06-28): `pastoral` and `ops` modes were originally added in
 * PR #282, which was closed (not merged). They are re-implemented here from the
 * intent described in docs/coordination/TODO.html and om-brain/TODO.md.
 */

const MODES = Object.freeze([
  { id: 'calendar', description: 'Orthodox calendar, feasts, fasting, Pascha' },
  { id: 'study',    description: 'Doctrine, scripture, and theological study' },
  { id: 'prayer',   description: 'Prayer rules and hesychast practice' },
  { id: 'church',   description: 'Orthodox church finder by location' },
  { id: 'pastoral', description: 'Pastoral and spiritual-counsel guidance (informational)' },
  { id: 'ops',      description: 'Operational, governance, and infrastructure queries' },
  { id: 'general',  description: 'General fallback' },
]);

// Operational / infrastructure signal words.
const OPS_RE = /\b(restart|reboot|deploy|deployment|rollback|502|503|500|outage|crash(ed|ing)?|systemctl|service (down|status|failed)|incident|proposal|health\s*(check|status)?|uptime|disk|cpu|memory usage|nginx|firewall|port \d+|brain (health|status)|fleet|server (down|status)|provision)\b/;

// Pastoral / spiritual-counsel signal words. Kept distinct from `prayer`
// (prayer = mechanics of prayer rules) and `study` (= doctrine/scripture).
const PASTORAL_RE = /\b(confess(ion|ing)?|repent(ance)?|how do i prepare for confession|spiritual father|spiritual struggle|temptation|despair|grief|grieving|mourning|forgive(ness)?|guilt|shame|sin(ful|s)?\b|passions?|acedia|spiritual (counsel|guidance|advice|direction)|am i a sinner|struggling with)\b/;

function classifyIntent(text) {
  const q = String(text || '').toLowerCase();

  if (/\b(pascha|paschal|easter|pentecost|lent|fast(ing)?|feast|calendar|clean monday|holy week|bright week|when is)\b/.test(q)) {
    return 'calendar';
  }

  // Pastoral is checked before prayer/study so that "how do I prepare for
  // confession" routes to pastoral guidance rather than a prayer-rule answer.
  if (PASTORAL_RE.test(q)) {
    return 'pastoral';
  }

  if (/\b(jesus prayer|morning rule|evening rule|hesychasm|noetic prayer|prayer rule|trisagion|kathisma)\b/.test(q)) {
    return 'prayer';
  }

  if (/\b(find church|church near|orthodox church|parish near|nearest church|church in \d{5})\b/.test(q) ||
      (/\b(church|parish)\b/.test(q) && /\b(near|find|locate|zip|city)\b/.test(q))) {
    return 'church';
  }

  // Ops is checked before the generic study/"what is" fallbacks so that
  // "brain health status" and "should I restart the service" route to ops.
  if (OPS_RE.test(q)) {
    return 'ops';
  }

  if (/\b\d?\s*[a-z]+ \d+:\d+\b/.test(q) ||
      /\b(theosis|doctrine|scripture|bible|gospel|epistle|theology|canon|creed|catechism|what is the)\b/.test(q)) {
    return 'study';
  }

  if (/\b(what is|explain|how does|tell me about)\b/.test(q)) {
    return 'study';
  }

  return 'general';
}

function listModes() {
  return MODES.slice();
}

module.exports = { classifyIntent, listModes, MODES };
