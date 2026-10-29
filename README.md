<p align="center">
  <img src="assets/banner.webp" alt="Madura Logger: watch, track, log, protect" width="820">
</p>

# Madura Logger

Watches a folder on Windows and records every file or folder that is **added**, **modified** or **deleted**, with the date and time. A live web page shows the changes as green, yellow and red cards.

```
[2026-10-16 22:52:23] MODIFIED  resources/[jobs]/garage/config.lua
[2026-10-16 22:52:20] DELETED   resources/[standalone]/old-hud/client.lua
[2026-10-16 22:49:10] ADDED     resources/[qb]/qb-inventory/
```

## Requirements

- Windows
- [Node.js](https://nodejs.org) 18 or newer (no other packages needed)

## Setup

1. Double-click `start.bat`. The UI opens at http://localhost:4780.
2. Click **Settings** in the top bar. Choose the folder to watch, the folders to ignore (like `cache` and `db`) and any file names to skip (like `*.tmp`), then save. Watching restarts straight away; no file editing needed.
3. To run it in the background from Windows startup, run this once in an administrator PowerShell:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
   ```

   `scripts\uninstall-autostart.ps1` removes it again.

## Configuration

The watched folder, ignored folders and ignored names are managed in the web UI's Settings, which saves them to `config.json`. The other keys are for the server itself and rarely change; edit `config.json` and restart the logger for those.

| Key | Default | Meaning |
|---|---|---|
| `watchPath` | (set in Settings) | Folder to watch |
| `ignore` | `[]` | Folders inside `watchPath` to skip (set in Settings) |
| `ignorePatterns` | `[]` | File or folder names to skip, `*` and `?` allowed (set in Settings) |
| `logDir` | `logs` | Where daily log files are written |
| `host` | `127.0.0.1` | Address the UI listens on (`0.0.0.0` for other PCs) |
| `port` | `4780` | UI port |
| `settleMs` | `1000` | Quiet time before a change is recorded |
| `maxWaitMs` | `30000` | Longest a busy file waits before it is recorded |

Change logs are plain text, one file per day: `logs\2026-10-16.log`.

## Notes

- Only paths and times are recorded; file contents are never read or copied.
- Changes made while the logger is not running are not recorded.
- A rename shows as a deleted old name plus an added new name.

<p align="center"><img src="assets/logo.webp" alt="" width="96"></p>
<p align="center">Madura Logger by Madura Scripts</p>
