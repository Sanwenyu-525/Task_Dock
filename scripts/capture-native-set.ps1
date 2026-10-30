# Capture the native window for each theme combination (ASCII only).
#
#   powershell -ExecutionPolicy Bypass -NoProfile -File scripts/capture-native-set.ps1 `
#     -DataDir "$env:TEMP\taskdock-v06" -OutDir "docs/screenshots/v06"
#
# For every combination it seeds the local settings (preset / theme / mode /
# material), disables edge snapping (otherwise the window can slide off screen
# while we grab it) and pins the window rect, then runs scripts/native-verify.ps1.
param(
  [string]$DataDir = "$env:TEMP\taskdock-v06",
  [string]$OutDir = "docs/screenshots/v06",
  [string]$Material = "glass",
  [int]$X = 60,
  [int]$Y = 60,
  [int]$W = 500,
  [int]$H = 700
)

$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

function Stop-App {
  Get-Process -Name "task-dock" -ErrorAction SilentlyContinue | Stop-Process -Force
  $t = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $t) {
    if (-not (Get-Process -Name "task-dock" -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 200
  }
  Start-Sleep -Milliseconds 600
}

$combos = @(
  @{ name = "native-dream-light"; preset = "dream-gradient"; theme = "light" },
  @{ name = "native-dream-dark"; preset = "dream-gradient"; theme = "dark" },
  @{ name = "native-glass-light"; preset = "liquid-glass"; theme = "light" },
  @{ name = "native-glass-dark"; preset = "liquid-glass"; theme = "dark" }
)

foreach ($c in $combos) {
  python scripts/seed-settings.py $DataDir "theme=$($c.theme)" "visual_preset=$($c.preset)" "mode=full" "material=$Material" "snap_enabled=false" "window_rect=$X,$Y,$W,$H" | Out-Null
  Stop-App
  $out = Join-Path $OutDir ("{0}.png" -f $c.name)
  $o = powershell -ExecutionPolicy Bypass -NoProfile -File scripts/native-verify.ps1 -Out $out -DataDir $DataDir -WaitSeconds 20 2>&1
  $reg = ($o | Select-String -Pattern "region_probe").Line
  $top = ($o | Select-String -Pattern "ontop_check").Line
  Write-Output ("{0,-20} {1} | {2}" -f $c.name, $reg, $top)
}

Write-Output ("done -> " + $OutDir)
