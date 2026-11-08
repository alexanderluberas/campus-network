import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { PrometheusCollector, startSyslog } from './collectors.js';
import { Actions } from './actions.js';
import { createApi } from './api.js';

export function createBackend(config = loadConfig()) {
  if (config.adminKey.length < 32) throw new Error('ADMIN_API_KEY must contain at least 32 characters');
  const keys = [config.adminKey, config.readKey, config.ingestKey].filter(Boolean);
  if (keys.some(k => k.length < 32) || new Set(keys).size !== keys.length) throw new Error('API keys must be distinct and at least 32 characters');
  const store = new Store(config.databasePath), engine = new Engine(store, config);
  const collector = new PrometheusCollector(store, engine, config), actions = new Actions(store, config);
  let running = null, closing = false;
  const runCycle = () => {
    if (running) return running;
    if (closing) return Promise.resolve({ closing: true });
    running = (async () => {
      try {
        const collection = await collector.collect();
        const diagnoses = engine.evaluate();
        await actions.deliver();
        await actions.automaticResets();
        store.purge(new Date(Date.now() - config.retentionDays * 86400000).toISOString());
        return { collection, diagnoses };
      } catch (error) {
        store.setState('cycle-error', { at: new Date().toISOString(), error: 'Monitoring cycle failed', name: error.name });
        // A collection failure must still evaluate stale evidence instead of freezing old diagnoses.
        engine.evaluate();
        return { error: 'Monitoring cycle failed; inspect collector configuration and health' };
      } finally { running = null; }
    })();
    return running;
  };
  const server = createApi({ store, engine, actions, config, runCycle });
  let timer, syslog;
  return {
    store, engine, actions, collector, server, runCycle,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
      if (config.syslogEnabled) syslog = startSyslog(store, config);
      timer = setInterval(() => { void runCycle(); }, config.pollIntervalMs);
      timer.unref();
      void runCycle();
      return server.address();
    },
    async close() {
      closing = true;
      clearInterval(timer);
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (syslog) await new Promise(resolve => syslog.close(resolve));
      if (running) await running;
      store.close();
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const backend = createBackend();
    const address = await backend.start();
    console.log(JSON.stringify({ event: 'backend_started', address }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await backend.close(); process.exitCode = 0; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
