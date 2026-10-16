#Requires -Version 5.1
<#
.SYNOPSIS
  Runs Madura Logger in the background from Windows startup, restarting it if it ever stops.

.DESCRIPTION
  Registers a scheduled task that starts at boot (no one needs to be logged in), runs
  without a console window, and restarts every minute if the process exits.
  Run from an elevated PowerShell window:

    powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Madura Logger'
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw 'Open PowerShell with "Run as administrator" and run this script again.'
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  throw 'Node.js was not found. Install the LTS version from https://nodejs.org and run this again.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectRoot 'src\index.js'
$port = 4780
try {
  $configured = (Get-Content (Join-Path $projectRoot 'config.json') -Raw | ConvertFrom-Json).port
  if ($configured) { $port = $configured }
} catch { }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`"" -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description 'Logs file changes in the watched folder and serves the Madura Logger UI.' `
  -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed '$TaskName'. It is running now and will start with Windows."
Write-Host "Open http://localhost:$port"
