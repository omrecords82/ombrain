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

- **SSH** (`src/fleet/transports/ssh.js`): pipes allowlisted script to `ssh next@<ip> bash -s`, BatchMode, 120s timeout.
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

## SSH prerequisites (.254 → .239)

- `next@192.168.1.239` key-based auth, BatchMode
- `FLEET_SSH_USER` env override if needed
- If SSH is blocked, run handler locally: `--local` CLI flag or API `"local": true` (dev/test)

## Adding a new fleet operation

1. Add handler script under `scripts/fleet/handlers/`.
2. Register in `src/operations/registry.js` with `spawn_mode: 'fleet_ssh'`.
3. Add intent patterns in `src/operations/intent.js` (optional).
4. Test with mock transport in `test/fleet-operations.test.js`.
