# `ombrain` — system-wide command-line client

`ombrain` is a thin, zero-dependency HTTP client for the om-brain service. Once
installed it runs as a bare command (`ombrain ...`) from **any server** that can
reach the Brain. The host does **not** need the Brain source tree — only Node.js
and the single `bin/ombrain.js` file.

It is distinct from `bin/om-brain-cli.js`, which loads the Brain's modules
directly and therefore only works from inside the source tree on the Brain host.

---

## Install

### On the Brain host (source present, e.g. `/opt/om-brain`)
```bash
sudo bash deploy/install-ombrain.sh
# Symlinks the launcher at /usr/local/bin/ombrain to the source bin/ombrain.js,
# pinning the resolved node interpreter so it runs even under a sanitized PATH.
```

### On any other server (no source)
```bash
# 1. copy the single file over
scp om-brain/bin/ombrain.js you@server:/tmp/ombrain.js
scp om-brain/deploy/install-ombrain.sh you@server:/tmp/

# 2. install a standalone copy, baking in the Brain URL it should talk to
ssh you@server
sudo bash /tmp/install-ombrain.sh --standalone /tmp/ombrain.js --url http://<brain-host>:8390
```

### Options
| Flag | Meaning |
|------|---------|
| `--prefix <dir>` | Launcher install dir (default `/usr/local/bin`). |
| `--standalone <file>` | Install a copy of `ombrain.js` (remote hosts without source). |
| `--node <path>` | Use a specific node binary (skip auto-detect). |
| `--url <url>` | Bake a default `OMBRAIN_URL` into `/etc/om-brain/ombrain.conf`. |
| `--uninstall` | Remove the installed command. |

---

## Pointing it at a Brain

Base URL resolution (first match wins):

1. `--url <url>` flag
2. `$OMBRAIN_URL` environment variable
3. `/etc/om-brain/ombrain.conf` (sourced by the launcher, e.g. `OMBRAIN_URL=...`)
4. `http://127.0.0.1:8390` (the service default — loopback on the Brain host)

> The Brain binds to `127.0.0.1:8390`. From another machine, either install with
> `--url http://<brain-host>:8390`, set `OMBRAIN_URL`, or open an SSH tunnel:
> `ssh -N -L 8390:127.0.0.1:8390 <brain-host>` and use the default URL.

---

## Commands

```text
Core
  ombrain ask <query...>                 Ask anything; routed by the mode router
  ombrain health                         Service health (full JSON)
  ombrain ping                           Health as a script check (exit 0/1)
  ombrain classify <query...>            Show the routed mode without a full answer

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
  ombrain modes
```

### Global flags
`--url <url>`, `--session <id>`, `--mode <mode>`, `--timeout <ms>`, `--json`,
`-h/--help`, `-v/--version`.

---

## Examples
```bash
ombrain pascha 2026
ombrain saints 12 6 old 2026                 # St. Nicholas -> Dec 19 N.S.
ombrain ask "what is theosis" --session demo-1
ombrain ask "restart nginx" --mode ops       # routed to governance, not executed
ombrain --url http://10.0.0.254:8390 health
OMBRAIN_URL=http://127.0.0.1:8390 ombrain today
```

## Exit codes
| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | usage / unknown command |
| 2 | server returned 4xx/5xx (message includes the server's `error`) |
| 3 | could not reach the Brain (connection refused / timeout / DNS) |

Use `ombrain ping` in health checks: it exits `0` only when the Brain responds
`{ ok: true }`.
