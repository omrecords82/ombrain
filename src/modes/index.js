'use strict';

const MODES = Object.freeze([
  { id: 'calendar', description: 'Orthodox calendar, feasts, fasting, Pascha' },
  { id: 'study', description: 'Doctrine, scripture, and theological study' },
  { id: 'prayer', description: 'Prayer rules and hesychast practice' },
  { id: 'church', description: 'Orthodox church finder by location' },
  { id: 'general', description: 'Operational and governance queries' },
]);

function classifyIntent(text) {
  const q = String(text || '').toLowerCase();

  if (/\b(pascha|paschal|easter|pentecost|lent|fast(ing)?|feast|calendar|clean monday|holy week|bright week|when is)\b/.test(q)) {
    return 'calendar';
  }

  if (/\b(jesus prayer|morning rule|evening rule|hesychasm|noetic prayer|prayer rule|trisagion|kathisma)\b/.test(q)) {
    return 'prayer';
  }

  if (/\b(find church|church near|orthodox church|parish near|nearest church|church in \d{5})\b/.test(q) ||
      (/\b(church|parish)\b/.test(q) && /\b(near|find|locate|zip|city)\b/.test(q))) {
    return 'church';
  }

  if (/\b\d?\s*[a-z]+ \d+:\d+\b/.test(q) ||
      /\b(theosis|doctrine|scripture|bible|gospel|epistle|theology|canon|creed|catechism|what is the)\b/.test(q)) {
    return 'study';
  }

  if (/\b(restart|deploy|502|503|outage|crash|systemctl|service down|incident|proposal)\b/.test(q)) {
    return 'general';
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
