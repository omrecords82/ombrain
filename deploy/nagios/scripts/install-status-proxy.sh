#!/usr/bin/env bash
# Install local authenticated statusjson proxy on om-dev (127.0.0.1:18080).
# Does NOT broaden Nagios exposure. Does NOT print secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ETC=/etc/om-brain
PASS_FILE="${ETC}/nagios-status.password"
HTPASSWD_FILE="${ETC}/nagios-status.htpasswd"
USER_NAME="${NAGIOS_STATUS_USER:-ombrain-nagios-ro}"
NGINX_AVAIL=/etc/nginx/sites-available/nagios-status-proxy.conf
NGINX_ENABLED=/etc/nginx/sites-enabled/nagios-status-proxy.conf

if [[ "${EUID}" -ne 0 ]]; then
  echo "must run as root" >&2
  exit 1
fi

mkdir -p "${ETC}"
install -m 0644 "${ROOT}/proxy/nagios-status-proxy.conf" "${NGINX_AVAIL}"
ln -sfn "${NGINX_AVAIL}" "${NGINX_ENABLED}"

if [[ ! -f "${PASS_FILE}" ]]; then
  umask 077
  openssl rand -base64 24 | tr -d '\n' > "${PASS_FILE}"
  chown root:om-brain "${PASS_FILE}"
  chmod 640 "${PASS_FILE}"
  echo "created ${PASS_FILE} (mode 640, group om-brain)"
fi

PASS="$(tr -d '\n' < "${PASS_FILE}")"
if command -v htpasswd >/dev/null 2>&1; then
  htpasswd -bb -c "${HTPASSWD_FILE}" "${USER_NAME}" "${PASS}" >/dev/null
else
  # openssl passwd APR1 fallback
  HASH="$(openssl passwd -apr1 "${PASS}")"
  printf '%s:%s\n' "${USER_NAME}" "${HASH}" > "${HTPASSWD_FILE}"
fi
chown root:www-data "${HTPASSWD_FILE}"
chmod 640 "${HTPASSWD_FILE}"
unset PASS

nginx -t
systemctl reload nginx

# Point om-brain at the proxy (do not overwrite unrelated env keys)
ENV_FILE="${ETC}/om-brain.env"
if [[ -f "${ENV_FILE}" ]]; then
  grep -q '^BRAIN_NAGIOS_STATUSJSON_URL=' "${ENV_FILE}" \
    && sed -i 's|^BRAIN_NAGIOS_STATUSJSON_URL=.*|BRAIN_NAGIOS_STATUSJSON_URL=http://127.0.0.1:18080/nagios4/cgi-bin/statusjson.cgi|' "${ENV_FILE}" \
    || echo 'BRAIN_NAGIOS_STATUSJSON_URL=http://127.0.0.1:18080/nagios4/cgi-bin/statusjson.cgi' >> "${ENV_FILE}"
  grep -q '^BRAIN_NAGIOS_STATUS_USER=' "${ENV_FILE}" \
    && sed -i "s|^BRAIN_NAGIOS_STATUS_USER=.*|BRAIN_NAGIOS_STATUS_USER=${USER_NAME}|" "${ENV_FILE}" \
    || echo "BRAIN_NAGIOS_STATUS_USER=${USER_NAME}" >> "${ENV_FILE}"
  grep -q '^BRAIN_NAGIOS_STATUS_PASSWORD_FILE=' "${ENV_FILE}" \
    && sed -i "s|^BRAIN_NAGIOS_STATUS_PASSWORD_FILE=.*|BRAIN_NAGIOS_STATUS_PASSWORD_FILE=${PASS_FILE}|" "${ENV_FILE}" \
    || echo "BRAIN_NAGIOS_STATUS_PASSWORD_FILE=${PASS_FILE}" >> "${ENV_FILE}"
  grep -q '^BRAIN_NAGIOS_AUTH_REQUIRED=' "${ENV_FILE}" \
    && sed -i 's|^BRAIN_NAGIOS_AUTH_REQUIRED=.*|BRAIN_NAGIOS_AUTH_REQUIRED=true|' "${ENV_FILE}" \
    || echo 'BRAIN_NAGIOS_AUTH_REQUIRED=true' >> "${ENV_FILE}"
fi

echo "proxy installed on 127.0.0.1:18080; restart om-brain to pick up env"
