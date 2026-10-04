// Pure helpers and the HTTP client for ProtoArt ME_CN105_ATA_WIFI units.
// Nothing in this file depends on Matterbridge so it can be unit tested on its own.

export const HTTP_TIMEOUT = 5_000;
export const DEFAULT_POLL_INTERVAL = 15_000;
export const MIN_POLL_INTERVAL = 5_000;
export const MAX_BACKOFF = 120_000;

// The units report heatmin/heatmax/coolmin/coolmax = 16/31 and accept 0.5 °C steps.
export const SETPOINT_MIN = 16;
export const SETPOINT_MAX = 31;
export const SETPOINT_STEP = 0.5;

// Matter Thermostat.SystemMode values the plugin supports.
export const SystemMode = { Off: 0, Auto: 1, Cool: 3, Heat: 4, FanOnly: 7, Dry: 8 };

const API_MODE_TO_SYSTEM_MODE = {
  auto: SystemMode.Auto,
  cool: SystemMode.Cool,
  heat: SystemMode.Heat,
  fan: SystemMode.FanOnly,
  fan_only: SystemMode.FanOnly,
  dry: SystemMode.Dry,
};

const SYSTEM_MODE_TO_API_MODE = {
  [SystemMode.Auto]: 'auto',
  [SystemMode.Cool]: 'cool',
  [SystemMode.Heat]: 'heat',
  [SystemMode.FanOnly]: 'fan',
  [SystemMode.Dry]: 'dry',
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function normalizeHost(host) {
  return String(host ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

export function normalizePollInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_POLL_INTERVAL;
  return Math.max(n, MIN_POLL_INTERVAL);
}

/**
 * Turn the plugin config into a list of devices.
 * Prefers the `devices` array; falls back to the legacy comma-separated `hosts` / `deviceNames`.
 *
 * @returns {{ devices: {host: string, name: string, identity: 'ip'|'mac'}[], warnings: string[] }}
 */
export function resolveDevices(config = {}) {
  const warnings = [];
  const raw = [];

  if (Array.isArray(config.devices) && config.devices.length > 0) {
    if (String(config.hosts ?? '').trim()) {
      warnings.push('Both "devices" and the legacy "hosts" setting are configured; "hosts" is ignored.');
    }
    config.devices.forEach((d, i) => {
      raw.push({
        host: normalizeHost(d?.host),
        name: String(d?.name ?? '').trim(),
        identity: d?.identity === 'mac' ? 'mac' : 'ip',
        position: i,
      });
    });
  } else {
    const hosts = String(config.hosts ?? '').split(',').map(normalizeHost);
    const names = String(config.deviceNames ?? '').split(',').map((s) => s.trim());
    if (names.some(Boolean) && names.length !== hosts.filter(Boolean).length) {
      warnings.push(
        `"deviceNames" has ${names.length} entries but "hosts" has ${hosts.filter(Boolean).length}; names are matched by position.`,
      );
    }
    hosts.forEach((host, i) => raw.push({ host, name: names[i] ?? '', identity: 'ip', position: i }));
  }

  const seen = new Set();
  const devices = [];
  for (const r of raw) {
    if (!r.host) {
      if (Array.isArray(config.devices)) warnings.push(`devices[${r.position}] has no host and is ignored.`);
      continue;
    }
    if (seen.has(r.host)) {
      warnings.push(`Host ${r.host} is configured more than once; duplicates are ignored.`);
      continue;
    }
    seen.add(r.host);
    devices.push({ host: r.host, name: r.name || `Heat Pump ${r.position + 1}`, identity: r.identity });
  }
  return { devices, warnings };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Original (v0.1–0.3) identity, derived from the IP address. Kept as default so existing pairings survive upgrades. */
export function ipIdentity(host) {
  return {
    id: `protoart-${host.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    serial: `PA${host.replace(/[^0-9]/g, '').slice(-8)}`,
  };
}

/** Identity derived from the unit's MAC address, stable across DHCP changes. */
export function macIdentity(mac) {
  const hex = String(mac ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return null;
  return { id: `protoart-${hex}`, serial: `PA${hex}` };
}

// ---------------------------------------------------------------------------
// ProtoArt -> Matter
// ---------------------------------------------------------------------------

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise a `/control` response. Missing values are `null` rather than invented defaults,
 * so a broken response is never mistaken for a real reading.
 */
export function parseControl(data) {
  const hp = data?.heatpump;
  if (hp === null || typeof hp !== 'object') {
    throw new Error('Unexpected response: missing "heatpump" section');
  }

  const power = hp.power === 'off' || hp.power === '0' || hp.power === 0 || hp.power === false ? 'off' : 'on';
  const mode = typeof hp.mode === 'string' ? hp.mode.toLowerCase() : 'auto';
  const systemMode = power === 'off' ? SystemMode.Off : (API_MODE_TO_SYSTEM_MODE[mode] ?? SystemMode.Auto);

  const batt = toNumber(data?.sensor?.thermometer?.batt);
  const humidity = toNumber(data?.sensor?.thermometer?.hact);
  const faultCode = typeof hp.fault_code === 'string' ? hp.fault_code : null;

  return {
    power,
    mode,
    systemMode,
    temperature: toNumber(hp.actual_temperature),
    setpoint: toNumber(hp.set_temperature),
    operating: typeof hp.oper === 'boolean' ? hp.oper : null,
    battery: batt === null ? null : Math.min(Math.max(batt, 0), 100),
    humidity: humidity === null ? null : Math.min(Math.max(humidity, 0), 100),
    fault: faultCode && faultCode.toLowerCase() !== 'no error' ? faultCode : null,
    info: {
      mac: data?.wifi?.mac ?? null,
      name: data?.sys?.frname ?? null,
      firmware: data?.fw?.curr ?? null,
    },
  };
}

/** Matter thermostatRunningState / thermostatRunningMode derived from the `oper` flag. */
export function runningStateFor(state) {
  const on = state.power === 'on' && state.operating === true;
  const heat = on && state.mode === 'heat';
  const cool = on && state.mode === 'cool';
  const fan = on && (state.mode === 'fan' || state.mode === 'fan_only');
  return {
    runningState: {
      heat,
      cool,
      fan,
      heatStage2: false,
      coolStage2: false,
      fanStage2: false,
      fanStage3: false,
    },
    // Thermostat.ThermostatRunningMode: Off = 0, Cool = 3, Heat = 4
    runningMode: heat ? 4 : cool ? 3 : 0,
  };
}

/**
 * PowerSource attributes for the wireless thermometer's battery.
 * `batt` is a percentage; Matter stores half-percent steps. No sensor -> unknown (null), not a fake 100 %.
 */
export function batteryAttributes(percent) {
  if (percent === null || percent === undefined) {
    return { batPercentRemaining: null, batChargeLevel: 0, batReplacementNeeded: false };
  }
  return {
    batPercentRemaining: Math.round(percent * 2),
    batChargeLevel: percent <= 10 ? 2 : percent <= 20 ? 1 : 0, // Critical / Warning / Ok
    batReplacementNeeded: percent <= 10,
  };
}

/** RelativeHumidityMeasurement.measuredValue is in 0.01 % steps; no thermometer / no reading -> unknown (null). */
export function humidityValue(percent) {
  return percent === null || percent === undefined ? null : Math.round(percent * 100);
}

// ---------------------------------------------------------------------------
// Matter -> ProtoArt
// ---------------------------------------------------------------------------

/** Round to the unit's 0.5 °C step and clamp to its supported range. */
export function normalizeSetpoint(celsius) {
  const stepped = Math.round(celsius / SETPOINT_STEP) * SETPOINT_STEP;
  return Math.min(Math.max(stepped, SETPOINT_MIN), SETPOINT_MAX);
}

/** API parameters for a Matter SystemMode, or null if the unit cannot do it. */
export function paramsForSystemMode(systemMode) {
  if (systemMode === SystemMode.Off) return { power: 'off' };
  const mode = SYSTEM_MODE_TO_API_MODE[systemMode];
  return mode ? { power: 'on', mode } : null;
}

/**
 * True when an attribute change came from inside the plugin (our own updateAttribute), not from a Matter controller.
 * `offline` is the long-standing marker; newer matter.js prefers the absence of a fabric/session.
 */
export function isLocalContext(context) {
  if (!context) return false;
  if (context.offline === true) return true;
  return context.offline === undefined && context.session === undefined && context.fabric === undefined;
}

// ---------------------------------------------------------------------------
// Polling schedule
// ---------------------------------------------------------------------------

/** Exponential backoff on consecutive failures: base, 2x, 4x ... capped at MAX_BACKOFF. */
export function backoffDelay(base, consecutiveErrors) {
  return Math.min(base * 2 ** Math.min(consecutiveErrors, 5), MAX_BACKOFF);
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/**
 * Talks to a single unit. Requests are serialised (the ESP firmware copes badly with parallel requests),
 * and each unit has its own queue so one dead unit never delays the others.
 */
export class ProtoArtClient {
  #tail = Promise.resolve();
  #abort = new AbortController();
  #fetch;

  constructor(host, { timeout = HTTP_TIMEOUT, fetchImpl = globalThis.fetch } = {}) {
    this.host = host;
    this.timeout = timeout;
    this.#fetch = fetchImpl;
  }

  /** GET /control, returns the parsed JSON. */
  async poll() {
    const res = await this.#enqueue(() => this.#request(`http://${this.host}/control`));
    try {
      return await res.json();
    } catch {
      throw new Error('Response was not valid JSON');
    }
  }

  /** GET /control?cmd=heatpump&key=value..., returns the query string that was sent. */
  async send(params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    await this.#enqueue(() => this.#request(`http://${this.host}/control?cmd=heatpump&${qs}`));
    return qs;
  }

  /** Abort the in-flight request and refuse new ones. */
  close() {
    this.#abort.abort();
  }

  #enqueue(fn) {
    if (this.#abort.signal.aborted) return Promise.reject(new Error('Client closed'));
    const run = this.#tail.then(() => fn());
    this.#tail = run.catch(() => {});
    return run;
  }

  async #request(url) {
    if (this.#abort.signal.aborted) throw new Error('Client closed');
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeout), this.#abort.signal]);
    let res;
    try {
      res = await this.#fetch(url, { signal });
    } catch (err) {
      if (this.#abort.signal.aborted) throw new Error('Client closed');
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeout / 1000}s`);
      }
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }
}
