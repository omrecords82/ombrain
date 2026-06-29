# Fleet Operations

OMBrain fleet operations run **versioned, allowlisted handlers** on remote hosts. The operation model is transport-agnostic — **NATS request/reply** is the primary transport; SSH remains for break-glass fallback.

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
        ├── natsTransport.execute()  ◄── primary (.254 → NATS → .239)
        └── sshTransport.execute()   ◄── fallback (FLEET_TRANSPORT=ssh)
        │
        ▼
  operation_run_children (per host)
        │
        ▼
  aggregated report JSON
```

See [ADR 0001](om-brain/adr/0001-satellite-transport-nats.md) for subjects, payloads, and security rules.

## NATS subjects

| Subject | Pattern | Example |
|---------|---------|---------|
| Spawn (request/reply) | `brain.fleet.spawn.{host_id}` | `brain.fleet.spawn.om-prod01` |

Reply uses NATS inbox — no separate result topic.

## Operation registry fields

| Field | Example | Purpose |
|-------|---------|---------|
| `id` | `fleet.find_env_files@v1` | Versioned operation id |
| `spawn_mode` | `fleet_ssh` | `local` \| `fleet_ssh` \| `fleet` |
| `transport` | `nats` | Default transport (`nats` \| `ssh`) |
| `handler_ref` | `fleetFindEnvFiles` | Internal handler key (not shell) |
| `script_ref` | `scripts/fleet/handlers/find-env-files.sh` | Allowlisted script path |

## Transport interface

Each transport implements:

```js
execute(hostConfig, handlerRef, env, meta) → { stdout, stderr, exit_code }
```

`meta`: `{ runId, parentRunId, operationId, params }`

- **NATS** (`src/fleet/transports/nats.js`): `nc.request('brain.fleet.spawn.<host>', payload)` with 120s timeout.
- **SSH** (`src/fleet/transports/ssh.js`): pipes allowlisted script to `ssh -i $FLEET_SSH_IDENTITY_FILE next@<ip> bash -s`.

Select transport: registry default, per-request `transport` in params, or `FLEET_TRANSPORT` env.

## Child run schema

Table `operation_run_children`:

- `parent_run_id` → `operation_runs.id`
- `host` — inventory name (`om-prod01`)
- `hostname` — from handler JSON
- `status`, `exit_code`, `result_json`
- `transport` — `nats` \| `ssh`
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
2. Satellites validate `operation_id` against `ALLOWED_OPERATION_IDS`.
3. Handlers output JSON paths only; never `cat` `.env` files.
4. `src/fleet/redact.js` strips `KEY=value` patterns from results if leaked.
5. Host targets resolved from `inventory/hosts.json` only.
6. `NATS_URL` must be loopback or RFC1918 — external brokers are rejected.

## Deploy: NATS broker (om-dev .254)

```bash
# 1. Install nats-server (single binary)
curl -fsSL https://github.com/nats-io/nats-server/releases/download/v2.10.29/nats-server-v2.10.29-linux-amd64.tar.gz \
  | tar -xz -C /tmp && sudo install /tmp/nats-server-v2.10.29-linux-amd64/nats-server /usr/local/bin/

# 2. Config + systemd
sudo mkdir -p /etc/nats /var/lib/nats
sudo cp /opt/om-brain/deploy/nats.conf /etc/nats/nats.conf
sudo cp /opt/om-brain/deploy/nats.service /etc/systemd/system/nats.service
sudo systemctl daemon-reload
sudo systemctl enable --now nats.service

# 3. Brain env (/etc/om-brain/om-brain.env)
NATS_URL=nats://127.0.0.1:4222
FLEET_TRANSPORT=nats

sudo systemctl restart om-brain.service
```

Broker binds `192.168.1.254:4222` (LAN). Monitoring on `127.0.0.1:8222` only.

## Deploy: satellite worker (om-prod01 .239)

```bash
# Sync om-brain to /opt/om-brain (handlers must exist)
sudo cp /opt/om-brain/deploy/satellite.env.example /etc/om-brain/satellite.env
# Edit NATS_URL=nats://192.168.1.254:4222, SATELLITE_HOST_ID=om-prod01

sudo cp /opt/om-brain/deploy/om-brain-satellite.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now om-brain-satellite.service
```

## Runtime env

| Variable | Default | Purpose |
|----------|---------|---------|
| `NATS_URL` | `nats://127.0.0.1:4222` | Broker URL (LAN/loopback only) |
| `NATS_TOKEN` | _(unset)_ | Optional broker auth |
| `FLEET_TRANSPORT` | `nats` | `nats` \| `ssh` |
| `FLEET_NATS_TIMEOUT_MS` | `120000` | Per-host NATS timeout |
| `SATELLITE_HOST_ID` | _(satellite)_ | Inventory host id |
| `OM_BRAIN_ROOT` | `/opt/om-brain` | Handler scripts on satellite |
| `FLEET_SSH_USER` | `next` | SSH fallback remote user |
| `FLEET_SSH_IDENTITY_FILE` | _(unset)_ | SSH fallback private key |
| `FLEET_SSH_TIMEOUT_MS` | `120000` | SSH fallback timeout |

## Verify end-to-end

```bash
curl -sS -X POST http://127.0.0.1:8390/brain/operations/fleet.find_env_files@v1/run \
  -H 'Content-Type: application/json' \
  -d '{"description":"nats fleet verify","targets":["om-prod01"]}'
```

Expect `ok: true`, `report.summary.total_paths` > 0, children `transport: "nats"`.

## SSH fallback (break-glass)

Set `FLEET_TRANSPORT=ssh` on brain. SSH prerequisites unchanged — see below.

### One-time SSH provisioning (om-dev .254)

Run on **om-dev** (192.168.1.254) as root:

```bash
install -d -m 700 -o om-brain -g om-brain /var/lib/om-brain/.ssh
sudo -u om-brain ssh-keygen -t ed25519 -f /var/lib/om-brain/.ssh/id_ed25519 -N '' -C 'om-brain-fleet'
chmod 600 /var/lib/om-brain/.ssh/id_ed25519

PUB="$(cat /var/lib/om-brain/.ssh/id_ed25519.pub)"
ssh next@192.168.1.239 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
  grep -qxF '$PUB' ~/.ssh/authorized_keys 2>/dev/null || \
  echo '$PUB' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

sudo -u om-brain ssh -i /var/lib/om-brain/.ssh/id_ed25519 \
  -o BatchMode=yes -o StrictHostKeyChecking=accept-new next@192.168.1.239 'echo ok'
```

## Adding a new fleet operation

1. Add handler script under `scripts/fleet/handlers/`.
2. Add `operation_id` to `ALLOWED_OPERATION_IDS` in `src/fleet/handlers.js`.
3. Register in `src/operations/registry.js` with `spawn_mode: 'fleet_ssh'`, `transport: 'nats'`.
4. Add intent patterns in `src/operations/intent.js` (optional).
5. Test with mock transport in `test/fleet-operations.test.js` and `test/fleet-nats.test.js`.

## SSH vs NATS

| | NATS (primary) | SSH (fallback) |
|---|----------------|----------------|
| Coupling | Message bus; no shell access to brain user | Requires SSH key + `authorized_keys` |
| Firewall | Outbound 4222 from satellite to .254 | Inbound SSH to fleet hosts |
| Timeout | Request-level (`FLEET_NATS_TIMEOUT_MS`) | `FLEET_SSH_TIMEOUT_MS` |
| Auth | Optional `NATS_TOKEN`; LAN URL guard | Ed25519 key in `/var/lib/om-brain/.ssh` |
| Multi-host | Queue group per host subject | One SSH session per host |
| Break-glass | Set `FLEET_TRANSPORT=ssh` | Default when NATS down |
