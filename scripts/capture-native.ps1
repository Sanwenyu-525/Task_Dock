# Native window capture for Task Dock v0.6 visual acceptance.
#
# Why a dedicated script: browser harnesses can only verify CSS layout.
# Whether the four window corners really are transparent (no black square),
# whether native Mica/Acrylic shows the desktop behind, and whether the
# drag region still works, must be verified on a real Win32 window.
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/capture-native.ps1 -Out docs/screenshots/v06/native.png
#
# The capture uses CopyFromScreen (screen composited pixels), not PrintWindow,
# so whatever is behind the window shows up in the rounded corners. That is
# exactly the evidence this script is meant to produce.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 files as
# ANSI unless they carry a BOM, so non-ASCII strings would be garbled.

param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Process = "task-dock",
  [int]$WaitSeconds = 5
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class NativeWin {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  // Returns top level windows of the given pid, visible ones first.
  public static List<IntPtr> WindowsOfProcess(uint target) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == target) list.Add(h);
      return true;
    }, IntPtr.Zero);
    list.Sort((a, b) => {
      bool va = IsWindowVisible(a), vb = IsWindowVisible(b);
      if (va != vb) return va ? -1 : 1;
      RECT ra, rb;
      GetWindowRect(a, out ra);
      GetWindowRect(b, out rb);
      long sa = (long)(ra.Right - ra.Left) * (ra.Bottom - ra.Top);
      long sb = (long)(rb.Right - rb.Left) * (rb.Bottom - rb.Top);
      return sb.CompareTo(sa);
    });
    return list;
  }
}
"@

[void][NativeWin]::SetProcessDPIAware()

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$handle = [IntPtr]::Zero
$rect = New-Object NativeWin+RECT

while ((Get-Date) -lt $deadline) {
  $procs = Get-Process -Name $Process -ErrorAction SilentlyContinue
  foreach ($proc in $procs) {
    foreach ($h in [NativeWin]::WindowsOfProcess([uint32]$proc.Id)) {
      [void][NativeWin]::GetWindowRect($h, [ref]$rect)
      $w = $rect.Right - $rect.Left
      $ht = $rect.Bottom - $rect.Top
      # The real UI window is roughly 240x96 .. 900x1400; skip tray/hidden helpers.
      if ($w -ge 200 -and $ht -ge 80 -and $w -le 2000 -and $ht -le 3000) {
        $handle = $h
        break
      }
    }
    if ($handle -ne [IntPtr]::Zero) { break }
  }
  if ($handle -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 250
}

if ($handle -eq [IntPtr]::Zero) { throw "No UI window found for process: $Process" }

[void][NativeWin]::GetWindowRect($handle, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
[void][NativeWin]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 700

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$full = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location).Path $Out }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
$bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose()
$bmp.Dispose()

Write-Output ("captured {0}x{1} at ({2},{3}) -> {4}" -f $w, $h, $rect.Left, $rect.Top, $full)
