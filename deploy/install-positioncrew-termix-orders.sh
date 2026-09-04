#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' "install-positioncrew-termix-orders.sh must run as root" >&2
  exit 1
fi

release_root=${1:-/home/crosswind/apps/positioncrew}
artifact_root=/opt/positioncrew-termix-orders
observer_source=${release_root}/dist/runtime/watch-termix-orders.mjs
notifier_source=${release_root}/dist/runtime/notify-termix-orders.mjs

for required_file in \
  "${observer_source}" \
  "${notifier_source}" \
  "${release_root}/deploy/sysusers.d/positioncrew-termix-orders.conf" \
  "${release_root}/deploy/tmpfiles.d/positioncrew-termix-orders.conf" \
  "${release_root}/deploy/systemd/positioncrew-termix-orders.service" \
  "${release_root}/deploy/systemd/positioncrew-termix-orders.timer" \
  "${release_root}/deploy/systemd/positioncrew-termix-order-alert.service" \
  "${release_root}/deploy/systemd/positioncrew-termix-order-alert.path"
do
  if [ ! -s "${required_file}" ]; then
    printf '%s\n' "Missing required deployment file: ${required_file}" >&2
    exit 1
  fi
done

/usr/bin/install -d -o root -g root -m 0755 "${artifact_root}"
/usr/bin/install -T -o root -g root -m 0555 "${observer_source}" "${artifact_root}/watch-termix-orders.mjs"
/usr/bin/install -T -o root -g root -m 0555 "${notifier_source}" "${artifact_root}/notify-termix-orders.mjs"

/usr/bin/install -T -o root -g root -m 0644 \
  "${release_root}/deploy/sysusers.d/positioncrew-termix-orders.conf" \
  /etc/sysusers.d/positioncrew-termix-orders.conf
/usr/bin/systemd-sysusers /etc/sysusers.d/positioncrew-termix-orders.conf

/usr/bin/install -T -o root -g root -m 0644 \
  "${release_root}/deploy/tmpfiles.d/positioncrew-termix-orders.conf" \
  /etc/tmpfiles.d/positioncrew-termix-orders.conf
/usr/bin/systemd-tmpfiles --create /etc/tmpfiles.d/positioncrew-termix-orders.conf

for unit in \
  positioncrew-termix-orders.service \
  positioncrew-termix-orders.timer \
  positioncrew-termix-order-alert.service \
  positioncrew-termix-order-alert.path
do
  /usr/bin/install -T -o root -g root -m 0644 \
    "${release_root}/deploy/systemd/${unit}" \
    "/etc/systemd/system/${unit}"
done

/usr/bin/systemctl daemon-reload
/usr/bin/systemctl enable --now positioncrew-termix-orders.timer positioncrew-termix-order-alert.path
