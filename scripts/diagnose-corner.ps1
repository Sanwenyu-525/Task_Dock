# Diagnostic matrix for the window corner fix (ASCII only).
#
# Question: does the Win32 region clip (SetWindowRgn) or the DWM corner
# preference break the WebView2 presentation of a layered (Mica) window?
#
#   node/ps1 -> for each combination: launch the app with the diagnostic env
#   vars, capture the window and report whether the app is really on screen.
#
#   powershell -ExecutionPolicy Bypass -NoProfile -File scripts/diagnose-corner.ps1

param(
  [string]$DataDir = "$env:TEMP\taskdock-v06",
  [string]$OutDir = "$env:TEMP\taskdock-diag"
)

$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

function Stop-App {
  Get-Process -Name "task-dock" -ErrorAction SilentlyContinue | Stop-Process -Force
  $t = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $t) {
    if (-not (Get-Process -Name "task-dock" -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 200
  }
  Start-Sleep -Milliseconds 400
}

$combos = @(
  @{ name = "region+corner"; region = "1"; corner = "1" },
  @{ name = "region-only"; region = "1"; corner = "0" },
  @{ name = "corner-only"; region = "0"; corner = "1" },
  @{ name = "neither"; region = "0"; corner = "0" }
)

foreach ($c in $combos) {
  foreach ($mat in @("glass", "solid")) {
    Stop-App
    python scripts/seed-settings.py $DataDir theme=light visual_preset=dream-gradient mode=full "material=$mat" | Out-Null
    $env:TASK_DOCK_WINDOW_REGION = $c.region
    $env:TASK_DOCK_WINDOW_DWM_CORNER = $c.corner
    $out = Join-Path $OutDir ("{0}-{1}.png" -f $c.name, $mat)
    $o = powershell -ExecutionPolicy Bypass -NoProfile -File scripts/native-verify.ps1 -Out $out -DataDir $DataDir -WaitSeconds 18 -NoRaise 2>&1
    $line = ($o | Select-String -Pattern "ontop_check").Line
    $reg = ($o | Select-String -Pattern "region_probe").Line
    Write-Output ("{0,-14} {1,-6} {2} | {3}" -f $c.name, $mat, $reg, $line)
  }
}

Remove-Item Env:TASK_DOCK_WINDOW_REGION -ErrorAction SilentlyContinue
Remove-Item Env:TASK_DOCK_WINDOW_DWM_CORNER -ErrorAction SilentlyContinue
Write-Output ("screenshots in " + $OutDir)
