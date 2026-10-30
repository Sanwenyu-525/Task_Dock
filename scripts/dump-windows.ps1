# Diagnostic dump of top level windows (ASCII only, see capture-native.ps1).
param([string]$Process = "task-dock")

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinDump {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public static List<string> Dump() {
    var rows = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      var sb = new System.Text.StringBuilder(256);
      GetWindowText(h, sb, 256);
      rows.Add(string.Format("hwnd={0} pid={1} vis={2} rect={3},{4} {5}x{6} title={7}",
        h, pid, IsWindowVisible(h), r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, sb.ToString()));
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
"@

[void][WinDump]::SetProcessDPIAware()
foreach ($proc in Get-Process -Name $Process -ErrorAction SilentlyContinue) {
  Write-Output ("== process {0} mainhandle={1}" -f $proc.Id, $proc.MainWindowHandle)
}
[WinDump]::Dump() | ForEach-Object { Write-Output $_ }
