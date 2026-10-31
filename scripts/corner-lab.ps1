# Corner lab: capture the real composited window over a controlled bright
# backdrop, then capture the same screen area with the window hidden.
#
# The visible/baseline pair is the only way to tell "transparent rounded
# corner" (background pixels show through) from "black wedge" (window paints
# dark pixels where the corner should be cut out).
#
# ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI without BOM).
param(
  [string]$Out = "docs/screenshots/v07/lab.png",
  [string]$Exe = "src-tauri\target\release\task-dock.exe",
  [string]$DataDir = "",
  [string]$Preset = "dream-gradient",
  [string]$Theme = "light",
  [string]$Material = "solid",
  [int]$X = 200,
  [int]$Y = 120,
  [int]$W = 500,
  [int]$H = 700,
  [int]$WaitSeconds = 20,
  [int]$SettleMs = 2500,
  [string]$Region = "1",
  [string]$DwmCorner = "1",
  [string]$NcPolicy = "",
  [string]$ResizeTo = "",
  [int]$ResizeJitter = 0,
  [switch]$MinimizeCycle,
  [string]$BackdropColor = "242,236,255",
  [string]$Seed = "",
  [switch]$KeepAlive
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

// Topmost, non-activating solid backdrop. The live wallpaper is animated
// (Wallpaper Engine), so neither the desktop nor a normal window is a stable
// baseline; this window is drawn above everything and the app is raised above
// it. Hiding the app then leaves exactly this surface behind.
public class Backdrop {
  public static Color Face = Color.FromArgb(242, 236, 255);
  private static Form form;
  private static Thread thread;
  private static readonly ManualResetEventSlim ready = new ManualResetEventSlim(false);

  public static void SetFace(int r, int g, int b) {
    Face = Color.FromArgb(r, g, b);
  }

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

  private class BackdropForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get {
        CreateParams cp = base.CreateParams;
        cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
        cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
        return cp;
      }
    }
    protected override void OnPaint(PaintEventArgs e) {
      e.Graphics.Clear(Face);
    }
  }

  public static string Closed = "";

  public static string Info() {
    if (form == null) return "no-form";
    try {
      return "hwnd=" + form.Handle + " visible=" + form.Visible + " disposed=" + form.IsDisposed + " bounds=" + form.Bounds + " " + Closed;
    } catch (Exception ex) {
      return "info-error " + ex.Message + " " + Closed;
    }
  }

  public static void Start() {
    thread = new Thread(() => {
      Application.EnableVisualStyles();
      form = new BackdropForm();
      form.FormBorderStyle = FormBorderStyle.None;
      form.StartPosition = FormStartPosition.Manual;
      form.Bounds = SystemInformation.VirtualScreen;
      form.BackColor = Face;
      form.ShowInTaskbar = false;
      form.FormClosed += (s, e) => { Closed = "closed@"; };
      form.Show();
      // Setting TopMost before Show is not enough on this shell: the form
      // stays below other windows. Re-assert it after the handle exists.
      form.TopMost = true;
      SetWindowPos(form.Handle, (IntPtr)(-1), 0, 0, form.Width, form.Height, 0x0040 | 0x0010);
      form.Refresh();
      ready.Set();
      Application.Run(form);
    });
    thread.SetApartmentState(ApartmentState.STA);
    thread.IsBackground = true;
    thread.Start();
    ready.Wait(3000);
  }

  // Re-assert the topmost position. Other topmost windows (editors, browsers)
  // can end up above the backdrop after the app takes focus, so each capture
  // boundary raises it again. The app is then raised above it when visible.
  public static bool Raise() {
    if (form == null || form.IsDisposed) return false;
    return (bool)form.Invoke((Func<bool>)(() => {
      SetWindowPos(form.Handle, (IntPtr)(-1), 0, 0, form.Width, form.Height, 0x0040 | 0x0010 | 0x0001 | 0x0002);
      return true;
    }));
  }

  public static void Stop() {
    try {
      if (form != null && !form.IsDisposed) {
        form.Invoke(new Action(() => form.Close()));
      }
    } catch {}
  }
}

public class Lab {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hWnd, IntPtr hRgn);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr hRgn, out RECT rect);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr hRgn, int x, int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr ho);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);

  public static string Describe(IntPtr h) {
    var cls = new System.Text.StringBuilder(256);
    var txt = new System.Text.StringBuilder(256);
    GetClassName(h, cls, 256);
    GetWindowText(h, txt, 256);
    return cls.ToString() + "|" + txt.ToString();
  }

  public static List<IntPtr> WindowsOfProcess(uint target) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

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
}
"@

[void][Lab]::SetProcessDPIAware()

if ($DataDir -eq "") { $DataDir = Join-Path $env:TEMP ("taskdock-lab-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)) }
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# A user instance may be running; never kill it. This lab uses an isolated data
# directory and tracks only the process it starts, so a foreign instance is
# harmless (the backdrop and lab window are raised above it for captures).
$foreign = @(Get-Process -Name "task-dock" -ErrorAction SilentlyContinue)
if ($foreign.Count -gt 0) {
  $ids = ($foreign | ForEach-Object { $_.Id }) -join ","
  Write-Output ("WARN: another task-dock is running (PIDs " + $ids + "); leaving it untouched")
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$full = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location).Path $Out }

# Controlled bright backdrop (topmost, non-activating). The colour can be
# overridden for high-contrast geometry measurement.
$rgb = $BackdropColor.Split(",")
if ($rgb.Length -eq 3) {
  [Backdrop]::SetFace([int]$rgb[0], [int]$rgb[1], [int]$rgb[2])
}
[Backdrop]::Start()
Start-Sleep -Milliseconds 700

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = (Resolve-Path $Exe).Path
$psi.UseShellExecute = $false
$env:TASK_DOCK_DATA_DIR = $DataDir
$env:TASK_DOCK_WINDOW_REGION = $Region
$env:TASK_DOCK_WINDOW_DWM_CORNER = $DwmCorner
$env:RUST_LOG = "info"

function Start-LabApp {
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  return $p
}

# A fresh data dir defaults to material=glass (Mica); passing -Material solid
# alone would not actually switch the window to solid. When seeding is asked
# for, start once to create/migrate the DB, stop only that own process, write
# the settings, then start the measured instance. User instances are untouched.
if ($Seed -ne "") {
  $db = Join-Path $DataDir "task-dock.db"
  if (-not (Test-Path $db)) {
    $prep = Start-LabApp
    $dbDeadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $dbDeadline -and -not (Test-Path $db)) {
      Start-Sleep -Milliseconds 200
      $prep.Refresh()
      if ($prep.HasExited) { break }
    }
    Start-Sleep -Milliseconds 900
    $prep.Refresh()
    if (-not $prep.HasExited) {
      $prep.Kill()
      [void]$prep.WaitForExit(5000)
    }
    Start-Sleep -Milliseconds 400
  }
  $seedArgs = @("scripts/seed-settings.py", $DataDir) + @($Seed -split "\s+" | Where-Object { $_ -ne "" })
  $seedOut = & python @seedArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw ("seed-settings failed: " + ($seedOut -join " ")) }
  Write-Output ("seeded: " + ($Seed -replace "\s+", " "))
}

$proc = Start-LabApp
Write-Output ("pid={0} data={1} region={2} dwm={3}" -f $proc.Id, $DataDir, $Region, $DwmCorner)

$handle = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $proc.Refresh()
  if ($proc.HasExited) { throw ("app exited early: " + $proc.ExitCode) }
  foreach ($hwnd in [Lab]::WindowsOfProcess([uint32]$proc.Id)) {
    if (-not [Lab]::IsWindowVisible($hwnd)) { continue }
    $wr = New-Object Lab+RECT
    [void][Lab]::GetWindowRect($hwnd, [ref]$wr)
    $ww = $wr.Right - $wr.Left
    $wh = $wr.Bottom - $wr.Top
    if ($ww -ge 240 -and $wh -ge 96 -and $ww -le 1200 -and $wh -le 1800) {
      Write-Output ("candidate hwnd={0} {1} rect={2},{3} {4}x{5}" -f $hwnd, [Lab]::Describe($hwnd), $wr.Left, $wr.Top, $ww, $wh)
      $handle = $hwnd; break
    }
  }
  if ($handle -ne [IntPtr]::Zero) { break }
}
if ($handle -eq [IntPtr]::Zero) { throw "no app window" }

[void]$proc.WaitForInputIdle(5000)
Start-Sleep -Milliseconds $SettleMs

[void][Lab]::SetCursorPos(2, 2)
# Raise the backdrop first, then the app: both are topmost, so the last
# SetWindowPos wins and the app sits above a solid background.
[void][Backdrop]::Raise()
[void][Lab]::SetWindowPos($handle, [IntPtr](-1), $X, $Y, $W, $H, 0x0004)
Start-Sleep -Milliseconds 900
[void][Lab]::ShowWindow($handle, 5)
[void][Lab]::BringWindowToTop($handle)
[void][Lab]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds $SettleMs

# Optional resize stress: a burst of intermediate sizes ending at -ResizeTo,
# which is what a drag-resize looks like to the window-event handler.
if ($ResizeTo -ne "") {
  $parts = $ResizeTo.ToLower().Split("x")
  if ($parts.Length -ne 2) { throw "-ResizeTo must look like 500x700" }
  $tw = [int]$parts[0]; $th = [int]$parts[1]
  if ($ResizeJitter -gt 0) {
    for ($i = 1; $i -le $ResizeJitter; $i++) {
      $f = $i / [double]($ResizeJitter + 1)
      $iw = [int][Math]::Round($W + ($tw - $W) * $f)
      $ih = [int][Math]::Round($H + ($th - $H) * $f)
      [void][Lab]::SetWindowPos($handle, [IntPtr](0), $X, $Y, $iw, $ih, 0x0004)
      Start-Sleep -Milliseconds 35
    }
  }
  [void][Lab]::SetWindowPos($handle, [IntPtr](0), $X, $Y, $tw, $th, 0x0004)
  Start-Sleep -Milliseconds $SettleMs
  Write-Output ("resized to {0}x{1} (jitter={2})" -f $tw, $th, $ResizeJitter)
}

# Minimize/restore cycle re-creates the native surface; a stale region cache
# would leave square corners here too.
if ($MinimizeCycle) {
  [void][Lab]::ShowWindow($handle, 6)
  Start-Sleep -Milliseconds 900
  [void][Lab]::ShowWindow($handle, 9)
  [void][Backdrop]::Raise()
  [void][Lab]::SetWindowPos($handle, [IntPtr](-1), $X, $Y, 0, 0, 0x0001 -bor 0x0002)
  [void][Lab]::BringWindowToTop($handle)
  Start-Sleep -Milliseconds $SettleMs
  Write-Output "minimize/restore cycle done"
}

$r = New-Object Lab+RECT
[void][Lab]::GetWindowRect($handle, [ref]$r)
$winW = $r.Right - $r.Left
$winH = $r.Bottom - $r.Top

# Optional DWM non-client rendering policy (1 = disabled, 2 = enabled).
# Experiments only: distinguishes a DWM frame shadow from our own painting.
if ($NcPolicy -ne "") {
  $policy = [int]$NcPolicy
  $hr = [Lab]::DwmSetWindowAttribute($handle, 2, [ref]$policy, 4)
  Start-Sleep -Milliseconds 700
  Write-Output ("dwm nc policy={0} hr={1}" -f $policy, $hr)
}
$ncCurrent = 0
$ncHr = -1
try { $ncHr = [Lab]::DwmGetWindowAttribute($handle, 2, [ref]$ncCurrent, 4) } catch {}
$dpi = [Lab]::GetDpiForWindow($handle)
$regionProbe = [Lab]::RegionProbe($handle, $winW, $winH)
$cornerPref = 0; $backdrop = 0; $borderColor = 0; $darkMode = 0
$cornerHr = -1; $backdropHr = -1; $borderHr = -1; $darkHr = -1
try { $cornerHr = [Lab]::DwmGetWindowAttribute($handle, 33, [ref]$cornerPref, 4) } catch {}
try { $backdropHr = [Lab]::DwmGetWindowAttribute($handle, 38, [ref]$backdrop, 4) } catch {}
try { $borderHr = [Lab]::DwmGetWindowAttribute($handle, 34, [ref]$borderColor, 4) } catch {}
try { $darkHr = [Lab]::DwmGetWindowAttribute($handle, 20, [ref]$darkMode, 4) } catch {}

$pad = 48
$screen = [System.Windows.Forms.Screen]::FromHandle($handle).Bounds
$capX = [Math]::Max($screen.Left, $r.Left - $pad)
$capY = [Math]::Max($screen.Top, $r.Top - $pad)
$capR = [Math]::Min($screen.Right, $r.Left + $winW + $pad)
$capB = [Math]::Min($screen.Bottom, $r.Top + $winH + $pad)
$capW = [int]($capR - $capX)
$capH = [int]($capB - $capY)
Write-Output ("capture x={0} y={1} w={2} h={3} win={4}x{5} rect={6},{7},{8},{9} screen={10},{11},{12},{13}" -f `
  $capX, $capY, $capW, $capH, $winW, $winH, $r.Left, $r.Top, $r.Right, $r.Bottom, `
  $screen.Left, $screen.Top, $screen.Right, $screen.Bottom)

function Save-Capture([string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($capW, $capH)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen($capX, $capY, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  $gfx.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $px = $bmp.GetPixel(4, 4)
  $px2 = $bmp.GetPixel($bmp.Width - 5, 4)
  $bmp.Dispose()
  Write-Output ("capture {0}: borderTL={1},{2},{3} borderTR={4},{5},{6} bg={7}" -f `
    (Split-Path -Leaf $path), $px.R, $px.G, $px.B, $px2.R, $px2.G, $px2.B, [Backdrop]::Info())
}

$visiblePath = $full -replace '\.png$', '-visible.png'
$baselinePath = $full -replace '\.png$', '-baseline.png'

Save-Capture $visiblePath
Start-Sleep -Milliseconds 350

# Hide the app, re-raise the backdrop above any other topmost window, and
# capture the same geometry: it must now hold only the backdrop surface.
[void][Lab]::ShowWindow($handle, 0)
Start-Sleep -Milliseconds 300
[void][Backdrop]::Raise()
Start-Sleep -Milliseconds 700
Save-Capture $baselinePath

# Baseline sanity: the capture border (window is inset by the padding) must be
# the backdrop face, otherwise the baseline is invalid and acceptance must not
# silently pass. Record the actual pixel for the analyzer.
$bgBmp = [System.Drawing.Bitmap]::FromFile($baselinePath)
$bgPx = $bgBmp.GetPixel(4, 4)
$bgPx2 = $bgBmp.GetPixel($bgBmp.Width - 5, $bgBmp.Height - 5)
$bgBmp.Dispose()
$expected = [Backdrop]::Face
$bgOk = ([Math]::Abs($bgPx.R - $expected.R) -le 3 -and
         [Math]::Abs($bgPx.G - $expected.G) -le 3 -and
         [Math]::Abs($bgPx.B - $expected.B) -le 3 -and
         [Math]::Abs($bgPx2.R - $expected.R) -le 3 -and
         [Math]::Abs($bgPx2.G - $expected.G) -le 3 -and
         [Math]::Abs($bgPx2.B - $expected.B) -le 3)

# Show again and re-capture: catches stale-frame / first-present artifacts.
[void][Backdrop]::Raise()
[void][Lab]::ShowWindow($handle, 5)
[void][Lab]::SetWindowPos($handle, [IntPtr](-1), $r.Left, $r.Top, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010)
[void][Lab]::BringWindowToTop($handle)
[void][Lab]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 900
$reShowPath = $full -replace '\.png$', '-reshow.png'
Save-Capture $reShowPath

$radiusLogical = if ($Preset -eq "liquid-glass") { 20 } else { 18 }
$scale = [Math]::Round($dpi / 96.0, 4)
$meta = [ordered]@{
  out = $full
  visible = $visiblePath
  baseline = $baselinePath
  reshow = $reShowPath
  window = @{ x = $r.Left; y = $r.Top; w = $winW; h = $winH }
  capture = @{ x = $capX; y = $capY; w = $capW; h = $capH }
  dpi = $dpi
  scale = $scale
  region_probe = $regionProbe
  dwm = @{ corner_preference = $cornerPref; system_backdrop = $backdrop; border_color = $borderColor; dark_mode = $darkMode; nc_policy = $ncCurrent
           corner_hr = $cornerHr; backdrop_hr = $backdropHr; border_hr = $borderHr; dark_hr = $darkHr; nc_policy_hr = $ncHr }
  preset = $Preset; theme = $Theme; material = $Material
  seed = $Seed
  radius_logical = $radiusLogical
  radius_phys = [int][Math]::Round($radiusLogical * $scale)
  backdrop = @{ r = $expected.R; g = $expected.G; b = $expected.B }
  glass_backend = if ($env:TASK_DOCK_GLASS_BACKEND) { $env:TASK_DOCK_GLASS_BACKEND } else { "auto" }
  dwm_border_env = if ($env:TASK_DOCK_WINDOW_DWM_BORDER) { $env:TASK_DOCK_WINDOW_DWM_BORDER } else { "1" }
  region_env = $Region; dwm_env = $DwmCorner
  nc_policy_env = $NcPolicy
  visible_before = $true
  baseline_check = @{
    expected = ("{0},{1},{2}" -f $expected.R, $expected.G, $expected.B)
    corner_px = ("{0},{1},{2}" -f $bgPx.R, $bgPx.G, $bgPx.B)
    far_px = ("{0},{1},{2}" -f $bgPx2.R, $bgPx2.G, $bgPx2.B)
    valid = $bgOk
  }
}
$metaPath = $full -replace '\.png$', '.json'
$meta | ConvertTo-Json -Depth 5 | Set-Content -Path $metaPath -Encoding UTF8
Write-Output ("meta=" + $metaPath)
Write-Output ("size={0}x{1} dpi={2} region_probe={3}" -f $winW, $winH, $dpi, $regionProbe)
Write-Output ("dwm corner={0} backdrop={1} border={2} dark={3}" -f $cornerPref, $backdrop, $borderColor, $darkMode)
Write-Output ("baseline valid={0} corner={1} far={2}" -f $bgOk, $meta.baseline.corner_px, $meta.baseline.far_px)
if (-not $bgOk) { Write-Output "WARN: baseline is not the controlled backdrop; corner verdict must be UNVERIFIED" }

$proc.Refresh()
if (-not $KeepAlive -and -not $proc.HasExited) {
  $proc.Kill()
  [void]$proc.WaitForExit(5000)
}
[Backdrop]::Stop()
Start-Sleep -Milliseconds 300
