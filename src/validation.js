export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireThat(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/;
export function text(value, name, max = 200) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${name}`);
  return value;
}
export function number(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  requireThat(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `Invalid ${name}`);
}
export function timestamp(value, name = 'observedAt') {
  requireThat(typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), `Invalid ${name}; include timezone`);
  return new Date(value).toISOString();
}

export function validateAsset(type, input, store, existingId) {
  requireThat(object(input), 'Expected an object');
  const a = structuredClone(input);
  requireThat(typeof a.id === 'string' && idPattern.test(a.id), 'Invalid id');
  if (existingId) requireThat(a.id === existingId, 'Asset id cannot change');
  text(a.name, 'name');
  if (type === 'locations') {
    for (const key of ['building', 'floor', 'room']) if (a[key] !== undefined) text(a[key], key);
    requireThat(typeof a.verified === 'boolean', 'verified is required');
  } else if (type === 'devices') {
    text(a.address, 'address');
    requireThat(!/[\s/"{}\\]/.test(a.address), 'address must be a hostname or IP address');
    requireThat(['mdf', 'idf', 'switch', 'router', 'endpoint', 'external'].includes(a.role), 'Invalid device role');
    a.upstreamIds ??= [];
    requireThat(Array.isArray(a.upstreamIds) && new Set(a.upstreamIds).size === a.upstreamIds.length, 'Invalid upstreamIds');
    for (const parent of a.upstreamIds) {
      requireThat(parent !== a.id && store.asset('devices', parent), 'Unknown upstream device or self-reference');
      const visited = new Set();
      const walk = id => {
        requireThat(id !== a.id, 'Topology must not contain a dependency cycle');
        if (visited.has(id)) return;
        visited.add(id);
        for (const p of store.asset('devices', id)?.upstreamIds || []) walk(p);
      };
      walk(parent);
    }
    if (a.locationId) requireThat(store.asset('locations', a.locationId), 'Unknown locationId');
    if (a.remediation) {
      requireThat(object(a.remediation) && typeof a.remediation.allowAutomatic === 'boolean', 'Invalid remediation policy');
      for (const key of ['urlEnv', 'tokenEnv']) requireThat(/^[A-Z][A-Z0-9_]+$/.test(a.remediation[key]), `Invalid remediation ${key}`);
    }
    requireThat(!store.assets('devices').some(d => d.id !== a.id && d.address === a.address), 'Device address must be unique', 409);
  } else if (type === 'interfaces') {
    requireThat(store.asset('devices', a.deviceId), 'Unknown deviceId');
    requireThat(Number.isSafeInteger(a.ifIndex) && a.ifIndex > 0, 'Invalid ifIndex');
    const prior = store.asset('interfaces', a.id);
    requireThat(!prior || prior.deviceId === a.deviceId && prior.ifIndex === a.ifIndex, 'Stable interface identifiers cannot be reassigned to another device or ifIndex');
    requireThat(!store.assets('interfaces').some(i => i.id !== a.id && i.deviceId === a.deviceId && i.ifIndex === a.ifIndex), 'Duplicate device/ifIndex', 409);
    if (a.speedBps !== undefined) number(a.speedBps, 'speedBps', 1);
    if (a.schedule) {
      requireThat(object(a.schedule) && Array.isArray(a.schedule.days) && a.schedule.days.length > 0 && a.schedule.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6), 'schedule.days must use 0=Sunday through 6=Saturday');
      for (const key of ['start', 'end']) requireThat(/^([01]\d|2[0-3]):[0-5]\d$/.test(a.schedule[key]), `Invalid schedule.${key}`);
      requireThat(a.schedule.start < a.schedule.end, 'Schedule must start before end; split overnight schedules outside this version');
    }
  } else if (type === 'drops') {
    requireThat(store.asset('interfaces', a.interfaceId), 'Unknown interfaceId');
    requireThat(store.asset('locations', a.locationId), 'Unknown locationId');
    requireThat(typeof a.verified === 'boolean', 'verified is required');
    text(a.patchPanel, 'patchPanel');
    requireThat(!store.assets('drops').some(d => d.id !== a.id && d.interfaceId === a.interfaceId), 'Interface already assigned to a drop', 409);
  } else throw new HttpError(404, 'Unknown inventory type');
  return a;
}

export function validateObservation(input, store, now = Date.now()) {
  requireThat(object(input) && object(input.data), 'Expected telemetry object with data');
  const { kind, targetId, data } = input;
  requireThat(['icmp', 'snmp', 'interface'].includes(kind), 'Invalid telemetry kind');
  requireThat(store.asset(kind === 'interface' ? 'interfaces' : 'devices', targetId), 'Unknown telemetry target');
  const observedAt = timestamp(input.observedAt);
  requireThat(Date.parse(observedAt) <= now + 5000 && Date.parse(observedAt) >= now - 35 * 86400000, 'Telemetry timestamp outside accepted window');
  const allowed = kind === 'icmp' ? ['reachable', 'sent', 'received', 'latencyMs', 'packetLossPercent'] : kind === 'snmp' ? ['responsive', 'uptimeTicks', 'cpuPercent', 'thermalAlarm'] : ['adminStatus', 'operStatus', 'inOctets', 'outOctets', 'counterBits', 'uptimeTicks', 'discontinuityTicks', 'speedBps', 'inBps', 'outBps', 'inErrors', 'outErrors', 'inDiscards', 'outDiscards', 'broadcastPackets', 'multicastPackets'];
  requireThat(Object.keys(data).every(k => allowed.includes(k)), 'Unknown telemetry data field');
  if (kind === 'icmp') {
    requireThat(typeof data.reachable === 'boolean', 'reachable is required');
    if (data.sent !== undefined || data.received !== undefined) {
      number(data.sent, 'sent', 1); number(data.received, 'received', 0, data.sent);
      requireThat(Number.isInteger(data.sent) && Number.isInteger(data.received), 'Probe counts must be integers');
      requireThat(data.reachable === (data.received > 0), 'Contradictory ICMP counts and reachability');
    }
    if (data.latencyMs !== undefined) number(data.latencyMs, 'latencyMs');
    if (data.packetLossPercent !== undefined) number(data.packetLossPercent, 'packetLossPercent', 0, 100);
  } else if (kind === 'snmp') {
    requireThat(typeof data.responsive === 'boolean', 'responsive is required');
    if (data.cpuPercent !== undefined) number(data.cpuPercent, 'cpuPercent', 0, 100);
    if (data.thermalAlarm !== undefined) requireThat(typeof data.thermalAlarm === 'boolean', 'Invalid thermalAlarm');
    if (data.uptimeTicks !== undefined) number(data.uptimeTicks, 'uptimeTicks');
  } else {
    for (const key of ['adminStatus', 'operStatus']) requireThat(Number.isInteger(data[key]) && data[key] >= 1 && data[key] <= (key === 'adminStatus' ? 3 : 7), `Invalid ${key}`);
    for (const [key, value] of Object.entries(data)) {
      if (['adminStatus', 'operStatus'].includes(key)) continue;
      if (['inOctets', 'outOctets'].includes(key)) requireThat(typeof value === 'string' && /^\d{1,20}$/.test(value) && BigInt(value) < (1n << BigInt(data.counterBits || 64)), `Invalid ${key}; send decimal strings`);
      else number(value, key);
    }
    if (data.counterBits !== undefined) requireThat([32, 64].includes(data.counterBits), 'counterBits must be 32 or 64');
  }
  return { kind, targetId, observedAt, data: structuredClone(data) };
}
