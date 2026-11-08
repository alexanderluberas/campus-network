import { analyzeLowFlow, classifyDevice, deriveRates, fresh, localPeriod, expectedActivity } from './analysis.js';
import { validateObservation } from './validation.js';

export class Engine {
  constructor(store, config) { this.store = store; this.config = config; }
  ingest(input, now = Date.now()) {
    const validated = validateObservation(input, this.store, now);
    return this.store.transaction(() => {
      const prior = this.store.latest(validated.kind, validated.targetId);
      if (this.store.observations(validated.kind, validated.targetId, validated.observedAt, new Date(Date.parse(validated.observedAt) + 1).toISOString(), 1).length) return { accepted: false, duplicate: true };
      let observation = validated;
      if (validated.kind === 'interface') {
        const iface = this.store.asset('interfaces', validated.targetId);
        observation.data.speedBps ??= iface.speedBps;
        const previous = this.store.observations('interface', iface.id, '1970', validated.observedAt, 1)[0];
        observation = { ...observation, ...deriveRates(observation, previous, this.config.pollIntervalMs) };
        const period = localPeriod(observation.observedAt, this.config.timeZone);
        observation.baselinePeriod = { key: `${period.category}:${Math.floor(period.minute / this.config.baseline.bandMinutes)}`, expectedActivity: expectedActivity(iface, observation.observedAt, this.config.timeZone) };
        // Backfill is retained but cannot trigger live EWMA or persistence.
        if (!prior || validated.observedAt > prior.observedAt) observation.lowFlow = analyzeLowFlow(this.store, observation, iface, this.config);
      }
      this.store.addObservation(observation);
      return { accepted: true, observation };
    });
  }
  locations(diagnosis) {
    const devices = this.store.assets('devices');
    const affectedIds = new Set([diagnosis.deviceId]);
    if (diagnosis.category === 'idf_outage') {
      let changed = true;
      while (changed) {
        changed = false;
        for (const d of devices) if (!affectedIds.has(d.id) && d.upstreamIds?.length && d.upstreamIds.every(id => affectedIds.has(id))) { affectedIds.add(d.id); changed = true; }
      }
    }
    const interfaces = this.store.assets('interfaces').filter(i => diagnosis.interfaceId ? i.id === diagnosis.interfaceId : affectedIds.has(i.deviceId));
    const interfaceIds = new Set(interfaces.map(i => i.id));
    const drops = this.store.assets('drops').filter(d => d.verified && interfaceIds.has(d.interfaceId) && this.store.asset('locations', d.locationId)?.verified);
    return { faultDomain: { deviceId: diagnosis.deviceId, interfaceId: diagnosis.interfaceId }, affectedDeviceIds: [...affectedIds], affectedLocations: drops.map(d => ({ dropId: d.id, interfaceId: d.interfaceId, location: this.store.asset('locations', d.locationId) })), mappingVerified: drops.length > 0 };
  }
  evaluate(now = Date.now()) {
    return this.store.transaction(() => {
      const diagnoses = this.store.assets('devices').flatMap(d => classifyDevice(this.store, d, this.config, now));
      const active = this.store.records('incidents', 100000).filter(i => i.status !== 'resolved');
      const at = new Date(now).toISOString();
      const seen = new Set();
      for (const diagnosis of diagnoses) {
        if (diagnosis.category === 'healthy') continue;
        const key = `${diagnosis.deviceId}:${diagnosis.interfaceId || '-'}`;
        seen.add(key);
        const prior = active.find(i => i.key === key);
        const evidenceTimes = [diagnosis.evidence.icmp?.observedAt, diagnosis.evidence.snmp?.observedAt, diagnosis.evidence.interface?.observedAt].filter(Boolean).sort();
        const categoryChanged = prior && prior.category !== diagnosis.category;
        const history = categoryChanged ? [...(prior.diagnosisHistory || []), { category: prior.category, evidenceState: prior.evidenceState, changedAt: at }] : prior?.diagnosisHistory || [];
        const incident = { ...prior, key, ...diagnosis, ...this.locations(diagnosis), status: prior?.status || 'open', firstDetectedAt: prior?.firstDetectedAt || at, lastObservedAt: evidenceTimes.at(-1) || prior?.lastObservedAt || null, lastEvaluatedAt: at, updatedAt: at, diagnosisHistory: history, currentEvidenceStatus: diagnosis.category === 'unresolved' ? 'insufficient' : 'current' };
        // Independent verification remains valid only while the observed condition continues.
        if (!categoryChanged && prior?.verification && prior.evidenceState === 'Confirmed') { incident.verification = prior.verification; incident.evidenceState = 'Confirmed'; }
        else if (categoryChanged) delete incident.verification;
        const saved = this.store.record('incidents', incident);
        if (!prior || categoryChanged || prior.evidenceState !== saved.evidenceState) this.store.record('outbox', { incidentId: saved.id, incidentSnapshot: saved, event: prior ? 'updated' : 'opened', status: 'pending', attempts: 0 });
      }
      for (const incident of active) {
        if (seen.has(incident.key)) continue;
        const device = this.store.asset('devices', incident.deviceId);
        // Stale or contradictory evidence never counts as recovery.
        const probe = device && this.store.latest('icmp', device.id);
        const snmp = device && this.store.latest('snmp', device.id);
        const deviceResponsive = probe && snmp && fresh(probe, now, this.config) && probe.data.reachable && fresh(snmp, now, this.config) && snmp.data.responsive;
        const deviceHealthy = device && (diagnoses.some(d => d.deviceId === device.id && d.category === 'healthy') || !incident.interfaceId && incident.category === 'idf_outage' && deviceResponsive);
        const iface = incident.interfaceId && this.store.latest('interface', incident.interfaceId);
        const interfaceHealthy = deviceResponsive && iface && fresh(iface, now, this.config) && iface.data.adminStatus === 1 && iface.data.operStatus === 1 && !iface.lowFlow?.in?.anomaly && !iface.lowFlow?.out?.anomaly && diagnoses.every(d => d.deviceId !== incident.deviceId || d.interfaceId !== incident.interfaceId || d.category === 'healthy');
        if (deviceHealthy || interfaceHealthy) {
          this.store.record('incidents', { ...incident, status: 'resolved', resolvedAt: at, updatedAt: at });
          this.store.record('outbox', { incidentId: incident.id, incidentSnapshot: { ...incident, status: 'resolved', resolvedAt: at }, event: 'resolved', status: 'pending', attempts: 0 });
        } else {
          this.store.record('incidents', { ...incident, evidenceState: 'Unresolved', currentEvidenceStatus: 'unavailable', lastEvaluatedAt: at, updatedAt: at });
        }
      }
      this.store.setState('engine-health', { lastEvaluationAt: at, diagnosisCount: diagnoses.length });
      return diagnoses;
    });
  }
  summary(now = Date.now()) {
    const devices = this.store.assets('devices').map(d => {
      const probes = this.store.observations('icmp', d.id, new Date(now - 86400000).toISOString());
      const successes = probes.filter(p => p.data.reachable).length;
      return { id: d.id, name: d.name, role: d.role, latestIcmp: this.store.latest('icmp', d.id), latestSnmp: this.store.latest('snmp', d.id), observedAvailabilityPercent: probes.length ? successes / probes.length * 100 : null, observedProbeCount: probes.length, expectedProbeCount: Math.floor(86400000 / this.config.pollIntervalMs) };
    });
    return { generatedAt: new Date(now).toISOString(), devices, incidents: this.store.records('incidents').filter(i => i.status !== 'resolved') };
  }
}
