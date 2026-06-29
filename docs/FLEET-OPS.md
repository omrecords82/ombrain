# Fleet Operations

OMBrain fleet operations run **versioned, allowlisted handlers** on remote hosts. The operation model is transport-agnostic so SSH can be swapped for NATS without changing registry entries or API shapes.

## Architecture

```
POST /brain/operations/<id>/run
        │
        ▼
  runFleetOperation()  ──► operation_runs (parent)
        │
        ▼
  dispatchFleetOperation()
        │
        ├── sshTransport.execute()   ◄── current (.254 → .239)
        └── natsTransport.execute()  ◄── stub (future)
        │
        ▼
  operation_run_children (per host)
        │
        ▼
  aggregated report JSON
```

## Operation registry fields

| Field | Example | Purpose |
|-------|---------|---------|
| `id` | `fleet.find_env_files@v1` | Versioned operation id |
| `spawn_mode` | `fleet_ssh` | `local` \| `fleet_ssh` \| `fleet` |
| `transport` | `ssh` | Default transport (`ssh` \| `nats`) |
| `handler_ref` | `fleetFindEnvFiles` | Internal handler key (not shell) |
| `script_ref` | `scripts/fleet/handlers/find-env-files.sh` | Allowlisted script path |

## Transport interface

Each transport implements:

```js
execute(hostConfig, handlerRef, env) → { stdout, stderr, exit_code }
```

- **SSH** (`src/fleet/transports/ssh.js`): pipes allowlisted script to `ssh -i $FLEET_SSH_IDENTITY_FILE next@<ip> bash -s`, BatchMode, 120s timeout.
- **NATS** (`src/fleet/transports/nats.js`): stub — returns `nats_not_implemented`.

To add NATS later: implement `natsTransport.execute`, set `transport: 'nats'` on the operation (or per-request body), and keep `dispatchFleetOperation` unchanged.

## Child run schema

Table `operation_run_children`:

- `parent_run_id` → `operation_runs.id`
- `host` — inventory name (`om-prod01`)
- `hostname` — from handler JSON
- `status`, `exit_code`, `result_json`
- `transport` — `ssh` \| `nats`
- `started_at`, `finished_at`

## Aggregation report

```json
{
  "operation_id": "fleet.find_env_files@v1",
  "parent_run_id": "uuid",
  "summary": { "hosts_requested": 1, "hosts_ok": 1, "total_paths": 12 },
  "hosts": [
    {
      "hostname": "om-prod01",
      "paths": ["/var/www/omai/.env"],
      "count": 1,
      "errors": [],
      "exit_code": 0,
      "started_at": "...",
      "finished_at": "..."
    }
  ]
}
```

## Safety rules

1. No arbitrary shell from API/LLM — only `script_ref` under `scripts/fleet/handlers/`.
2. Handlers output JSON paths only; never `cat` `.env` files.
3. `src/fleet/redact.js` strips `KEY=value` patterns from results if leaked.
4. Host targets resolved from `inventory/hosts.json` only.

## SSH prerequisites (.254 → fleet hosts)

`om-brain.service` runs as user `om-brain` with `ProtectHome=yes` — there is no usable `~/.ssh`. Fleet SSH uses a dedicated key under the service state directory.

### One-time provisioning (om-dev .254)

Run on **auth01** (192.168.1.254) as root:

```bash
# 1. Keypair for om-brain fleet dispatch
install -d -m 700 -o om-brain -g om-brain /var/lib/om-brain/.ssh
sudo -u om-brain ssh-keygen -t ed25519 -f /var/lib/om-brain/.ssh/id_ed25519 -N '' -C 'om-brain-fleet'
chmod 600 /var/lib/om-brain/.ssh/id_ed25519
chmod 644 /var/lib/om-brain/.ssh/id_ed25519.pub

# 2. Install pubkey on each fleet target (example: om-prod01)
PUB="$(cat /var/lib/om-brain/.ssh/id_ed25519.pub)"
ssh next@192.168.1.239 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
  grep -qxF '$PUB' ~/.ssh/authorized_keys 2>/dev/null || \
  echo '$PUB' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# 3. Verify as om-brain (BatchMode)
sudo -u om-brain ssh -i /var/lib/om-brain/.ssh/id_ed25519 \
  -o BatchMode=yes -o StrictHostKeyChecking=accept-new next@192.168.1.239 'echo ok'

# 4. Env + restart (after deploy merges FLEET_SSH_* into om-brain.env.example)
grep -q FLEET_SSH_IDENTITY_FILE /etc/om-brain/om-brain.env || cat >> /etc/om-brain/om-brain.env <<'EOF'
FLEET_SSH_USER=next
FLEET_SSH_IDENTITY_FILE=/var/lib/om-brain/.ssh/id_ed25519
EOF
systemctl restart om-brain.service
```

`ReadWritePaths=/var/lib/om-brain` in `deploy/om-brain.service` already covers `.ssh/` — no unit change required.

### Runtime env

| Variable | Default | Purpose |
|----------|---------|---------|
| `FLEET_SSH_USER` | `next` | Remote SSH user |
| `FLEET_SSH_IDENTITY_FILE` | _(unset)_ | Private key path; **required** in production |
| `FLEET_SSH_TIMEOUT_MS` | `120000` | Per-host handler timeout |

If SSH is blocked, run handler locally: `--local` CLI flag or API `"local": true` (dev/test).

## Adding a new fleet operation

1. Add handler script under `scripts/fleet/handlers/`.
2. Register in `src/operations/registry.js` with `spawn_mode: 'fleet_ssh'`.
3. Add intent patterns in `src/operations/intent.js` (optional).
4. Test with mock transport in `test/fleet-operations.test.js`.
