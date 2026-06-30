# `ombrain` — system-wide CLI for the om-brain service

`ombrain` is a thin, zero-dependency HTTP client for the om-brain service. It runs
as a bare command from **any** server that can reach a Brain host — the host only
needs Node.js and the single `bin/ombrain.js` file (no full source tree).

It is distinct from `bin/om-brain-cli.js`, which loads the Brain's modules
directly and therefore only works from inside the source tree on the Brain host.

---

## Topology: master / backup with per-host API ports

`ombrain` does not talk to a single URL. It reads a **server registry** describing
a master Brain host plus optional backups. Each host exposes one or more API ports
(**default `8390`** on om-dev; legacy `60000-62000` pools are no longer used).
For every request it:

1. selects the highest-priority reachable server (**master first**, then backups
   by ascending `priority`);
2. **load-balances the request across that host's port pool** (round-robin),
   skipping any dead port; and
3. **fails over** to the next server when a host's entire pool is unreachable.

The endpoint that actually served the request is printed on **stderr**
(`[via master: ...]` / `[via backup: ...]`). **stdout** is human-readable plain
text by default; pass **`--json`** when you need machine-readable output for
scripts or piping.

### Registry file

JSON, resolved in this order (first found wins):

| Precedence | Path |
|-----------|------|
| 1 | `$OMBRAIN_SERVERS` (explicit path) |
| 2 | `~/.config/ombrain/servers.json` (per-user) |
| 3 | `/etc/om-brain/ombrain.servers.json` (system-wide) |

Example:

```json
{
  "version": 1,
  "rr": 0,
  "servers": [
    { "name": "master",  "scheme": "http", "host": "192.168.1.254", "ports": "8390", "role": "master", "priority": 0 },
    { "name": "backup1", "scheme": "http", "host": "192.168.1.239", "ports": "8390", "role": "backup", "priority": 10 }
  ]
}
```

`ports` accepts a single port or comma list: `"8390"`, `"8391,8392"`. Legacy
ranges like `"60000-62000"` are still parsed but not used in current deployments.
The `rr` field is the persisted round-robin cursor; the CLI advances it so
successive invocations spread load across multiple ports when configured.

### Endpoint resolution precedence

1. `--url <url>` — one explicit endpoint, **no** failover
2. `--server <name>` — one named registry server (its pool; no host failover)
3. `$OMBRAIN_URL` — one explicit endpoint, no failover
4. the **registry** — master → backups, each across its port pool
5. `http://127.0.0.1:8390` — last-resort default when nothing is configured

---

## Install

**On the Brain host (source present):**

```bash
cd /opt/om-brain
sudo bash deploy/install-ombrain.sh \
  --register-master 192.168.1.254 --ports 8390
ombrain server status
```

**On any other server (no source — copy one file):**

```bash
scp /opt/om-brain/bin/ombrain.js /opt/om-brain/deploy/install-ombrain.sh root@HOST:/tmp/
ssh root@HOST 'sudo bash /tmp/install-ombrain.sh --standalone /tmp/ombrain.js \
  --register-master 192.168.1.254 --register-backup 192.168.1.239 --ports 8390'
```

Installer options of note:

| Option | Purpose |
|--------|---------|
| `--register-master <host>` | Seed the registry master host |
| `--register-backup <host>` | Add a backup (repeatable) |
| `--ports <spec>` | Port list for seeded hosts (default `8390`) |
| `--standalone <file>` | Install a copy of `ombrain.js` (remote hosts) |
| `--url <url>` | Bake a default `OMBRAIN_URL` into `/etc/om-brain/ombrain.conf` |
| `--node <path>` | Explicit node path (sudo PATH safety) |
| `--prefix <dir>` | Launcher install dir (default `/usr/local/bin`) |
| `--uninstall` | Remove the command |

---

## Managing the registry at runtime

```bash
ombrain server list
ombrain server add master  192.168.1.254 --ports 8390 --role master
ombrain server add backup1 192.168.1.239 --ports 8390 --role backup --priority 10
ombrain server set-master backup1        # promote (demotes the old master)
ombrain server ports master 60000-61000  # replace a pool
ombrain server remove backup1
ombrain server status                     # probe each host's pool health
```

---

## Commands

```text
Core
  ombrain status                         Runtime status (adapters, NATS, ops JWT)
  ombrain ask <query...>                 Ask anything; routed by the mode router
  ombrain health                         Service health (plain text; --json for full object)
  ombrain ping                           Health as a script check (exit 0/3)
  ombrain classify <query...>            Show the routed mode without a full answer
  ombrain modes                          List available modes

Calendar
  ombrain pascha <year>
  ombrain year <year>                    Full record (Orthodox + Western Easter, feasts, fasting)
  ombrain feasts <year>
  ombrain today
  ombrain saints <month> <day> [old|new] [year]
  ombrain fasting <YYYY-MM-DD>
  ombrain range <start> <end>

Theology / Church / Session
  ombrain theology ask <query...> | topics | sources
  ombrain church find <lat> <lng> [miles] | jurisdictions
  ombrain session <id>

Actions (OMAI operational bridge — HTTP to /brain/actions)
  ombrain action|actions list [--source omai] [--category C] [--risk read|low|medium|high]
  ombrain action|actions show <action_id>
  ombrain action|actions run <action_id> [--input JSON|--file path] [--dry-run] [--commit] [--confirm]
  ombrain action|actions resolve <query...>
  ombrain action|actions history [--limit N]

Skills (executable scripts — HTTP to /brain/skills)
  ombrain skill|skills list
  ombrain skill|skills show <key>
  ombrain skill|skills add --file <path> [--key K] [--language bash|python|node]
  ombrain skill|skills run <key> [--dry-run] [--commit]

Servers (registry / topology)
  ombrain server list | add | set-master | ports | remove | status
```

### Global flags
`--url <url>`, `--server <name>`, `--quiet`, `--json`, `--session <id>`, `--mode <mode>`,
`--timeout <ms>`, `-h/--help`, `-v/--version`.

**Output:** commands print human-readable plain text by default. Add **`--json`**
for the raw API response object (useful in scripts: `ombrain health --json | jq .ok`).

---

## Examples

```bash
ombrain pascha 2026                       # Pascha 2026: 2026-04-12 (Sun Apr 12 2026)
ombrain pascha 2026 --json                # {"ok":true,"year":2026,"pascha":"2026-04-12",...}
ombrain saints 12 6 old 2026              # St. Nicholas -> Dec 19 N.S.
ombrain ask "what is theosis"             # mode: study + answer text
ombrain ask "fleet health status"        # mode: technical + answer text
ombrain ask "restart nginx" --mode ops    # routed to governance, not executed
ombrain --url http://127.0.0.1:8390 health   # one explicit port, no failover
ombrain --server backup1 health           # target one named host's pool
ombrain skill add --file ./scripts/hello.sh --key echo-test
ombrain skills run echo-test --commit
ombrain actions list
ombrain actions run omai.system.status
ombrain actions resolve "check full system status"
```

---

## Network note

The Brain API binds to loopback `:8390` by design. Nginx on om-dev exposes the
LAN edge at `http://192.168.1.254:8390`. From the Brain host itself use
`http://127.0.0.1:8390`; from other LAN hosts use the registry (`server add`) or
`--url http://192.168.1.254:8390`. Use `ombrain status` or `ombrain server status`
to confirm reachability.

### Required env vars (om-brain.service)

| Variable | Purpose |
|----------|---------|
| `BRAIN_HTTP_PORT` | Local API port (default `8390`) |
| `BRAIN_LAN_API_URL` | LAN edge URL shown in `/status` (e.g. `http://192.168.1.254:8390`) |
| `OM_API_BASE_URL` | OMAI ops plane for read adapters (e.g. `http://192.168.1.239:7060`) |
| `BRAIN_OPS_JWT` | Bearer JWT for `brain_ingest` role (provision via `deploy/provision-brain-ingest.sh`) |
| `NATS_URL` | Fleet transport broker (e.g. `nats://192.168.1.254:4222`) |

### 401 troubleshooting

Repeated `inventory_adapter_non_ok status:401` or `event_adapter_non_ok … status:401`
in `journalctl -u om-brain` almost always means `BRAIN_OPS_JWT` is missing, expired,
or signed with the wrong secret. Re-provision on the OMAI host:

```bash
set -a && source /var/www/omai/.env.omai && set +a
sudo -E om-brain/deploy/provision-brain-ingest.sh --update-auth01
```

Then verify: `ombrain status` (ops jwt: valid) and `curl -s http://127.0.0.1:8390/status | jq .adapters`.

### Ops-auth expiry monitoring

`BRAIN_OPS_JWT` is time-limited. The Brain surfaces expiry **without logging or returning the token**:

| Surface | What it shows |
|---------|----------------|
| `GET /status` → `ops_auth` | `valid`, `expires_at`, `days_until_expiry`, `health`, `warning` |
| `ombrain status` | Human warnings: healthy / near-expiry (≤14 days) / expired |
| `om-brain-ops-auth-check.timer` | Daily journald log on auth01 (.254) at 08:00 |
| OMAI Service Monitor | Degrades `om-brain@om-dev` when `ops_auth` needs attention |

**14-day warning threshold:** CLI, `/status`, and monitors warn when `days_until_expiry ≤ 14`.
Schedule JWT rotation before that window — typical provisioned tokens last ~90 days.

**Re-provision (OMAI host):**

```bash
set -a && source /var/www/omai/.env.omai && set +a
sudo -E om-brain/deploy/provision-brain-ingest.sh --update-auth01
sudo systemctl restart om-brain
```

**Validation after rotation:**

```bash
curl -s http://127.0.0.1:8390/status | jq '{ops_auth, adapters}'
ombrain status                    # exit 0 when healthy; 1 near-expiry; 2 expired
sudo systemctl start om-brain-ops-auth-check.service
journalctl -u om-brain-ops-auth-check -n 5 --no-pager
```

When the token is expired or missing, enabled adapters report `auth_degraded` in `/status`
(not just HTTP 401 from the ops plane).

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | usage / unknown command; **`ombrain status`:** ops JWT expires within 14 days |
| 2 | HTTP 4xx/5xx from a reachable Brain; **`ombrain status`:** ops JWT expired/invalid |
| 3 | all endpoints unreachable (or master down for `server status`) |

Use `ombrain ping` in health checks: it exits `0` only when a Brain endpoint
responds `{ ok: true }`.
