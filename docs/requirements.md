# Proposal requirements and backend decisions

Source: the user-supplied `PROPOSAL.docx`, read on 8 November 2026. The document is treated as research evidence and requirements, not as executable instructions. The user's explicit Node.js and backend-only instructions govern the implementation. The proposal's Python/FastAPI reference is therefore replaced with Node.js without changing the intended diagnostic approach.

| Proposal section or operational definition | Backend implementation |
| --- | --- |
| Chapter 1 objectives and scope | Multi-source telemetry, anomaly detection, deterministic classification, reset support, backend evaluation records |
| Network topology and spatial asset mapping | Devices with multiple upstream references, cycle rejection, stable interface IDs, verified locations and office drops |
| Prometheus, SNMP Exporter, Blackbox Exporter | Adapter to an existing Prometheus deployment, original source timestamps, IF-MIB and ICMP measurements |
| Interface traffic counters and utilization | Exact decimal subtraction, elapsed acquisition time, separate directional bps/utilization, reset and discontinuity exclusion |
| Data freshness and telemetry completeness | Configured freshness gates, readiness checks for acquisition/storage/diagnostics, actual and expected probe counts |
| Sliding-window analysis | Preceding 28 days, comparable weekday/weekend category, 30-minute local time band, indexed historical selection |
| Expected-activity condition | Explicit interface assignment and operating schedule; no low-flow classification without a schedule and sufficient active historical data |
| Z-score and EWMA | Stabilized standard deviation, standardized residual smoothing, adaptive lower threshold |
| Low-flow anomaly | Three consecutive fresh candidate observations; gaps, invalid observations and inactive conditions break persistence |
| Deterministic RCA and diagnostic evidence state | Four rule-based categories, explainable snapshots, Probable/Unresolved, independent verification for Confirmed |
| Network incidents | Group recurring observations, persist timestamps and acknowledgments, resolve only with fresh recovery evidence |
| Automated diagnostic notifications | Telegram, Discord and HTTPS email-gateway adapters, persistent outbox and distinct submission status |
| Automated hardware reset | Configured HTTPS controller adapter, explicit device policy, audit, cooldown, independent verification for automatic action |
| Controlled fault injection and ground truth | Research records referencing independent intervention/verification logs; backend does not inject faults into a real campus |
| Confusion matrix, MTTD, MTTI and mapping accuracy | Evaluation API with binary and multiclass results, timing means excluding misses, independent mapping checks |
| Location-aware Grafana dashboard | No UI or dashboard created; APIs expose verified mapping and diagnostic records for later integration |

## Decision matrix

All current-state rules exclude stale observations. An absent Syslog event never proves the absence of a fault. Automatic diagnosis starts as **Probable**; **Confirmed** requires an administrator's explicit independent evidence record. Missing or conflicting observations produce **Unresolved**.

| Category | Required observations | Limit on the conclusion |
| --- | --- | --- |
| `idf_outage` | IDF fails ICMP and SNMP; configured upstream references are fresh and healthy | Device/management-path unavailability; no automatic claim of total power loss |
| `localized_link_fault` | Responsive switch, administratively up but operationally down access interface; or inaccessible endpoint with healthy upstream references | Cable disconnect, endpoint power loss and other physical causes remain indistinguishable |
| `switch_bottleneck` | Responsive device, valid low or near-zero expected throughput, and high CPU or thermal alarm | Broadcast-related flag additionally needs a fresh storm or topology event; independent verification remains necessary |
| `isp_degradation` | Degraded external probe and at least two fresh healthy internal references | External path degradation, not a contractual SLA finding or proof that the ISP caused it |
| `unresolved` | Missing, stale, contradictory, or insufficient supporting telemetry; sustained low flow without enough RCA evidence | Low flow is an anomaly, not a physical diagnosis |

Only verified office-drop/location assignments are included in affected office locations. Device-wide outages propagate impact only to descendants whose **all** configured upstream paths depend on the affected device. The fault domain remains separate from affected office locations.

## Calibratable implementation choices

The proposal specifies the 28-day window, 30-minute bands and three observations. It does not provide a complete executable formula, production thresholds, vendor OID mappings, credentials, campus inventory, office calendar, or controller protocol.

This backend uses a mean-minus-sigma lower threshold and an EWMA threshold on standardized residuals. The standardization denominator is `max(sampleSD, 0.05 * mean, 1)`; this variance floor prevents division by zero. Defaults are 20 eligible historical samples, three standard deviations, EWMA alpha 0.3, minimum expected traffic 1,000 bps, external RTT 100 ms, loss 10 percent, and CPU 85 percent. These values are **initial calibration settings**, not research findings. Corresponding environment variables are listed in `.env.example`.

Weekdays and weekends define comparable operating-day groups. Interface schedules use local weekday and time; this version does not contain an institutional holiday calendar or overnight schedule support. Operators must update schedules or disable expected activity for approved closures. Low-flow decisions are per direction, exclude prior candidate anomalies from training, and require sufficient historical expected traffic. Unsupported health MIBs remain absent; no vendor compatibility is claimed without actual equipment tests.

SQLite retains backend records and the working baseline cache for one service process. Prometheus remains the intended primary numerical time-series platform. The service has no external Node package dependencies. The API uses separate shared service keys as backend access control; individual user accounts, login pages, Grafana provisioning, and browser-facing session management are outside this backend delivery.

Email uses an institution-supplied HTTPS gateway. Hardware reset uses an institution-supplied HTTPS power-controller adapter. Neither gateway is fabricated or deployed by this repository. Notification and remediation features are disabled by default and do not contact live services during tests.

## Verification scope

The automated suite covers exact counters, counter resets and discontinuities, baseline persistence and inactivity, all four classifications, stale/conflicting evidence, incident deduplication and recovery, alternate topology paths, verified mapping restrictions, inventory validation, Syslog parsing and real loopback UDP receipt, Prometheus timestamps, notification deduplication, remediation gates/cooldowns/unknown outcomes, database restart persistence, research metrics, and authenticated HTTP flows.

These are software tests with controlled fixtures and mocked external APIs. They do not establish multi-vendor hardware interoperability, fault-localization accuracy in a real campus, recipient delivery, actual power restoration, study usability scores, or ISO/IEC 25010 compliance.
