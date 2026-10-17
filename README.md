# matterbridge-protoart

Matterbridge plugin for ProtoArt ME_CN105_ATA_WIFI heat pumps.

Exposes ProtoArt heat pumps as Matter thermostats via [Matterbridge](https://github.com/Luligu/matterbridge).

## Prerequisites

- [Matterbridge](https://github.com/Luligu/matterbridge) >= 3.9.0
- Node.js >= 20.3
- One or more ProtoArt ME_CN105_ATA_WIFI units on your local network

## Installation

### Via Matterbridge frontend (if published on npm)

```
matterbridge --add matterbridge-protoart
matterbridge --enable matterbridge-protoart
```

### Manual installation

Clone or copy the plugin to your Matterbridge plugins directory:

```bash
git clone https://github.com/maxbengtzen/matterbridge-protoart.git ~/Matterbridge/matterbridge-protoart
matterbridge --add ~/Matterbridge/matterbridge-protoart
matterbridge --enable ~/Matterbridge/matterbridge-protoart
```

## Configuration

Configure via the Matterbridge frontend (`http://<host>:8283`) or by editing the plugin's config file.

| Field | Type | Default | Description |
|---|---|---|---|
| `devices` | array | `[]` | One entry per unit: `host` (required), `name`, `identity` (`ip` or `mac`) |
| `pollInterval` | number | `15000` | Polling interval per unit in milliseconds (minimum 5000) |
| `humidity` | string | `off` | Humidity from the wireless thermometer: `off`, `thermostat` (recommended, added to the thermostat itself) or `separate` (separate humidity sensor; Apple Home may then show the unit primarily as a humidity sensor) |
| `fanControl` | boolean | `false` | **Experimental.** Add a fan control (Auto / Low / Medium / High) to each thermostat |
| `debug` | boolean | `false` | Verbose debug logging |
| `unregisterOnShutdown` | boolean | `false` | Unregister devices when Matterbridge stops (development only; loses room assignments in Apple Home) |
| `hosts`, `deviceNames` | string | (empty) | **Legacy**: comma-separated hosts and names, matched by position. Used only when `devices` is empty |

### Example

```json
{
  "devices": [
    { "host": "192.168.0.151", "name": "Living Room" },
    { "host": "192.168.0.152", "name": "Hallway" }
  ],
  "pollInterval": 15000,
  "debug": false
}
```

### Device identity

By default a device's identity is derived from its IP address (as in earlier versions). If the unit gets a new IP from DHCP, controllers see it as a new device, so give your units a fixed IP or a DHCP reservation. Alternatively set `"identity": "mac"` to derive the identity from the unit's MAC address. The unit must then be reachable when Matterbridge starts. Switching an existing device between `ip` and `mac` makes controllers see a new device.

## How it works

Each unit is polled at `/control` (every unit on its own schedule) and exposed as a Matter thermostat with:

- Current temperature (`localTemperature`, from the wireless thermometer if one is paired)
- Target temperature (`occupiedHeatingSetpoint` / `occupiedCoolingSetpoint`, always the same value, 16–31 °C in 0.5 °C steps)
- System mode: off, auto, cool, heat, fan only, dry
- Running state (heating / cooling), from the unit's `oper` flag
- Battery level of the wireless thermometer (shown as unknown if none is paired)
- Optional: humidity from the wireless thermometer (`humidity` setting, off by default)
- Reachability: after 3 failed polls in a row the device shows as unreachable until the unit answers again

Changes made in Apple Home (or any Matter controller) are sent to the unit as `/control?cmd=heatpump&...` requests. Setpoint changes are debounced, and the unit is re-read a couple of seconds after every command to confirm the result. Requests to one unit are sent one at a time; a unit that stops answering is polled less often (exponential backoff up to 2 minutes) without affecting the others.

Optional and experimental: fan speed (`fanControl`). The unit's speeds map to Matter's Auto / Low / Medium / High (`silent` shows as Low and `superhigh` as High and cannot be selected from a controller; the unit has no "fan off"). Controllers differ in whether they show a fan control on a thermostat; Apple Home may not.

Not exposed (yet): louver/vane positions.

## Development

The plugin is written in TypeScript. `src/` is the source; `dist/` is the JavaScript that Matterbridge loads (`main` in `package.json`) and is built from `src/` with `tsc`. `dist/` is committed so the plugin can be installed straight from a git clone without a build step; CI fails if it does not match `src/`.

`src/protoart.ts` holds the client and the mapping logic and has no Matterbridge dependency; `src/module.ts` is the Matterbridge platform. The tests in `test/` use real `/control` responses as fixtures.

Requires Node.js 24 or later for development (the tests run the TypeScript directly). The built plugin still runs on Node.js >= 20.3.

```bash
npm install     # TypeScript and Node types
npm run setup   # matterbridge, for its types only (see below)
npm run check   # typecheck, tests, build dist/
```

| Script | What it does |
|---|---|
| `npm run build` | Compile `src/` to `dist/` |
| `npm run typecheck` | Type check `src/` and `test/` without writing files |
| `npm test` | Unit tests and platform tests (`node:test`) against fake units and a stubbed Matterbridge, no network |
| `npm run check` | All of the above |

`matterbridge` is not listed in `package.json`: Matterbridge refuses to load a plugin that has it in any dependency list. `npm run setup` installs it without saving it (the version the server runs), the same role `npm link matterbridge` has in the official plugin template. A later `npm install` removes it again; rerun `npm run setup`.

To release: describe the changes under `## Unreleased` in `CHANGELOG.md`, commit, and run `npm version patch|minor|major`. It refuses an empty Unreleased section, runs `npm run check`, turns Unreleased into the new version with today's date, and commits a freshly built `dist/` with the version bump and a `vX.Y.Z` tag. Push with `git push --follow-tags` and create the GitHub release from the changelog:

```bash
gh release create v0.5.1 --title v0.5.1 --notes "$(node scripts/changelog.ts notes 0.5.1)"
```

## API Reference

ProtoArt HTTP API: https://protoart.net/knowledgebase/me_cn105_ata_wifi_http_api_mqtt_topics/

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
