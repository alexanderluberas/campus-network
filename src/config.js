import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

function integer(env, name, fallback, min = 1) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${name}`);
  return value;
}
function decimal(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function loadConfig(env = process.env) {
  const config = {
    host: env.HOST || '127.0.0.1', port: integer(env, 'PORT', 3000),
    databasePath: env.DATABASE_PATH || './data/campus.sqlite',
    adminKey: env.ADMIN_API_KEY || '', readKey: env.READ_API_KEY || '', ingestKey: env.INGEST_API_KEY || '',
    timeZone: env.TIME_ZONE || 'Asia/Manila',
    pollIntervalMs: integer(env, 'POLL_INTERVAL_MS', 30000),
    freshnessMs: integer(env, 'FRESHNESS_MS', 90000),
    prometheusUrl: env.PROMETHEUS_URL || '', prometheusToken: env.PROMETHEUS_BEARER_TOKEN || '',
    snmpJob: env.SNMP_JOB || 'snmp', icmpJob: env.ICMP_JOB || 'blackbox-icmp',
    cpuMetric: env.CPU_METRIC || '', thermalMetric: env.THERMAL_METRIC || '',
    syslogEnabled: env.SYSLOG_ENABLED === 'true', syslogHost: env.SYSLOG_HOST || '127.0.0.1',
    syslogPort: integer(env, 'SYSLOG_PORT', 5514),
    notificationsEnabled: env.NOTIFICATIONS_ENABLED === 'true',
    remediationEnabled: env.REMEDIATION_ENABLED === 'true',
    remediationCooldownMs: integer(env, 'REMEDIATION_COOLDOWN_MS', 900000),
    retentionDays: integer(env, 'RETENTION_DAYS', 35),
    baseline: { days: 28, bandMinutes: 30, minSamples: integer(env, 'BASELINE_MIN_SAMPLES', 20, 2), sigma: decimal(env, 'BASELINE_SIGMA', 3, 0.1, 10), alpha: decimal(env, 'BASELINE_ALPHA', 0.3, 0.01, 1), consecutive: 3, minimumBps: decimal(env, 'MIN_EXPECTED_BPS', 1000, 0, 1e12) },
    thresholds: { latencyMs: decimal(env, 'LATENCY_THRESHOLD_MS', 100, 1, 60000), packetLossPercent: decimal(env, 'PACKET_LOSS_THRESHOLD_PERCENT', 10, 0, 100), cpuPercent: decimal(env, 'CPU_THRESHOLD_PERCENT', 85, 1, 100) }
  };
  new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format();
  if (config.port > 65535 || config.syslogPort > 65535) throw new Error('Port must be 1–65535');
  if (config.freshnessMs < config.pollIntervalMs) throw new Error('FRESHNESS_MS must cover a polling interval');
  if (config.retentionDays < 29) throw new Error('RETENTION_DAYS must preserve the 28-day baseline');
  return config;
}
