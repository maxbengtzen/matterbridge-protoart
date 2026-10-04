import {
  bridgedNode,
  humiditySensor,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  thermostat,
} from 'matterbridge';
import { BridgedDeviceBasicInformation, PowerSource, RelativeHumidityMeasurement, Thermostat } from 'matterbridge/matter/clusters';
import {
  backoffDelay,
  batteryAttributes,
  humidityValue,
  ipIdentity,
  isLocalContext,
  macIdentity,
  normalizePollInterval,
  normalizeSetpoint,
  paramsForSystemMode,
  parseControl,
  ProtoArtClient,
  resolveDevices,
  runningStateFor,
  SETPOINT_MAX,
  SETPOINT_MIN,
} from './protoart.js';

// A unit is reported as unreachable (shown as "No Response" in Apple Home) after this many failed polls in a row.
const UNREACHABLE_AFTER = 3;
// Controllers send a burst of writes while a slider is dragged; only the last one is forwarded.
const SETPOINT_DEBOUNCE = 800;
// After a failed command, re-read the unit so controllers don't keep showing a value it never accepted.
const RESYNC_DELAY = 1_000;
// After a successful command, confirm the unit's real state shortly afterwards. This also overrides any poll that was
// already in flight when the command was sent and still carries the old values.
const CONFIRM_DELAY = 2_500;

export default function initializePlugin(matterbridge, log, config) {
  return new ProtoArtMatterbridgePlatform(matterbridge, log, config);
}

export class ProtoArtMatterbridgePlatform extends MatterbridgeDynamicPlatform {
  /** One entry per configured unit: { name, host, client, device, state, errors, reachable, timer, ... } */
  _entries = [];
  _stopped = false;
  _pollInterval = 15_000;

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
    this._stopped = false;

    const { devices, warnings } = resolveDevices(this.config);
    for (const w of warnings) this.log.warn(w);
    if (devices.length === 0) {
      this.log.error('No ProtoArt units configured. Add at least one entry under "devices" (or an IP in "hosts").');
      return;
    }

    this._pollInterval = normalizePollInterval(this.config.pollInterval);

    for (const cfg of devices) {
      try {
        await this._createDevice(cfg);
      } catch (err) {
        this.log.error(`${cfg.name} (${cfg.host}): not registered — ${err.message}`);
      }
    }

    this.log.info(
      `ProtoArt plugin ready: ${this._entries.length} device(s), poll interval ${Math.round(this._pollInterval / 1000)}s`,
    );
  }

  // Server node is online: read the real state straight away instead of showing defaults for a whole poll interval.
  async onConfigure() {
    await super.onConfigure();
    await Promise.allSettled(this._entries.map((entry) => this._poll(entry)));
  }

  async onChangeLoggerLevel(logLevel) {
    this.log.info(`Logger level changed to ${logLevel}`);
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _resolveIdentity(cfg, client) {
    if (cfg.identity !== 'mac') return ipIdentity(cfg.host);

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const identity = macIdentity(parseControl(await client.poll()).info.mac);
        if (identity) return identity;
        throw new Error('response contains no valid wifi.mac');
      } catch (err) {
        lastError = err;
        if (attempt < 3) await this._sleep(2_000);
      }
    }
    throw new Error(`identity "mac" requires the unit to be reachable at startup (${lastError.message})`);
  }

  async _createDevice(cfg) {
    const { name, host } = cfg;
    const client = new ProtoArtClient(host);
    const { id, serial } = await this._resolveIdentity(cfg, client);

    const device = new MatterbridgeEndpoint([thermostat, bridgedNode], { id }, this.config.debug)
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, 0xfff1, 'ProtoArt', 'Heat Pump')
      // Heat and cool setpoints are mirrored (the unit has a single target), so no dead band; limits match the unit.
      .createDefaultThermostatClusterServer(21, 21, 21, 0, SETPOINT_MIN, SETPOINT_MAX, SETPOINT_MIN, SETPOINT_MAX)
      // Battery of the unit's wireless thermometer; reports "unknown" until a reading arrives.
      .createDefaultPowerSourceReplaceableBatteryClusterServer(null)
      .addRequiredClusterServers();

    // Humidity reported by the unit's wireless thermometer, as a separate sensor tile in controllers.
    const humidityDevice =
      this.config.humiditySensor === false
        ? null
        : device
            .addChildDeviceType('Humidity', [humiditySensor], {}, this.config.debug)
            .createDefaultRelativeHumidityMeasurementClusterServer(null, 0, 10_000)
            .addRequiredClusterServers();

    const entry = {
      name,
      host,
      client,
      device,
      humidityDevice,
      state: null,
      errors: 0,
      reachable: true,
      polling: false,
      timer: null,
      setpointTimer: null,
      pendingSetpoint: null,
      fault: null,
    };

    await this.registerDevice(device);

    // Only changes made by a Matter controller are forwarded; our own updateAttribute calls are ignored.
    const fromController = (handler) => (value, _old, context) => {
      if (isLocalContext(context)) return;
      handler(value);
    };

    device.subscribeAttribute(
      Thermostat.id,
      'systemMode',
      fromController((value) => {
        this.log.info(`${name}: systemMode changed to ${value}`);
        this._handleModeChange(entry, value);
      }),
      this.log,
    );

    device.subscribeAttribute(
      Thermostat.id,
      'occupiedHeatingSetpoint',
      fromController((value) => {
        this.log.info(`${name}: heatingSetpoint changed to ${value / 100}°C`);
        this._queueSetpoint(entry, value / 100);
      }),
      this.log,
    );

    device.subscribeAttribute(
      Thermostat.id,
      'occupiedCoolingSetpoint',
      fromController((value) => {
        this.log.info(`${name}: coolingSetpoint changed to ${value / 100}°C`);
        this._queueSetpoint(entry, value / 100);
      }),
      this.log,
    );

    device.addCommandHandler('identify', ({ request: { identifyTime } }) => {
      device.log.info(`Command identify called identifyTime ${identifyTime}`);
    });

    device.addCommandHandler('triggerEffect', ({ request: { effectIdentifier, effectVariant } }) => {
      device.log.info(`Command triggerEffect called ${effectIdentifier} ${effectVariant}`);
    });

    device.addCommandHandler('setpointRaiseLower', ({ request: { mode, amount } }) => {
      const lookupSetpointAdjustMode = ['Heat', 'Cool', 'Both'];
      // `amount` is in steps of 0.1 °C; setpoint attributes are in steps of 0.01 °C.
      const delta = amount / 10;
      device.log.info(`Command setpointRaiseLower called with mode: ${lookupSetpointAdjustMode[mode]} amount: ${delta}`);
      const current = device.getAttribute(
        Thermostat.id,
        mode === 1 ? 'occupiedCoolingSetpoint' : 'occupiedHeatingSetpoint',
        this.log,
      );
      const base = current ?? (entry.state?.setpoint ?? 21) * 100;
      this._queueSetpoint(entry, base / 100 + delta);
    });

    this._entries.push(entry);
    this.log.info(`Registered device "${name}" — ${host}`);
  }

  // -------------------------------------------------------------------------
  // Matter -> unit
  // -------------------------------------------------------------------------

  _handleModeChange(entry, systemMode) {
    const params = paramsForSystemMode(systemMode);
    if (!params) {
      this.log.warn(`${entry.name}: system mode ${systemMode} is not supported by the unit, ignoring`);
      this._schedulePoll(entry, RESYNC_DELAY);
      return;
    }
    if (entry.state?.systemMode === systemMode) return;
    this._sendCommand(entry, params).then((ok) => {
      if (ok && entry.state) entry.state.systemMode = systemMode;
    });
  }

  _queueSetpoint(entry, celsius) {
    entry.pendingSetpoint = normalizeSetpoint(celsius);
    // Reflect the (rounded/clamped) value in both setpoints right away so controllers show it and
    // consecutive setpointRaiseLower commands accumulate. These are local changes and are not echoed back.
    this._mirrorSetpoint(entry, entry.pendingSetpoint);

    if (entry.setpointTimer) clearTimeout(entry.setpointTimer);
    entry.setpointTimer = setTimeout(() => this._flushSetpoint(entry), SETPOINT_DEBOUNCE);
  }

  _mirrorSetpoint(entry, celsius) {
    const value = Math.round(celsius * 100);
    for (const attribute of ['occupiedHeatingSetpoint', 'occupiedCoolingSetpoint']) {
      entry.device.updateAttribute(Thermostat.id, attribute, value, this.log).catch((err) => {
        this.log.debug(`${entry.name}: could not update ${attribute}: ${err.message}`);
      });
    }
  }

  async _flushSetpoint(entry) {
    const celsius = entry.pendingSetpoint;
    entry.setpointTimer = null;
    entry.pendingSetpoint = null;
    if (celsius === null || this._stopped) return;
    if (entry.state?.setpoint === celsius) return;

    const ok = await this._sendCommand(entry, { set_temperature: celsius.toFixed(1) });
    if (ok && entry.state) entry.state.setpoint = celsius;
  }

  async _sendCommand(entry, params) {
    try {
      const qs = await entry.client.send(params);
      this.log.info(`${entry.name}: command sent (${entry.host}): ${qs}`);
      this._schedulePoll(entry, CONFIRM_DELAY);
      return true;
    } catch (err) {
      if (!this._stopped) {
        this.log.error(`${entry.name}: command to ${entry.host} failed: ${err.message}`);
        this._schedulePoll(entry, RESYNC_DELAY);
      }
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Unit -> Matter
  // -------------------------------------------------------------------------

  _schedulePoll(entry, delay) {
    if (this._stopped) return;
    if (entry.timer) clearTimeout(entry.timer);
    const actualDelay = delay ?? backoffDelay(this._pollInterval, entry.errors);
    if (delay === undefined && entry.errors > 0) {
      this.log.debug(`${entry.name}: backoff, next poll in ${Math.round(actualDelay / 1000)}s (failure #${entry.errors})`);
    }
    entry.timer = setTimeout(() => this._poll(entry), actualDelay);
  }

  async _poll(entry) {
    if (entry.polling || this._stopped) return;
    entry.polling = true;
    try {
      let state;
      try {
        state = parseControl(await entry.client.poll());
      } catch (err) {
        await this._onPollFailure(entry, err);
        return;
      }
      entry.errors = 0;
      await this._setReachable(entry, true);
      await this._applyState(entry, state);
    } catch (err) {
      this.log.error(`${entry.name}: failed to apply state: ${err.message}`);
    } finally {
      entry.polling = false;
      this._schedulePoll(entry);
    }
  }

  async _onPollFailure(entry, err) {
    if (this._stopped) return;
    entry.errors++;
    if (entry.errors === 1) {
      this.log.warn(`${entry.name}: poll failed: ${err.message}`);
    } else {
      this.log.debug(`${entry.name}: poll failed (#${entry.errors}): ${err.message}`);
    }
    if (entry.errors === UNREACHABLE_AFTER) {
      this.log.error(`${entry.name}: ${entry.host} did not respond ${entry.errors} times in a row, marking as unreachable`);
      await this._setReachable(entry, false);
    }
  }

  async _setReachable(entry, reachable) {
    if (entry.reachable === reachable) return;
    entry.reachable = reachable;
    if (reachable) this.log.info(`${entry.name}: ${entry.host} is reachable again`);
    const cluster = BridgedDeviceBasicInformation.id;
    await entry.device.updateAttribute(cluster, 'reachable', reachable, this.log);
    await entry.device.triggerEvent(cluster, 'reachableChanged', { reachableNewValue: reachable }, this.log);
  }

  async _applyState(entry, state) {
    const { device, name } = entry;
    entry.state = state;

    if (state.fault !== entry.fault) {
      if (state.fault) this.log.warn(`${name}: heat pump reports fault "${state.fault}"`);
      else this.log.info(`${name}: heat pump fault cleared`);
      entry.fault = state.fault;
    }

    if (state.temperature !== null) {
      await device.updateAttribute(Thermostat.id, 'localTemperature', Math.round(state.temperature * 100), this.log);
    }

    // A setpoint the user just changed is still waiting to be sent; don't overwrite it with the old reading.
    if (state.setpoint !== null && !entry.setpointTimer) {
      const value = Math.round(Math.min(Math.max(state.setpoint, SETPOINT_MIN), SETPOINT_MAX) * 100);
      await device.updateAttribute(Thermostat.id, 'occupiedHeatingSetpoint', value, this.log);
      await device.updateAttribute(Thermostat.id, 'occupiedCoolingSetpoint', value, this.log);
    }

    await device.updateAttribute(Thermostat.id, 'systemMode', state.systemMode, this.log);

    const { runningState, runningMode } = runningStateFor(state);
    await device.updateAttribute(Thermostat.id, 'thermostatRunningState', runningState, this.log);
    await device.updateAttribute(Thermostat.id, 'thermostatRunningMode', runningMode, this.log);

    for (const [attribute, value] of Object.entries(batteryAttributes(state.battery))) {
      await device.updateAttribute(PowerSource.id, attribute, value, this.log);
    }

    if (entry.humidityDevice) {
      await entry.humidityDevice.updateAttribute(
        RelativeHumidityMeasurement.id,
        'measuredValue',
        humidityValue(state.humidity),
        this.log,
      );
    }
  }

  // -------------------------------------------------------------------------

  async onShutdown(reason) {
    this.log.info('ProtoArt plugin shutdown', reason);
    this._stopped = true;
    for (const entry of this._entries) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.setpointTimer) clearTimeout(entry.setpointTimer);
      entry.client.close();
    }
    if (this.config.unregisterOnShutdown === true) {
      for (const { device } of this._entries) {
        await this.unregisterDevice(device).catch(() => {});
      }
    }
    this._entries = [];
    await super.onShutdown(reason);
  }
}
