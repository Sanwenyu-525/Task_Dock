# Full screen snapshot (ASCII only). Used to inspect what is covering the desktop
# while the native acceptance capture runs.
param([string]$Out = "$env:TEMP\full-screen.png")

Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(2560, 1440)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output ("saved " + $Out)
