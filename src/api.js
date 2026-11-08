import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { validateAsset, validateObservation, requireThat, HttpError, object, timestamp, text, number } from './validation.js';
import { fresh } from './analysis.js';
import { categories, evaluationReport } from './evaluation.js';

const digest = value => createHash('sha256').update(value).digest();
const matchKey = (value, expected) => Boolean(expected && value && timingSafeEqual(digest(value), digest(expected)));
const inventoryTypes = ['devices', 'interfaces', 'locations', 'drops'];

async function jsonBody(req) {
  requireThat(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 'Use application/json', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= 1048576, 'Request body too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function safeAsset(a) {
  if (!a) return a;
  const copy = structuredClone(a);
  // Inventory contains environment variable references only, never secret values.
  return copy;
}

export function createApi({ store, engine, actions, config, runCycle }) {
  const requests = new Map();
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'x-frame-options': 'DENY' });
      res.end(JSON.stringify(body));
    };
    let role = 'anonymous';
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.method === 'GET' && url.pathname === '/health/live') return send(200, { status: 'alive' });
      const key = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      role = matchKey(key, config.adminKey) ? 'admin' : matchKey(key, config.ingestKey) ? 'ingest' : matchKey(key, config.readKey) ? 'read' : 'anonymous';
      requireThat(role !== 'anonymous', 'Valid Bearer API key required', 401);
      const bucketKey = `${req.socket.remoteAddress}:${role}`;
      const minute = Math.floor(Date.now() / 60000);
      if (requests.size > 10000) requests.clear();
      const bucket = requests.get(bucketKey);
      const count = bucket?.minute === minute ? bucket.count + 1 : 1;
      requests.set(bucketKey, { minute, count });
      requireThat(count <= (role === 'ingest' ? 600 : 300), 'Rate limit exceeded', 429);
      const read = () => requireThat(['read', 'admin'].includes(role), 'Read permission required', 403);
      const admin = () => requireThat(role === 'admin', 'Administrator permission required', 403);
      const page = values => {
        const limit = Number(url.searchParams.get('limit') || 100), offset = Number(url.searchParams.get('offset') || 0);
        requireThat(Number.isInteger(limit) && limit > 0 && limit <= 1000 && Number.isInteger(offset) && offset >= 0, 'Invalid limit or offset');
        return { items: values.slice(offset, offset + limit), total: values.length, limit, offset };
      };
      if (url.pathname === '/health/ready' && req.method === 'GET') {
        read();
        const now = Date.now();
        const evaluation = store.state('engine-health');
        const collection = store.state('collector-health');
        const devices = store.assets('devices');
        const staleTargets = devices.filter(d => !fresh(store.latest('icmp', d.id), now, config) || (!['external', 'endpoint'].includes(d.role) && !fresh(store.latest('snmp', d.id), now, config))).map(d => d.id);
        const staleInterfaces = store.assets('interfaces').filter(i => !fresh(store.latest('interface', i.id), now, config)).map(i => i.id);
        const database = store.db.prepare('SELECT 1 AS ok').get().ok === 1;
        const diagnostics = evaluation && now - Date.parse(evaluation.lastEvaluationAt) <= config.freshnessMs;
        const ready = Boolean(database && diagnostics && devices.length && !staleTargets.length && !staleInterfaces.length && (!config.prometheusUrl || collection?.successful));
        return send(ready ? 200 : 503, { ready, database, diagnostics: Boolean(diagnostics), inventoryConfigured: devices.length > 0, staleTargets, staleInterfaces, collection, syslog: store.state('syslog-health') });
      }
      requireThat(route[0] === 'api' && route[1] === 'v1', 'Route not found', 404);
      const resource = route[2], id = route[3], operation = route[4];
      if (inventoryTypes.includes(resource) && route.length <= 4) {
        if (req.method === 'GET') {
          read();
          if (!id) return send(200, page(store.assets(resource).map(safeAsset)));
          const asset = store.asset(resource, id); requireThat(asset, 'Asset not found', 404); return send(200, safeAsset(asset));
        }
        admin();
        if (req.method === 'POST' && !id || req.method === 'PUT' && id) {
          const input = await jsonBody(req);
          requireThat(object(input) && typeof input.id === 'string', 'Expected asset object with id');
          if (req.method === 'POST') requireThat(!store.asset(resource, input.id), 'Asset already exists', 409);
          else requireThat(store.asset(resource, id), 'Asset not found', 404);
          const asset = validateAsset(resource, input, store, id);
          store.putAsset(resource, asset);
          store.record('audit', { action: `${req.method}:${resource}`, targetId: asset.id, actor: role });
          return send(req.method === 'POST' ? 201 : 200, safeAsset(asset));
        }
        if (req.method === 'DELETE' && id) {
          requireThat(store.asset(resource, id), 'Asset not found', 404);
          const referenced = resource === 'devices' ? store.assets('devices').some(d => d.upstreamIds?.includes(id)) || store.assets('interfaces').some(i => i.deviceId === id) : resource === 'interfaces' ? store.assets('drops').some(d => d.interfaceId === id) : resource === 'locations' ? store.assets('devices').some(d => d.locationId === id) || store.assets('drops').some(d => d.locationId === id) : false;
          requireThat(!referenced, 'Remove dependent inventory records first', 409);
          requireThat(!store.records('incidents', 100000).some(i => i.status !== 'resolved' && (resource === 'devices' && i.deviceId === id || resource === 'interfaces' && i.interfaceId === id)), 'Asset has active incidents; retain its diagnostic history', 409);
          store.deleteAsset(resource, id); store.record('audit', { action: `DELETE:${resource}`, targetId: id, actor: role });
          return send(200, { deleted: id });
        }
      }
      if (resource === 'telemetry' && route.length === 3) {
        if (req.method === 'POST') {
          requireThat(['admin', 'ingest'].includes(role), 'Telemetry ingest permission required', 403);
          const body = await jsonBody(req), batch = Array.isArray(body) ? body : [body];
          requireThat(batch.length > 0 && batch.length <= 1000, 'Send 1–1000 observations');
          // Validate all input before writes and process backfill in chronological order.
          const results = batch.map(item => validateObservation(item, store)).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
          const accepted = store.transaction(() => {
            const output = results.map(item => engine.ingest(item));
            engine.evaluate();
            return output;
          });
          store.record('audit', { action: 'telemetry:ingest', count: batch.length, actor: role });
          return send(202, { results: accepted });
        }
        if (req.method === 'GET') {
          read(); const kind = url.searchParams.get('kind'), target = url.searchParams.get('targetId');
          requireThat(['icmp', 'snmp', 'interface'].includes(kind) && target, 'kind and targetId are required');
          const since = url.searchParams.get('since') ? timestamp(url.searchParams.get('since'), 'since') : new Date(Date.now() - 86400000).toISOString();
          return send(200, page(store.observations(kind, target, since, '9999', 100000)));
        }
      }
      if (req.method === 'GET' && resource === 'overview' && !id) { read(); return send(200, engine.summary()); }
      if (req.method === 'POST' && resource === 'monitoring' && id === 'run' && !operation) { admin(); return send(200, await runCycle()); }
      if (req.method === 'GET' && ['incidents', 'notifications', 'remediations', 'syslog', 'audit'].includes(resource) && !operation) {
        read(); if (resource === 'audit') admin();
        if (id) { const record = store.getRecord(resource, id); requireThat(record, 'Record not found', 404); return send(200, record); }
        let records = store.records(resource, 100000);
        if (url.searchParams.has('status')) records = records.filter(r => r.status === url.searchParams.get('status'));
        return send(200, page(records));
      }
      if (resource === 'incidents' && id && req.method === 'POST' && ['acknowledge', 'verify', 'reset'].includes(operation)) {
        admin(); const incident = store.getRecord('incidents', id); requireThat(incident, 'Incident not found', 404);
        const body = await jsonBody(req); requireThat(object(body), 'Expected object');
        if (operation === 'reset') return send(202, await actions.reset(id, { reason: body.reason, actor: role }));
        requireThat(incident.status !== 'resolved', 'Incident already resolved', 409);
        let updated;
        if (operation === 'acknowledge') updated = { ...incident, status: 'acknowledged', acknowledgedAt: new Date().toISOString(), acknowledgedBy: text(body.operator, 'operator') };
        else {
          requireThat(incident.category !== 'unresolved', 'Unresolved diagnoses need sufficient telemetry before confirmation', 409);
          text(body.operator, 'operator'); text(body.method, 'method', 1000); text(body.evidenceReference, 'evidenceReference', 1000);
          updated = { ...incident, evidenceState: 'Confirmed', verification: { operator: body.operator, method: body.method, evidenceReference: body.evidenceReference, verifiedAt: new Date().toISOString() } };
        }
        store.record('incidents', updated); store.record('audit', { action: `incident:${operation}`, incidentId: id, actor: body.operator || role });
        return send(200, updated);
      }
      if (resource === 'evaluations' && id === 'trials' && req.method === 'POST') {
        admin(); const body = await jsonBody(req);
        requireThat(object(body) && categories.includes(body.actualCategory) && body.actualCategory !== 'unresolved' && categories.includes(body.predictedCategory), 'Invalid trial categories');
        text(body.evidenceReference, 'evidenceReference', 1000); text(body.operator, 'operator');
        body.startedAt = timestamp(body.startedAt, 'startedAt');
        for (const field of ['detectedAt', 'localizedAt']) if (body[field]) {
          body[field] = timestamp(body[field], field);
          requireThat(Date.parse(body[field]) >= Date.parse(body.startedAt) && Date.parse(body[field]) <= Date.now() + 5000, 'Invalid trial timing');
        }
        if (body.localizedAt) requireThat(body.detectedAt && body.localizedAt >= body.detectedAt && body.actualCategory === body.predictedCategory, 'Localization timing requires prior detection and correct classification');
        if (body.traditionalDiagnosticMs !== undefined) number(body.traditionalDiagnosticMs, 'traditionalDiagnosticMs', 1);
        const trial = store.record('trials', { actualCategory: body.actualCategory, predictedCategory: body.predictedCategory, startedAt: body.startedAt, detectedAt: body.detectedAt || null, localizedAt: body.localizedAt || null, traditionalDiagnosticMs: body.traditionalDiagnosticMs || null, evidenceReference: body.evidenceReference, operator: body.operator });
        return send(201, trial);
      }
      if (resource === 'evaluations' && id === 'mapping-checks' && req.method === 'POST') {
        admin(); const body = await jsonBody(req); requireThat(object(body), 'Expected object');
        const drop = store.asset('drops', body.dropId); requireThat(drop, 'Unknown dropId');
        requireThat(store.asset('locations', body.actualLocationId), 'Unknown actualLocationId');
        text(body.evidenceReference, 'evidenceReference', 1000); text(body.operator, 'operator');
        return send(201, store.record('mappingChecks', { dropId: drop.id, recordedLocationId: drop.locationId, actualLocationId: body.actualLocationId, correct: drop.locationId === body.actualLocationId, evidenceReference: body.evidenceReference, operator: body.operator }));
      }
      if (resource === 'evaluations' && id === 'report' && req.method === 'GET') { read(); return send(200, evaluationReport(store)); }
      throw new HttpError(404, 'Route not found');
    } catch (error) {
      if (!error.status) console.error(JSON.stringify({ event: 'request_error', name: error.name }));
      if (!res.headersSent && !res.destroyed) send(error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
