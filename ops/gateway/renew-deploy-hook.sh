#!/bin/sh
set -eu
# Install as a root-owned executable under Certbot renewal-hooks/deploy.
# Never restart unrelated applications or load certificates from another lineage.
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/positioncrew.dolepee.com ]; then
  stage=$(/usr/bin/mktemp -d /etc/positioncrew-gateway/.renew.XXXXXXXX)
  trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
  /usr/bin/install -o root -g pc-gateway -m 440 "$RENEWED_LINEAGE/privkey.pem" "$stage/privkey.pem"
  /usr/bin/install -o root -g pc-gateway -m 440 "$RENEWED_LINEAGE/fullchain.pem" "$stage/fullchain.pem"
  /usr/bin/mv -f "$stage/privkey.pem" /etc/positioncrew-gateway/privkey.pem
  /usr/bin/mv -f "$stage/fullchain.pem" /etc/positioncrew-gateway/fullchain.pem
  /usr/bin/systemctl try-restart positioncrew-gateway-public.service
fi
