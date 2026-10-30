# Native window probe: launch Task Dock, report window visibility over time and
# capture a screen shot. ASCII only (see capture-native.ps1 for the encoding note).
param(
  [string]$Out = "docs/screenshots/v06/native-probe.png",
  [string]$Exe = "D:\Develop\task_dock\src-tauri\target\release\task-dock.exe",
  [string]$DataDir = "",
  [int]$WatchSeconds = 20
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Probe {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
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

[void][Probe]::SetProcessDPIAware()

if ($DataDir -ne "") { $env:TASK_DOCK_DATA_DIR = $DataDir }
$proc = Start-Process -FilePath $Exe -PassThru
Write-Output ("started pid={0} data={1}" -f $proc.Id, $env:TASK_DOCK_DATA_DIR)

$handle = [IntPtr]::Zero
for ($i = 0; $i -lt $WatchSeconds * 2; $i++) {
  Start-Sleep -Milliseconds 500
  $proc.Refresh()
  if ($proc.HasExited) { Write-Output ("t={0}s process exited (code {1})" -f ($i / 2), $proc.ExitCode); break }
  $handles = [Probe]::WindowsOfProcess([uint32]$proc.Id)
  foreach ($h in $handles) {
    $r = New-Object Probe+RECT
    [void][Probe]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    Write-Output ("t={0}s hwnd={1} visible={2} size={3}x{4} at {5},{6}" -f ($i / 2), $h, [Probe]::IsWindowVisible($h), $w, $ht, $r.Left, $r.Top)
    if ($handle -eq [IntPtr]::Zero -and $w -ge 200 -and $ht -ge 80) { $handle = $h }
  }
  if ($handle -ne [IntPtr]::Zero -and [Probe]::IsWindowVisible($handle)) { break }
}

if ($handle -eq [IntPtr]::Zero) { Write-Output "no window handle"; exit 1 }

# Force show + focus so the capture is possible even when the window is hidden.
[void][Probe]::ShowWindow($handle, 5)   # SW_SHOW
[void][Probe]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 900

$r = New-Object Probe+RECT
[void][Probe]::GetWindowRect($handle, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$full = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location).Path $Out }
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
$bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()
Write-Output ("captured {0}x{1} -> {2}" -f $w, $ht, $full)
