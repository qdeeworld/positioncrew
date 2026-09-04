#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' "install-positioncrew-termix-orders.sh must run as root" >&2
  exit 1
fi

release_root=${1:-/home/crosswind/apps/positioncrew}
artifact_root=/opt/positioncrew-termix-orders
session_renewer_artifact_root=/opt/positioncrew-termix-session-renew
observer_source=${release_root}/dist/runtime/watch-termix-orders.mjs
notifier_source=${release_root}/dist/runtime/notify-termix-orders.mjs
session_renewer_source=${release_root}/dist/termix-session-renew/renew-termix-session-token.mjs
owner_key=/etc/positioncrew-runtime/credentials/dedicated-lending.owner-key
session_token=/var/lib/positioncrew-termix-session-renew/termix-session.token

preflight_root_secret() {
  secret_path=$1
  secret_label=$2
  if [ ! -f "${secret_path}" ] || [ -L "${secret_path}" ] || [ ! -s "${secret_path}" ]; then
    printf '%s\n' "${secret_label} must be a non-empty regular file, not a symlink" >&2
    exit 1
  fi
  secret_metadata=$(/usr/bin/stat -c '%u:%g:%a' -- "${secret_path}")
  case "${secret_metadata}" in
    0:0:400|0:0:600) ;;
    *)
      printf '%s\n' "${secret_label} must be owned by root:root with mode 0400 or 0600" >&2
      exit 1
      ;;
  esac
}

preflight_renewed_session_token() {
  if [ ! -f "${session_token}" ] || [ -L "${session_token}" ] || [ ! -s "${session_token}" ]; then
    printf '%s\n' "TermiX session renewal did not produce a protected token" >&2
    exit 1
  fi
  session_metadata=$(/usr/bin/stat -c '%U:%G:%a' -- "${session_token}")
  if [ "${session_metadata}" != "positioncrew-session-renew:positioncrew-session-renew:600" ]; then
    printf '%s\n' "TermiX session token must be owned by positioncrew-session-renew with mode 0600" >&2
    exit 1
  fi
}

preflight_root_secret "${owner_key}" "TermiX owner key"

for required_file in \
  "${observer_source}" \
  "${notifier_source}" \
  "${session_renewer_source}" \
  "${release_root}/deploy/sysusers.d/positioncrew-termix-orders.conf" \
  "${release_root}/deploy/sysusers.d/positioncrew-termix-session-renew.conf" \
  "${release_root}/deploy/tmpfiles.d/positioncrew-termix-orders.conf" \
  "${release_root}/deploy/systemd/positioncrew-termix-orders.service" \
  "${release_root}/deploy/systemd/positioncrew-termix-orders.service.d/zzzz-load-credential.conf" \
  "${release_root}/deploy/systemd/positioncrew-termix-orders.timer" \
  "${release_root}/deploy/systemd/positioncrew-termix-order-alert.service" \
  "${release_root}/deploy/systemd/positioncrew-termix-order-alert.path" \
  "${release_root}/deploy/systemd/positioncrew-termix-session-renew.service" \
  "${release_root}/deploy/systemd/positioncrew-termix-session-renew.timer" \
  "${release_root}/deploy/systemd/positioncrew-termix-session-renew.service.d/zzzz-load-credential.conf"
do
  if [ ! -s "${required_file}" ]; then
    printf '%s\n' "Missing required deployment file: ${required_file}" >&2
    exit 1
  fi
done

/usr/bin/install -d -o root -g root -m 0755 /etc/sysusers.d
/usr/bin/install -T -o root -g root -m 0644 \
  "${release_root}/deploy/sysusers.d/positioncrew-termix-orders.conf" \
  /etc/sysusers.d/positioncrew-termix-orders.conf
/usr/bin/install -T -o root -g root -m 0644 \
  "${release_root}/deploy/sysusers.d/positioncrew-termix-session-renew.conf" \
  /etc/sysusers.d/positioncrew-termix-session-renew.conf
/usr/bin/systemd-sysusers \
  /etc/sysusers.d/positioncrew-termix-orders.conf \
  /etc/sysusers.d/positioncrew-termix-session-renew.conf

/usr/bin/install -d -o root -g root -m 0755 "${session_renewer_artifact_root}"
/usr/bin/install -d -o root -g root -m 0755 /etc/systemd/system
/usr/bin/install -T -o root -g root -m 0555 \
  "${session_renewer_source}" \
  "${session_renewer_artifact_root}/renew-termix-session-token.mjs"
/usr/bin/install -T -o root -g root -m 0644 \
  "${release_root}/deploy/systemd/positioncrew-termix-session-renew.service" \
  /etc/systemd/system/positioncrew-termix-session-renew.service
/usr/bin/install -d -o root -g root -m 0755 \
  /etc/systemd/system/positioncrew-termix-session-renew.service.d
/usr/bin/install -T -o root -g root -m 0644 \
  "${release_root}/deploy/systemd/positioncrew-termix-session-renew.service.d/zzzz-load-credential.conf" \
  /etc/systemd/system/positioncrew-termix-session-renew.service.d/zzzz-load-credential.conf

/usr/bin/systemctl daemon-reload
/usr/bin/systemctl start positioncrew-termix-session-renew.service
preflight_renewed_session_token

/usr/bin/install -d -o root -g root -m 0755 "${artifact_root}"
/usr/bin/install -d -o root -g root -m 0755 /etc/tmpfiles.d
/usr/bin/install -T -o root -g root -m 0555 \
  "${observer_source}" \
  "${artifact_root}/watch-termix-orders.mjs"
/usr/bin/install -T -o root -g root -m 0555 \
  "${notifier_source}" \
  "${artifact_root}/notify-termix-orders.mjs"
/usr/bin/install -T -o root -g root -m 0644 \
  "${release_root}/deploy/tmpfiles.d/positioncrew-termix-orders.conf" \
  /etc/tmpfiles.d/positioncrew-termix-orders.conf
/usr/bin/systemd-tmpfiles --create /etc/tmpfiles.d/positioncrew-termix-orders.conf

for unit in \
  positioncrew-termix-orders.service \
  positioncrew-termix-orders.timer \
  positioncrew-termix-order-alert.service \
  positioncrew-termix-order-alert.path \
  positioncrew-termix-session-renew.timer
do
  /usr/bin/install -T -o root -g root -m 0644 \
    "${release_root}/deploy/systemd/${unit}" \
    "/etc/systemd/system/${unit}"
done

/usr/bin/install -d -o root -g root -m 0755 \
  /etc/systemd/system/positioncrew-termix-orders.service.d
/usr/bin/install -T -o root -g root -m 0644 \
  "${release_root}/deploy/systemd/positioncrew-termix-orders.service.d/zzzz-load-credential.conf" \
  /etc/systemd/system/positioncrew-termix-orders.service.d/zzzz-load-credential.conf

/usr/bin/systemctl daemon-reload
/usr/bin/systemctl enable --now \
  positioncrew-termix-orders.timer \
  positioncrew-termix-order-alert.path \
  positioncrew-termix-session-renew.timer
