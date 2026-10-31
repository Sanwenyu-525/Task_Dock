# Native window acceptance for Task Dock.
#
# The old v0.6 probe compared two crops of the SAME screenshot, so black corner
# wedges measured as a perfect 0.0 difference and passed. This version captures
# the app over a controlled topmost backdrop and then captures the same screen
# area again with the app hidden. check-corners.py compares those two
# independent surfaces: a transparent rounded corner must show the backdrop.
#
# Consequences:
# - no hardcoded screen size (the lab uses Screen.FromHandle and the monitor's
#   real bounds, so multi-monitor coordinates and 125%/150% DPI work);
# - a missing/invalid background baseline is UNVERIFIED, never PASS;
# - only the instance this run started is ever terminated.
#
# ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
#
#   powershell -ExecutionPolicy Bypass -NoProfile -File scripts/native-verify.ps1 `
#     -Out docs/screenshots/v07/native-dream-light-solid.png `
#     -Preset dream-gradient -Theme light -Material solid

param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Exe = "src-tauri\target\release\task-dock.exe",
  [string]$DataDir = "",
  [ValidateSet("dream-gradient", "liquid-glass")][string]$Preset = "dream-gradient",
  [ValidateSet("light", "dark")][string]$Theme = "light",
  [ValidateSet("solid", "glass")][string]$Material = "glass",
  [ValidateSet("", "auto", "mica", "acrylic", "blur", "none")][string]$Backend = "",
  [int]$Width = 500,
  [int]$Height = 700,
  [int]$X = -1,
  [int]$Y = -1,
  [int]$WaitSeconds = 20,
  [int]$SettleMs = 2500,
  [string]$Region = "1",
  [string]$DwmCorner = "1",
  [string]$NcPolicy = "",
  [string]$ResizeTo = "",
  [switch]$MinimizeCycle,
  [switch]$KeepAlive
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

# Console output from python must be decoded as UTF-8; otherwise PowerShell 5.1
# decodes the analyzer's Chinese reasons as ANSI and the report is unreadable.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
$env:PYTHONIOENCODING = "utf-8"

$root = (Get-Location).Path
$outFull = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
$outDir = Split-Path -Parent $outFull
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

# Default placement: visible on the monitor that will host the window, with a
# margin for the shadow. Never assume 2560x1440 or any other fixed resolution.
if ($X -lt 0 -or $Y -lt 0) {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $X = [int]$wa.Left + 120
  $Y = [int]$wa.Top + 80
}

$lab = Join-Path $root "scripts/corner-lab.ps1"
if (-not (Test-Path $lab)) { throw "corner-lab.ps1 not found: $lab" }
$analyzer = Join-Path $root "scripts/check-corners.py"
if (-not (Test-Path $analyzer)) { throw "check-corners.py not found: $analyzer" }

$seed = "theme=$Theme visual_preset=$Preset material=$Material"
# Native glass backend override is read by the app from the environment at
# apply time; empty means "auto" (the product default).
if ($Backend -ne "") { $env:TASK_DOCK_GLASS_BACKEND = $Backend }
else { Remove-Item Env:TASK_DOCK_GLASS_BACKEND -ErrorAction SilentlyContinue }

$labArgs = @(
  "-ExecutionPolicy", "Bypass", "-NoProfile", "-File", $lab,
  "-Out", $outFull,
  "-Exe", $Exe,
  "-Preset", $Preset,
  "-Theme", $Theme,
  "-Material", $Material,
  "-W", "$Width", "-H", "$Height", "-X", "$X", "-Y", "$Y",
  "-WaitSeconds", "$WaitSeconds",
  "-SettleMs", "$SettleMs",
  "-Region", "$Region",
  "-DwmCorner", "$DwmCorner",
  "-Seed", $seed
)
if ($DataDir -ne "") { $labArgs += @("-DataDir", $DataDir) }
if ($NcPolicy -ne "") { $labArgs += @("-NcPolicy", $NcPolicy) }
if ($ResizeTo -ne "") { $labArgs += @("-ResizeTo", $ResizeTo, "-ResizeJitter", "6") }
if ($MinimizeCycle) { $labArgs += "-MinimizeCycle" }
if ($KeepAlive) { $labArgs += "-KeepAlive" }

$logPath = $outFull -replace '\.png$', '-lab.log'
Write-Output ("[native-verify] lab log: " + $logPath)
& powershell @labArgs 2>&1 | Tee-Object -FilePath $logPath
if ($LASTEXITCODE -ne 0) {
  Write-Output ("RESULT=ERROR corner-lab exit=" + $LASTEXITCODE)
  exit 2
}

$metaPath = $outFull -replace '\.png$', '.json'
if (-not (Test-Path $metaPath)) { Write-Output "RESULT=ERROR no-meta"; exit 2 }

# Publish the composited visible capture under the requested name; the pair
# (-visible/-baseline) stays next to it as the actual evidence.
$visiblePath = $outFull -replace '\.png$', '-visible.png'
if (Test-Path $visiblePath) { Copy-Item -Force $visiblePath $outFull }

$analysisOut = & python $analyzer $metaPath 2>&1
$analysisExit = $LASTEXITCODE
$analysisOut | ForEach-Object { Write-Output $_ }
$analysisPath = $outFull -replace '\.png$', '-analysis.json'
$status = "UNKNOWN"
if (Test-Path $analysisPath) {
  try { $status = (Get-Content -Raw -Encoding UTF8 $analysisPath | ConvertFrom-Json).status } catch {}
}

$run = [ordered]@{
  out = $outFull
  meta = $metaPath
  analysis = $analysisPath
  lab_log = $logPath
  scenario = [ordered]@{
    preset = $Preset; theme = $Theme; material = $Material
    glass_backend = if ($Backend -ne "") { $Backend } else { "auto" }
    width = $Width; height = $Height; x = $X; y = $Y
    region = $Region; dwm_corner = $DwmCorner; nc_policy = $NcPolicy
    resize_to = $ResizeTo; minimize_cycle = [bool]$MinimizeCycle
  }
  status = $status
  analyzer_exit = $analysisExit
}
$runPath = $outFull -replace '\.png$', '-run.json'
$run | ConvertTo-Json -Depth 5 | Set-Content -Path $runPath -Encoding UTF8
Write-Output ("[native-verify] status=" + $status + " analyzer_exit=" + $analysisExit + " run=" + $runPath)

if ($analysisExit -eq 0) { exit 0 }
if ($analysisExit -eq 2) { exit 2 }
exit 1
