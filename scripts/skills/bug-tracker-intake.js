#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const title = process.argv.slice(2).join(' ').trim() || 'untitled-bug';
const slug =
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'bug';
const date = new Date().toISOString().slice(0, 10);
const brainRoot = path.resolve(__dirname, '../..');
const dataDir = process.env.BRAIN_DATA_DIR || path.join(brainRoot, 'data');
const outDir = path.join(dataDir, 'bug-reports');

fs.mkdirSync(outDir, { recursive: true });

const outFile = path.join(outDir, `${date}-${slug}.md`);
if (fs.existsSync(outFile)) {
  console.error(`exists: ${outFile}`);
  process.exit(1);
}

const body = `# Bug Report — ${title}

## Severity
P2

## Environment
- **Stack:**
- **Host/URL:**
- **Branch/deploy:** ${date}
- **Date observed:** ${date}

## User / Account
- **Email:**
- **Role:**

## Reproduction Steps
1.

## Expected Behavior


## Actual Behavior


## Investigation Notes


## Fix


## Verification
| Command | Result |
|---------|--------|
| | |

## Close-Out
- [ ] Repro confirmed fixed
- [ ] GAP-CLOSURE-REPORT updated
`;

fs.writeFileSync(outFile, body, 'utf8');
console.log(outFile);
