# OMBrain — Global Settings Approval (facilitator only)

OMBrain can **propose** global settings changes and **help a human approve**
them, but can never apply a global setting itself and can never approve its own
proposals. The approval record, auth challenge, apply-on-approval, and audit all
live in the **OM backend**; approvals are mirrored into **OMStudio Brain
Approvals** for human review.

Full design, schema, security guarantees, and auth methods:
[`orthodoxmetrics/prod/docs/internal/global-settings-approval.md`](../../orthodoxmetrics/prod/docs/internal/global-settings-approval.md)

## CLI

```bash
ombrain settings get <key>
ombrain settings set <key> <value> --scope global      # -> creates OMBA-####, NOT applied
ombrain approvals list [--state submitted] [--key K] [--limit N]
ombrain approvals show <OMBA-####>
ombrain approve <OMBA-####> [--email you@org] [--method session_reauth|totp|signed_token] [--password-stdin]
ombrain reject  <OMBA-####> [--reason "..."]
```

`approve` issues a **fresh** human-auth challenge and forwards the credential to
the OM backend, which verifies and applies. A plaintext "yes" is never accepted.

## Config (environment)

| Var | Purpose | Default |
|-----|---------|---------|
| `OM_SETTINGS_API_BASE` | OM backend base URL | `https://orthodoxmetrics.com` |
| `OM_SETTINGS_TOKEN` | super_admin JWT (transport only) | falls back to `OM_ADMIN_JWT`, then `BRAIN_OPS_JWT` |

The transport token only gets past OM's route auth; the actual approval
authority is always the fresh human challenge credential.
