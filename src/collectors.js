import dgram from 'node:dgram';

export class PrometheusCollector {
  constructor(store, engine, config, fetcher = fetch) { Object.assign(this, { store, engine, config, fetcher }); }
  async query(expression) {
    const url = new URL('/api/v1/query', this.config.prometheusUrl);
    url.searchParams.set('query', expression);
    const response = await this.fetcher(url, { headers: this.config.prometheusToken ? { Authorization: `Bearer ${this.config.prometheusToken}` } : {}, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Prometheus HTTP ${response.status}`);
    const body = await response.json();
    if (body.status !== 'success' || body.data?.resultType !== 'vector') throw new Error('Expected successful Prometheus vector');
    return body.data.result;
  }
  async collect() {
    const { config } = this;
    if (!config.prometheusUrl) return { enabled: false };
    const job = JSON.stringify(config.snmpJob), icmpJob = JSON.stringify(config.icmpJob);
    const expressions = {
      probe: `probe_success{job=${icmpJob}}`, rtt: `probe_icmp_duration_seconds{job=${icmpJob},phase="rtt"}`,
      snmp: `up{job=${job}}`, admin: `ifAdminStatus{job=${job}}`, oper: `ifOperStatus{job=${job}}`,
      uptime: `sysUpTime{job=${job}}`, discontinuity: `ifCounterDiscontinuityTime{job=${job}}`,
      inHC: `ifHCInOctets{job=${job}}`, outHC: `ifHCOutOctets{job=${job}}`,
      in32: `ifInOctets{job=${job}}`, out32: `ifOutOctets{job=${job}}`,
      highSpeed: `ifHighSpeed{job=${job}}`, speed: `ifSpeed{job=${job}}`,
      inErrors: `ifInErrors{job=${job}}`, outErrors: `ifOutErrors{job=${job}}`,
      inDiscards: `ifInDiscards{job=${job}}`, outDiscards: `ifOutDiscards{job=${job}}`,
      broadcastPackets: `ifHCInBroadcastPkts{job=${job}}`, multicastPackets: `ifHCInMulticastPkts{job=${job}}`
    };
    for (const [key, metric] of [['cpu', config.cpuMetric], ['thermal', config.thermalMetric]]) {
      if (metric) {
        if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric)) throw new Error('Invalid optional metric name');
        expressions[key] = `${metric}{job=${job}}`;
      }
    }
    const entries = Object.entries(expressions);
    const values = await Promise.allSettled(entries.map(([, expression]) => this.query(expression)));
    const metrics = {}, failures = [];
    values.forEach((value, i) => {
      const key = entries[i][0];
      if (value.status === 'fulfilled') metrics[key] = value.value;
      else { metrics[key] = []; failures.push(key); }
    });
    const now = Date.now();
    const sample = (name, address, index) => {
      const candidates = (metrics[name] || []).filter(m => m.metric.instance === address && (index === undefined || String(m.metric.ifIndex) === String(index)));
      // Ambiguous metric labels require explicit exporter configuration, never arbitrary selection.
      if (candidates.length !== 1) return null;
      const s = candidates[0], value = Number(s.value[1]), at = Number(s.value[0]) * 1000;
      if (!Number.isFinite(value) || !Number.isFinite(at) || now - at > config.freshnessMs || at > now + 5000) return null;
      return { value, at };
    };
    let accepted = 0;
    for (const d of this.store.assets('devices')) {
      const probe = sample('probe', d.address);
      if (probe) {
        const rtt = sample('rtt', d.address);
        const observations = this.store.observations('icmp', d.id, new Date(probe.at - config.pollIntervalMs * 9).toISOString(), new Date(probe.at).toISOString(), 9);
        const reachable = probe.value === 1;
        const data = { reachable, packetLossPercent: (observations.filter(p => !p.data.reachable).length + (reachable ? 0 : 1)) / (observations.length + 1) * 100 };
        if (reachable && rtt && Math.abs(rtt.at - probe.at) <= config.pollIntervalMs) data.latencyMs = rtt.value * 1000;
        accepted += Number(this.engine.ingest({ kind: 'icmp', targetId: d.id, observedAt: new Date(probe.at).toISOString(), data }).accepted);
      }
      if (['external', 'endpoint'].includes(d.role)) continue;
      const snmp = sample('snmp', d.address);
      if (!snmp) continue;
      const data = { responsive: snmp.value === 1 };
      for (const [field, name] of [['uptimeTicks', 'uptime'], ['cpuPercent', 'cpu'], ['thermalAlarm', 'thermal']]) {
        const value = sample(name, d.address);
        if (value && data.responsive) data[field] = field === 'thermalAlarm' ? value.value > 0 : value.value;
      }
      accepted += Number(this.engine.ingest({ kind: 'snmp', targetId: d.id, observedAt: new Date(snmp.at).toISOString(), data }).accepted);
      if (!data.responsive) continue;
      for (const iface of this.store.assets('interfaces').filter(i => i.deviceId === d.id)) {
        const admin = sample('admin', d.address, iface.ifIndex), oper = sample('oper', d.address, iface.ifIndex);
        if (!admin || !oper) continue;
        const row = { adminStatus: admin.value, operStatus: oper.value };
        const times = [admin.at, oper.at, snmp.at];
        if (data.uptimeTicks !== undefined) row.uptimeTicks = data.uptimeTicks;
        const highSpeed = sample('highSpeed', d.address, iface.ifIndex), speed = sample('speed', d.address, iface.ifIndex);
        if (highSpeed?.value > 0) row.speedBps = highSpeed.value * 1e6;
        else if (speed?.value > 0) row.speedBps = speed.value;
        const hcIn = sample('inHC', d.address, iface.ifIndex), hcOut = sample('outHC', d.address, iface.ifIndex);
        const counters = hcIn && hcOut ? [hcIn, hcOut] : [sample('in32', d.address, iface.ifIndex), sample('out32', d.address, iface.ifIndex)];
        row.counterBits = hcIn && hcOut ? 64 : 32;
        for (const [index, key] of ['inOctets', 'outOctets'].entries()) {
          const counter = counters[index];
          if (counter && Number.isSafeInteger(counter.value) && counter.value >= 0) { row[key] = String(counter.value); times.push(counter.at); }
        }
        for (const [field, name] of [['discontinuityTicks', 'discontinuity'], ['inErrors', 'inErrors'], ['outErrors', 'outErrors'], ['inDiscards', 'inDiscards'], ['outDiscards', 'outDiscards'], ['broadcastPackets', 'broadcastPackets'], ['multicastPackets', 'multicastPackets']]) {
          const s = sample(name, d.address, iface.ifIndex);
          if (s) { row[field] = s.value; times.push(s.at); }
        }
        accepted += Number(this.engine.ingest({ kind: 'interface', targetId: iface.id, observedAt: new Date(Math.min(...times)).toISOString(), data: row }).accepted);
      }
    }
    const health = { enabled: true, attemptedAt: new Date(now).toISOString(), accepted, failedQueries: failures, successful: failures.length === 0 };
    this.store.setState('collector-health', health);
    return health;
  }
}

export function parseSyslog(raw, receivedAt = new Date().toISOString()) {
  const priority = /^<(\d{1,3})>/.exec(raw);
  if (!priority || Number(priority[1]) > 191) throw new Error('Invalid Syslog priority');
  const payload = raw.slice(priority[0].length);
  const modern = /^(\d+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/s.exec(payload);
  let result;
  if (modern) {
    if (modern[1] !== '1') throw new Error('Unsupported Syslog version');
    const rest = modern[7];
    let end = 0;
    if (rest.startsWith('-')) end = 1;
    else if (rest.startsWith('[')) {
      let quoted = false, escaped = false, closed = false;
      for (let i = 0; i < rest.length; i++) {
        const c = rest[i];
        if (escaped) { escaped = false; continue; }
        if (c === '\\' && quoted) { escaped = true; continue; }
        if (c === '"') quoted = !quoted;
        if (c === ']' && !quoted && rest[i + 1] !== '[') { end = i + 1; closed = true; break; }
      }
      if (!closed) throw new Error('Malformed structured data');
    } else throw new Error('Missing structured data');
    const eventAt = modern[2] === '-' ? receivedAt : modern[2];
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(eventAt) || !Number.isFinite(Date.parse(eventAt))) throw new Error('Invalid Syslog timestamp');
    result = { format: 'RFC5424', observedAt: new Date(eventAt).toISOString(), hostname: modern[3], appName: modern[4], processId: modern[5], messageId: modern[6], structuredData: rest.slice(0, end), message: rest.slice(end).trimStart() };
  } else {
    const legacy = /^([A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}) (\S+) (.*)$/s.exec(payload);
    if (!legacy) throw new Error('Unsupported legacy Syslog');
    // Legacy timestamps lack year and timezone: receipt time is the only trusted correlation clock.
    result = { format: 'RFC3164', observedAt: receivedAt, deviceTimestamp: legacy[1], hostname: legacy[2], message: legacy[3], timestampBasis: 'receipt' };
  }
  const message = result.message.toLowerCase();
  const eventType = /storm|broadcast.*exceed/.test(message) ? 'storm' : /spanning.tree|topology.change|stp.*change/.test(message) ? 'topology_change' : /link.*down|changed state to down/.test(message) ? 'link_down' : /link.*up|changed state to up/.test(message) ? 'link_up' : /restart|reboot|coldstart/.test(message) ? 'restart' : 'other';
  return { ...result, priority: Number(priority[1]), facility: Math.floor(Number(priority[1]) / 8), severity: Number(priority[1]) % 8, eventType, receivedAt };
}

export function startSyslog(store, config) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (buffer, remote) => {
    const device = store.assets('devices').find(d => d.address === remote.address);
    if (!device || buffer.length > 16384) return;
    try {
      const event = parseSyslog(buffer.toString('utf8'));
      // Sender address is authoritative for identity; the claimed hostname is untrusted.
      store.record('syslog', { ...event, deviceId: device.id, sourceAddress: remote.address });
      store.setState('syslog-health', { lastReceivedAt: event.receivedAt });
    } catch { store.setState('syslog-rejection', { at: new Date().toISOString(), reason: 'Malformed datagram' }); }
  });
  socket.on('error', error => { store.setState('syslog-error', { at: new Date().toISOString(), code: error.code }); });
  socket.bind(config.syslogPort, config.syslogHost);
  return socket;
}
