'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OmstudioClient } = require('../src/governance/omstudioClient');
const { proposeWorkflowChange } = require('../src/governance/proposeWorkflowChange');

test('proposeWorkflowChange dry-run stages vault markdown and approval outbox', async () => {
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omstudio-outbox-'));
  const client = new OmstudioClient({
    transport: 'dryrun',
    outboxDir: outbox,
    baseUrl: 'http://192.168.1.242/omstudio-embed',
    serviceToken: 'test',
  });
  const result = await proposeWorkflowChange({
    title: 'Agent Hook Dry Run',
    description: 'Verify constitutional gate dry-run path',
    risk_profile: 'low',
    category: 'OPERATIONS',
  }, { omstudio: client, dryRun: true });

  assert.equal(result.ok, true);
  assert.equal(result.execution_allowed, false);
  assert.equal(result.dry_run, true);
  assert.ok(result.content_path.startsWith('vault/docs/'));
  const staged = path.join(outbox, 'vault-docs', path.basename(result.content_path));
  assert.ok(fs.existsSync(staged));
  fs.rmSync(outbox, { recursive: true, force: true });
});

test('proposeWorkflowChange http calls workflow-proposals path', async () => {
  const calls = [];
  const client = new OmstudioClient({
    transport: 'http',
    baseUrl: 'http://192.168.1.242/omstudio-embed',
    serviceToken: 'test',
    httpImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          ok: true,
          gate: 'awaiting_superadmin_approve',
          execution_allowed: false,
          content_path: 'vault/docs/http-proposal-proposal-v1.md',
          library_record_id: 42,
          documentation_slug: 'http-proposal',
          is_canonical: 0,
          approval: { id: 1, ref: 'oms-app-test', state: 'SUBMITTED' },
        }),
      };
    },
  });
  const result = await proposeWorkflowChange({
    title: 'HTTP Proposal',
    description: 'Calls composite Studio endpoint',
  }, { omstudio: client });
  assert.equal(result.ok, true);
  assert.equal(result.library_record_id, 42);
  assert.equal(result.execution_allowed, false);
  assert.match(calls[0].url, /\/workflow-proposals$/);
});
