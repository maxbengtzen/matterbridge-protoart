# v0.4.2 — Humidity off by default

## Fixed

- **Heat pumps showed up as humidity sensors in Apple Home.** In 0.4.1 the humidity reading was added as a separate sensor, and Apple Home picked it as the main tile of the unit. Humidity is now **off by default**.

## New

- `humidity` setting with three modes:
  - `off` (default): no humidity is exposed.
  - `thermostat` (**recommended**): the humidity reading is added to the thermostat itself. In Apple Home the unit stays a thermostat, and the humidity shows up in the detail view next to mode and temperature.
  - `separate`: the 0.4.1 behaviour (separate sensor). Apple Home may show the unit primarily as a humidity sensor.
- The `humiditySensor` setting from 0.4.1 is replaced by `humidity` and ignored.

## Upgrading

- If you ran 0.4.1, the humidity sensors disappear after the upgrade. Apple Home may keep the old tile until the Home app is restarted.
- To get humidity again, set `humidity` to `thermostat`.
- Nothing else changes. Requires Node.js >= 20.3 and Matterbridge >= 3.9.0.

**Full changelog:** https://github.com/maxbengtzen/matterbridge-protoart/compare/v0.4.1...v0.4.2
