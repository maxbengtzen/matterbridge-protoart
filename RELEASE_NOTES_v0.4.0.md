# v0.4.0 — Reliability release

This release fixes several bugs, makes Apple Home show what your heat pumps are actually doing, and adds a test suite. **Upgrading needs no changes**: device identities and the existing config keep working, so rooms and automations in Apple Home stay intact.

## Highlights

- **Fixed:** "+1 °C" from a controller (`setpointRaiseLower`) raised the setpoint by only 0.1 °C.
- **Unreachable units show as "No Response"** in Apple Home after 3 failed polls and recover automatically. Before, stale values were shown as if everything was fine.
- **Heating / cooling state** is now shown, based on the unit's `oper` flag.
- **Correct values from the start:** state is read as soon as Matterbridge is up, instead of showing 21 °C for the first 15 seconds. Missing readings are no longer replaced by invented defaults (21 °C, 100 % battery).
- **Faster, more reliable control:** setpoint changes show immediately, slider drags send only the final value, and the unit is re-read right after each command to confirm.
- **One dead unit no longer slows down the others.** Polling and backoff are per unit.
- **Clean shutdown:** polling really stops and in-flight requests are cancelled.
- **Setpoint range 16–31 °C in 0.5 °C steps**, matching the unit; out-of-range values are clamped.
- **Thermometer battery** with proper charge level (OK / warning / critical), or "unknown" if no thermometer is paired.

## Configuration

- New `devices` list (`host`, `name`, optional `identity`). The old `hosts` / `deviceNames` strings still work, but `devices` is recommended.
- Optional `identity: "mac"` ties a device to the unit's MAC address so it survives an IP change. Off by default; switching an existing device makes controllers see a new device.

## Internal

- Code split into a platform (`dist/module.js`) and a Matterbridge-independent client/mapping module (`dist/protoart.js`).
- 53 tests (`npm test`), using real `/control` responses as fixtures.
- Requires Node.js >= 20.3 and Matterbridge >= 3.9.0 (developed and tested against Matterbridge 3.10.12).

## Corrections to earlier notes

The 0.3.0 changelog described optimistic updates that were not implemented, and referred to an Adax rate limit that does not apply to this plugin. See [CHANGELOG.md](./CHANGELOG.md).

**Full changelog:** https://github.com/maxbengtzen/matterbridge-protoart/compare/v0.3.0...v0.4.0
