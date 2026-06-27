#!/usr/bin/env bash
# deploy-litellm.sh — install LiteLLM proxy on auth01 (.254). Idempotent.
set -euo pipefail

ETC_DIR="/etc/litellm"
VENV_DIR="/opt/litellm-venv"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

echo "[litellm] ensuring venv at ${VENV_DIR}"
if [[ ! -d "${VENV_DIR}/bin" ]]; then
  python3 -m venv "${VENV_DIR}"
fi
"${VENV_DIR}/bin/pip" install -q --upgrade pip
# Minimal litellm (proxy extras pull orjson which fails on Python 3.14)
PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1 "${VENV_DIR}/bin/pip" install -q litellm

mkdir -p "${ETC_DIR}"
install -m 0644 "${SRC}/config.yaml" "${ETC_DIR}/config.yaml"

if [[ ! -f "${ETC_DIR}/litellm.env" ]]; then
  echo "[litellm] creating ${ETC_DIR}/litellm.env — ADD OPENROUTER_API_KEY"
  printf '%s\n' '# OPENROUTER_API_KEY=sk-or-v1-...' > "${ETC_DIR}/litellm.env"
  chmod 600 "${ETC_DIR}/litellm.env"
  chown next:next "${ETC_DIR}/litellm.env"
else
  echo "[litellm] keeping existing ${ETC_DIR}/litellm.env"
fi

cat > /etc/systemd/system/litellm.service <<EOF
[Unit]
Description=LiteLLM Proxy Service (Brain external model gateway)
After=network.target

[Service]
User=next
Group=next
EnvironmentFile=${ETC_DIR}/litellm.env
ExecStart=${VENV_DIR}/bin/litellm --config ${ETC_DIR}/config.yaml --port 4000 --host 127.0.0.1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable litellm

if grep -q '^OPENROUTER_API_KEY=sk-' "${ETC_DIR}/litellm.env" 2>/dev/null; then
  systemctl restart litellm
  echo "[litellm] started (API key present)"
else
  echo "[litellm] SKIPPED start — set OPENROUTER_API_KEY in ${ETC_DIR}/litellm.env"
fi
