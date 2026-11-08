import { requireThat } from './validation.js';
import { classifyDevice } from './analysis.js';

async function postJson(url, body, token, fetcher) {
  requireThat(new URL(url).protocol === 'https:', 'Action destinations must use HTTPS');
  const response = await fetcher(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Remote submission failed (HTTP ${response.status})`);
  return response;
}

export class Actions {
  constructor(store, config, fetcher = fetch, env = process.env) { Object.assign(this, { store, config, fetcher, env }); this.delivering = false; }
  channels() {
    const e = this.env;
    return [e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID && 'telegram', e.DISCORD_WEBHOOK_URL && 'discord', e.EMAIL_GATEWAY_URL && e.EMAIL_TO && 'email'].filter(Boolean);
  }
  async deliver() {
    if (!this.config.notificationsEnabled || this.delivering) return;
    this.delivering = true;
    try {
      for (const job of this.store.records('outbox', 100000).filter(j => j.status === 'pending' && (!j.nextAttemptAt || Date.parse(j.nextAttemptAt) <= Date.now())).slice(0, 20)) {
        const channels = this.channels();
        if (!channels.length) continue;
        const incident = job.incidentSnapshot || this.store.getRecord('incidents', job.incidentId);
        const text = `[${job.event}] ${incident.category} (${incident.evidenceState})\nDevice: ${incident.deviceId}; interface: ${incident.interfaceId || 'device-wide'}\n${incident.reason}\nLocations: ${incident.affectedLocations.map(l => l.location.name).join(', ') || 'unverified/unmapped'}\nAction: ${incident.recommendedAction}\nIncident: ${incident.id}`;
        let failed = false;
        for (const channel of channels) {
          const id = `${job.id}:${channel}`;
          if (this.store.getRecord('notifications', id)?.status === 'submitted') continue;
          const started = Date.now();
          try {
            const e = this.env;
            if (channel === 'telegram') {
              const response = await postJson(`https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: e.TELEGRAM_CHAT_ID, text: text.slice(0, 4000) }, null, this.fetcher);
              if ((await response.json()).ok !== true) throw new Error('Telegram submission rejected');
            } else if (channel === 'discord') await postJson(e.DISCORD_WEBHOOK_URL, { content: text.slice(0, 1900), allowed_mentions: { parse: [] } }, null, this.fetcher);
            else await postJson(e.EMAIL_GATEWAY_URL, { to: e.EMAIL_TO, subject: `Campus network: ${incident.category}`, text }, e.EMAIL_GATEWAY_TOKEN, this.fetcher);
            this.store.record('notifications', { id, outboxId: job.id, incidentId: incident.id, channel, status: 'submitted', submittedAt: new Date().toISOString(), latencyMs: Date.now() - started, incidentToSubmissionMs: Date.now() - Date.parse(job.createdAt), recipientAcknowledged: false });
          } catch {
            failed = true;
            this.store.record('notifications', { id, outboxId: job.id, incidentId: incident.id, channel, status: 'failed', attempts: job.attempts + 1, error: 'Submission failed; check channel credentials and destination' });
          }
        }
        const attempts = job.attempts + 1;
        this.store.record('outbox', { ...job, attempts, status: failed ? attempts >= 5 ? 'failed' : 'pending' : 'submitted', nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts)).toISOString() });
      }
    } finally { this.delivering = false; }
  }
  async reset(incidentId, { automatic = false, reason, actor = 'administrator' } = {}) {
    requireThat(this.config.remediationEnabled, 'Remediation is disabled', 409);
    const incident = this.store.getRecord('incidents', incidentId);
    requireThat(incident && incident.status !== 'resolved' && incident.category === 'idf_outage', 'An active IDF outage incident is required', 409);
    requireThat(Date.now() - Date.parse(incident.lastObservedAt) <= this.config.freshnessMs, 'Incident evidence is stale', 409);
    const device = this.store.asset('devices', incident.deviceId);
    requireThat(device && classifyDevice(this.store, device, this.config).some(d => d.category === 'idf_outage'), 'Current telemetry no longer supports an IDF outage', 409);
    const policy = device.remediation;
    requireThat(policy, 'Device has no power-controller adapter', 409);
    if (automatic) requireThat(policy.allowAutomatic && incident.evidenceState === 'Confirmed', 'Automatic reset requires device opt-in and independently confirmed evidence', 409);
    else requireThat(typeof reason === 'string' && reason.trim().length >= 10 && reason.length <= 1000, 'Provide an operator reset reason (10–1000 characters)');
    const url = this.env[policy.urlEnv], token = this.env[policy.tokenEnv];
    requireThat(url && token, 'Power-controller adapter credentials are not configured', 409);
    requireThat(new URL(url).protocol === 'https:', 'Power-controller adapter must use HTTPS');
    const action = this.store.transaction(() => {
      const previous = this.store.records('remediations', 100000).find(a => a.deviceId === device.id);
      requireThat(!previous || Date.now() - Date.parse(previous.createdAt) >= this.config.remediationCooldownMs, 'Device is in remediation cooldown', 409);
      return this.store.record('remediations', { deviceId: device.id, incidentId, automatic, reason: reason || 'Confirmed outage policy', actor, status: 'pending' });
    });
    try {
      await postJson(url, { action: 'power-cycle', deviceId: device.id, requestId: action.id }, token, this.fetcher);
      return this.store.record('remediations', { ...action, status: 'submitted', submittedAt: new Date().toISOString() });
    } catch {
      // A timeout may follow a successful physical action: never blindly repeat it.
      return this.store.record('remediations', { ...action, status: 'unknown', error: 'Controller result unknown; independently verify before another attempt' });
    }
  }
  async automaticResets() {
    if (!this.config.remediationEnabled) return;
    for (const i of this.store.records('incidents').filter(i => i.status !== 'resolved' && i.category === 'idf_outage' && i.evidenceState === 'Confirmed')) {
      if (!this.store.asset('devices', i.deviceId)?.remediation?.allowAutomatic) continue;
      // One automatic attempt per incident, including unknown outcomes and across restarts.
      if (this.store.records('remediations', 100000).some(a => a.incidentId === i.id && a.automatic)) continue;
      try { await this.reset(i.id, { automatic: true, actor: 'policy' }); }
      catch (error) { if (!error.status) throw error; }
    }
  }
}
