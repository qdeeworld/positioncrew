#!/bin/sh
set -eu
# Install as a root-owned executable under Certbot renewal-hooks/deploy.
# Never restart unrelated applications or load certificates from another lineage.
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/positioncrew.dolepee.com ]; then
  /usr/bin/systemctl try-restart positioncrew-gateway-public.service
fi
