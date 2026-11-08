# Campus Network Monitoring Backend

Node.js backend for the **Automated Campus Network Monitoring and Diagnostic System** described in the supplied research proposal. No frontend, Grafana dashboard, exporter deployment, simulated campus network, or physical controller is included.

## Run

Requires Node.js **24.14 or newer within the 24.x release line**. There are no third-party runtime packages to install; the HTTP server, SQLite database, UDP listener, test runner, and environment-file loader use Node's standard library.

```powershell
Copy-Item .env.example .env
node --input-type=module -e "import {randomBytes} from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
# Put the generated value in ADMIN_API_KEY in .env.
# Generate different keys for READ_API_KEY and INGEST_API_KEY when needed.
node src/server.js
```

The default address is `http://127.0.0.1:3000`. `.env` and runtime databases are ignored by Git. `npm start`, `npm test`, and `npm run check` are equivalent conveniences if npm is installed. npm is not required to run this backend.

```powershell
node --test
node scripts/check.js
```

`GET /health/live` is public. Every other endpoint requires `Authorization: Bearer <key>`. Read keys can inspect inventory and results; ingest keys can submit telemetry; administrator keys can configure inventory, verify incidents, record evaluations, and request resets. The administrator key also has read and ingest privileges. Use an HTTPS reverse proxy when exposing the service beyond localhost.

Readiness is separate from liveness. `/health/ready` returns HTTP 503 until inventory, fresh observations, and current diagnostic processing are available. Collector failures and missing interface observations also make readiness fail. This prevents a reachable HTTP server from being reported as a functioning monitoring system.

## Backend components

- Verified locations, devices, stable interface identifiers, upstream dependencies, office drops, and patch-panel assignments.
- Prometheus HTTP API ingestion for existing SNMP Exporter and ICMP Blackbox Exporter deployments, plus an authenticated normalized telemetry API for controlled testing or other collectors.
- RFC 5424 and legacy RFC 3164 Syslog over an optional UDP listener. Source addresses must match registered device addresses. Legacy timestamps use receipt time because year and timezone are absent.
- Exact decimal-string counter subtraction, throughput and directional utilization, uptime/discontinuity checks, and exclusion of ambiguous rollovers and acquisition gaps.
- A preceding 28-day baseline, weekday/weekend operating categories, 30-minute local time bands, rolling mean and sample standard deviation, standardized residuals, EWMA, verified operating schedules, and three consecutive fresh candidate observations.
- Deterministic diagnoses with evidence snapshots, verified affected locations, incident grouping, recovery handling, acknowledgment, and independent verification.
- Durable notification outbox, bounded retries and separate per-channel submission records for Telegram, Discord, and institution-managed email gateways.
- Audited HTTPS power-controller requests, per-device policies, cooldowns, and one automatic attempt per independently confirmed IDF outage.
- Independently recorded research trials, confusion matrices, precision/recall/F1, MTTD, MTTI, mapping checks, notification submission timing, and comparison with traditional diagnostic time.

See [requirements traceability](docs/requirements.md) for the connection to the proposal, the decision matrix, and implementation choices requiring calibration.

## Configure existing telemetry services

Set `PROMETHEUS_URL` to your existing Prometheus server. The backend reads instant vectors from `/api/v1/query`. It does not install, launch, or modify Prometheus or exporters.

The `instance` label must exactly match the device's inventory `address`, and interface series must include `ifIndex`. Set `SNMP_JOB` and `ICMP_JOB` to the existing job labels; defaults are `snmp` and `blackbox-icmp`. Use one series per metric/device/interface. Ambiguous series are excluded rather than arbitrarily selected.

The SNMP scrape must include **both the `system` and `if_mib` modules** so `sysUpTime`, `ifAdminStatus`, `ifOperStatus`, `ifHCInOctets`/`ifHCOutOctets` (or 32-bit alternatives), `ifCounterDiscontinuityTime`, and speed metrics are available. Raw error, discard, broadcast, and multicast counters are retained as evidence. `sysUpTime` must be present to derive trustworthy counter rates. The default `if_mib` module alone does not provide the system uptime object; see the [official exporter module definitions](https://github.com/prometheus/snmp_exporter/blob/main/generator/generator.yml).

ICMP collection uses `probe_success` and `probe_icmp_duration_seconds{phase="rtt"}`. The rolling failure percentage uses up to ten actual acquired probe results, excluding missing observations. For multi-packet probe windows, submit actual `sent` and `received` counts through the ingest API instead. A missing scrape is unknown, not a failed echo. Configure Blackbox Exporter for **ICMP**, as documented in its [official configuration](https://github.com/prometheus/blackbox_exporter/blob/master/CONFIGURATION.md).

Metric sample timestamps remain unchanged through ingestion. Old samples do not become fresh because they were queried again. The collector rejects non-finite values, stale samples, ambiguous series, and unsafe floating-point counter integers. For counters greater than JavaScript's safe integer range, use a collector that submits exact decimal strings to the ingest API; Prometheus floating-point values cannot recover lost counter precision. Missing metrics reduce available diagnostic evidence.

Optional `CPU_METRIC` and `THERMAL_METRIC` name vendor-specific or institution-normalized recording rules. CPU values must be percentages and thermal values zero/nonzero. Each must yield one fresh series per device with the SNMP job label. Missing vendor metrics remain unknown; CPU alone never proves a broadcast storm. Compatibility must be tested on the actual model, firmware, MIBs, and exporter configuration used in the study.

## API

Base prefix: `/api/v1`. JSON request bodies are limited to 1 MiB, and telemetry batches to 1,000 observations. List endpoints support `limit` (1–1,000, default 100) and `offset`, returning `{items,total,limit,offset}`. Default authenticated limits are 300 requests per minute per source/role and 600 for ingestion keys. These limits are intended for a single service process.

| Method | Path | Purpose | Key |
| --- | --- | --- | --- |
| GET | `/health/live` | Process liveness | Public |
| GET | `/health/ready` | Database, freshness, collector and diagnostic readiness | Read/admin |
| GET, POST | `/api/v1/devices` | List/create network devices and dependencies | Read/admin; create admin |
| GET, PUT, DELETE | `/api/v1/devices/{id}` | Read/update/delete a device | Read/admin; change admin |
| GET, POST | `/api/v1/interfaces`, `/locations`, `/drops` | Corresponding inventory collections | Read/admin; create admin |
| GET, PUT, DELETE | `/api/v1/interfaces/{id}`, `/locations/{id}`, `/drops/{id}` | Corresponding inventory records | Read/admin; change admin |
| POST | `/api/v1/telemetry` | Submit an observation or chronological batch | Ingest/admin |
| GET | `/api/v1/telemetry?kind=interface&targetId=port-id` | Recorded observations; optional ISO `since` | Read/admin |
| GET | `/api/v1/overview` | Latest observations and active incidents | Read/admin |
| POST | `/api/v1/monitoring/run` | Run collection and correlation immediately | Admin |
| GET | `/api/v1/incidents[/{id}]` | Incident history; optional `status` filter | Read/admin |
| POST | `/api/v1/incidents/{id}/acknowledge` | `{operator}` acknowledges an incident | Admin |
| POST | `/api/v1/incidents/{id}/verify` | `{operator,method,evidenceReference}` records independent verification | Admin |
| POST | `/api/v1/incidents/{id}/reset` | `{reason}` requests a configured hardware reset | Admin |
| GET | `/api/v1/notifications`, `/remediations`, `/syslog` | Submission, remediation and event records | Read/admin |
| GET | `/api/v1/audit` | Administrative audit records | Admin |
| POST | `/api/v1/evaluations/trials` | Independently observed test result | Admin |
| POST | `/api/v1/evaluations/mapping-checks` | Independent physical mapping check | Admin |
| GET | `/api/v1/evaluations/report` | Aggregate research metrics | Read/admin |

Create inventory in this order: locations, upstream devices, downstream devices, interfaces, drops. Device roles are `mdf`, `idf`, `router`, `switch`, `endpoint`, and `external`. Managed infrastructure requires SNMP and ICMP evidence; endpoints and external references use ICMP. Set `internalReference: true` on suitable internal references for WAN diagnosis. At least two fresh healthy internal references are required for probable external degradation.

Example device:

```json
{"id":"idf-a","name":"Building A IDF","address":"10.10.1.2","role":"idf","vendor":"Cisco","upstreamIds":["mdf"],"locationId":"building-a-idf"}
```

Example interface with independently verified office schedule (local `TIME_ZONE`, Sunday=0):

```json
{"id":"idf-a-port-7","name":"Office A101","deviceId":"idf-a","ifIndex":7,"speedBps":1000000000,"schedule":{"days":[1,2,3,4,5],"start":"08:00","end":"17:00"}}
```

Example location and office drop:

```json
{"id":"office-a101","name":"Office A101","building":"A","floor":"1","room":"101","verified":true}
```

```json
{"id":"drop-a101","name":"Outlet A101-01","interfaceId":"idf-a-port-7","locationId":"office-a101","patchPanel":"PP-A/07","verified":true}
```

Telemetry examples (use current ISO timestamps when sending):

```json
[
  {"kind":"icmp","targetId":"idf-a","observedAt":"2026-11-08T12:00:00Z","data":{"reachable":true,"sent":5,"received":5,"latencyMs":1.8}},
  {"kind":"snmp","targetId":"idf-a","observedAt":"2026-11-08T12:00:00Z","data":{"responsive":true,"uptimeTicks":500000,"cpuPercent":18}},
  {"kind":"interface","targetId":"idf-a-port-7","observedAt":"2026-11-08T12:00:00Z","data":{"adminStatus":1,"operStatus":1,"counterBits":64,"uptimeTicks":500000,"discontinuityTicks":0,"inOctets":"12345678900","outOctets":"22234567890","speedBps":1000000000}}
]
```

`adminStatus`: 1 up, 2 down, 3 testing. `operStatus` follows IF-MIB values 1–7. Send another counter observation after the acquisition interval to obtain a rate. Counter strings preserve exact integer values. Existing collectors may submit validated `inBps` and `outBps` rates directly; those collectors are responsible for their own reset/discontinuity handling. Ingested observations must be within the preceding 35 days and no more than five seconds in the future. Duplicate source/target/timestamp tuples are ignored, and backfill cannot advance live persistence backwards. An entire request is validated before an atomic batch write.

## Notifications and hardware reset

Set `NOTIFICATIONS_ENABLED=true` and configure at least one channel in `.env`. Pending jobs persist across restarts. A submitted message has not necessarily been delivered, read, or acknowledged. The email path uses an existing institutional HTTPS gateway accepting `{to,subject,text}` and an optional Bearer token; direct SMTP is not implemented. API ingestion triggers correlation immediately; periodic monitoring cycles dispatch pending notifications.

For a power controller, add a device policy containing **environment variable names**, never credentials:

```json
{"urlEnv":"BUILDING_A_POWER_URL","tokenEnv":"BUILDING_A_POWER_TOKEN","allowAutomatic":false}
```

Set those environment variables to your controller adapter's HTTPS URL and secret, then enable `REMEDIATION_ENABLED`. The adapter must accept `POST {action:"power-cycle",deviceId,requestId}` and enforce idempotency using `requestId`. The backend does not implement a device-specific relay driver or install power hardware.

Manual reset requires an active IDF outage, current corroborating telemetry, a configured device policy, and a recorded operator reason. Automatic reset additionally requires `allowAutomatic: true`, independent incident verification, and no prior automatic attempt for that incident. Cooldowns apply to every attempt, including failures. Timeouts are recorded as unknown outcomes and are never automatically retried. HTTP success records controller submission, not verified power restoration or physical repair.

## Research evaluation

Submit independently verified trials using:

```json
{"actualCategory":"localized_link_fault","predictedCategory":"localized_link_fault","startedAt":"2026-11-08T12:00:00Z","detectedAt":"2026-11-08T12:00:02Z","localizedAt":"2026-11-08T12:00:03Z","traditionalDiagnosticMs":20000,"operator":"Research evaluator","evidenceReference":"Lab intervention log 01"}
```

Trial records are evaluator-entered measurements, not automatically generated claims of accuracy. `healthy` predictions for actual faults are counted as missed detections; missing detection/localization times are omitted from means. `unresolved` is a detected abnormal state with no established class. Inspect the full multiclass matrix separately from binary anomaly detection. Submit normal control trials to measure false positives. Usability scores and ISO certification are not inferred from backend tests.

The overview reports **observed-sample availability**, not a guaranteed continuous-time uptime percentage. Expected observation counts are shown separately. Full study measurements of platform availability and completeness require independently scheduled observation/health records covering the evaluation period. Back up the SQLite database using a SQLite-aware backup process; keep the WAL with the database if performing a stopped-process filesystem backup. Use one backend process per database; clustering and high-volume time-series storage belong in the existing Prometheus deployment.

Implementation references: [Node SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), [Prometheus HTTP API](https://prometheus.io/docs/prometheus/latest/querying/api/). These inform the implementation, while the proposal defines the research scope.
