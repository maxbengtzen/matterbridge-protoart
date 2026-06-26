# matterbridge-protoart

Matterbridge plugin for ProtoArt ME_CN105_ATA_WIFI heat pumps.

Exposes ProtoArt heat pumps as Matter thermostats via [Matterbridge](https://github.com/Luligu/matterbridge).

## Prerequisites

- [Matterbridge](https://github.com/Luligu/matterbridge) >= 3.9.0
- Node.js >= 20
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
git clone https://github.com/YOUR_USER/matterbridge-protoart.git /root/Matterbridge/matterbridge-protoart
matterbridge --add /root/Matterbridge/matterbridge-protoart
matterbridge --enable /root/Matterbridge/matterbridge-protoart
```

## Configuration

Configure via Matterbridge frontend UI at `http://<host>:8283` or by editing the auto-generated config file.

| Field | Type | Default | Description |
|---|---|---|---|
| `hosts` | string | (required) | Comma-separated list of ProtoArt unit IP addresses |
| `deviceNames` | string | (empty) | Comma-separated device names matching the hosts order |
| `pollInterval` | number | `15000` | Polling interval in milliseconds (minimum 5000) |
| `debug` | boolean | `false` | Enable verbose debug logging |

### Example

```json
{
  "hosts": "192.168.0.151,192.168.0.152",
  "deviceNames": "Living Room, Hallway",
  "pollInterval": 15000,
  "debug": false
}
```

## How it works

The plugin polls each ProtoArt unit's HTTP API at `/control` and exposes the data as a Matter thermostat with:

- Current temperature (`localTemperature`)
- Target temperature (`occupiedHeatingSetpoint` / `occupiedCoolingSetpoint`)
- System mode (off, cool, heat, auto, fan, dry)
- Power source information

Changes made in Apple Home (or any Matter controller) are sent back to the ProtoArt unit in real-time via the same HTTP API.

## API Reference

ProtoArt HTTP API: https://protoart.net/knowledgebase/me_cn105_ata_wifi_http_api_mqtt_topics/

## License

MIT
