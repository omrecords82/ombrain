# `ombrain` — system-wide CLI for the om-brain service

`ombrain` is a thin, zero-dependency HTTP client for the om-brain service. It runs
as a bare command from **any** server that can reach a Brain host — the host only
needs Node.js and the single `bin/ombrain.js` file (no full source tree).

It is distinct from `bin/om-brain-cli.js`, which loads the Brain's modules
directly and therefore only works from inside the source tree on the Brain host.

---

## Topology: master / backup with per-host port pools

`ombrain` does not talk to a single URL. It reads a **server registry** describing
a master Brain host plus optional backups, where **each host serves a pool of
ports** (e.g. `60000-62000`). For every request it:

1. selects the highest-priority reachable server (**master first**, then backups
   by ascending `priority`);
2. **load-balances the request across that host's port pool** (round-robin),
   skipping any dead port; and
3. **fails over** to the next server when a host's entire pool is unreachable.

The endpoint that actually served the request is printed on **stderr**
(`[via master: ...]` / `[via backup: ...]`), so stdout stays clean JSON for piping.

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
    { "name": "master",  "scheme": "http", "host": "192.168.1.254", "ports": "60000-62000", "role": "master", "priority": 0 },
    { "name": "backup1", "scheme": "http", "host": "192.168.1.239", "ports": "60000-62000", "role": "backup", "priority": 10 }
  ]
}
```

`ports` accepts ranges and lists: `"60000-62000"`, `"8391,8392"`, or a mix
`"8391,60000-60010"`. The `rr` field is the persisted round-robin cursor; the CLI
advances it so successive invocations spread load across the pool.

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
  --register-master 192.168.1.254 --ports 60000-62000
ombrain server status
```

**On any other server (no source — copy one file):**

```bash
scp /opt/om-brain/bin/ombrain.js /opt/om-brain/deploy/install-ombrain.sh root@HOST:/tmp/
ssh root@HOST 'sudo bash /tmp/install-ombrain.sh --standalone /tmp/ombrain.js \
  --register-master 192.168.1.254 --register-backup 192.168.1.239 --ports 60000-62000'
```

Installer options of note:

| Option | Purpose |
|--------|---------|
| `--register-master <host>` | Seed the registry master host |
| `--register-backup <host>` | Add a backup (repeatable) |
| `--ports <spec>` | Port pool for seeded hosts (default `60000-62000`) |
| `--standalone <file>` | Install a copy of `ombrain.js` (remote hosts) |
| `--url <url>` | Bake a default `OMBRAIN_URL` into `/etc/om-brain/ombrain.conf` |
| `--node <path>` | Explicit node path (sudo PATH safety) |
| `--prefix <dir>` | Launcher install dir (default `/usr/local/bin`) |
| `--uninstall` | Remove the command |

---

## Managing the registry at runtime

```bash
ombrain server list
ombrain server add master  192.168.1.254 --ports 60000-62000 --role master
ombrain server add backup1 192.168.1.239 --ports 60000-62000 --role backup --priority 10
ombrain server set-master backup1        # promote (demotes the old master)
ombrain server ports master 60000-61000  # replace a pool
ombrain server remove backup1
ombrain server status                     # probe each host's pool health
```

---

## Commands

```text
Core
  ombrain ask <query...>                 Ask anything; routed by the mode router
  ombrain health                         Service health (full JSON)
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

Servers (registry / topology)
  ombrain server list | add | set-master | ports | remove | status
```

### Global flags
`--url <url>`, `--server <name>`, `--quiet`, `--session <id>`, `--mode <mode>`,
`--timeout <ms>`, `-h/--help`, `-v/--version`.

---

## Examples

```bash
ombrain pascha 2026                       # 2026-04-12
ombrain saints 12 6 old 2026              # St. Nicholas -> Dec 19 N.S.
ombrain ask "what is theosis"             # -> mode: knowledge
ombrain ask "fleet health status"         # -> mode: technical
ombrain ask "restart nginx" --mode ops    # routed to governance, not executed
ombrain --url http://127.0.0.1:60000 health   # one explicit port, no failover
ombrain --server backup1 health           # target one named host's pool
```

---

## Network note

The Brain API binds to loopback by design. From the Brain host itself the pool is
directly reachable. From other hosts you need the pool reachable over the LAN
(bind/reverse-proxy the port range) or an SSH tunnel, then point `ombrain` at it
via the registry (`server add`) or `--url`. Use `ombrain server status` to confirm
reachability before relying on failover.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | usage / unknown command |
| 2 | HTTP 4xx/5xx from a reachable Brain |
| 3 | all endpoints unreachable (or master down for `server status`) |

Use `ombrain ping` in health checks: it exits `0` only when a Brain endpoint
responds `{ ok: true }`.
