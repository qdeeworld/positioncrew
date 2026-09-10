# Dedicated production runtimes

All four identities use owner `0xADd748C416E8A7efd7d65D18Abb121dea268ddF9` on BNB Chain (56). The original personal-wallet identities are historical and are not runtime dependencies.

| Service | systemd instance | Agent ID | Token ID |
| --- | --- | --- | --- |
| LENDING_RESCUE | `dedicated-lending` | `cmt4dzxvcli4tw70125nd5ra8` | 293111 |
| LP_REBALANCE | `dedicated-lp` | `cmtvave8t02wgw001wgg2ckgr` | 342734 |
| YIELD_OPTIMIZATION | `dedicated-yield` | `cmtvavee602wow001ob536zaf` | 342735 |
| BOUNDED_GRID | `dedicated-grid` | `cmtvavnib02y4w001uum4edob` | 342736 |

Each instance uses `positioncrew-runtime@INSTANCE.service` plus `positioncrew-runtime-renew@INSTANCE.timer`. The existing renewal binary verifies the owner address before signing the agent-scoped challenge. Its per-instance files are:

- `/etc/positioncrew-runtime/INSTANCE.env`: agent ID, service, API origin, poll interval and expected owner.
- `/etc/positioncrew-runtime/credentials/INSTANCE.owner-key`: root-only credential, hard-linked to the existing dedicated signer credential on this host; never available to the poller.
- `/etc/positioncrew-runtime/credentials/INSTANCE.token` and `INSTANCE.expiry.env`: agent-scoped token and verified expiry, written atomically by renewal.
- `/var/lib/positioncrew-runtime-INSTANCE/runtime.json`: independent inbox cursor and idempotency state.

The VPS's LXC drop-in clears `LoadCredential`, so each instance requires a later `zzzz-instance-credential.conf` drop-in to load only its own runtime token. The renewal instance similarly loads its owner credential. Runtime drop-ins include the matching expiry environment file. The runtime template and the three new instances use `StandardOutput=journal` and `StandardError=journal` so first start does not depend on a pre-existing log file. On the host, journald has `SystemMaxUse=1G` and `SystemKeepFree=4G`.

For a fresh installation from the repository templates, first stage the pinned runtime bundle using the build commands in `positioncrew-runtime@.service`; its root-owned installation and hash validation run before the poller starts. Each instance stages its own candidate file so concurrent starts cannot overwrite one another’s temporary artifact. Both runtime and renewal templates load the same `/etc/positioncrew-runtime/INSTANCE.env` file.

Enable the runtime unit, run its renewal service to issue the initial token and start the process, then enable its hourly renewal timer. Verify both the live agent card and service state. An online observation is not a continuous-uptime guarantee.

The order observer uses `TERMIX_AGENT_IDS` for these four IDs and a new `fleet-state.json` cursor. The older single-agent state is preserved. It only raises operator-attention events; it does not accept, deliver, settle or sign financial actions.
