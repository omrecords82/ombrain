# ADR 0001: Satellite transport via NATS

**Status:** Accepted (implemented 2026-06-29)  
**Context:** om-brain fleet operations on om-dev (.254) dispatch allowlisted handlers to satellites (om-prod01 `.239` first). SSH worked but couples dispatch to shell access and service-user key provisioning.

## Decision

Use **NATS request/reply** as the primary fleet transport. SSH remains available via `FLEET_TRANSPORT=ssh` for emergency fallback.

## Subjects

| Subject | Direction | Purpose |
|---------|-----------|---------|
| `brain.fleet.spawn.{host_id}` | Brain → Satellite (request/reply) | Dispatch allowlisted handler |
| _(reply inbox)_ | Satellite → Brain | Handler result |

Example: `brain.fleet.spawn.om-prod01`

No pub/sub result topics — NATS built-in reply inbox carries the response.

## Spawn payload (JSON)

```json
{
  "run_id": "<child operation_run_children.id>",
  "parent_run_id": "<parent operation_runs.id>",
  "operation_id": "fleet.find_env_files@v1",
  "task_id": null,
  "handler_ref": "scripts/fleet/handlers/find-env-files.sh",
  "host": "om-prod01",
  "params": {},
  "env": {}
}
```

## Result payload (JSON)

Same shape as SSH transport:

```json
{
  "stdout": "<handler JSON on stdout>",
  "stderr": "",
  "exit_code": 0
}
```

## Security

1. Satellites validate `operation_id` against `ALLOWED_OPERATION_IDS`.
2. Satellites validate `handler_ref` under `scripts/fleet/handlers/` only.
3. No arbitrary commands — handler scripts are packaged on disk at `OM_BRAIN_ROOT`.
4. `NATS_URL` circuit breaker: loopback or RFC1918 only.
5. Optional `NATS_TOKEN` on broker, brain, and satellite.

## Env vars

| Variable | Host | Default | Purpose |
|----------|------|---------|---------|
| `NATS_URL` | Brain + Satellite | `nats://127.0.0.1:4222` | Broker URL |
| `NATS_TOKEN` | All | _(unset)_ | Optional auth |
| `FLEET_TRANSPORT` | Brain | `nats` | `nats` \| `ssh` |
| `FLEET_NATS_TIMEOUT_MS` | Brain + Satellite | `120000` | Request timeout |
| `SATELLITE_HOST_ID` | Satellite | _(required)_ | Inventory host name |
| `OM_BRAIN_ROOT` | Satellite | `/opt/om-brain` | Handler script root |

## Migration

1. Deploy NATS on om-dev (.254), bind `192.168.1.254:4222`.
2. Deploy satellite worker on om-prod01 (.239).
3. Set `FLEET_TRANSPORT=nats` (default) on brain.
4. Verify `fleet.find_env_files@v1` end-to-end.
5. Keep SSH key + `FLEET_TRANSPORT=ssh` documented for break-glass.

## Implementation files

- `src/fleet/natsClient.js` — connection, URL guard, subject naming
- `src/fleet/transports/nats.js` — brain-side request
- `scripts/fleet/satellite-worker.js` — satellite subscriber
- `deploy/nats.conf`, `deploy/nats.service`, `deploy/om-brain-satellite.service`
