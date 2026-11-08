import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { deriveRates, classifyDevice } from '../src/analysis.js';
import { validateAsset, validateObservation } from '../src/validation.js';
import { parseSyslog, PrometheusCollector, startSyslog } from '../src/collectors.js';
import { Actions } from '../src/actions.js';
import { createBackend } from '../src/server.js';
import { evaluationReport } from '../src/evaluation.js';
import dgram from 'node:dgram';

const at = Date.parse('2026-11-09T01:10:00.000Z');
function fixture(now = at) {
  const store = new Store();
  const config = loadConfig({});
  const engine = new Engine(store, config);
  store.putAsset('locations', { id: 'room', name: 'Office 101', building: 'A', floor: '1', room: '101', verified: true });
  store.putAsset('devices', { id: 'core', name: 'Core', role: 'mdf', address: '10.0.0.1', upstreamIds: [], internalReference: true });
  store.putAsset('devices', { id: 'idf', name: 'IDF A', role: 'idf', address: '10.0.0.2', upstreamIds: ['core'], internalReference: true });
  store.putAsset('interfaces', { id: 'port', name: 'Office access', deviceId: 'idf', ifIndex: 1, speedBps: 1e9, schedule: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' } });
  store.putAsset('drops', { id: 'drop', name: 'Outlet A101', interfaceId: 'port', locationId: 'room', verified: true, patchPanel: 'PP1/1' });
  const ingest = (kind, targetId, data, time = now) => engine.ingest({ kind, targetId, data, observedAt: new Date(time).toISOString() }, Math.max(now, time));
  const healthy = (device = 'idf', time = now) => {
    ingest('icmp', device, { reachable: true, latencyMs: 1, sent: 3, received: 3 }, time);
    ingest('snmp', device, { responsive: true, uptimeTicks: 100000, cpuPercent: 10 }, time);
  };
  return { store, config, engine, ingest, healthy, close: () => store.close() };
}

test('exact counter arithmetic, capacity, resets, discontinuities and gaps', () => {
  const prior = { observedAt: new Date(at - 30000).toISOString(), data: { inOctets: '9007199254740993', outOctets: '50', uptimeTicks: 1000, counterBits: 64, discontinuityTicks: 0 } };
  const current = { observedAt: new Date(at).toISOString(), data: { inOctets: '9007199254741293', outOctets: '350', uptimeTicks: 4000, counterBits: 64, discontinuityTicks: 0, speedBps: 1000 } };
  const rate = deriveRates(current, prior, 30000);
  assert.equal(rate.data.inBps, 80);
  assert.equal(rate.data.outUtilizationPercent, 8);
  for (const changed of [{ uptimeTicks: 10 }, { discontinuityTicks: 1 }, { inOctets: '2' }, { counterBits: 32 }]) {
    const result = deriveRates({ ...current, data: { ...current.data, ...changed } }, prior, 30000);
    assert.equal(result.data.inBps, undefined);
  }
  assert.equal(deriveRates({ ...current, observedAt: new Date(at + 200000).toISOString() }, prior, 30000).data.inBps, undefined);
  assert.equal(deriveRates({ ...current, data: { ...current.data, inBps: 2000 } }, prior, 30000).data.inBps, undefined);
  const fast32 = { ...current, data: { inOctets: '1000', outOctets: '1000', uptimeTicks: 4000, counterBits: 32, speedBps: 10e9 } };
  const prior32 = { ...prior, data: { inOctets: '500', outOctets: '500', uptimeTicks: 1000, counterBits: 32 } };
  assert.equal(deriveRates(fast32, prior32, 30000).rateNote, 'ambiguous_rollover_window');
  assert.equal(deriveRates(fast32, prior32, 30000).data.inBps, undefined);
});

test('28-day baseline uses comparable periods and requires three fresh consecutive samples', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 20; i++) f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 100000, outBps: 100000 }, at - 7 * 86400000 - 600000 + i * 30000);
    for (let i = 0; i < 3; i++) {
      const result = f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 100, outBps: 100000 }, at + i * 30000);
      assert.equal(result.observation.lowFlow.in.ready, true);
      assert.equal(result.observation.lowFlow.in.anomaly, i === 2);
      assert.equal(result.observation.lowFlow.out.anomaly, false);
    }
    assert.equal(f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 0, outBps: 0 }, at + 60000).duplicate, true);
    const afterGap = f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 0, outBps: 100000 }, at + 300000);
    assert.equal(afterGap.observation.lowFlow.in.consecutive, 1);
  } finally { f.close(); }
});

test('inactive schedules and insufficient baselines do not declare low flow', () => {
  const f = fixture();
  try {
    const result = f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 0, outBps: 0 });
    assert.equal(result.observation.lowFlow.in.ready, false);
    const night = at + 12 * 3600000;
    assert.equal(f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 0, outBps: 0 }, night).observation.lowFlow.in.eligible, false);
  } finally { f.close(); }
});

test('all four fault categories and contradictory/stale evidence', () => {
  const f = fixture();
  try {
    f.healthy('core');
    f.ingest('icmp', 'idf', { reachable: false, sent: 3, received: 0 });
    f.ingest('snmp', 'idf', { responsive: false });
    let diagnoses = classifyDevice(f.store, f.store.asset('devices', 'idf'), f.config, at);
    assert.equal(diagnoses[0].category, 'idf_outage');
    assert.equal(diagnoses[0].evidenceState, 'Probable');
    f.healthy('idf', at + 1000);
    f.ingest('interface', 'port', { adminStatus: 1, operStatus: 2 }, at + 1000);
    assert.equal(classifyDevice(f.store, f.store.asset('devices', 'idf'), f.config, at + 1000)[0].category, 'localized_link_fault');
    f.ingest('snmp', 'idf', { responsive: true, cpuPercent: 95 }, at + 2000);
    f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 0, outBps: 0 }, at + 2000);
    diagnoses = classifyDevice(f.store, f.store.asset('devices', 'idf'), f.config, at + 2000);
    assert.equal(diagnoses[0].category, 'switch_bottleneck');
    assert.equal(diagnoses[0].broadcastRelated, false);
    f.store.putAsset('devices', { id: 'wan', name: 'External probe', role: 'external', address: '192.0.2.1' });
    f.ingest('icmp', 'wan', { reachable: true, latencyMs: 200, packetLossPercent: 30 }, at + 2000);
    assert.equal(classifyDevice(f.store, f.store.asset('devices', 'wan'), f.config, at + 2000)[0].category, 'isp_degradation');
    f.ingest('snmp', 'idf', { responsive: false }, at + 3000);
    assert.equal(classifyDevice(f.store, f.store.asset('devices', 'idf'), f.config, at + 3000)[0].evidenceState, 'Unresolved');
    assert.equal(classifyDevice(f.store, f.store.asset('devices', 'idf'), f.config, at + 200000)[0].evidenceState, 'Unresolved');
  } finally { f.close(); }
});

test('incidents deduplicate, preserve uncertainty on stale evidence, and recover', () => {
  const f = fixture();
  try {
    f.healthy('core'); f.healthy();
    f.ingest('interface', 'port', { adminStatus: 1, operStatus: 2 });
    f.engine.evaluate(at); f.engine.evaluate(at + 1000);
    const incident = f.store.records('incidents').find(i => i.category === 'localized_link_fault');
    assert.equal(f.store.records('incidents').length, 1);
    assert.equal(incident.affectedLocations[0].location.id, 'room');
    f.engine.evaluate(at + 200000);
    assert.notEqual(f.store.getRecord('incidents', incident.id).status, 'resolved');
    f.healthy('core', at + 201000); f.healthy('idf', at + 201000);
    f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 10000, outBps: 10000 }, at + 201000);
    f.engine.evaluate(at + 201000);
    assert.equal(f.store.getRecord('incidents', incident.id).status, 'resolved');
  } finally { f.close(); }
});

test('a continuing fault keeps its incident id when the diagnosis changes and loses old confirmation', () => {
  const f = fixture();
  try {
    f.healthy('core'); f.healthy();
    f.ingest('interface', 'port', { adminStatus: 1, operStatus: 2 });
    f.engine.evaluate(at);
    const incident = f.store.records('incidents')[0];
    f.store.record('incidents', { ...incident, evidenceState: 'Confirmed', verification: { evidenceReference: 'Lab record' } });
    f.ingest('snmp', 'idf', { responsive: true, cpuPercent: 99 }, at + 1000);
    f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 0, outBps: 0 }, at + 1000);
    f.engine.evaluate(at + 1000);
    const updated = f.store.getRecord('incidents', incident.id);
    assert.equal(f.store.records('incidents').length, 1);
    assert.equal(updated.category, 'switch_bottleneck');
    assert.equal(updated.evidenceState, 'Probable');
    assert.equal(updated.verification, undefined);
    assert.equal(updated.diagnosisHistory[0].category, 'localized_link_fault');
  } finally { f.close(); }
});

test('fresh interface status cannot resolve a fault when device evidence is stale', () => {
  const f = fixture();
  try {
    f.healthy('core'); f.healthy();
    f.ingest('interface', 'port', { adminStatus: 1, operStatus: 2 });
    f.engine.evaluate(at);
    const incident = f.store.records('incidents')[0];
    f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 10000, outBps: 10000 }, at + 100000);
    f.engine.evaluate(at + 100000);
    assert.equal(f.store.getRecord('incidents', incident.id).status, 'open');
    assert.equal(f.store.getRecord('incidents', incident.id).evidenceState, 'Unresolved');
  } finally { f.close(); }
});

test('CPU load alone and a one-direction idle counter do not prove a storm or bottleneck', () => {
  const f = fixture();
  try {
    f.healthy('core'); f.healthy();
    f.ingest('snmp', 'idf', { responsive: true, cpuPercent: 99 }, at + 1000);
    f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 0, outBps: 100000 }, at + 1000);
    assert.equal(classifyDevice(f.store, f.store.asset('devices', 'idf'), f.config, at + 1000)[0].category, 'healthy');
    f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 0, outBps: 0 }, at + 2000);
    f.store.record('syslog', { deviceId: 'idf', eventType: 'storm', observedAt: new Date(at + 86400000).toISOString() });
    assert.equal(classifyDevice(f.store, f.store.asset('devices', 'idf'), f.config, at + 2000)[0].broadcastRelated, false);
    f.store.record('syslog', { deviceId: 'idf', eventType: 'storm', observedAt: new Date(at + 1000).toISOString() });
    assert.equal(classifyDevice(f.store, f.store.asset('devices', 'idf'), f.config, at + 2000)[0].broadcastRelated, true);
  } finally { f.close(); }
});

test('nested batch rollback includes state and observation changes', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.transaction(() => {
      f.ingest('interface', 'port', { adminStatus: 1, operStatus: 1, inBps: 100000, outBps: 100000 });
      throw new Error('abort batch');
    }), /abort batch/);
    assert.equal(f.store.latest('interface', 'port'), null);
    assert.equal(f.store.state('baseline:port:in'), null);
  } finally { f.close(); }
});

test('endpoint ICMP diagnosis does not require endpoint SNMP support', () => {
  const f = fixture();
  try {
    f.healthy('core');
    f.store.putAsset('devices', { id: 'pc', name: 'Office endpoint', role: 'endpoint', address: '10.0.0.99', upstreamIds: ['core'] });
    f.ingest('icmp', 'pc', { reachable: false });
    assert.equal(classifyDevice(f.store, f.store.asset('devices', 'pc'), f.config, at)[0].category, 'localized_link_fault');
  } finally { f.close(); }
});

test('alternate upstream paths prevent downstream location overstatement', () => {
  const f = fixture();
  try {
    f.store.putAsset('devices', { id: 'dual', name: 'Dual connected switch', address: '10.0.0.9', role: 'switch', upstreamIds: ['core', 'idf'] });
    const locations = f.engine.locations({ category: 'idf_outage', deviceId: 'idf', interfaceId: null });
    assert.deepEqual(locations.affectedDeviceIds, ['idf']);
    f.store.putAsset('drops', { ...f.store.asset('drops', 'drop'), verified: false });
    assert.equal(f.engine.locations({ category: 'idf_outage', deviceId: 'idf' }).mappingVerified, false);
  } finally { f.close(); }
});

test('inventory rejects dependency cycles, duplicate interfaces and reassigned identities', () => {
  const f = fixture();
  try {
    assert.throws(() => validateAsset('devices', { ...f.store.asset('devices', 'core'), upstreamIds: ['idf'] }, f.store, 'core'), /cycle/);
    assert.throws(() => validateAsset('interfaces', { id: 'another', name: 'Duplicate', deviceId: 'idf', ifIndex: 1 }, f.store), /Duplicate/);
    assert.throws(() => validateAsset('interfaces', { ...f.store.asset('interfaces', 'port'), ifIndex: 2 }, f.store, 'port'), /cannot be reassigned/);
    assert.throws(() => validateAsset('locations', { name: 'Missing id', verified: true }, f.store), /Invalid id/);
  } finally { f.close(); }
});

test('invalid telemetry is rejected without accepting contradictory ICMP or imprecise counters', () => {
  const f = fixture();
  try {
    for (const data of [{ reachable: false, sent: 3, received: 2 }, { reachable: true, latencyMs: -1 }, { reachable: true, packetLossPercent: 101 }]) {
      assert.throws(() => validateObservation({ kind: 'icmp', targetId: 'idf', observedAt: new Date(at).toISOString(), data }, f.store, at));
    }
    assert.throws(() => validateObservation({ kind: 'interface', targetId: 'port', observedAt: new Date(at).toISOString(), data: { adminStatus: 1, operStatus: 1, inOctets: 123 } }, f.store, at), /decimal strings/);
  } finally { f.close(); }
});

test('RFC5424 escaped structured data and RFC3164 receipt timestamps normalize correctly', () => {
  const modern = parseSyslog('<134>1 2026-11-09T01:10:00Z switch app 7 ID [meta key="escaped\\\"value"][other a="b"] link changed state to down');
  assert.equal(modern.eventType, 'link_down');
  assert.equal(modern.facility, 16);
  assert.equal(modern.structuredData, '[meta key="escaped\\\"value"][other a="b"]');
  const legacy = parseSyslog('<30>Nov  9 09:10:00 switch STP topology change', new Date(at).toISOString());
  assert.equal(legacy.timestampBasis, 'receipt');
  assert.equal(legacy.eventType, 'topology_change');
  assert.throws(() => parseSyslog('<999>garbage'));
  assert.throws(() => parseSyslog('<30>1 invalid switch app 7 ID - msg'));
});

test('real UDP listener uses registered source address, not a forged hostname', async () => {
  const f = fixture();
  const socket = startSyslog(f.store, { syslogHost: '127.0.0.1', syslogPort: 0 });
  await new Promise(resolve => socket.once('listening', resolve));
  const client = dgram.createSocket('udp4');
  f.store.putAsset('devices', { id: 'local', name: 'Local test device', address: '127.0.0.1', role: 'switch' });
  try {
    await new Promise((resolve, reject) => client.send('<30>Nov  9 09:10:00 forged storm-control threshold', socket.address().port, '127.0.0.1', error => error ? reject(error) : resolve()));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.store.records('syslog')[0].deviceId, 'local');
    assert.equal(f.store.records('syslog')[0].hostname, 'forged');
  } finally { client.close(); await new Promise(resolve => socket.close(resolve)); f.close(); }
});

test('Prometheus integration preserves original timestamps and rejects stale samples', async () => {
  const f = fixture(Date.now());
  f.config.prometheusUrl = 'http://prometheus.test';
  const now = Date.now();
  const fetcher = async url => {
    const q = new URL(url).searchParams.get('query');
    let result = [];
    const metric = q.startsWith('probe_success') ? 1 : q.startsWith('up{') ? 1 : null;
    if (metric !== null) result = [{ metric: { instance: '10.0.0.2' }, value: [(now - 2000) / 1000, String(metric)] }];
    if (q.startsWith('ifAdminStatus')) result = [{ metric: { instance: '10.0.0.2', ifIndex: '1' }, value: [(now - 200000) / 1000, '1'] }];
    return { ok: true, json: async () => ({ status: 'success', data: { resultType: 'vector', result } }) };
  };
  try {
    const c = new PrometheusCollector(f.store, f.engine, f.config, fetcher);
    const result = await c.collect();
    assert.equal(result.accepted, 2);
    assert.equal(Date.parse(f.store.latest('icmp', 'idf').observedAt), now - 2000);
    assert.equal(f.store.latest('interface', 'port'), null);
    assert.equal((await c.collect()).accepted, 0);
  } finally { f.close(); }
});

test('notification submission is separate from acknowledgment and successful jobs are not repeated', async () => {
  const f = fixture();
  f.config.notificationsEnabled = true;
  const incident = f.store.record('incidents', { category: 'idf_outage', evidenceState: 'Probable', deviceId: 'idf', reason: 'Test outage', recommendedAction: 'Verify', affectedLocations: [] });
  f.store.record('outbox', { incidentId: incident.id, event: 'opened', status: 'pending', attempts: 0 });
  let calls = 0;
  const actions = new Actions(f.store, f.config, async () => { calls++; return { ok: true }; }, { DISCORD_WEBHOOK_URL: 'https://example.test/webhook' });
  try {
    await actions.deliver(); await actions.deliver();
    assert.equal(calls, 1);
    assert.equal(f.store.records('notifications')[0].recipientAcknowledged, false);
    assert.equal(f.store.records('outbox')[0].status, 'submitted');
  } finally { f.close(); }
});

test('remediation is opt-in, audited, cooldown protected and never automatically retried after timeout', async () => {
  const f = fixture(Date.now());
  const now = Date.now();
  f.healthy('core', now);
  f.ingest('icmp', 'idf', { reachable: false, sent: 3, received: 0 }, now);
  f.ingest('snmp', 'idf', { responsive: false }, now);
  f.engine.evaluate(now);
  const incident = f.store.records('incidents').find(i => i.category === 'idf_outage');
  f.store.putAsset('devices', { ...f.store.asset('devices', 'idf'), remediation: { allowAutomatic: true, urlEnv: 'POWER_URL', tokenEnv: 'POWER_TOKEN' } });
  let calls = 0;
  const actions = new Actions(f.store, f.config, async () => { calls++; throw new Error('timeout'); }, { POWER_URL: 'https://controller.test/reset', POWER_TOKEN: 'secret' });
  try {
    await assert.rejects(actions.reset(incident.id, { reason: 'Operator verified outage' }), /disabled/);
    f.config.remediationEnabled = true;
    await assert.rejects(actions.reset(incident.id, { automatic: true }), /confirmed/);
    f.store.record('incidents', { ...incident, evidenceState: 'Confirmed', verification: { evidenceReference: 'independent lab power record' } });
    await actions.automaticResets(); await actions.automaticResets();
    assert.equal(calls, 1);
    assert.equal(f.store.records('remediations')[0].status, 'unknown');
    await assert.rejects(actions.reset(incident.id, { reason: 'Another operator retry' }), /cooldown/);
  } finally { f.close(); }
});

test('SQLite inventory, EWMA persistence and incident state survive a restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'campus-db-'));
  const path = join(directory, 'test.sqlite');
  try {
    let store = new Store(path);
    store.putAsset('locations', { id: 'room', name: 'Room', verified: true });
    store.setState('baseline:port:in', { consecutive: 2 });
    const incident = store.record('incidents', { category: 'idf_outage', status: 'open' });
    store.close(); store = new Store(path);
    assert.equal(store.asset('locations', 'room').name, 'Room');
    assert.equal(store.state('baseline:port:in').consecutive, 2);
    assert.equal(store.getRecord('incidents', incident.id).status, 'open');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('evaluation includes missed faults without inventing detection times', () => {
  const store = new Store();
  try {
    store.record('trials', { actualCategory: 'idf_outage', predictedCategory: 'healthy', startedAt: new Date(at).toISOString() });
    store.record('trials', { actualCategory: 'localized_link_fault', predictedCategory: 'localized_link_fault', startedAt: new Date(at).toISOString(), detectedAt: new Date(at + 1000).toISOString(), localizedAt: new Date(at + 2000).toISOString(), traditionalDiagnosticMs: 10000 });
    const report = evaluationReport(store);
    assert.equal(report.missedIncidents, 1);
    assert.equal(report.meanTimeToDetectMs, 1000);
    assert.equal(report.meanTimeToIsolateMs, 2000);
    assert.equal(report.detection.recall, 0.5);
    assert.equal(report.meanDiagnosticTimeReductionPercent, 80);
    assert.equal(report.verifiedMappingAccuracy, null);
  } finally { store.close(); }
});

test('HTTP API authentication, permissions, inventory, telemetry, recovery and malformed batches', async () => {
  const config = loadConfig({ ADMIN_API_KEY: 'a'.repeat(32), READ_API_KEY: 'r'.repeat(32), INGEST_API_KEY: 'i'.repeat(32), DATABASE_PATH: ':memory:' });
  config.port = 0;
  const backend = createBackend(config);
  const address = await backend.start();
  const base = `http://127.0.0.1:${address.port}`;
  async function request(path, method = 'GET', body, key = config.adminKey) {
    const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.equal((await request('/health/live', 'GET', undefined, '')).status, 200);
    assert.equal((await request('/api/v1/devices', 'GET', undefined, '')).status, 401);
    assert.equal((await request('/api/v1/devices', 'POST', {}, config.readKey)).status, 403);
    assert.equal((await request('/api/v1/devices', 'GET', undefined, config.ingestKey)).status, 403);
    assert.equal((await request('/health/ready')).status, 503);
    assert.equal((await request('/api/v1/devices', 'POST', { id: 'core', name: 'Core', address: '10.0.0.1', role: 'mdf' })).status, 201);
    assert.equal((await request('/api/v1/devices', 'POST', { id: 'idf', name: 'IDF', address: '10.0.0.2', role: 'idf', upstreamIds: ['core'] })).status, 201);
    assert.equal((await request('/api/v1/interfaces', 'POST', { id: 'port', name: 'Port', deviceId: 'idf', ifIndex: 1 })).status, 201);
    assert.equal((await request('/api/v1/devices/core', 'DELETE')).status, 409);
    const now = new Date().toISOString();
    const batch = ['core', 'idf'].flatMap(targetId => [{ kind: 'icmp', targetId, observedAt: now, data: { reachable: true, sent: 3, received: 3, latencyMs: 1 } }, { kind: 'snmp', targetId, observedAt: now, data: { responsive: true } }]);
    batch.push({ kind: 'interface', targetId: 'port', observedAt: now, data: { adminStatus: 1, operStatus: 2 } });
    assert.equal((await request('/api/v1/telemetry', 'POST', batch, config.ingestKey)).status, 202);
    assert.equal((await request('/health/ready')).status, 200);
    const incidents = (await request('/api/v1/incidents')).body.items;
    const incident = incidents.find(i => i.category === 'localized_link_fault');
    assert.ok(incident);
    assert.equal((await request(`/api/v1/incidents/${incident.id}/acknowledge`, 'POST', { operator: 'Lab technician' })).body.status, 'acknowledged');
    assert.equal((await request(`/api/v1/incidents/${incident.id}/verify`, 'POST', { operator: 'Lab technician', method: 'Physical verification', evidenceReference: 'Test record 1' })).body.evidenceState, 'Confirmed');
    const badBatch = [{ kind: 'icmp', targetId: 'core', observedAt: new Date(Date.now() + 1).toISOString(), data: { reachable: false } }, { kind: 'snmp', targetId: 'unknown', observedAt: now, data: { responsive: false } }];
    assert.equal((await request('/api/v1/telemetry', 'POST', badBatch)).status, 400);
    assert.equal(backend.store.latest('icmp', 'core').data.reachable, true);
    assert.equal((await request('/api/v1/telemetry?kind=icmp&targetId=core&limit=-1')).status, 400);
  } finally { await backend.close(); }
});
