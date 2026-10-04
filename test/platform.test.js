import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import './helpers/register-stubs.js';

const { ProtoArtMatterbridgePlatform } = await import('../dist/module.js');

const THERMOSTAT = 513;
const POWER_SOURCE = 47;
const BRIDGED_BASIC_INFO = 57;
const HUMIDITY = 1029;

const control = (heatpump = {}, batt = 71, hact = 57) => ({
  wifi: { mac: 'AA:BB:CC:00:11:22' },
  sys: { frname: 'Allrum' },
  heatpump: { power: 'on', mode: 'heat', set_temperature: 20, oper: true, fault_code: 'No error', actual_temperature: 22.5, ...heatpump },
  sensor: batt === null ? {} : { thermometer: { batt, hact } },
});

/** Fake ProtoArt units keyed by host. Commands are recorded; `down` makes a host fail. */
function fakeNetwork(initial = {}) {
  const net = { requests: [], down: new Set(), units: {} };
  net.units = Object.fromEntries(Object.keys(initial).length ? Object.entries(initial) : [['10.0.0.1', control()]]);
  net.fetch = async (url) => {
    const u = new URL(url);
    net.requests.push(`${u.host}${u.pathname}${u.search}`);
    if (net.down.has(u.host)) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, json: async () => structuredClone(net.units[u.host]) };
  };
  net.commands = (host) => net.requests.filter((r) => r.startsWith(host) && r.includes('cmd=heatpump')).map((r) => r.split('?cmd=heatpump&')[1]);
  return net;
}

const makeLog = () => {
  const lines = [];
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (...a) => lines.push([level, a.join(' ')]);
  log.lines = lines;
  return log;
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const tick = async (ms) => {
  mock.timers.tick(ms);
  await flush();
};

describe('ProtoArtMatterbridgePlatform', () => {
  let net;
  let realFetch;
  let platform;
  let log;

  const start = async (config, units) => {
    net = fakeNetwork(units);
    globalThis.fetch = net.fetch;
    log = makeLog();
    platform = new ProtoArtMatterbridgePlatform({ matterbridgeVersion: '3.10.0' }, log, { pollInterval: 15_000, ...config });
    await platform.onStart('test');
    await platform.onConfigure();
    await flush();
    return platform.registered[0];
  };

  beforeEach(() => {
    realFetch = globalThis.fetch;
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(async () => {
    await platform?.onShutdown('test');
    mock.timers.reset();
    globalThis.fetch = realFetch;
  });

  it('registers devices with the original IP-derived identity and the unit\'s limits', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1', name: 'Living room' }] });
    assert.equal(device.id, 'protoart-10_0_0_1');
    assert.deepEqual(device.calls.basicInfo.slice(0, 2), ['Living room', 'PA10001']);
    // heating/cooling limits 16-31 °C, no dead band
    assert.deepEqual(device.calls.thermostat, [21, 21, 21, 0, 16, 31, 16, 31]);
    assert.deepEqual(device.calls.battery, [null]);
  });

  it('still understands the legacy hosts/deviceNames config', async () => {
    await start({ hosts: '10.0.0.1,10.0.0.2', deviceNames: 'A,B' }, { '10.0.0.1': control(), '10.0.0.2': control() });
    assert.deepEqual(platform.registered.map((d) => d.calls.basicInfo[0]), ['A', 'B']);
  });

  it('can derive identity from the MAC address', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1', identity: 'mac' }] });
    assert.equal(device.id, 'protoart-AABBCC001122');
  });

  it('polls immediately on configure and maps the state to Matter attributes', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    const get = (c, a) => device.getAttribute(c, a);
    assert.equal(get(THERMOSTAT, 'localTemperature'), 2250);
    assert.equal(get(THERMOSTAT, 'occupiedHeatingSetpoint'), 2000);
    assert.equal(get(THERMOSTAT, 'occupiedCoolingSetpoint'), 2000);
    assert.equal(get(THERMOSTAT, 'systemMode'), 4);
    assert.equal(get(THERMOSTAT, 'thermostatRunningMode'), 4);
    assert.equal(get(THERMOSTAT, 'thermostatRunningState').heat, true);
    assert.equal(get(POWER_SOURCE, 'batPercentRemaining'), 142);
  });

  it('exposes the thermometer humidity as a separate humidity sensor', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    assert.equal(device.children.length, 1);
    const [sensor] = device.children;
    assert.equal(sensor.id, 'Humidity');
    assert.equal(sensor.deviceTypes[0].name, 'humiditySensor');
    assert.deepEqual(sensor.calls.humidity, [null, 0, 10000]);
    assert.equal(sensor.getAttribute(HUMIDITY, 'measuredValue'), 5700);
  });

  it('reports unknown humidity when no thermometer is paired', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] }, { '10.0.0.1': control({}, null) });
    assert.equal(device.children[0].getAttribute(HUMIDITY, 'measuredValue') ?? null, null);
  });

  it('follows humidity changes on later polls', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    net.units['10.0.0.1'] = control({}, 71, 61.5);
    await tick(15_000);
    assert.equal(device.children[0].getAttribute(HUMIDITY, 'measuredValue'), 6150);
  });

  it('creates no humidity sensor when humiditySensor is false', async () => {
    const device = await start({ humiditySensor: false, devices: [{ host: '10.0.0.1' }] });
    assert.equal(device.children.length, 0);
  });

  it('reports an unknown battery when no thermometer is paired', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] }, { '10.0.0.1': control({}, null) });
    assert.equal(device.getAttribute(POWER_SOURCE, 'batPercentRemaining'), null);
  });

  it('does not echo its own attribute updates back to the unit', async () => {
    await start({ devices: [{ host: '10.0.0.1' }] });
    await tick(15_000); // another poll with unchanged data
    await tick(15_000);
    assert.deepEqual(net.commands('10.0.0.1'), []);
  });

  it('never forwards a change the plugin made itself, even if it differs from the unit', async () => {
    // e.g. attributes restored from Matterbridge storage on startup
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    await device.updateAttribute(THERMOSTAT, 'systemMode', 3);
    await device.updateAttribute(THERMOSTAT, 'occupiedHeatingSetpoint', 2800);
    await tick(2_000);
    assert.deepEqual(net.commands('10.0.0.1'), []);
  });

  it('forwards a controller mode change in a single request and confirms with a poll', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    const before = net.requests.length;
    device.writeFromController(THERMOSTAT, 'systemMode', 3);
    await flush();
    assert.deepEqual(net.commands('10.0.0.1'), ['power=on&mode=cool']);
    await tick(2_500);
    assert.ok(net.requests.length > before + 1, 'confirmation poll after the command');
  });

  it('turns the unit off', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    device.writeFromController(THERMOSTAT, 'systemMode', 0);
    await flush();
    assert.deepEqual(net.commands('10.0.0.1'), ['power=off']);
  });

  it('ignores system modes the unit cannot do', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    device.writeFromController(THERMOSTAT, 'systemMode', 5);
    await flush();
    assert.deepEqual(net.commands('10.0.0.1'), []);
  });

  it('debounces a burst of setpoint writes, rounds to 0.5 and mirrors both setpoints', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    for (const c of [2110, 2160, 2230]) device.writeFromController(THERMOSTAT, 'occupiedHeatingSetpoint', c);
    await flush();
    assert.deepEqual(net.commands('10.0.0.1'), []); // still debouncing
    assert.equal(device.getAttribute(THERMOSTAT, 'occupiedCoolingSetpoint'), 2250);
    await tick(800);
    assert.deepEqual(net.commands('10.0.0.1'), ['set_temperature=22.5']);
  });

  it('clamps out-of-range setpoints to what the unit supports', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    device.writeFromController(THERMOSTAT, 'occupiedCoolingSetpoint', 3800);
    await tick(800);
    assert.deepEqual(net.commands('10.0.0.1'), ['set_temperature=31.0']);
    assert.equal(device.getAttribute(THERMOSTAT, 'occupiedCoolingSetpoint'), 3100);
  });

  it('setpointRaiseLower raises by the requested tenths of a degree and accumulates', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] }, { '10.0.0.1': control({ set_temperature: 21 }) });
    const handler = device.commandHandlers.get('setpointRaiseLower');
    handler({ request: { mode: 0, amount: 10 } }); // +1.0 °C
    handler({ request: { mode: 0, amount: 5 } }); // +0.5 °C on top of the pending value
    await flush();
    await tick(800);
    assert.deepEqual(net.commands('10.0.0.1'), ['set_temperature=22.5']);
  });

  it('keeps a pending setpoint when a poll lands inside the debounce window', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    device.writeFromController(THERMOSTAT, 'occupiedHeatingSetpoint', 2400);
    await flush();
    await platform._poll(platform._entries[0]);
    assert.equal(device.getAttribute(THERMOSTAT, 'occupiedHeatingSetpoint'), 2400);
  });

  it('marks a unit unreachable after repeated failures and recovers', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    net.down.add('10.0.0.1');
    await tick(15_000); // failure 1
    assert.deepEqual(device.events, []);
    await tick(30_000); // failure 2 (backoff 30 s)
    await tick(60_000); // failure 3 (backoff 60 s)
    assert.deepEqual(device.events, [{ cluster: BRIDGED_BASIC_INFO, event: 'reachableChanged', payload: { reachableNewValue: false } }]);
    assert.equal(device.getAttribute(BRIDGED_BASIC_INFO, 'reachable'), false);

    net.down.delete('10.0.0.1');
    await tick(120_000);
    assert.equal(device.getAttribute(BRIDGED_BASIC_INFO, 'reachable'), true);
    assert.equal(device.events.at(-1).payload.reachableNewValue, true);
  });

  it('backs off per unit: a dead unit does not slow down a healthy one', async () => {
    await start(
      { devices: [{ host: '10.0.0.1' }, { host: '10.0.0.2' }] },
      { '10.0.0.1': control(), '10.0.0.2': control() },
    );
    net.down.add('10.0.0.1');
    net.requests.length = 0;
    await tick(15_000);
    await tick(15_000);
    await tick(15_000);
    const healthy = net.requests.filter((r) => r.startsWith('10.0.0.2')).length;
    const dead = net.requests.filter((r) => r.startsWith('10.0.0.1')).length;
    assert.ok(healthy >= 3, `healthy unit polled every interval (got ${healthy})`);
    assert.ok(dead < healthy, `dead unit backed off (dead ${dead}, healthy ${healthy})`);
  });

  it('resyncs shortly after a failed command', async () => {
    const device = await start({ devices: [{ host: '10.0.0.1' }] });
    net.down.add('10.0.0.1');
    device.writeFromController(THERMOSTAT, 'systemMode', 3);
    await flush();
    net.down.delete('10.0.0.1');
    net.requests.length = 0;
    await tick(1_000);
    assert.ok(net.requests.some((r) => r.endsWith('/control')), 'poll scheduled after the failure');
  });

  it('stops polling and aborts requests on shutdown', async () => {
    await start({ devices: [{ host: '10.0.0.1' }] });
    await platform.onShutdown('test');
    net.requests.length = 0;
    await tick(120_000);
    assert.deepEqual(net.requests, []);
  });

  it('does not restart its timer when shutdown happens during a poll', async () => {
    await start({ devices: [{ host: '10.0.0.1' }] });
    const entry = platform._entries[0];
    const inFlight = platform._poll(entry);
    await platform.onShutdown('test');
    await inFlight;
    net.requests.length = 0;
    await tick(120_000);
    assert.deepEqual(net.requests, []);
  });

  it('logs an error and registers nothing without configured units', async () => {
    await start({});
    assert.equal(platform.registered.length, 0);
    assert.ok(log.lines.some(([level]) => level === 'error'));
  });
});
