# notification-focus-probe.ps1 - repeatable "notification must not steal focus" probe.
#
# Baseline: the user-selected foreground app is Notepad (the spec names no baseline app;
# Notepad is chosen only as a benign real foreground window).
#
# Procedure:
#   1. remember current foreground window (restored at the end);
#   2. launch Notepad, ShowWindow(SW_RESTORE) + one SetForegroundWindow call (explicitly
#      allowed by the acceptance task; the real mouse is never moved);
#   3. start a high-frequency sampler (default 80 ms) over GetForegroundWindow,
#      notification HWND (title "Task Dock " + U+901A/U+77E5), its GWL_EXSTYLE WS_EX_NOACTIVATE bit,
#      window rect and monitor work area;
#   4. two baseline frames, then POST one agent event to the local ingest endpoint
#      (non-blocking HttpClient task) so sampling continues through the whole
#      appear -> visible -> disappear window (agent_failed auto-dismisses after 13 s);
#   5. stop after 3 consecutive hidden frames once visible was seen, or at timeout;
#   6. close the Notepad we started and restore the original foreground window.
#
# Read-only with respect to the app: no clicks, no IPC writes, no window mutation.
# ASCII-only source (PowerShell 5.1 reads BOM-less files as ANSI).

param(
  [int]$AppProcessId = 0,
  [string]$IngestBase = "http://127.0.0.1:47831",
  [string]$Token = "",
  [string]$Out = "tmp/acceptance/notification-focus/focus-probe.json",
  [int]$IntervalMs = 60,
  [int]$TimeoutMs = 22000
)

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 does not load System.Net.Http by default.
if (-not ([System.Management.Automation.PSTypeName]'System.Net.Http.HttpClient').Type) {
  Add-Type -AssemblyName System.Net.Http
}

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class NtfFocus {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MSG {
    public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
    public uint time; public int x; public int y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public int dwFlags;
  }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFO info);

  public static string Title(IntPtr hWnd) {
    var sb = new StringBuilder(512);
    GetWindowTextW(hWnd, sb, 512);
    return sb.ToString();
  }

  // Match any top-level window owned by target pid whose title contains needle.
  public static IntPtr FindByPidTitle(uint targetPid, string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != targetPid) return true;
      if (Title(h).IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr FindVisibleByPid(uint targetPid, string hint) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != targetPid) return true;
      if (!IsWindowVisible(h)) return true;
      string t = Title(h);
      if (t.Length == 0) return true;
      if (hint.Length > 0 && t.IndexOf(hint, StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }

  public static bool LastAttachSucceeded;
  public static bool LastSetForegroundReturned;

  // 'pid|0xHWND|title' for every visible top-level window (used to detect a NEW Notepad window).
  public static string[] ListVisibleWindows() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      string t = Title(h);
      if (t.Length == 0) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      list.Add(p.ToString() + "|0x" + h.ToInt64().ToString("X") + "|" + t);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  // Foreground lock workaround: a background console lacks foreground rights. Prime this
  // thread's input queue (PeekMessage), temporarily attach to the foreground thread, make
  // the one SetForegroundWindow call, then detach. No synthetic keyboard/mouse input.
  public static bool ForceForeground(IntPtr hWnd) {
    MSG msg; PeekMessage(out msg, IntPtr.Zero, 0, 0, 1 /* PM_REMOVE */);
    IntPtr fg = GetForegroundWindow();
    uint fgPid; uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out fgPid);
    uint ownThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != ownThread) attached = AttachThreadInput(ownThread, fgThread, true);
    LastAttachSucceeded = attached;
    ShowWindow(hWnd, 9 /* SW_RESTORE */);
    BringWindowToTop(hWnd);
    LastSetForegroundReturned = SetForegroundWindow(hWnd);
    System.Threading.Thread.Sleep(450);
    if (attached) AttachThreadInput(ownThread, fgThread, false);
    System.Threading.Thread.Sleep(80);
    return GetForegroundWindow() == hWnd;
  }

  public static MONITORINFO MonitorInfo(IntPtr hWnd) {
    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    IntPtr mon = MonitorFromWindow(hWnd, 2 /* MONITOR_DEFAULTTONEAREST */);
    GetMonitorInfoW(mon, ref mi);
    return mi;
  }
}
"@

function New-OrderedMap {
  return [ordered]@{}
}

function Get-ProcessNameSafe([int]$pidValue) {
  if ($script:pidNameCache.ContainsKey($pidValue)) { return $script:pidNameCache[$pidValue] }
  $name = $null
  try { $name = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch { $name = $null }
  $script:pidNameCache[$pidValue] = $name
  return $name
}

function Get-Frame {
  param(
    [Int64]$ElapsedMs,
    [Int64]$UnixMs,
    [IntPtr]$FgHwnd,
    [IntPtr]$NotifHwnd,
    [uint32]$NotepadPid
  )
  $fgPid = [uint32]0
  if ($FgHwnd -ne [IntPtr]::Zero) { [void][NtfFocus]::GetWindowThreadProcessId($FgHwnd, [ref]$fgPid) }
  $fgTitle = if ($FgHwnd -ne [IntPtr]::Zero) { [NtfFocus]::Title($FgHwnd) } else { $null }

  $found = ($NotifHwnd -ne [IntPtr]::Zero)
  $visible = $false
  $ex = $null
  $noActivate = $null
  $rect = $null
  $workArea = $null
  $inWorkArea = $null
  $overflow = $null
  if ($found) {
    $visible = [NtfFocus]::IsWindowVisible($NotifHwnd)
    $ex = [int64][NtfFocus]::GetWindowLongPtrW($NotifHwnd, -20)
    $noActivate = (($ex -band 0x08000000) -ne 0)
    $r = New-Object NtfFocus+RECT
    if ([NtfFocus]::GetWindowRect($NotifHwnd, [ref]$r)) {
      $rect = [ordered]@{
        left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom
        width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top)
      }
      $mi = [NtfFocus]::MonitorInfo($NotifHwnd)
      $workArea = [ordered]@{
        left = $mi.rcWork.Left; top = $mi.rcWork.Top; right = $mi.rcWork.Right; bottom = $mi.rcWork.Bottom
      }
      $overflow = [ordered]@{
        left = [Math]::Max(0, $workArea.left - $r.Left)
        top = [Math]::Max(0, $workArea.top - $r.Top)
        right = [Math]::Max(0, $r.Right - $workArea.right)
        bottom = [Math]::Max(0, $r.Bottom - $workArea.bottom)
      }
      $inWorkArea = (($overflow.left + $overflow.top + $overflow.right + $overflow.bottom) -eq 0)
    }
  }

  return [ordered]@{
    elapsedMs = $ElapsedMs
    unixMs = $UnixMs
    foregroundHwnd = ("0x" + $FgHwnd.ToInt64().ToString("X"))
    foregroundPid = [int]$fgPid
    foregroundProcess = (Get-ProcessNameSafe ([int]$fgPid))
    foregroundTitle = $fgTitle
    notificationFound = $found
    notificationVisible = $visible
    notificationHwnd = if ($found) { ("0x" + $NotifHwnd.ToInt64().ToString("X")) } else { $null }
    exStyle = if ($null -ne $ex) { [int64]$ex } else { $null }
    exStyleHex = if ($null -ne $ex) { ("0x" + $ex.ToString("X")) } else { $null }
    noActivateBit = $noActivate
    notificationRect = $rect
    workArea = $workArea
    rectInWorkArea = $inWorkArea
    rectOverflowPx = $overflow
    foregroundIsNotepad = ([int]$fgPid -eq [int]$NotepadPid)
  }
}

# ---- parameters ----------------------------------------------
if ($AppProcessId -le 0) {
  $apps = @(Get-Process -Name task-dock -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq "Task Dock" })
  if ($apps.Count -ne 1) {
    throw "expected exactly one running Task Dock with a main window, found $($apps.Count); pass -AppProcessId"
  }
  $AppProcessId = $apps[0].Id
}

$outFull = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))
$outDir = Split-Path -Parent $outFull
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$script:pidNameCache = @{}
$needle = "Task Dock " + [string][char]0x901A + [string][char]0x77E5

$appProc = Get-Process -Id $AppProcessId -ErrorAction Stop
$originalFg = [NtfFocus]::GetForegroundWindow()

# Baseline: existing visible Notepad windows (Windows 11 Notepad can host several windows
# in one process, so a NEW window handle is the reliable indicator, not a new pid).
$baselineNotepadPids = @(Get-Process -Name notepad -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$baselineNotepadHwnds = @()
foreach ($w in [NtfFocus]::ListVisibleWindows()) {
  $parts = $w -split '\|', 3
  if ($parts.Count -lt 3) { continue }
  if ($parts[2] -match 'Notepad') { $baselineNotepadHwnds += [Convert]::ToInt64($parts[1].Substring(2), 16) }
}

$notepad = Start-Process -FilePath "notepad.exe" -PassThru
$notepadHwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 150
  foreach ($w in [NtfFocus]::ListVisibleWindows()) {
    $parts = $w -split '\|', 3
    if ($parts.Count -lt 3) { continue }
    if ($parts[2] -notmatch 'Notepad') { continue }
    $hVal = [Convert]::ToInt64($parts[1].Substring(2), 16)
    if ($baselineNotepadHwnds -notcontains $hVal) { $notepadHwnd = [IntPtr]$hVal; break }
  }
  if ($notepadHwnd -ne [IntPtr]::Zero) { break }
}

$notepadPid = if ($notepadHwnd -ne [IntPtr]::Zero) {
  $tmpPid = [uint32]0
  [void][NtfFocus]::GetWindowThreadProcessId($notepadHwnd, [ref]$tmpPid)
  [int]$tmpPid
} else { 0 }

$fgGranted = $false
$fgAfterGrant = [IntPtr]::Zero
$grantAttach = $false
$grantSetForeground = $false
if ($notepadHwnd -ne [IntPtr]::Zero) {
  # Foreground lock: a background console is normally denied SetForegroundWindow.
  # ForceForeground primes the thread input queue, attaches to the current foreground
  # thread, makes the one allowed SetForegroundWindow call, then detaches.
  $fgGranted = [NtfFocus]::ForceForeground($notepadHwnd)
  $grantAttach = [NtfFocus]::LastAttachSucceeded
  $grantSetForeground = [NtfFocus]::LastSetForegroundReturned
  $fgAfterGrant = [NtfFocus]::GetForegroundWindow()
}

if (-not $fgGranted) {
  if ($notepadHwnd -ne [IntPtr]::Zero) {
    try { [void][NtfFocus]::PostMessageW($notepadHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) } catch {}
    Start-Sleep -Milliseconds 500
    if ($notepadPid -gt 0 -and $baselineNotepadPids -notcontains $notepadPid) {
      try { if (Get-Process -Id $notepadPid -ErrorAction SilentlyContinue) { Stop-Process -Id $notepadPid -Force } } catch {}
    }
  }
  $blocked = [ordered]@{
    name = "notification focus probe"
    timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
    result = "ENVIRONMENT BLOCKED"
    reason = "foreground grant to Notepad failed; no baseline foreground app to protect"
    appProcessId = $AppProcessId
    notepadPid = $notepadPid
    notepadHwnd = ("0x" + $notepadHwnd.ToInt64().ToString("X"))
    foregroundAfterGrant = ("0x" + $fgAfterGrant.ToInt64().ToString("X"))
    attachThreadInput = [NtfFocus]::LastAttachSucceeded
    setForegroundReturned = [NtfFocus]::LastSetForegroundReturned
  }
  $json = $blocked | ConvertTo-Json -Depth 6
  Set-Content -Path $outFull -Value $json -Encoding utf8
  Write-Output $json
  exit 3
}

# ---- one non-blocking ingest request -------------------------
$sessionSuffix = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmssfff")
$payload = [ordered]@{
  source_id = "bridge"
  session_id = "nfp-focus-$sessionSuffix"
  run_id = "nfp-focus-r-$sessionSuffix"
  state = "failed"
  task_title = "Focus probe: build release 0.7.0"
  message = "Signing certificate missing; packaging cannot complete."
  transport = "http"
} | ConvertTo-Json -Compress

$http = [System.Net.Http.HttpClient]::new()
$http.Timeout = [TimeSpan]::FromSeconds(10)
$req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, ($IngestBase.TrimEnd('/') + "/api/v1/events"))
[void]$req.Headers.TryAddWithoutValidation("Authorization", ("Bearer " + $Token))
$req.Content = [System.Net.Http.StringContent]::new($payload, [System.Text.Encoding]::UTF8, "application/json")
$postTask = $null
$postStarted = $null

# ---- sampling loop -------------------------------------------
$frames = New-Object System.Collections.Generic.List[object]
$loopStart = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$deadline = $loopStart + $TimeoutMs
$notifHwnd = [IntPtr]::Zero
$visibleSeen = $false
$hiddenStreak = 0
$firstVisibleMs = $null
$lastVisibleMs = $null
$hiddenAtMs = $null

while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $deadline) {
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $elapsed = $nowMs - $loopStart
  if ($notifHwnd -eq [IntPtr]::Zero -or -not [NtfFocus]::IsWindow($notifHwnd)) {
    $notifHwnd = [NtfFocus]::FindByPidTitle([uint32]$AppProcessId, $needle)
  }
  $fg = [NtfFocus]::GetForegroundWindow()
  $frame = Get-Frame -ElapsedMs $elapsed -UnixMs $nowMs -FgHwnd $fg -NotifHwnd $notifHwnd -NotepadPid ([uint32]$notepadPid)
  $frames.Add($frame)

  if ($frame.notificationVisible) {
    if (-not $visibleSeen) { $visibleSeen = $true; $firstVisibleMs = $elapsed }
    $lastVisibleMs = $elapsed
    $hiddenStreak = 0
  } elseif ($visibleSeen) {
    $hiddenStreak++
    if ($null -eq $hiddenAtMs) { $hiddenAtMs = $elapsed }
    if ($hiddenStreak -ge 3) { break }
  }

  # Two baseline frames first, then fire the event once (sampling never pauses:
  # SendAsync returns immediately, the HTTP work happens on the thread pool).
  if ($null -eq $postStarted -and $frames.Count -ge 2) {
    $postStarted = $elapsed
    $postTask = $http.SendAsync($req)
  }

  Start-Sleep -Milliseconds $IntervalMs
}

$postStatus = $null
$postBody = $null
$postCompleted = $false
try {
  if ($null -ne $postTask) {
    # The HTTP call should finish well before the loop ends; wait at most 2 s for the receipt.
    [void]$postTask.Wait(2000)
    if ($postTask.IsCompleted) {
      $resp = $postTask.GetAwaiter().GetResult()
      $postStatus = [int]$resp.StatusCode
      $postBody = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      $postCompleted = $true
    }
  }
} catch {
  $postBody = "ERROR: $($_.Exception.Message)"
}

# ---- restore foreground / close our Notepad ------------------
if ($notepadHwnd -ne [IntPtr]::Zero) {
  # WM_CLOSE = 0x0010
  try { [void][NtfFocus]::PostMessageW($notepadHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) } catch {}
  Start-Sleep -Milliseconds 700
  if ($notepadPid -gt 0 -and $baselineNotepadPids -notcontains $notepadPid) {
    try { if (Get-Process -Id $notepadPid -ErrorAction SilentlyContinue) { Stop-Process -Id $notepadPid -Force } } catch {}
  }
}
if ($notepad -and $notepad.Id -ne $notepadPid -and $baselineNotepadPids -notcontains $notepad.Id) {
  try { if (Get-Process -Id $notepad.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $notepad.Id -Force } } catch {}
}

$restoreAttempted = $false
$restoreOk = $false
if ($originalFg -ne [IntPtr]::Zero -and [NtfFocus]::IsWindow($originalFg)) {
  $restoreAttempted = $true
  $restoreOk = [NtfFocus]::ForceForeground($originalFg)
}
$restoreAttach = [NtfFocus]::LastAttachSucceeded
$restoreSetForeground = [NtfFocus]::LastSetForegroundReturned
$fgFinal = [NtfFocus]::GetForegroundWindow()

# ---- summary -------------------------------------------------
$gaps = @()
for ($i = 1; $i -lt $frames.Count; $i++) { $gaps += ($frames[$i].elapsedMs - $frames[$i - 1].elapsedMs) }
$maxGap = if ($gaps.Count -gt 0) { ($gaps | Measure-Object -Maximum).Maximum } else { $null }
$visibleFrames = @($frames | Where-Object { $_.notificationVisible })
$visibleCount = $visibleFrames.Count
# Foreground must never be the notification HWND (compare against every observed notification HWND).
$notifHwnds = @($frames | ForEach-Object { $_.notificationHwnd } | Where-Object { $null -ne $_ } | Select-Object -Unique)
$fgIsNotif = @($frames | Where-Object { $null -ne $_.notificationHwnd -and ($notifHwnds -contains $_.foregroundHwnd) }).Count
$foregroundNotNotepad = @($visibleFrames | Where-Object { -not $_.foregroundIsNotepad })
$noActivateFalse = @($visibleFrames | Where-Object { $_.noActivateBit -ne $true })
$rectOut = @($visibleFrames | Where-Object { $_.rectInWorkArea -ne $true })
$firstVisibleFg = if ($visibleCount -gt 0) { $visibleFrames[0].foregroundHwnd } else { $null }
$visibleFgChanges = @($visibleFrames | Where-Object { $_.foregroundHwnd -ne $firstVisibleFg })

$criteria = [ordered]@{
  notificationSeen = ($visibleCount -gt 0)
  fullCycleCovered = ($null -ne $firstVisibleMs -and $null -ne $hiddenAtMs)
  atLeast5VisibleFrames = ($visibleCount -ge 5)
  maxFrameGapMs = $maxGap
  frameGapUnder200ms = ($null -ne $maxGap -and $maxGap -le 200)
  foregroundNeverNotification = ($fgIsNotif -eq 0)
  foregroundStaysNotepadWhileVisible = ($foregroundNotNotepad.Count -eq 0)
  noActivateBitSetOnAllVisibleFrames = ($noActivateFalse.Count -eq 0)
  notificationRectInsideWorkArea = ($rectOut.Count -eq 0)
  foregroundStableAcrossVisibleFrames = ($visibleFgChanges.Count -eq 0)
  ingestHttpStatus = $postStatus
  ingestHttpBody = $postBody
}

$pass = $criteria.notificationSeen -and $criteria.atLeast5VisibleFrames -and
  $criteria.frameGapUnder200ms -and $criteria.foregroundNeverNotification -and
  $criteria.foregroundStaysNotepadWhileVisible -and $criteria.noActivateBitSetOnAllVisibleFrames -and
  $criteria.notificationRectInsideWorkArea -and $criteria.foregroundStableAcrossVisibleFrames -and
  ($postStatus -eq 200)

$result = if ($pass) { "PASS" } elseif ($null -eq $firstVisibleMs) { "EVIDENCE INSUFFICIENT" } else { "FAIL" }

$record = [ordered]@{
  name = "notification focus probe"
  timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
  result = $result
  baseline = [ordered]@{
    app = "Notepad (executor-chosen benign foreground app; not specified by the acceptance clause)"
    notepadPid = $notepadPid
    notepadHwnd = ("0x" + $notepadHwnd.ToInt64().ToString("X"))
    originalForegroundHwnd = ("0x" + $originalFg.ToInt64().ToString("X"))
    foregroundGranted = $fgGranted
    foregroundAfterGrant = ("0x" + $fgAfterGrant.ToInt64().ToString("X"))
    foregroundAttachThreadInput = $grantAttach
    foregroundSetForegroundReturned = $grantSetForeground
  }
  trigger = [ordered]@{
    endpoint = ($IngestBase.TrimEnd('/') + "/api/v1/events")
    payload = $payload
    postStartedAtMs = $postStarted
    httpStatus = $postStatus
    httpBody = $postBody
    httpCompleted = $postCompleted
  }
  timing = [ordered]@{
    loopStartUnixMs = $loopStart
    firstVisibleAtMs = $firstVisibleMs
    lastVisibleAtMs = $lastVisibleMs
    hiddenDetectedAtMs = $hiddenAtMs
    visibleDurationMs = if ($null -ne $firstVisibleMs -and $null -ne $lastVisibleMs) { $lastVisibleMs - $firstVisibleMs } else { $null }
  }
  criteria = $criteria
  cleanup = [ordered]@{
    restoreAttempted = $restoreAttempted
    restoreForegroundOk = $restoreOk
    restoreAttachThreadInput = $restoreAttach
    restoreSetForegroundReturned = $restoreSetForeground
    finalForegroundHwnd = ("0x" + $fgFinal.ToInt64().ToString("X"))
  }
  frameCount = $frames.Count
  frames = $frames
}

$json = $record | ConvertTo-Json -Depth 8
Set-Content -Path $outFull -Value $json -Encoding utf8
try { $http.Dispose() } catch {}
Write-Output ("RESULT {0} frames={1} visible={2} out={3}" -f $result, $frames.Count, $visibleCount, $outFull)
Write-Output ("foregroundWhileVisible pid={0} process={1}" -f $notepadPid, (Get-ProcessNameSafe ([int]$notepadPid)))
Write-Output ("maxGapMs={0} noActivateFailures={1} rectOut={2} fgNotifFrames={3}" -f $maxGap, $noActivateFalse.Count, $rectOut.Count, $fgIsNotif)
Write-Output ("ingestStatus={0} restoreOk={1}" -f $postStatus, $restoreOk)
if ($result -eq "PASS") { exit 0 }
if ($result -eq "EVIDENCE INSUFFICIENT") { exit 5 }
exit 4
