# Bounded access gateway

This Node 22 service provides a fixed upstream route to the existing Sites
application. It does not migrate data or repair the managed origin's browser
signature policy. Its honest upstream User-Agent identifies the gateway.

The application must have the trusted-gateway verifier and the matching
`TRUSTED_GATEWAY_HMAC_KEY` secret before this service can forward requests. The
secret is a randomly generated 64-character lowercase hexadecimal string; HMAC
uses its UTF-8 bytes. Keep it out of source, logs, argv and deployment archives.

The four `X-PositionCrew-Gateway-*` headers authenticate the socket-derived
client address, timestamp, exact method/path/query/body digest, Origin,
Authorization and Idempotency-Key. The Worker validates before canonicalizing
the URL and replacing the rate-limit client address. All normal authorization,
request idempotency, origin, observation and financial checks remain in force.
The envelope permits replay within its 60-second lifetime; it is not payment
authorization. No gateway request is automatically retried or redirected.

Run `npm run test:gateway`. The test-only factory permits an HTTP loopback
origin; the production CLI fixes the upstream and accepts no command arguments.

Staging uses `127.0.0.1:18741`, a dedicated protected key file and the supplied
dedicated `pc-gateway` systemd account. The health route reports process readiness only.
Use an SSH tunnel for staging access; no firewall or DNS change is needed.

Public binding requires both `GATEWAY_TLS_KEY_FILE` and
`GATEWAY_TLS_CERT_FILE`, plus an explicit `GATEWAY_HOST`/`GATEWAY_PORT`. Public
TLS requests must use the canonical Host. Configure certificate renewal and
the least required bind capability separately before exposing traffic. This
loopback unit intentionally grants no bind capability or public web port.

The separate `positioncrew-gateway-public.service` loads protected certificate
and private-key files and grants only the low-port bind
capability. It binds IPv4 port 443, requires the canonical Host (optionally
with explicit port 443), and bounds TLS handshakes to ten seconds. Install
`renew-deploy-hook.sh` root-owned in Certbot's deploy-hooks directory to reload
only this service after a successful renewal of the exact canonical lineage.
Create `pc-gateway` as a system account with no login, home or supplementary
groups. The configuration directory is root-owned, group `pc-gateway`, mode
750; its key and copied TLS files are root-owned, group `pc-gateway`, mode 440.
Code and units remain root-owned and unwritable by the service. This file-based
setup works on the target LXC host, whose global service drop-in clears
LoadCredential. Install `zzzz-positioncrew-hardening.conf` in each gateway
unit's `.service.d` directory to restore the three sandbox flags cleared by
that host-wide drop-in; verify the effective unit properties and process
`NoNewPrivs` after startup. Do not edit the global override. The account
has no access to the existing runtime accounts or their secrets.
Initial DNS validation can obtain the certificate before a traffic cutover.
After cutover, configure and test unattended HTTP-01 standalone renewal on
port 80; the initial manual DNS configuration alone is not auto-renewal.

Before cutover, validate signed Worker integration, separate client quotas,
forged-envelope refusals, mutation Origin checks, a harmless create/run/poll
assessment, historical receipt reload, TLS renewal, monitoring and rollback.
Retain the previous exact DNS record and Sites deployment. Preserve existing
runtime services and database bindings. A gateway failure must not trigger an
automatic replay of a possibly completed mutation.
