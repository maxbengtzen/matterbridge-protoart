import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  backoffDelay,
  batteryAttributes,
  humidityValue,
  ipIdentity,
  isLocalContext,
  macIdentity,
  MAX_BACKOFF,
  normalizeHost,
  normalizeHumidityMode,
  normalizePollInterval,
  normalizeSetpoint,
  paramsForSystemMode,
  parseControl,
  ProtoArtClient,
  resolveDevices,
  runningStateFor,
  SystemMode,
} from '../dist/protoart.js';

// Trimmed /control response from a real ME_CN105_ATA_WIFI (fw 3.4.1); MAC addresses are made up.
const sample = (overrides = {}, sensor) => ({
  wifi: { mac: 'AA:BB:CC:00:11:22', ip: '192.168.0.151' },
  fw: { curr: '3.4.1', model: 'ME_CN105_ATA_WIFI' },
  sys: { frname: 'Allrum', id: '172371260339696' },
  heatpump: {
    power: 'on',
    mode: 'heat',
    set_temperature: 20,
    oper: true,
    fault_code: 'No error',
    actual_temperature: 22.5,
    ...overrides,
  },
  sensor: sensor === undefined ? { thermometer: { batt: 71, tact: 22.5, hact: 57 } } : sensor,
});

describe('resolveDevices', () => {
  it('reads the devices array', () => {
    const { devices, warnings } = resolveDevices({
      devices: [{ host: '192.168.0.151', name: 'Living room' }, { host: 'http://192.168.0.152/', identity: 'mac' }],
    });
    assert.deepEqual(devices, [
      { host: '192.168.0.151', name: 'Living room', identity: 'ip' },
      { host: '192.168.0.152', name: 'Heat Pump 2', identity: 'mac' },
    ]);
    assert.deepEqual(warnings, []);
  });

  it('falls back to legacy hosts/deviceNames', () => {
    const { devices } = resolveDevices({ hosts: '192.168.0.151, 192.168.0.152', deviceNames: 'LVP Allrum,Hall' });
    assert.deepEqual(
      devices.map((d) => [d.host, d.name]),
      [['192.168.0.151', 'LVP Allrum'], ['192.168.0.152', 'Hall']],
    );
  });

  it('uses numbered default names and tolerates empty config', () => {
    assert.deepEqual(resolveDevices({ hosts: '10.0.0.1' }).devices[0].name, 'Heat Pump 1');
    assert.deepEqual(resolveDevices({}).devices, []);
  });

  it('warns when name and host counts differ', () => {
    const { warnings } = resolveDevices({ hosts: '10.0.0.1,10.0.0.2', deviceNames: 'Only one' });
    assert.equal(warnings.length, 1);
  });

  it('prefers devices over hosts and warns', () => {
    const { devices, warnings } = resolveDevices({ hosts: '10.0.0.9', devices: [{ host: '10.0.0.1' }] });
    assert.deepEqual(devices.map((d) => d.host), ['10.0.0.1']);
    assert.equal(warnings.length, 1);
  });

  it('drops duplicates and entries without a host', () => {
    const { devices, warnings } = resolveDevices({ devices: [{ host: '10.0.0.1' }, { host: '10.0.0.1' }, { name: 'x' }] });
    assert.equal(devices.length, 1);
    assert.equal(warnings.length, 2);
  });
});

describe('config normalisation', () => {
  it('normalizeHost strips scheme and trailing slash', () => {
    assert.equal(normalizeHost(' http://heatpump.local/ '), 'heatpump.local');
  });

  it('normalizePollInterval enforces the minimum and survives garbage', () => {
    assert.equal(normalizePollInterval(1000), 5000);
    assert.equal(normalizePollInterval('20000'), 20000);
    assert.equal(normalizePollInterval(undefined), 15000);
    assert.equal(normalizePollInterval('abc'), 15000);
  });
});

describe('identity', () => {
  it('keeps the original IP-derived identity', () => {
    assert.deepEqual(ipIdentity('192.168.0.151'), { id: 'protoart-192_168_0_151', serial: 'PA21680151' });
  });

  it('derives a stable identity from the MAC', () => {
    assert.deepEqual(macIdentity('aa:bb:cc:00:11:22'), { id: 'protoart-AABBCC001122', serial: 'PAAABBCC001122' });
    assert.equal(macIdentity('nonsense'), null);
    assert.equal(macIdentity(undefined), null);
  });
});

describe('parseControl', () => {
  it('maps a real response', () => {
    const s = parseControl(sample());
    assert.equal(s.systemMode, SystemMode.Heat);
    assert.equal(s.temperature, 22.5);
    assert.equal(s.setpoint, 20);
    assert.equal(s.operating, true);
    assert.equal(s.battery, 71);
    assert.equal(s.humidity, 57);
    assert.equal(s.fault, null);
    assert.equal(s.info.mac, 'AA:BB:CC:00:11:22');
  });

  it('treats power off as system mode Off whatever the mode says', () => {
    for (const power of ['off', '0', 0, false]) {
      assert.equal(parseControl(sample({ power })).systemMode, SystemMode.Off);
    }
  });

  it('maps all modes', () => {
    const expect = { auto: 1, cool: 3, heat: 4, fan: 7, fan_only: 7, dry: 8 };
    for (const [mode, sm] of Object.entries(expect)) assert.equal(parseControl(sample({ mode })).systemMode, sm);
  });

  it('does not invent readings when values are missing', () => {
    const s = parseControl(sample({ actual_temperature: undefined, set_temperature: undefined, oper: undefined }, null));
    assert.equal(s.temperature, null);
    assert.equal(s.setpoint, null);
    assert.equal(s.operating, null);
    assert.equal(s.battery, null);
    assert.equal(s.humidity, null);
  });

  it('rejects responses without a heatpump section', () => {
    assert.throws(() => parseControl({}), /heatpump/);
    assert.throws(() => parseControl(null), /heatpump/);
  });

  it('surfaces fault codes', () => {
    assert.equal(parseControl(sample({ fault_code: 'E6' })).fault, 'E6');
  });

  it('clamps battery to 0-100', () => {
    assert.equal(parseControl(sample({}, { thermometer: { batt: 150 } })).battery, 100);
  });
});

describe('runningStateFor', () => {
  it('reports heating only when the unit is actually operating', () => {
    assert.deepEqual(runningStateFor(parseControl(sample())).runningMode, 4);
    assert.equal(runningStateFor(parseControl(sample())).runningState.heat, true);
    assert.equal(runningStateFor(parseControl(sample({ oper: false }))).runningMode, 0);
    assert.equal(runningStateFor(parseControl(sample({ power: 'off' }))).runningMode, 0);
  });

  it('reports cooling', () => {
    const r = runningStateFor(parseControl(sample({ mode: 'cool' })));
    assert.equal(r.runningMode, 3);
    assert.equal(r.runningState.cool, true);
  });
});

describe('batteryAttributes', () => {
  it('uses half-percent steps and charge levels', () => {
    assert.deepEqual(batteryAttributes(71), { batPercentRemaining: 142, batChargeLevel: 0, batReplacementNeeded: false });
    assert.equal(batteryAttributes(20).batChargeLevel, 1);
    assert.deepEqual(batteryAttributes(5), { batPercentRemaining: 10, batChargeLevel: 2, batReplacementNeeded: true });
  });

  it('reports unknown rather than a fake 100 % without a sensor', () => {
    assert.equal(batteryAttributes(null).batPercentRemaining, null);
  });
});

describe('normalizeHumidityMode', () => {
  it('defaults to off and rejects unknown values', () => {
    assert.equal(normalizeHumidityMode(undefined), 'off');
    assert.equal(normalizeHumidityMode(''), 'off');
    assert.equal(normalizeHumidityMode('thermostat'), 'thermostat');
    assert.equal(normalizeHumidityMode('separate'), 'separate');
    assert.equal(normalizeHumidityMode('both'), null);
    assert.equal(normalizeHumidityMode(true), null);
  });
});

describe('humidityValue', () => {
  it('uses 0.01 % steps and unknown without a reading', () => {
    assert.equal(humidityValue(57), 5700);
    assert.equal(humidityValue(55.5), 5550);
    assert.equal(humidityValue(null), null);
  });

  it('clamps readings to 0-100 %', () => {
    assert.equal(parseControl(sample({}, { thermometer: { hact: 140 } })).humidity, 100);
  });
});

describe('Matter -> ProtoArt', () => {
  it('rounds to 0.5 and clamps to 16-31', () => {
    assert.equal(normalizeSetpoint(21.3), 21.5);
    assert.equal(normalizeSetpoint(21.2), 21);
    assert.equal(normalizeSetpoint(10), 16);
    assert.equal(normalizeSetpoint(40), 31);
  });

  it('maps system modes to API parameters', () => {
    assert.deepEqual(paramsForSystemMode(0), { power: 'off' });
    assert.deepEqual(paramsForSystemMode(4), { power: 'on', mode: 'heat' });
    assert.deepEqual(paramsForSystemMode(7), { power: 'on', mode: 'fan' });
    assert.equal(paramsForSystemMode(2), null);
    assert.equal(paramsForSystemMode(9), null);
  });

  it('setpointRaiseLower arithmetic: amount is in 0.1 °C, attributes in 0.01 °C', () => {
    // regression for v0.3.0, which added `amount` (0.1 °C) straight onto a 0.01 °C value
    const current = 2100;
    const amount = 10; // +1.0 °C
    assert.equal(normalizeSetpoint(current / 100 + amount / 10), 22);
  });
});

describe('isLocalContext', () => {
  it('recognises plugin-originated changes', () => {
    assert.equal(isLocalContext({ offline: true }), true);
    assert.equal(isLocalContext({}), true);
  });

  it('recognises controller-originated changes', () => {
    assert.equal(isLocalContext({ offline: false, session: {}, fabric: 1 }), false);
    assert.equal(isLocalContext({ session: {}, fabric: 1 }), false);
    assert.equal(isLocalContext(undefined), false);
  });
});

describe('backoffDelay', () => {
  it('doubles per failure and is capped', () => {
    assert.equal(backoffDelay(15_000, 0), 15_000);
    assert.equal(backoffDelay(15_000, 1), 30_000);
    assert.equal(backoffDelay(15_000, 2), 60_000);
    assert.equal(backoffDelay(15_000, 3), MAX_BACKOFF);
    assert.equal(backoffDelay(15_000, 50), MAX_BACKOFF);
  });
});

describe('ProtoArtClient', () => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  it('polls /control and sends commands with encoded query strings', async () => {
    const urls = [];
    const client = new ProtoArtClient('10.0.0.1', {
      fetchImpl: async (url) => {
        urls.push(url);
        return ok({ heatpump: {} });
      },
    });
    assert.deepEqual(await client.poll(), { heatpump: {} });
    assert.equal(await client.send({ power: 'on', mode: 'heat' }), 'power=on&mode=heat');
    assert.deepEqual(urls, ['http://10.0.0.1/control', 'http://10.0.0.1/control?cmd=heatpump&power=on&mode=heat']);
  });

  it('serialises requests', async () => {
    let active = 0;
    let maxActive = 0;
    const client = new ProtoArtClient('h', {
      fetchImpl: async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return ok({});
      },
    });
    await Promise.all([client.poll(), client.send({ power: 'on' }), client.poll()]);
    assert.equal(maxActive, 1);
  });

  it('keeps working after a failed request', async () => {
    let calls = 0;
    const client = new ProtoArtClient('h', {
      fetchImpl: async () => {
        if (calls++ === 0) return { ok: false, status: 500 };
        return ok({ fine: true });
      },
    });
    await assert.rejects(client.poll(), /HTTP 500/);
    assert.deepEqual(await client.poll(), { fine: true });
  });

  it('turns aborts into a readable timeout error', async () => {
    const client = new ProtoArtClient('h', {
      timeout: 20,
      fetchImpl: (_url, { signal }) =>
        new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason))),
    });
    await assert.rejects(client.poll(), /timed out after 0\.02s/);
  });

  it('rejects invalid JSON', async () => {
    const client = new ProtoArtClient('h', {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }),
    });
    await assert.rejects(client.poll(), /not valid JSON/);
  });

  it('close() aborts the in-flight request and refuses new ones', async () => {
    const client = new ProtoArtClient('h', {
      fetchImpl: (_url, { signal }) =>
        new Promise((_res, rej) => signal.addEventListener('abort', () => rej(signal.reason))),
    });
    const pending = client.poll();
    client.close();
    await assert.rejects(pending, /Client closed/);
    await assert.rejects(client.poll(), /Client closed/);
  });
});
