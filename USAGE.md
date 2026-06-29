# OMBrain Usage

## Fleet operations

Fleet operations dispatch **allowlisted handler scripts** to inventory hosts over **NATS** (primary, om-dev `.254` broker) with **SSH fallback**. They never accept arbitrary shell from API bodies or LLM output.

### Registered fleet ops

| ID | Description | Default target |
|----|-------------|----------------|
| `fleet.find_env_files@v1` | Find `.env` / `.env.*` paths under `/var/www`, `/opt`, `/etc/omai` (paths only — never reads contents) | `om-prod01` (192.168.1.239) |

### HTTP API

```bash
# Run fleet env scan via NATS (default host om-prod01)
curl -sS -X POST http://127.0.0.1:8390/brain/operations/fleet.find_env_files@v1/run \
  -H 'Content-Type: application/json' \
  -d '{"description":"prod env inventory"}'

# Explicit target
curl -sS -X POST http://127.0.0.1:8390/brain/operations/fleet.find_env_files@v1/run \
  -H 'Content-Type: application/json' \
  -d '{"targets":["om-prod01"]}'

# SSH fallback (break-glass)
curl -sS -X POST http://127.0.0.1:8390/brain/operations/fleet.find_env_files@v1/run \
  -H 'Content-Type: application/json' \
  -d '{"targets":["om-prod01"],"transport":"ssh"}'

# Fetch parent run + per-host children
curl -sS http://127.0.0.1:8390/brain/operations/runs/<parent_run_id>
```

URL-encode the operation id if your client requires it: `fleet.find_env_files%40v1`.

### CLI

```bash
node bin/om-brain-cli.js operations run 'fleet.find_env_files@v1' --host om-prod01
node bin/om-brain-cli.js operations run 'fleet.find_env_files@v1' --local   # local handler only (dev)
```

### Natural language (ask)

Phrases like **find env files**, **.env locations**, or **fleet env scan** suggest `fleet.find_env_files@v1`. Pass `execute: true` on `POST /brain/ask` to run.

### Safety

- Handlers must live under `scripts/fleet/handlers/`
- NATS: `brain.fleet.spawn.<host_id>` request/reply; optional `NATS_TOKEN`
- SSH fallback: `BatchMode=yes`, 120s timeout, user `next` — see [docs/FLEET-OPS.md](docs/FLEET-OPS.md)
- Results redact accidental `KEY=value` lines

See [docs/FLEET-OPS.md](docs/FLEET-OPS.md) and [docs/om-brain/adr/0001-satellite-transport-nats.md](docs/om-brain/adr/0001-satellite-transport-nats.md).

## Local operations

```bash
node bin/om-brain-cli.js operations list
node bin/om-brain-cli.js operations run doc-registry-scan --commit
```

## Deploy

### om-dev (.254) — brain + NATS broker

```bash
cd /opt/om-brain
git fetch origin main && git checkout --detach origin/main
npm ci
sudo systemctl restart om-brain nats
```

### om-prod01 (.239) — satellite worker

```bash
sudo systemctl enable --now om-brain-satellite
```
