# Changelog

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
