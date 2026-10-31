# Corner matrix: Region x DWM x Solid/Glass on a controlled backdrop.
#
# Each cell launches its own isolated instance (own data dir), captures the app
# and the same area without it, then runs check-corners.py. The verdict comes
# from composited pixels + GetWindowRgn + DWM attributes, never from region
# success alone. Cells can be added with -Backends for the native material
# experiment (auto / mica / acrylic / blur / none).
#
# No process that this script did not start is ever terminated: corner-lab.ps1
# owns exactly one PID per cell and kills only that PID.
#
# ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
#
#   powershell -ExecutionPolicy Bypass -NoProfile -File scripts/diagnose-corner.ps1 `
#     -Exe src-tauri\target\release\task-dock.exe `
#     -OutDir docs/screenshots/v07/matrix

param(
  [string]$Exe = "src-tauri\target\release\task-dock.exe",
  [string]$OutDir = "docs/screenshots/v07/matrix",
  [int]$Width = 500,
  [int]$Height = 700,
  [int]$WaitSeconds = 20,
  [string]$BackdropColor = "0,255,0",
  [string]$NcPolicy = "",
  [string[]]$Backends = @("auto"),
  [switch]$SkipGlass
)

$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$outFull = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $root $OutDir }
New-Item -ItemType Directory -Path $outFull -Force | Out-Null
$lab = Join-Path $root "scripts/corner-lab.ps1"
$analyzer = Join-Path $root "scripts/check-corners.py"
if (-not (Test-Path $lab)) { throw "corner-lab.ps1 not found" }
if (-not (Test-Path $analyzer)) { throw "check-corners.py not found" }

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
$env:PYTHONIOENCODING = "utf-8"

# Geometry cells: region and DWM are independent switches; material is the app
# setting (default glass). "region+dwm", "region", "dwm", "neither".
$cells = @(
  @{ name = "region-dwm"; region = "1"; corner = "1" },
  @{ name = "region-only"; region = "1"; corner = "0" },
  @{ name = "dwm-only"; region = "0"; corner = "1" },
  @{ name = "neither"; region = "0"; corner = "0" }
)

$materials = @("solid")
if (-not $SkipGlass) { $materials += "glass" }
if ($Backends -contains "auto") { $Backends = @("auto") }

$results = @()
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

foreach ($mat in $materials) {
  $backends = @("auto")
  if ($mat -eq "glass") { $backends = $Backends }
  foreach ($backend in $backends) {
    foreach ($cell in $cells) {
      $label = "{0}-{1}" -f $mat, $cell.name
      if ($mat -eq "glass" -and $backend -ne "auto") { $label = "{0}-{1}-{2}" -f $mat, $backend, $cell.name }
      $out = Join-Path $outFull ("{0}-{1}.png" -f $label, $stamp)
      $dataDir = Join-Path $env:TEMP ("taskdock-matrix-{0}-{1}" -f $stamp, $label)
      New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
      $seed = "theme=light visual_preset=dream-gradient material=$mat"
      Write-Output ("[matrix] {0} region={1} dwm={2} backend={3}" -f $label, $cell.region, $cell.corner, $backend)
      $env:TASK_DOCK_GLASS_BACKEND = $backend
      $labArgs = @(
        "-ExecutionPolicy", "Bypass", "-NoProfile", "-File", $lab,
        "-Out", $out, "-Exe", $Exe, "-DataDir", $dataDir,
        "-W", "$Width", "-H", "$Height",
        "-WaitSeconds", "$WaitSeconds",
        "-Region", $cell.region, "-DwmCorner", $cell.corner,
        "-BackdropColor", $BackdropColor,
        "-Seed", $seed
      )
      if ($NcPolicy -ne "") { $labArgs += @("-NcPolicy", $NcPolicy) }
      $logPath = $out -replace '\.png$', '-lab.log'
      & powershell @labArgs 2>&1 | Tee-Object -FilePath $logPath | Out-Null
      $labExit = $LASTEXITCODE

      $meta = $out -replace '\.png$', '.json'
      $analysisPath = $out -replace '\.png$', '-analysis.json'
      $status = "ERROR"
      $detail = ""
      if ((Test-Path $meta) -and $labExit -eq 0) {
        $analysisOut = & python $analyzer $meta 2>&1
        $detail = ($analysisOut | Select-Object -First 1)
        if (Test-Path $analysisPath) {
          try { $status = (Get-Content -Raw -Encoding UTF8 $analysisPath | ConvertFrom-Json).status } catch {}
        }
      } elseif ($labExit -ne 0) {
        $detail = "corner-lab exit=$labExit (see log)"
      }

      # Region/DWM facts are recorded even when the pixel verdict fails.
      $regionProbe = ""; $dwmCorner = ""; $dwmBackdrop = ""; $baselineValid = ""
      if (Test-Path $meta) {
        try {
          $m = Get-Content -Raw -Encoding UTF8 $meta | ConvertFrom-Json
          $regionProbe = $m.region_probe
          $dwmCorner = $m.dwm.corner_preference
          $dwmBackdrop = $m.dwm.system_backdrop
          $baselineValid = $m.baseline_check.valid
        } catch {}
      }
      $results += [ordered]@{
        label = $label; material = $mat; backend = $backend
        region = $cell.region; dwm_corner = $cell.corner
        status = $status; lab_exit = $labExit
        region_probe = $regionProbe; dwm_corner_pref = $dwmCorner
        dwm_backdrop = $dwmBackdrop; baseline_valid = $baselineValid
        meta = $meta; analysis = $analysisPath; screenshot = $out
        detail = $detail
      }
      Remove-Item Env:TASK_DOCK_GLASS_BACKEND -ErrorAction SilentlyContinue
    }
  }
}

$summary = [ordered]@{
  generated_at = (Get-Date).ToString("o")
  exe = (Resolve-Path $Exe).Path
  window = @{ w = $Width; h = $Height }
  backdrop = $BackdropColor
  nc_policy = $NcPolicy
  cells = $results
}
$summaryPath = Join-Path $outFull ("matrix-{0}.json" -f $stamp)
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $summaryPath -Encoding UTF8

Write-Output ""
Write-Output ("{0,-34} {1,-10} {2,7} {3,7} {4,8} {5}" -f "cell", "status", "region", "dwmcorner", "backdrop", "baseline")
foreach ($r in $results) {
  Write-Output ("{0,-34} {1,-10} {2,7} {3,7} {4,8} {5}" -f $r.label, $r.status, $r.region_probe, $r.dwm_corner_pref, $r.dwm_backdrop, $r.baseline_valid)
}
Write-Output ("summary=" + $summaryPath)

$failed = @($results | Where-Object { $_.status -eq "FAIL" -or $_.status -eq "ERROR" })
$unverified = @($results | Where-Object { $_.status -eq "UNVERIFIED" -or $_.status -eq "OBSERVE" })
if ($failed.Count -gt 0) { exit 1 }
if ($unverified.Count -gt 0) { exit 2 }
exit 0
