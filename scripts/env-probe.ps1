# Environment probe: can this session display a visible top level window and
# capture it from the screen? ASCII only.
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class EnvProbe {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][EnvProbe]::SetProcessDPIAware()

$f = New-Object System.Windows.Forms.Form
$f.Text = "Probe"
$f.Size = New-Object System.Drawing.Size(320, 200)
$f.BackColor = [System.Drawing.Color]::CornflowerBlue
$f.StartPosition = "Manual"
$f.Location = New-Object System.Drawing.Point(100, 100)
$f.Show()
$f.Refresh()
Start-Sleep -Milliseconds 1200
"form visible=" + [EnvProbe]::IsWindowVisible($f.Handle)
"handle=" + $f.Handle
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
"screen bounds=" + $screen.Bounds
$bmp = New-Object System.Drawing.Bitmap($f.Width, $f.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($f.Left, $f.Top, 0, 0, $bmp.Size)
$out = Join-Path $env:TEMP "env-probe.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved=" + $out
$f.Close()
