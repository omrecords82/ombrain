# PROC-001 Constitutional Gate (Phase 4)

## Purpose

Agents must not directly mutate procedural system workflows. They must open
a **registry-backed proposal** and wait for a human superadmin to Approve
in OMStudio Brain Approvals.

## Hook

| Layer | Path |
|-------|------|
| Agent API | `om-brain/src/governance/proposeWorkflowChange.js` |
| Brain HTTP | `POST /brain/propose-workflow` |
| Fork-A (Studio) | `POST /api/governance/brain/workflow-proposals` |
| Package impl | `packages/omstudio-brain-governance/src/governance/workflowProposal.js` |

## Sequence

1. Write `vault/docs/<slug>-proposal-v1.md`
2. Insert `om_library_records` (`is_canonical = 0`, tags include `proposal`) and
   `om_documentation` (`status = draft`, `content_path`)
3. Create Brain Approval (`SUBMITTED`) with title, description, risk profile,
   and links to Library / content path

## Gate hold

- Response always includes `execution_allowed: false` and
  `gate: awaiting_superadmin_approve`
- Only the Brain Approvals **Approve** action (superadmin JWT / admin gate)
  moves the request out of `SUBMITTED`
- Canonical flip (`is_canonical = 1`) is **not** performed by this hook —
  follow PROC-001 promotion after Approve

## Env (Studio host `.242`)

```bash
OMSTUDIO_REPO_ROOT=/var/www/omstudio
# or explicitly:
OMSTUDIO_VAULT_DOCS_ROOT=/var/www/omstudio/vault/docs
```
