# v0.4.1 — Humidity sensors

## New

- **Humidity sensors.** The humidity reading from each unit's wireless thermometer is now exposed as a separate humidity sensor next to the thermostat, so it appears as its own tile in Apple Home and other Matter controllers. Units without a paired thermometer show an unknown value.

## Upgrading

- Each heat pump gets **one new humidity sensor** in your controller after the upgrade; in Apple Home you may need to assign it to a room. Existing devices, rooms and automations are unaffected.
- Don't want them? Set `humiditySensor` to `false` in the plugin config (default `true`), ideally before upgrading.
- No other changes. Requires Node.js >= 20.3 and Matterbridge >= 3.9.0.

**Full changelog:** https://github.com/maxbengtzen/matterbridge-protoart/compare/v0.4.0...v0.4.1
