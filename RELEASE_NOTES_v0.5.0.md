# v0.5.0 — Fan speed (experimental)

## New

- **Fan speed, opt-in.** Set `fanControl` to `true` and each thermostat gets a fan control (Auto / Low / Medium / High) that follows the unit's fan speed and can be changed from a Matter controller. Changes made on the unit's remote or in its web page show up in the controller.

  | Unit | Matter |
  |---|---|
  | auto | Auto |
  | silent, low | Low |
  | med | Medium |
  | high, superhigh | High |

- Experimental: whether and how a controller presents a fan control on a thermostat varies, and Apple Home may not show it at all.
- Limitations: the unit has no "fan off", so Off from a controller is ignored and the real speed is shown again. `silent` and `superhigh` can't be selected from a controller.

## Upgrading

- Nothing changes unless you turn `fanControl` on. Existing devices, rooms and automations are unaffected.
- Requires Node.js >= 20.3 and Matterbridge >= 3.9.0.

**Full changelog:** https://github.com/maxbengtzen/matterbridge-protoart/compare/v0.4.2...v0.5.0
