# U1 Farm Control

A Windows desktop dashboard for running a small print farm of **Snapmaker U1** printers.
See every printer on one screen. When you minimize it, each printer stays in the system
tray next to the clock as an icon that shows its live print percentage.

**Website:** https://g4zi.github.io/u1-farm-control/ · **Download:** [latest release](https://github.com/g4zi/u1-farm-control/releases/latest)

![Screenshot](docs/screenshot.png)

Available in **English, Türkçe, Deutsch, Español and Français**. The app follows your Windows
language by default; you can change it in Settings.

## Features

- **Tray icons with live progress.** Each printer gets its own icon next to the clock. The icon
  shows the print percentage and fills up as the print progresses. Its color shows the state:
  green while printing, orange when paused, blue ✓ when finished, red on error and gray when offline.
  Hover over it to see the remaining time and file name.

  ![Tray icons](docs/tray-icons.png)

- **Live camera.** On stock firmware the built-in camera does not stream by itself. The app wakes
  it up automatically and shows the feed at about 1 frame per second.
- **Print details.** Progress, time remaining, estimated finish time, current layer, filament used,
  live speed and the slicer thumbnail.
- **All 4 toolheads.** Filament color and type, nozzle temperature, and which head is active.
- **Filament unload.** Unload one head, the heads you select, or all of them. The app uses the
  printer's own unload sequence.
- **Controls.** Pause, resume, cancel, chamber light, speed, flow and fan sliders, temperatures,
  turning off the heaters, and emergency stop.
- **Files and history.** Start a print from the G-code files on the printer and browse past jobs.
- **Notifications.** Alerts when a print finishes, pauses, fails, or a printer goes offline.
- **Start with Windows**, hidden in the tray (optional).

## Installation

Download the latest version from the [Releases](https://github.com/g4zi/u1-farm-control/releases) page:

- `U1-Farm-Control-Setup-x.y.z.exe`: installer
- `U1-Farm-Control-Portable-x.y.z.exe`: a single file that runs without installing

On first launch the **Settings** window opens. Enter the local IP address of each printer. You can
find it in the printer's network settings on the touchscreen, or in your router's list of
connected devices.

> The executables are not code-signed, so Windows SmartScreen may show a warning.
> Click **More info → Run anyway**.

### Requirements

- Windows 10 or 11 (x64)
- Snapmaker U1. Tested with stock firmware `2.0.0.205`.
- The PC and the printers must be on the same local network. The app talks to each printer
  directly over its Moonraker API on port `7125`. No cloud service or account is needed.

## Running from source

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone https://github.com/g4zi/u1-farm-control.git
cd u1-farm-control
npm install
npm start
```

To build the Windows installer and the portable exe:

```bash
npm run dist
```

The files are written to `dist/`. When you push a tag such as `v1.2.3`, GitHub Actions builds
the installers and publishes them as a new release.

## How it works

| What | How |
|---|---|
| Status | Polls `GET /printer/objects/query` on Moonraker every 2 seconds |
| Camera | Sends `camera.start_monitor` (`{"domain":"lan"}`) over the Moonraker websocket every 8 seconds, then reads frames from `/server/files/camera/monitor.jpg` |
| Filament unload | `AUTO_FEEDING_BATCH` with `AUTO_FEEDING EXTRUDER=n UNLOAD=1 STAGE=prepare/doing`, the same sequence the touchscreen uses |
| Tray icon | Drawn on a canvas in the renderer and passed to the Electron `Tray` |

Project layout:

```
main.js            Electron main process: polling, tray icons, notifications, printer commands
preload.js         Bridge between the UI and the main process
renderer/          Dashboard UI (plain HTML, CSS and JS, no framework)
assets/            App icon
```

Settings are stored in `%APPDATA%\U1 Farm Control\config.json`.

## Contributing

Issues and pull requests are welcome. Ideas that would help most:

- More translations. All UI text is in [`renderer/i18n.js`](renderer/i18n.js): copy the `en` block,
  translate the values and add the language to `LANGS`.
- macOS and Linux builds (the code is cross-platform Electron; only the builds are missing)
- Testing with other firmware versions

## Disclaimer

This is a community project. It is not affiliated with or endorsed by Snapmaker. The commands it
sends were read from the stock firmware, and a firmware update may change how they behave. Actions
such as filament unload and emergency stop physically move your printer. Use at your own risk.

## License

[MIT](LICENSE)
