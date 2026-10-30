# Native acceptance probe for Task Dock v0.6.
#
# Starts the built app with an isolated data dir, waits for the window, forces
# it visible if needed, captures the composited screen pixels of the window
# rectangle (so rounded corners show the desktop behind), and dumps the app log.
#
# ASCII only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
#
#   powershell -ExecutionPolicy Bypass -NoProfile -File scripts/native-verify.ps1 `
#     -Out docs/screenshots/v06/native-dream.png -Preset dream-gradient -Theme light

param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Exe = "src-tauri\target\release\task-dock.exe",
  [string]$DataDir = "",
  [string]$Preset = "",
  [string]$Theme = "",
  [int]$WaitSeconds = 6,
  [switch]$KeepAlive,
  [switch]$NoRaise,
  [int]$SettleMs = 3500
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Verify {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hWnd, IntPtr hRgn);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr hRgn, out RECT rect);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr hRgn, int x, int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr ho);
  [DllImport("gdi32.dll")] public static extern IntPtr GetStockObject(int i);

  // Samples the window region: returns "corner1,corner2,corner3,corner4,center"
  // where each value is 1 when the point is INSIDE the region.
  public static string RegionProbe(IntPtr hwnd, int w, int h) {
    IntPtr rgn = CreateRectRgn(0, 0, 0, 0);
    int err = GetWindowRgn(hwnd, rgn);
    if (err == 0) { DeleteObject(rgn); return "no-region"; }
    int[] pts = new int[] { 0, 0, w - 1, 0, 0, h - 1, w - 1, h - 1, w / 2, h / 2 };
    string res = "";
    for (int i = 0; i < pts.Length; i += 2) {
      res += (PtInRegion(rgn, pts[i], pts[i + 1]) ? "1" : "0");
    }
    RECT box;
    GetRgnBox(rgn, out box);
    res += " bounds=" + box.Left + "," + box.Top + "," + box.Right + "," + box.Bottom;
    DeleteObject(rgn);
    return res;
  }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public static List<IntPtr> WindowsOfProcess(uint target) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

[void][Verify]::SetProcessDPIAware()

if ($DataDir -eq "") { $DataDir = Join-Path $env:TEMP ("taskdock-v06-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)) }
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# Do NOT force-kill every task-dock process here. The same image name is used by
# the user's own app and by other acceptance runs with isolated data dirs, and
# Stop-Process -Force is TerminateProcess: it skips the shutdown journal and
# destroys someone else's in-flight verification. Teardown below only ever
# kills the instance this script started ($proc).
$foreign = @(Get-Process -Name "task-dock" -ErrorAction SilentlyContinue)
if ($foreign.Count -gt 0) {
  $ids = ($foreign | ForEach-Object { $_.Id }) -join ","
  Write-Output ("ABORT: " + $foreign.Count + " task-dock instance(s) already running (PIDs " + $ids + "). " +
    "Single Instance would make this launch exit immediately, and this script refuses to force-kill " +
    "processes it did not start. Close the running app (or wait for the other acceptance run) and rerun.")
  exit 3
}
Start-Sleep -Milliseconds 400

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = (Resolve-Path $Exe).Path
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
# EnvironmentVariables is unreliable on Windows PowerShell 5.1; the child
# inherits the current process environment instead.
$env:TASK_DOCK_DATA_DIR = $DataDir
$env:RUST_LOG = "info"
# ??? CDP ??? WebView2 ??????????????

$log = New-Object System.Text.StringBuilder

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
[void]$proc.Start()

$outHandler = Register-ObjectEvent -InputObject $proc -EventName "OutputDataReceived" -Action {
  if ($EventArgs.Data -ne $null) { [void]$Event.MessageData.AppendLine($EventArgs.Data) }
} -MessageData $log
$errHandler = Register-ObjectEvent -InputObject $proc -EventName "ErrorDataReceived" -Action {
  if ($EventArgs.Data -ne $null) { [void]$Event.MessageData.AppendLine("ERR " + $EventArgs.Data) }
} -MessageData $log

$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()
Write-Output ("pid={0} data={1}" -f $proc.Id, $DataDir)

# ??????????????????????
$db = Join-Path $DataDir "task-dock.db"

$handle = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  foreach ($h in [Verify]::WindowsOfProcess([uint32]$proc.Id)) {
    $r = New-Object Verify+RECT
    [void][Verify]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    # The app window is at most ~600x900 physical pixels; larger helper windows (WebView2 host) are skipped
    if ($w -ge 200 -and $ht -ge 80 -and $w -le 900 -and $ht -le 1600) { $handle = $h; break }
  }
  if ($handle -ne [IntPtr]::Zero) { break }
}
if ($handle -eq [IntPtr]::Zero) { Write-Output "RESULT=no-window"; exit 2 }

$r = New-Object Verify+RECT
[void][Verify]::GetWindowRect($handle, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
$visibleBefore = [Verify]::IsWindowVisible($handle)
if (-not $NoRaise) {
  [void][Verify]::ShowWindow($handle, 5)
  [void][Verify]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040)
  [void][Verify]::BringWindowToTop($handle)
  [void][Verify]::SetForegroundWindow($handle)
} else {
  # Let the app show itself: forcing ShowWindow on a layered (transparent) window
  # can leave the WebView2 surface without a presented frame.
  $waitVisible = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $waitVisible -and -not [Verify]::IsWindowVisible($handle)) {
    Start-Sleep -Milliseconds 250
  }
}
Start-Sleep -Milliseconds $SettleMs
$visibleAfter = [Verify]::IsWindowVisible($handle)

# Objective check of the rounded-corner fix (run after the app had time to
# apply the region): the four window corners must be OUTSIDE the region (cut
# out, so the DWM backdrop cannot paint them) while the centre is INSIDE.
$regionProbe = [Verify]::RegionProbe($handle, $w, $ht)
Write-Output ("region_probe={0} (expected 00001: corners cut out, centre inside)" -f $regionProbe)
[void][Verify]::GetWindowRect($handle, [ref]$r)

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$full = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location).Path $Out }

# PrintWindow first: it renders the window own content and is independent of z-order.
$pwBmp = New-Object System.Drawing.Bitmap($w, $ht)
$pwGfx = [System.Drawing.Graphics]::FromImage($pwBmp)
$hdc = $pwGfx.GetHdc()
$pwOk = [Verify]::PrintWindow($handle, $hdc, 2)
$pwGfx.ReleaseHdc($hdc)
$pwBmp.Save(($full -replace '\.png$', '-printwindow.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# Raise the window right before the screen grab and retry until it really is the
# topmost window at that position (other always-on-top windows may steal the
# z-order, which would silently capture the wrong pixels).
$attempt = 0
$ontop = $false
while ($attempt -lt 6 -and -not $ontop -and -not $NoRaise) {
  $attempt++
  [void][Verify]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040)
  [void][Verify]::BringWindowToTop($handle)
  [void][Verify]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 250
  [void][Verify]::GetWindowRect($handle, [ref]$r)
  $probe = New-Object System.Drawing.Bitmap(1, 1)
  $probeGfx = [System.Drawing.Graphics]::FromImage($probe)
  $probeGfx.CopyFromScreen([int]($r.Left + $w / 2), [int]($r.Top + $ht / 2), 0, 0, $probe.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  $probeGfx.Dispose()
  $probeColor = $probe.GetPixel(0, 0)
  $probe.Dispose()
  $pwCenter = $pwBmp.GetPixel([int]($w / 2), [int]($ht / 2))
  $d = [Math]::Abs($probeColor.R - $pwCenter.R) + [Math]::Abs($probeColor.G - $pwCenter.G) + [Math]::Abs($probeColor.B - $pwCenter.B)
  $ontop = ($d -lt 40)
  Write-Output ("attempt={0} probe={1} printwindow={2} diff={3} ontop={4}" -f $attempt, $probeColor, $pwCenter, $d, $ontop)
}

# Capture the WHOLE screen once, then derive both outputs from that single
# snapshot: the window crop and the context crop are guaranteed to be pixel
# consistent, so a transparent rounded corner can be compared against the
# desktop right outside the window.
$pad = 60
$scrW = 2560
$scrH = 1440
$scrBmp = New-Object System.Drawing.Bitmap($scrW, $scrH)
$scrGfx = [System.Drawing.Graphics]::FromImage($scrBmp)
$scrGfx.CopyFromScreen(0, 0, 0, 0, $scrBmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)

$ex = [int][Math]::Max(0, $r.Left - $pad)
$ey = [int][Math]::Max(0, $r.Top - $pad)
$ew = [int][Math]::Min($scrW - $ex, [int]($w + 2 * $pad))
$eh = [int][Math]::Min($scrH - $ey, [int]($ht + 2 * $pad))
$ctxCrop = New-Object System.Drawing.Bitmap($ew, $eh)
$ctxGfx = [System.Drawing.Graphics]::FromImage($ctxCrop)
$ctxGfx.DrawImage($scrBmp, (New-Object System.Drawing.Rectangle(0, 0, $ew, $eh)), (New-Object System.Drawing.Rectangle($ex, $ey, $ew, $eh)), [System.Drawing.GraphicsUnit]::Pixel)
$ctxGfx.Dispose()
$ctxCrop.Save(($full -replace '\.png$', '-context.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$ctxCrop.Dispose()

$ox = [int]($r.Left - $ex)
$oy = [int]($r.Top - $ey)
$winCrop = New-Object System.Drawing.Bitmap($w, $ht)
$winGfx = [System.Drawing.Graphics]::FromImage($winCrop)
$winGfx.DrawImage($scrBmp, (New-Object System.Drawing.Rectangle(0, 0, $w, $ht)), (New-Object System.Drawing.Rectangle($r.Left, $r.Top, $w, $ht)), [System.Drawing.GraphicsUnit]::Pixel)
$winGfx.Dispose()
$winCrop.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)

# Sanity: is the app really on top of the captured region? Compare the centre of
# the screen crop with the centre of the PrintWindow rendering.
$center = New-Object System.Drawing.Rectangle([int]($w / 2 - 40), [int]($ht / 2 - 40), 80, 80)
$sa = $winCrop.GetPixel([int]($w / 2), [int]($ht / 2))
$pa = $pwBmp.GetPixel([int]($w / 2), [int]($ht / 2))
$diff = [Math]::Abs($sa.R - $pa.R) + [Math]::Abs($sa.G - $pa.G) + [Math]::Abs($sa.B - $pa.B)
Write-Output ("ontop_check screen={0} printwindow={1} diff={2}" -f $sa, $pa, $diff)

$winCrop.Dispose()
$scrGfx.Dispose()
$scrBmp.Dispose()
$pwGfx.Dispose()
$pwBmp.Dispose()

Write-Output ("RESULT=ok size={0}x{1} visibleBefore={2} visibleAfter={3} out={4}" -f $w, $ht, $visibleBefore, $visibleAfter, $full)


Start-Sleep -Milliseconds 400
Write-Output "---- app log ----"
Write-Output $log.ToString()

Unregister-Event -SourceIdentifier $outHandler.Name -ErrorAction SilentlyContinue
Unregister-Event -SourceIdentifier $errHandler.Name -ErrorAction SilentlyContinue
if (-not $KeepAlive -and -not $proc.HasExited) { $proc.Kill() }
if ($KeepAlive) { Write-Output ("KEEPALIVE pid={0}" -f $proc.Id) }
