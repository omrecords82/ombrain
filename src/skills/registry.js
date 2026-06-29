'use strict';

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '../../scripts/skills');

const BUILTIN_SKILL_IDS = {
  'bug-tracker-intake': '00000000-0000-4000-8000-000000000101',
};

function readSkillScript(filename) {
  return fs.readFileSync(path.join(SKILLS_DIR, filename), 'utf8');
}

const BUILTIN_SKILLS = [
  {
    id: BUILTIN_SKILL_IDS['bug-tracker-intake'],
    skill_key: 'bug-tracker-intake',
    title: 'Bug tracker intake',
    description:
      'Scaffold a dated fleet bug report under {BRAIN_DATA_DIR}/bug-reports/. Pass title as script args.',
    language: 'node',
    script_body: readSkillScript('bug-tracker-intake.js'),
    tags_json: JSON.stringify(['bug-tracker', 'ops', 'fleet']),
    source: 'import',
  },
];

function getBuiltinSkills() {
  return BUILTIN_SKILLS.map((s) => ({ ...s }));
}

function getBuiltinSkill(skill_key) {
  return BUILTIN_SKILLS.find((s) => s.skill_key === skill_key) || null;
}

module.exports = {
  BUILTIN_SKILLS,
  BUILTIN_SKILL_IDS,
  getBuiltinSkills,
  getBuiltinSkill,
};
