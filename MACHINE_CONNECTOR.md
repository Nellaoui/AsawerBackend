# Asawer office machine connector

The hosted API cannot directly reach printer addresses such as `192.168.1.103`. The connector runs on one Windows computer that stays on the workshop network and reports only whether each registered printer answers a network check. A ping reply means the device is reachable; it does not prove the printer is ready, printing successfully, or accepting jobs.

## Registered printers

| Code | Machine | IP address | MAC address | Route |
| --- | --- | --- | --- | --- |
| `WAX-FF-01` | FlashForge WaxJet510 · `W51E9300086` | `192.168.1.103` | `00:E0:4C:9A:22:F1` | Wax |
| `WAX-FF-02` | FlashForge W510 · `W51E9300082` | `192.168.1.227` | `00:E0:4C:9A:17:1F` | Wax |
| `WAX-FF-03` | FlashForge WaxJet510 · `W51E9300075` | `192.168.1.123` | `00:E0:4C:9A:24:6B` | Wax |
| `WAX-3DS-01` | 3D Systems ProJet MJP 2500W · `3010F475311` | `192.168.1.62` | `00:04:5F:46:27:64` | Wax |
| `RESIN-RS-01` | Rapid Shape S50+ · `222R142766` | `192.168.1.28` | `DC:2C:6E:21:D2:33` | Resin |
| `RESIN-RS-02` | Rapid Shape S50+ · `224R157774` | `192.168.1.26` | `DC:2C:6E:21:D6:D2` | Resin |

Reserve these IP/MAC pairs in the router before relying on automatic monitoring.

## Configuration

1. Create one long random secret. Never send it in chat or commit it to Git.
2. Set `MACHINE_CONNECTOR_TOKEN` to that secret on the backend host.
3. On the always-on workshop computer, set the same `MACHINE_CONNECTOR_TOKEN` and set `ASAWER_API_BASE_URL` to the backend URL ending in `/api`.
4. From the `backend` directory, run `npm run machines:connector`.

Optional: set `MACHINE_CONNECTOR_INTERVAL_MS`. The minimum is 10 seconds and the default is 30 seconds.

The connector does not submit print files, read the manufacturer's print queue, or control a machine. Employees use the manufacturer's software to start prints, then select the machine in the Asawer workflow so the portal can show the task they recorded. A machine's network observation becomes stale after 90 seconds without a connector report and should then be treated as unknown.
