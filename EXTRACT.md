# Extract provenance — v1.0.0

OMBrain was split out of [omrecords82/omai](https://github.com/omrecords82/omai)
so it can follow its own versioned SDLC on omdev (192.168.1.254).

| Field | Value |
|-------|--------|
| OMAI `origin/main` | `d1c9edcc9f75d6f4f142a0837fe38f62ac72c6e9` |
| Last `om-brain/` commit on that tip | `e45ad64` — durable notification evidence, receipt parser, deploy drift |
| `git subtree split -P om-brain` tip | `2b2fb8d5ba78a6ea14ea03bb14eabee33054bd29` |
| `git subtree split -P om-brain-console` tip | `f3901a842f97e0b7f6359f1a398e3c467dc9bec3` |
| Left in OMAI (not this repo) | `packages/omstudio-brain-governance`, `docs/om-brain/`, OMAI `/api/brain` adapters |
| OMAI copies | Parked in place. Not deleted. |

`om-brain-console/` in this repository is the operator UI. Runtime on `.254`
still lives at `/opt/om-brain-console`.
