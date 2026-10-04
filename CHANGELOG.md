# Changelog

## 0.4.0 — 2026-10-04

Reliability release: fixes several bugs found in a code review, makes the plugin report what the heat pump is actually doing, and adds a test suite. Existing installations upgrade without changes to their config or their Apple Home setup.

### Fixed
- `setpointRaiseLower` changed the setpoint by a tenth of the requested amount (a 0.1 °C-unit value was added to a 0.01 °C-unit value). "+1 °C" now raises by 1 °C, and repeated commands accumulate.
- The poll loop could restart itself after shutdown if a poll was in flight, and in-flight requests were never aborted. Shutdown now stops timers and cancels requests.
- Echo suppression compared against the last *polled* value, so setting a value back to what the last poll saw was silently dropped, and attribute values restored at startup could be sent to the unit as commands. Only changes made by a Matter controller are forwarded now.
- The first poll happened a full poll interval after start, so controllers showed placeholder values (21 °C) in the meantime. The state is now read as soon as the Matter server is online.
- A single unreachable unit slowed polling of all units (global backoff). Polling, backoff and request queues are now per unit.
- Missing readings were replaced by made-up defaults (21 °C, "on", 100 % battery). They are now left unknown, and a response without a `heatpump` section is treated as an error.
- Unsupported system modes (e.g. emergency heat) were silently turned into "auto"; they are now ignored with a warning.

### Added
- **Reachability**: a unit that fails 3 polls in a row is reported as unreachable ("No Response" in Apple Home); it recovers automatically.
- **Running state**: Home shows whether the unit is actually heating or cooling (from the unit's `oper` flag).
- **Setpoint limits** of 16–31 °C and 0.5 °C steps, matching the unit. Out-of-range values from a controller are clamped instead of being sent.
- **Optimistic updates + confirmation poll**: the setpoint/mode changes show up immediately, and the unit is re-read 2.5 s after a command (1 s after a failed command) to confirm.
- Slider drags are debounced: only the final setpoint is sent.
- `devices` config: a list of `{ host, name, identity }` entries (see below). The comma-separated `hosts` / `deviceNames` settings still work and are used when `devices` is empty.
- Optional `identity: "mac"` per device: identity derived from the unit's MAC address instead of its IP, so the device survives a DHCP change. Off by default, because switching an existing device makes controllers see a new device.
- Battery level and charge level (OK / warning ≤ 20 % / critical ≤ 10 %) of the wireless thermometer; shown as unknown when no thermometer is paired.
- Config warnings for mismatched names/hosts, duplicate hosts and missing hosts; `http://` prefixes and trailing slashes in hosts are tolerated.
- Test suite (`npm test`, 53 tests, no dependencies) that runs against real `/control` responses and a stub of Matterbridge.
- `package.json`: `files`, `scripts`; `engines.node` raised to `>=20.3.0` (for `AbortSignal.any`).

### Changed
- Code split into `dist/module.js` (platform) and `dist/protoart.js` (client and mapping logic, no Matterbridge dependency).
- Thermostat endpoint is created with 0 dead band, so the mirrored heat/cool setpoints are always valid.
- Poll failures are logged as a warning the first time and at debug level while the failure persists.

### Notes on earlier entries
- 0.3.0's "optimistic state updates" and the removal of the post-command poll were described inaccurately: the code did not update state after commands, and the "Adax 30 s rate limit" referred to another plugin and does not apply to ProtoArt's local HTTP API. 0.4.0 implements the optimistic update and brings back a confirmation poll.
- 0.2.0 mentions a `_polling` flag and a debounced post-command poll that were no longer present in 0.3.0.

### Upgrade notes
- No action needed. Device identities are unchanged, so rooms and automations in Apple Home are kept.
- Recommended: move to the `devices` list in the plugin config. When you do, keep the same IPs and names.
- Not covered: humidity from the wireless thermometer (`hact`) is not exposed yet.

## 0.3.0 — 2026-06-29

### Added
- Serialised API request queue prevents concurrent fetch collisions between poll and commands
- Exponential backoff on consecutive poll failures (doubles interval up to 2 min)
- Optimistic state updates after commands (no post-command poll needed)
- Cleaner error handling with timeout detection on HTTP requests

### Fixed
- Eliminated "No Response" by removing post-command poll that triggered Adax 30s rate limit
- Poll cycle no longer crashes on single-device failure

## 0.2.1 — 2026-06-26

### Fixed
- `onShutdown` now calls `super.onShutdown()` to persist endpoint number mappings across restarts
- `unregisterDevice` only runs when `unregisterOnShutdown` config is `true` (default `false`), preventing Apple Home from losing room assignments after bridge restart

## 0.2.0 — 2026-06-26

### Added
- Wireless temperature sensor battery level (PowerSource with ReplaceableBattery)
- Concurrent poll guard (`_polling` flag) to prevent overlapping poll cycles
- Debounced post-command poll (`_pollTimer`) to avoid duplicate scheduled polls
- Combined `power` + `mode` in a single API request when turning on

### Fixed
- Actual temperature now reads from `actual_temperature` field (was falling back to static 21°C)
- Race condition in `_lastApiValues` Map prevents poll-echo from triggering spurious API commands
- Cleaner shutdown with timer cleanup

## 0.1.0 — 2026-06-25

### Added
- Initial release
- Matter thermostat support for ProtoArt ME_CN105_ATA_WIFI heat pumps
- Poll-based state synchronisation
- Temperature, mode, and power control via Apple Home
- Multi-device support
