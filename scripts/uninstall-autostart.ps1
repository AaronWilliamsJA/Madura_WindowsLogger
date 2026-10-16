#Requires -Version 5.1
<#
.SYNOPSIS
  Stops Madura Logger and removes it from Windows startup. Change logs are kept.

    powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Madura Logger'
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "'$TaskName' is not installed."
  return
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed '$TaskName'. Your change logs are still in the logs folder."
