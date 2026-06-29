# OMBrain Usage

## Fleet operations

Fleet operations dispatch **allowlisted handler scripts** to inventory hosts over SSH (from om-dev `.254`). They never accept arbitrary shell from API bodies or LLM output.

### Registered fleet ops

| ID | Description | Default target |
|----|-------------|----------------|
| `fleet.find_env_files@v1` | Find `.env` / `.env.*` paths under `/var/www`, `/opt`, `/etc/omai` (paths only — never reads contents) | `om-prod01` (192.168.1.239) |

### HTTP API

```bash
# Run fleet env scan (default host om-prod01)
curl -sS -X POST http://127.0.0.1:8390/brain/operations/fleet.find_env_files@v1/run \
  -H 'Content-Type: application/json' \
  -d '{"description":"prod env inventory"}'

# Explicit target
curl -sS -X POST http://127.0.0.1:8390/brain/operations/fleet.find_env_files@v1/run \
  -H 'Content-Type: application/json' \
  -d '{"targets":["om-prod01"]}'

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
- SSH uses `BatchMode=yes`, 120s timeout, user `next` (override: `FLEET_SSH_USER`)
- Results redact accidental `KEY=value` lines

See [docs/FLEET-OPS.md](docs/FLEET-OPS.md) for transport abstraction and future NATS swap.

## Local operations

```bash
node bin/om-brain-cli.js operations list
node bin/om-brain-cli.js operations run doc-registry-scan --commit
```

## Deploy (om-dev .254)

After merging to `main`:

```bash
cd /var/www/omai/om-brain   # or /opt/om-brain on .254
git fetch origin main && git checkout --detach origin/main
# restart om-brain service per deploy/OMBRAIN_CLI.md
sudo systemctl restart om-brain
```
