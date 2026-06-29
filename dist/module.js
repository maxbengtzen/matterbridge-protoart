import {
  bridgedNode,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  thermostat,
} from 'matterbridge';
import { Thermostat } from 'matterbridge/matter/clusters';

const HTTP_TIMEOUT = 5_000;

export default function initializePlugin(matterbridge, log, config) {
  return new ProtoArtMatterbridgePlatform(matterbridge, log, config);
}

export class ProtoArtMatterbridgePlatform extends MatterbridgeDynamicPlatform {
  _devices = [];
  _pollTimer = null;
  _lastApiValues = new Map();
  _consecutiveErrors = 0;
  _apiQueue = [];
  _apiQueueProcessing = false;

  constructor(matterbridge, log, config) {
    super(matterbridge, log, config);
    this.config = config;
    if (
      typeof this.verifyMatterbridgeVersion !== 'function' ||
      !this.verifyMatterbridgeVersion('3.9.0')
    ) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.9.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }
    this.log.info('Initializing ProtoArt Matterbridge platform');
  }

  async onStart(reason) {
    this.log.info('onStart called with reason:', reason ?? 'none');
    await this.ready;
    await this.clearSelect();

    const hosts = (this.config.hosts ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const names = (this.config.deviceNames ?? '')
      .split(',')
      .map((s) => s.trim());
    const pollInterval = Math.max(this.config.pollInterval ?? 15_000, 5_000);

    if (hosts.length === 0) {
      this.log.error('No ProtoArt hosts configured. Set at least one IP address in hosts.');
      return;
    }

    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i];
      const name = names[i] || `Heat Pump ${i + 1}`;
      await this._createDevice(name, host);
    }

    this.log.info(
      `ProtoArt plugin ready: ${this._devices.length} device(s), poll interval ${Math.round(pollInterval / 1000)}s`,
    );

    if (this._devices.length > 0) {
      this._schedulePoll();
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _enqueueApiCall(fn) {
    return new Promise((resolve, reject) => {
      this._apiQueue.push({ fn, resolve, reject });
      this._processApiQueue();
    });
  }

  async _processApiQueue() {
    if (this._apiQueueProcessing) return;
    this._apiQueueProcessing = true;

    while (this._apiQueue.length > 0) {
      const { fn, resolve, reject } = this._apiQueue.shift();
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }

    this._apiQueueProcessing = false;
  }

  async _createDevice(name, host) {
    const id = `protoart-${host.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const serial = `PA${host.replace(/[^0-9]/g, '').slice(-8)}`;

    const device = new MatterbridgeEndpoint(
      [thermostat, bridgedNode],
      { id },
      this.config.debug,
    )
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        name,
        serial,
        0xfff1,
        'ProtoArt',
        'Heat Pump',
      )
      .createDefaultThermostatClusterServer(21, 19, 23)
      .createDefaultPowerSourceReplaceableBatteryClusterServer(100)
      .addRequiredClusterServers();

    await this.registerDevice(device);

    device.subscribeAttribute(
      Thermostat.id,
      'systemMode',
      (value) => {
        const prev = this._lastApiValues.get(host);
        if (prev && prev.mode === value) return;
        this.log.info(`${name}: systemMode changed to ${value}`);
        this._handleModeChange(host, value);
      },
      this.log,
    );

    device.subscribeAttribute(
      Thermostat.id,
      'occupiedHeatingSetpoint',
      (value) => {
        const prev = this._lastApiValues.get(host);
        if (prev && prev.setpoint === value) return;
        const temp = value / 100;
        this.log.info(`${name}: heatingSetpoint changed to ${temp}\u00b0C`);
        this._sendCommand(host, 'set_temperature', temp.toFixed(1));
      },
      this.log,
    );

    device.subscribeAttribute(
      Thermostat.id,
      'occupiedCoolingSetpoint',
      (value) => {
        const prev = this._lastApiValues.get(host);
        if (prev && prev.setpoint === value) return;
        const temp = value / 100;
        this.log.info(`${name}: coolingSetpoint changed to ${temp}\u00b0C`);
        this._sendCommand(host, 'set_temperature', temp.toFixed(1));
      },
      this.log,
    );

    device.addCommandHandler('identify', ({ request: { identifyTime } }) => {
      device.log.info(`Command identify called identifyTime ${identifyTime}`);
    });

    device.addCommandHandler('triggerEffect', ({ request: { effectIdentifier, effectVariant } }) => {
      device.log.info(
        `Command triggerEffect called ${effectIdentifier} ${effectVariant}`,
      );
    });

    device.addCommandHandler('setpointRaiseLower', ({ request: { mode, amount } }) => {
      const lookupSetpointAdjustMode = ['Heat', 'Cool', 'Both'];
      device.log.info(
        `Command setpointRaiseLower called with mode: ${lookupSetpointAdjustMode[mode]} amount: ${amount / 10}`,
      );
      const currentSetpoint = device.getAttribute(
        Thermostat.id,
        mode === 1 ? 'occupiedCoolingSetpoint' : 'occupiedHeatingSetpoint',
        this.log,
      );
      const newSetpoint = ((currentSetpoint ?? 2100) + amount) / 100;
      this._sendCommand(host, 'set_temperature', newSetpoint.toFixed(1));
    });

    this._devices.push({ name, host, device });
    this.log.info(`Registered device "${name}" \u2014 ${host}`);
  }

  _handleModeChange(host, systemMode) {
    if (systemMode === 0) {
      this._sendCommand(host, { power: 'off' });
    } else {
      const modeMap = { 1: 'auto', 3: 'cool', 4: 'heat', 7: 'fan', 8: 'dry' };
      const mode = modeMap[systemMode] || 'auto';
      this._sendCommand(host, { power: 'on', mode });
    }
  }

  async _pollDevice(host) {
    const res = await fetch(`http://${host}/control`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT),
    }).catch((err) => {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`Request timed out after ${HTTP_TIMEOUT / 1000}s`);
      }
      throw err;
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async _pollAll() {
    let allSucceeded = true;
    for (const { name, host, device } of this._devices) {
      try {
        const data = await this._enqueueApiCall(() => this._pollDevice(host));
        this._updateState(device, data, name, host);
      } catch (err) {
        allSucceeded = false;
        this.log.error(`${name}: Poll error ${err.message}`);
      }
    }
    return allSucceeded;
  }

  _schedulePoll(delay) {
    if (this._pollTimer) clearTimeout(this._pollTimer);
    const base = Math.max(this.config.pollInterval ?? 15_000, 5_000);
    const factor = Math.min(this._consecutiveErrors, 5);
    const actualDelay = delay ?? Math.min(base * Math.pow(2, factor), 120_000);
    if (actualDelay !== base) {
      this.log.info(
        `Backoff active: next poll in ${Math.round(actualDelay / 1000)}s (base ${base / 1000}s, error #${this._consecutiveErrors})`,
      );
    }
    this._pollTimer = setTimeout(() => this._doPoll(), actualDelay);
  }

  async _doPoll() {
    try {
      const success = await this._pollAll();
      this._consecutiveErrors = success ? 0 : this._consecutiveErrors + 1;
    } catch (err) {
      this._consecutiveErrors++;
      this.log.error(`Poll cycle error: ${err.message}`);
    } finally {
      this._schedulePoll();
    }
  }

  _updateState(device, data, name, host) {
    const hp = data?.heatpump ?? data ?? {};
    const temperature = Number(hp.actual_temperature ?? hp.temperature ?? hp.temp ?? 21);
    const setpoint = Number(hp.set_temperature ?? hp.setpoint ?? hp.target ?? 21);
    const power = hp.power ?? 'on';
    const mode = hp.mode ?? 'auto';
    const systemMode =
      power === 'off' || power === '0' || power === false
        ? 0
        : ({ auto: 1, cool: 3, heat: 4, fan: 7, fan_only: 7, dry: 8 }[mode] ?? 1);

    this._lastApiValues.set(host, {
      mode: systemMode,
      setpoint: Math.round(setpoint * 100),
    });

    const battery = data?.sensor?.thermometer?.batt;
    if (battery != null) {
      device.updateAttribute(47, 'batPercentRemaining', battery * 2, this.log);
    } else {
      device.updateAttribute(47, 'batPercentRemaining', 200, this.log);
    }

    device.updateAttribute(
      Thermostat.id,
      'localTemperature',
      Math.round(temperature * 100),
      this.log,
    );

    device.updateAttribute(
      Thermostat.id,
      'occupiedHeatingSetpoint',
      Math.round(setpoint * 100),
      this.log,
    );
    device.updateAttribute(
      Thermostat.id,
      'occupiedCoolingSetpoint',
      Math.round(setpoint * 100),
      this.log,
    );

    device.updateAttribute(Thermostat.id, 'systemMode', systemMode, this.log);
  }

  async _sendCommand(host, params, value) {
    try {
      if (typeof params === 'string') {
        params = { [params]: value };
      }
      const qs = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
      const url = `http://${host}/control?cmd=heatpump&${qs}`;
      await this._enqueueApiCall(async () => {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(HTTP_TIMEOUT),
        }).catch((err) => {
          if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            throw new Error(`Request timed out after ${HTTP_TIMEOUT / 1000}s`);
          }
          throw err;
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.log.info(`Command sent to ${host}: ${qs}`);
      });
    } catch (err) {
      this.log.error(`Command ${host}: ${err.message}`);
    }
  }

  async onShutdown(reason) {
    this.log.info('ProtoArt plugin shutdown', reason);
    if (this._pollTimer) clearTimeout(this._pollTimer);
    if (this.config.unregisterOnShutdown === true) {
      for (const { device } of this._devices) {
        await this.unregisterDevice(device).catch(() => {});
      }
    }
    this._devices = [];
    await super.onShutdown(reason);
  }
}
