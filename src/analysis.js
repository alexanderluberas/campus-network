export function localPeriod(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { day, category: day === 0 || day === 6 ? 'weekend' : 'weekday', minute: Number(p.hour) * 60 + Number(p.minute) };
}

export function expectedActivity(iface, at, timeZone) {
  if (!iface.schedule) return false;
  const p = localPeriod(at, timeZone);
  const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  return iface.schedule.days.includes(p.day) && p.minute >= minutes(iface.schedule.start) && p.minute < minutes(iface.schedule.end);
}

export function deriveRates(current, previous, intervalMs) {
  const data = { ...current.data };
  const seconds = previous ? (Date.parse(current.observedAt) - Date.parse(previous.observedAt)) / 1000 : 0;
  let reason = null;
  if (!previous) reason = 'first_sample';
  else if (seconds <= 0 || seconds * 1000 > intervalMs * 3) reason = 'invalid_interval';
  else if (data.uptimeTicks === undefined || previous.data.uptimeTicks === undefined) reason = 'missing_uptime';
  else if (data.uptimeTicks < previous.data.uptimeTicks) reason = 'device_restart_or_uptime_wrap';
  else if (data.discontinuityTicks !== previous.data.discontinuityTicks) reason = 'counter_discontinuity';
  else if ((data.counterBits || 64) !== (previous.data.counterBits || 64)) reason = 'counter_width_changed';
  else if (data.counterBits === 32 && (!data.speedBps || data.speedBps * seconds / 8 >= 2 ** 32)) reason = 'ambiguous_rollover_window';
  for (const direction of ['in', 'out']) {
    const rateKey = `${direction}Bps`;
    const counterKey = `${direction}Octets`;
    // Exporter-derived rates are accepted only as explicitly supplied measurements.
    if (data[rateKey] === undefined && !reason && data[counterKey] !== undefined && previous.data[counterKey] !== undefined) {
      const delta = BigInt(data[counterKey]) - BigInt(previous.data[counterKey]);
      if (delta >= 0n) data[rateKey] = Number(delta) * 8 / seconds;
      else reason = 'counter_reset_or_ambiguous_rollover';
    }
    if (data.speedBps && data[rateKey] > data.speedBps * 1.05) {
      delete data[rateKey]; reason = 'rate_exceeds_capacity';
    }
    if (data[rateKey] !== undefined && data.speedBps) data[`${direction}UtilizationPercent`] = data[rateKey] / data.speedBps * 100;
  }
  if (reason === 'counter_reset_or_ambiguous_rollover') {
    for (const direction of ['in', 'out']) if (current.data[`${direction}Bps`] === undefined) {
      delete data[`${direction}Bps`]; delete data[`${direction}UtilizationPercent`];
    }
  }
  return { data, rateNote: reason };
}

export function analyzeLowFlow(store, observation, iface, config) {
  const at = Date.parse(observation.observedAt);
  const period = localPeriod(at, config.timeZone);
  const settings = config.baseline;
  const eligible = observation.data.adminStatus === 1 && observation.data.operStatus === 1 && expectedActivity(iface, observation.observedAt, config.timeZone);
  const historical = store.baselineHistory(iface.id, `${period.category}:${Math.floor(period.minute / settings.bandMinutes)}`, new Date(at - settings.days * 86400000).toISOString(), observation.observedAt);
  const result = {};
  for (const direction of ['in', 'out']) {
    const key = `${direction}Bps`;
    const stateKey = `baseline:${iface.id}:${direction}`;
    const previous = store.state(stateKey);
    if (previous?.at === observation.observedAt) { result[direction] = previous.result; continue; }
    const samples = historical.filter(o => {
      return o.data.adminStatus === 1 && o.data.operStatus === 1 && Number.isFinite(o.data[key]) &&
        o.baselinePeriod.expectedActivity && !o.lowFlow?.[direction]?.candidate;
    }).map(o => o.data[key]);
    const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
    const sd = samples.length > 1 ? Math.sqrt(samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (samples.length - 1)) : 0;
    const lower = Math.max(0, mean - settings.sigma * sd);
    const ready = eligible && samples.length >= settings.minSamples && mean >= settings.minimumBps && Number.isFinite(observation.data[key]);
    const z = ready ? (observation.data[key] - mean) / Math.max(sd, mean * 0.05, 1) : null;
    const continuous = previous && at - Date.parse(previous.at) <= config.freshnessMs && at > Date.parse(previous.at);
    const ewma = ready ? settings.alpha * z + (1 - settings.alpha) * (continuous ? previous.ewma ?? 0 : 0) : null;
    const candidate = ready && (observation.data[key] < lower || ewma < -settings.sigma);
    const consecutive = candidate ? (continuous ? previous.consecutive : 0) + 1 : 0;
    result[direction] = { eligible, ready, sampleCount: samples.length, mean, standardDeviation: sd, lowerThreshold: lower, zScore: z, ewma, candidate, consecutive, anomaly: consecutive >= settings.consecutive };
    // Historical/backfilled measurements never move live persistence backwards.
    if (!previous || at > Date.parse(previous.at)) store.setState(stateKey, { at: observation.observedAt, band: `${period.category}:${Math.floor(period.minute / settings.bandMinutes)}`, ewma, consecutive, result: result[direction] });
  }
  return result;
}

export const fresh = (observation, now, config) => Boolean(observation && now - Date.parse(observation.observedAt) <= config.freshnessMs && Date.parse(observation.observedAt) <= now + 5000);

export function classifyDevice(store, device, config, now = Date.now()) {
  const icmp = store.latest('icmp', device.id);
  const snmp = store.latest('snmp', device.id);
  const liveIcmp = fresh(icmp, now, config) ? icmp.data : null;
  const liveSnmp = fresh(snmp, now, config) ? snmp.data : null;
  const deviceHealthy = id => {
    const p = store.latest('icmp', id), s = store.latest('snmp', id);
    return fresh(p, now, config) && p.data.reachable && p.data.latencyMs !== undefined && p.data.latencyMs <= config.thresholds.latencyMs &&
      (p.data.packetLossPercent ?? (p.data.sent ? (p.data.sent - p.data.received) / p.data.sent * 100 : null)) === 0 &&
      (s ? fresh(s, now, config) && s.data.responsive : true);
  };
  const evidence = { icmp: fresh(icmp, now, config) ? icmp : null, snmp: fresh(snmp, now, config) ? snmp : null };
  const make = (category, reason, extra = {}) => ({ category, evidenceState: category === 'healthy' ? null : category === 'unresolved' ? 'Unresolved' : 'Probable', deviceId: device.id, interfaceId: null, reason, evidence, recommendedAction: 'Verify the affected fault domain using independent device and physical checks.', ...extra });
  const parents = device.upstreamIds || [];
  if (device.role === 'external') {
    const references = store.assets('devices').filter(d => d.internalReference === true && d.role !== 'external');
    const loss = liveIcmp?.packetLossPercent ?? (liveIcmp?.sent ? (liveIcmp.sent - liveIcmp.received) / liveIcmp.sent * 100 : null);
    const degraded = liveIcmp && (!liveIcmp.reachable || liveIcmp.latencyMs > config.thresholds.latencyMs || loss > config.thresholds.packetLossPercent);
    if (degraded && references.length >= 2 && references.every(d => deviceHealthy(d.id))) return [make('isp_degradation', 'Healthy internal references with degraded external probe; provider attribution remains probable.')];
    return [make(liveIcmp?.reachable && !degraded ? 'healthy' : 'unresolved', 'External path needs fresh probes and at least two healthy internal references.')];
  }
  if (device.role === 'endpoint') {
    if (!liveIcmp) return [make('unresolved', 'Endpoint ICMP evidence is missing or stale.')];
    if (liveIcmp.reachable) return [make('healthy', 'Endpoint responds to ICMP.')];
    return [make(parents.length && parents.every(deviceHealthy) ? 'localized_link_fault' : 'unresolved', 'Endpoint does not respond; upstream availability determines whether the fault domain can be localized. Physical cause remains unconfirmed.')];
  }
  if (!liveIcmp || !liveSnmp) return [make('unresolved', 'ICMP or SNMP evidence is missing or stale; no physical cause inferred.')];
  if (liveIcmp.reachable !== liveSnmp.responsive) return [make('unresolved', 'ICMP and SNMP disagree; check management access, filtering and collector health.')];
  if (!liveIcmp.reachable && !liveSnmp.responsive) {
    const upstreamHealthy = parents.length > 0 && parents.every(deviceHealthy);
    return [make(device.role === 'idf' && upstreamHealthy ? 'idf_outage' : 'unresolved', upstreamHealthy ? 'IDF inaccessible by ICMP and SNMP while upstream references are healthy; power loss is unconfirmed.' : 'Device inaccessible; upstream evidence cannot isolate the cause.')];
  }
  const interfaces = store.assets('interfaces').filter(i => i.deviceId === device.id);
  const diagnoses = [];
  for (const iface of interfaces) {
    const current = store.latest('interface', iface.id);
    if (!fresh(current, now, config)) {
      diagnoses.push(make('unresolved', 'Interface telemetry is missing or stale.', { interfaceId: iface.id })); continue;
    }
    if (current.data.adminStatus !== 1) continue;
    if (current.data.operStatus === 2) {
      diagnoses.push(make('localized_link_fault', 'Switch responsive; administratively enabled interface is operationally down. Cable and endpoint causes cannot be distinguished.', { interfaceId: iface.id, evidence: { ...evidence, interface: current } })); continue;
    }
    if (current.data.operStatus !== 1) {
      diagnoses.push(make('unresolved', 'Interface is not operationally up or definitively down.', { interfaceId: iface.id })); continue;
    }
    const low = current.lowFlow?.in?.anomaly || current.lowFlow?.out?.anomaly;
    const nearZero = Number.isFinite(current.data.inBps) && Number.isFinite(current.data.outBps) && current.data.inBps + current.data.outBps < config.baseline.minimumBps && expectedActivity(iface, current.observedAt, config.timeZone);
    const stressed = liveSnmp.cpuPercent >= config.thresholds.cpuPercent || liveSnmp.thermalAlarm === true;
    if ((low || nearZero) && stressed) {
      const events = store.records('syslog').filter(e => e.deviceId === device.id && now - Date.parse(e.observedAt) <= config.freshnessMs && Date.parse(e.observedAt) <= now + 5000 && ['storm', 'topology_change'].includes(e.eventType));
      diagnoses.push(make('switch_bottleneck', 'Low throughput with elevated processor load or a thermal alarm.', { interfaceId: iface.id, broadcastRelated: events.length > 0, evidence: { ...evidence, interface: current, events }, recommendedAction: 'Check switch resources, Layer 2 counters and topology events; verify any suspected broadcast storm independently.' }));
    } else if (low) {
      diagnoses.push(make('unresolved', 'Sustained low-flow anomaly detected; available evidence does not establish the root cause.', { interfaceId: iface.id, evidence: { ...evidence, interface: current } }));
    }
  }
  return diagnoses.length ? diagnoses : [make('healthy', 'Fresh telemetry does not match a configured fault rule.')];
}
