param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$IntervalSec = 5,
  [int]$DurationSec = 1800,
  [string]$Base = "http://127.0.0.1:47821",
  [string]$Token = "",
  # 主进程镜像名匹配式。默认匹配正式产物 task-dock.exe；
  # 测量若改用改名后的副本（避免被其它会话按镜像名 taskkill 误杀），
  # 必须显式传入对应式，否则主进程树不会归入 taskdock 分组。
  [string]$ProcessNamePattern = "^task-dock"
)

# 真机资源采样：区分 Task Dock 主进程、其 WebView2 进程树、其他 WebView2、其他 Agent。
# 每 IntervalSec 输出一行 JSON；health 每轮一次，stats 每 6 轮一次（30s）。
# 进程父子关系用 Toolhelp32 快照（毫秒级）；只对相关进程取 CPU/内存，
# 避免对全机数百进程逐个读取 CPU 造成 8s 级抖动。

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ProcTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32FirstW")]
  static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32NextW")]
  static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr hObject);

  public class Snapshot {
    public Dictionary<int, int> Parents = new Dictionary<int, int>();
    public Dictionary<int, string> Names = new Dictionary<int, string>();
  }

  public static Snapshot Take() {
    var snap = new Snapshot();
    IntPtr h = CreateToolhelp32Snapshot(0x2, 0);
    if (h == (IntPtr)(-1)) return snap;
    var pe = new PROCESSENTRY32();
    pe.dwSize = (uint)Marshal.SizeOf(pe);
    if (Process32First(h, ref pe)) {
      do {
        int id = (int)pe.th32ProcessID;
        snap.Parents[id] = (int)pe.th32ParentProcessID;
        snap.Names[id] = pe.szExeFile;
      } while (Process32Next(h, ref pe));
    }
    CloseHandle(h);
    return snap;
  }
}
"@

Add-Type -AssemblyName System.Net.Http

$cores = [Environment]::ProcessorCount
$prevCpu = @{}
$sw = [Diagnostics.Stopwatch]::StartNew()
$sampleNo = 0
# null 表示首轮没有「上一轮采样开始」，不能把 0 当成窗口起点。
$prevTickStart = $null
$utf8 = New-Object System.Text.UTF8Encoding($false)

$handler = New-Object System.Net.Http.HttpClientHandler
$handler.UseProxy = $false
$http = New-Object System.Net.Http.HttpClient($handler)
$http.Timeout = [TimeSpan]::FromSeconds(5)
$statsHeaders = @{ Authorization = "Bearer $Token" }

function Write-Line([string]$text) {
  [System.IO.File]::AppendAllText($Out, $text + "`n", $utf8)
}

function Get-Json($url, $headers) {
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $url)
  if ($headers) {
    foreach ($k in $headers.Keys) { [void]$req.Headers.TryAddWithoutValidation($k, $headers[$k]) }
  }
  $resp = $http.SendAsync($req).GetAwaiter().GetResult()
  $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  return $text | ConvertFrom-Json
}

Write-Line (@{
  record = "meta"; cores = $cores; interval_sec = $IntervalSec; duration_sec = $DurationSec
  stats_every_n_samples = 6
  interval_fields = "planned_interval_s=计划; actual_interval_s=相邻样本开始间隔; sample_duration_s=本轮采样耗时; interval_s=actual_interval_s(兼容旧字段)"
  started_at = (Get-Date).ToString("o"); base = $Base
} | ConvertTo-Json -Compress)

function ConvertTo-Group($procMap, $ids, [double]$interval) {
  $cpuDelta = 0.0; $ws = 0.0; $priv = 0.0; $count = 0
  $maxDelta = 0.0; $maxPid = 0; $maxCpu = 0.0; $maxPrev = 0.0; $missingPrev = 0
  foreach ($procId in $ids) {
    $p = $procMap[$procId]
    if ($null -eq $p) { continue }
    $count++
    $ws += [double]$p.WorkingSet64
    $priv += [double]$p.PrivateMemorySize64
    $cpu = [double]$p.CPU
    if ($prevCpu.ContainsKey($procId)) {
      $prev = [double]$prevCpu[$procId]
      $d = $cpu - $prev
      if ($d -gt 0) {
        $cpuDelta += $d
        if ($d -gt $maxDelta) { $maxDelta = $d; $maxPid = $procId; $maxCpu = $cpu; $maxPrev = $prev }
      }
    } else {
      $missingPrev++
    }
  }
  $cpuPct = 0.0
  if ($interval -gt 0) { $cpuPct = [math]::Round($cpuDelta / $interval / $script:cores * 100, 2) }
  [pscustomobject]@{
    count = $count
    cpu_pct = $cpuPct
    ws_mb = [math]::Round($ws / 1MB, 1)
    private_mb = [math]::Round($priv / 1MB, 1)
    window_s = [math]::Round($interval, 3)
  }
}

while ($sw.Elapsed.TotalSeconds -lt $DurationSec) {
  $tickStart = $sw.Elapsed.TotalSeconds
  $sampleNo++
  # CPU 差值窗口必须按「上一轮采样开始 → 本轮采样开始」计算，
  # 否则上一轮若因 IO/HTTP 耗时较长，会被误当成极短窗口导致数值虚高。
  # actual_interval_s 记录真实间隔；sample_duration_s 记录本轮采集耗时，两者独立。
  $actualInterval = $null
  if ($null -ne $prevTickStart) { $actualInterval = $tickStart - $prevTickStart }
  $interval = if ($null -eq $actualInterval -or $actualInterval -le 0) { [double]$IntervalSec } else { [double]$actualInterval }
  $prevTickStart = $tickStart

  $snap = [ProcTree]::Take()
  $parent = $snap.Parents
  $names = $snap.Names

  $taskIds = New-Object System.Collections.Generic.HashSet[int]
  foreach ($procId in $names.Keys) {
    if ($names[$procId] -match $ProcessNamePattern) { [void]$taskIds.Add($procId) }
  }
  $tree = New-Object System.Collections.Generic.HashSet[int]
  foreach ($r in $taskIds) { [void]$tree.Add($r) }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($procId in $parent.Keys) {
      if ($tree.Contains($parent[$procId]) -and -not $tree.Contains($procId)) {
        [void]$tree.Add($procId); $changed = $true
      }
    }
  }

  $treeWeb = New-Object System.Collections.Generic.HashSet[int]
  $otherWeb = New-Object System.Collections.Generic.HashSet[int]
  $otherAgents = New-Object System.Collections.Generic.HashSet[int]
  foreach ($procId in $names.Keys) {
    $name = [string]$names[$procId]
    if ($name -match '^msedgewebview2') {
      if ($tree.Contains($procId)) { [void]$treeWeb.Add($procId) } else { [void]$otherWeb.Add($procId) }
    } elseif ($name -match 'workbuddy|qoder|trae|codex|opencode|zcode') {
      if (-not $tree.Contains($procId)) { [void]$otherAgents.Add($procId) }
    }
  }

  $relevant = New-Object System.Collections.Generic.HashSet[int]
  foreach ($procId in $tree) { [void]$relevant.Add($procId) }
  foreach ($procId in $treeWeb) { [void]$relevant.Add($procId) }
  foreach ($procId in $otherWeb) { [void]$relevant.Add($procId) }
  foreach ($procId in $otherAgents) { [void]$relevant.Add($procId) }

  $procMap = @{}
  $relevantIds = @($relevant)
  if ($relevantIds.Count -gt 0) {
    foreach ($p in @(Get-Process -Id $relevantIds -ErrorAction SilentlyContinue)) {
      $procMap[[int]$p.Id] = $p
    }
  }

  $health = $null
  try {
    $h = Get-Json "$Base/api/v1/health" $null
    $health = [pscustomobject]@{ ok = $true; queue = $h.queue }
  } catch { $health = [pscustomobject]@{ ok = $false; error = "$($_.Exception.ToString())" } }

  $stats = $null
  if ($Token -and ($sampleNo % 6 -eq 1)) {
    try {
      $s = Get-Json "$Base/api/v1/stats" $statsHeaders
      $stats = [pscustomobject]@{
        queue_depth_events = $s.pipeline.queue_depth_events
        merge_buffer = $s.pipeline.merge_buffer
        events_received = $s.pipeline.events_received
        events_processed = $s.pipeline.events_processed
        events_merged = $s.pipeline.events_merged
        events_sampled = $s.pipeline.events_sampled
        overload_rejects = $s.pipeline.overload_rejects
        commit_failures = $s.pipeline.commit_failures
        http_accepted = $s.http.accepted
        http_requests = $s.http.requests
        http_rejected_overload = $s.http.rejected_overload
        http_active = $s.http.active_requests
        process = $s.process
        runtime = $s.runtime
        notifications = $s.notifications
        db = $s.db
      }
    } catch { $stats = [pscustomobject]@{ error = "$($_.Exception.Message)" } }
  }

  $sampleDuration = $sw.Elapsed.TotalSeconds - $tickStart
  $actualRounded = $null
  if ($null -ne $actualInterval) { $actualRounded = [math]::Round($actualInterval, 3) }
  $record = [pscustomobject]@{
    record = "sample"
    n = $sampleNo
    t = (Get-Date).ToString("o")
    elapsed_s = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    planned_interval_s = $IntervalSec
    actual_interval_s = $actualRounded
    sample_duration_s = [math]::Round($sampleDuration, 3)
    interval_s = $actualRounded
    taskdock = ConvertTo-Group $procMap $taskIds $interval
    webview2_tree = ConvertTo-Group $procMap $treeWeb $interval
    webview2_other = ConvertTo-Group $procMap $otherWeb $interval
    other_agents = ConvertTo-Group $procMap $otherAgents $interval
    system = [pscustomobject]@{ process_count = $names.Count }
    health = $health
    stats = $stats
  }
  Write-Line ($record | ConvertTo-Json -Compress -Depth 8)

  $prevCpu = @{}
  foreach ($id in $procMap.Keys) { $prevCpu[$id] = [double]$procMap[$id].CPU }

  $target = ($sampleNo + 1) * $IntervalSec
  $remain = $target - $sw.Elapsed.TotalSeconds
  if ($remain -gt 0) { Start-Sleep -Milliseconds ([int]($remain * 1000)) }
}

Write-Line (@{ record = "meta"; ended_at = (Get-Date).ToString("o"); samples = $sampleNo } | ConvertTo-Json -Compress)
