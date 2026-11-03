# Windows PowerShell 5.1+ / PowerShell 7+
# Project-scoped, conservative cleanup of stale developer processes.
# Default is observation only. -AutoStop permits narrowly gated termination.
# Example:
# powershell -NoProfile -ExecutionPolicy Bypass -File .\watch-dev-processes.ps1 -ProjectRoot 'D:\code\task_dock' -Once
# powershell -NoProfile -ExecutionPolicy Bypass -File .\watch-dev-processes.ps1 -ProjectRoot 'D:\code\task_dock' -AutoStop

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [switch]$Once,
    [switch]$AutoStop,
    [ValidateRange(10, 3600)][int]$IntervalSeconds = 45,
    [ValidateRange(5, 1440)][int]$MinAgeMinutes = 15,
    # N consecutive idle deltas; the first snapshot only seeds the baseline, so N+1 samples are needed.
    [ValidateRange(2, 20)][int]$ConfirmSamples = 3,
    [ValidateRange(64, 65536)][int]$MinPrivateMB = 256,
    [ValidateRange(512, 131072)][int]$LowMemoryMB = 4096,
    # Optional: append-only log for each scan summary and each stop (with the reason).
    [string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
if (-not (Test-Path -LiteralPath (Join-Path $resolvedRoot 'package.json') -PathType Leaf)) {
    throw 'ProjectRoot must point to the project directory (package.json is missing).'
}
$script:rootText = $resolvedRoot.TrimEnd([char[]]@('\', '/')).Replace('\', '/')
$script:seen = @{}
$script:logPath = $LogPath

function Write-Log([string]$message) {
    if ([string]::IsNullOrWhiteSpace($script:logPath)) { return }
    $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $message
    try {
        Add-Content -LiteralPath $script:logPath -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {
        Write-Warning ("Cannot append to log: {0}" -f $_.Exception.Message)
    }
}
$names = @('node.exe', 'cargo.exe', 'rustc.exe', 'esbuild.exe', 'tauri.exe', 'vite.exe')
# Prefix match is enough: hyphenated tool names (codex-with-chatgpt, opencode-cli) must still be protected.
# tsserver/typingsInstaller are editor language services, not stale build processes of this project.
$protectedTools = '(?i)(?:^|[/\\\s"''])(?:codex|claude|gemini|opencode|cursor|windsurf|tsserver|typingsinstaller)'

function Test-ProjectCommand([string]$line) {
    if ([string]::IsNullOrWhiteSpace($line)) { return $false }
    $normalized = $line.Replace('\', '/')
    $at = $normalized.IndexOf($script:rootText, [StringComparison]::OrdinalIgnoreCase)
    while ($at -ge 0) {
        $end = $at + $script:rootText.Length
        if ($end -eq $normalized.Length -or $normalized[$end] -in @('/', ' ', '"', "'", "`t")) {
            return $true
        }
        $at = $normalized.IndexOf($script:rootText, $at + 1, [StringComparison]::OrdinalIgnoreCase)
    }
    return $false
}

function Test-Orphan($p, $pidMap) {
    $parentId = [int]$p.ParentProcessId
    if ($parentId -le 4) { return $false }
    if (-not $pidMap.ContainsKey($parentId)) { return $true }
    $parent = $pidMap[$parentId]
    # PID reuse: a parent created AFTER the child cannot be its original parent.
    return ([datetime]$parent.CreationDate -gt ([datetime]$p.CreationDate).AddSeconds(1))
}

function Get-AvailableMemoryMB {
    # Available memory (standby cache included) is the meaningful pressure metric. FreePhysicalMemory
    # counts only truly free pages and stays below the threshold on machines with a large standby list.
    try {
        $mem = Get-CimInstance -ClassName Win32_PerfRawData_PerfOS_Memory -ErrorAction Stop
        return [pscustomobject]@{
            MB = [math]::Round(([double]$mem.AvailableBytes / 1MB), 0); Source = 'available'
        }
    } catch {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        return [pscustomobject]@{
            MB = [math]::Round(([double]$os.FreePhysicalMemory / 1024), 0); Source = 'free-physical'
        }
    }
}

function Get-ScopedSnapshot {
    $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $pidMap = @{}
    foreach ($p in $all) { $pidMap[[int]$p.ProcessId] = $p }
    $found = @()
    foreach ($p in $all) {
        if ($p.Name -notin $names) { continue }
        if (-not (Test-ProjectCommand ([string]$p.CommandLine)) -and
            -not (Test-ProjectCommand ([string]$p.ExecutablePath))) { continue }
        $found += $p
    }
    return [pscustomobject]@{ All = $all; Map = $pidMap; Scoped = $found }
}

function Confirm-SafeToStop($p, [double]$sampleCpu) {
    # All predicates are rechecked immediately before stopping; unknown -> skip.
    $id = [int]$p.ProcessId
    $live = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $id" -ErrorAction Stop
    if ($null -eq $live) { return $null }
    if ([datetime]$live.CreationDate -ne [datetime]$p.CreationDate) { return $null }
    if (-not (Test-ProjectCommand ([string]$live.CommandLine)) -and
        -not (Test-ProjectCommand ([string]$live.ExecutablePath))) { return $null }
    if ([string]$live.CommandLine -match $protectedTools) { return $null }
    $parentId = [int]$live.ParentProcessId
    if ($parentId -le 4) { return $null }
    $parent = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $parentId" -ErrorAction Stop
    if ($null -ne $parent -and
        [datetime]$parent.CreationDate -le ([datetime]$live.CreationDate).AddSeconds(1)) {
        return $null
    }
    $cpu = (Get-Process -Id $id -ErrorAction Stop).CPU
    if ($null -eq $cpu -or ([double]$cpu - $sampleCpu) -gt 0.5) { return $null }
    # Recheck listening ports: the process may start listening between the scan and the stop (TOCTOU).
    try {
        if (@(Get-NetTCPConnection -State Listen -ErrorAction Stop |
                Where-Object { [int]$_.OwningProcess -eq $id }).Count -gt 0) { return $null }
    } catch {
        return $null  # Unknown listening state is treated as unsafe.
    }
    # Return the verified process object; the caller no longer stops by bare PID (narrows PID-reuse window).
    $proc = Get-Process -Id $id -ErrorAction Stop
    if ([math]::Abs(($proc.StartTime - [datetime]$p.CreationDate).TotalSeconds) -gt 2) { return $null }
    return $proc
}

function Invoke-Scan {
    $snap = Get-ScopedSnapshot
    $memInfo = Get-AvailableMemoryMB
    $freeMB = $memInfo.MB
    $pressure = $freeMB -lt $LowMemoryMB
    $now = Get-Date
    $next = @{}
    $rows = @()
    $eligible = @()
    foreach ($p in $snap.Scoped) {
        $id = [int]$p.ProcessId
        $started = [datetime]$p.CreationDate
        $key = '{0}|{1}' -f $id, $started.Ticks
        $ageMin = ($now - $started).TotalMinutes
        $privateMB = [math]::Round(([double]$p.PrivatePageCount / 1MB), 0)
        $orphan = Test-Orphan $p $snap.Map
        $protected = ([string]$p.CommandLine -match $protectedTools)
        $cpu = $null
        try { $cpu = (Get-Process -Id $id -ErrorAction Stop).CPU } catch { }

        $streak = 0
        if ($script:seen.ContainsKey($key) -and $null -ne $cpu) {
            $prior = $script:seen[$key]
            $elapsed = ($now - $prior.Time).TotalSeconds
            if ($elapsed -gt 0 -and $null -ne $prior.Cpu) {
                $delta = ([double]$cpu - [double]$prior.Cpu)
                # <=2% of one logical core over the full sampling interval.
                if ($delta -ge 0 -and $delta -le ($elapsed * 0.02) -and
                    $orphan -and -not $protected -and
                    $ageMin -ge $MinAgeMinutes -and $privateMB -ge $MinPrivateMB) {
                    $streak = [int]$prior.Streak + 1
                }
            }
        }
        $next[$key] = [pscustomobject]@{ Cpu = $cpu; Time = $now; Streak = $streak }
        $row = [pscustomobject]@{
            PID = $id; Name = [string]$p.Name; MemoryMB = $privateMB
            AgeMin = [int][math]::Floor($ageMin); Orphan = $orphan
            IdleSamples = $streak
        }
        $rows += $row
        if ($streak -ge $ConfirmSamples) {
            $eligible += [pscustomobject]@{ Process = $p; Cpu = [double]$cpu; Row = $row }
        }
    }
    $script:seen = $next
    Write-Host ("[{0}] scoped={1} availRAM={2}MB({3}) pressure={4} mode={5}" -f
        $now.ToString('HH:mm:ss'), $rows.Count, $freeMB, $memInfo.Source, $pressure,
        $(if ($AutoStop) { 'AUTO' } else { 'DRY-RUN' }))
    Write-Log ("scan scoped={0} availRAM={1}MB({2}) threshold={3}MB pressure={4} mode={5}" -f
        $rows.Count, $freeMB, $memInfo.Source, $LowMemoryMB, $pressure,
        $(if ($AutoStop) { 'AUTO' } else { 'DRY-RUN' }))

    if ($Once) {
        if ($rows.Count) {
            $rows | Sort-Object MemoryMB -Descending | Select-Object -First 20 |
                Format-Table -AutoSize | Out-Host
        } else {
            Write-Host 'No project-scoped dev processes found. Relative-path commands may be missed.'
        }
        Write-Host 'Note: -Once cannot accumulate samples, so IdleSamples stays 0; gating needs continuous mode.'
        $snap.All | Sort-Object -Property PrivatePageCount -Descending |
            Select-Object -First 8 @{N='PID';E={$_.ProcessId}}, Name,
                @{N='PrivateMB';E={[math]::Round(([double]$_.PrivatePageCount / 1MB), 0)}} |
            Format-Table -AutoSize | Out-Host
        return
    }

    if (-not $pressure -or $eligible.Count -eq 0) { return }
    $listening = @{}
    try {
        foreach ($conn in @(Get-NetTCPConnection -State Listen -ErrorAction Stop)) {
            $listening[[int]$conn.OwningProcess] = $true
        }
    } catch {
        Write-Warning 'Cannot inspect listening TCP ports; no process will be stopped in this cycle.'
        return
    }

    foreach ($item in $eligible) {
        $id = [int]$item.Process.ProcessId
        if ($listening.ContainsKey($id)) { continue }
        $reason = ('orphan; age={0}min>={1}; idle={2}samples>={3}; private={4}MB>={5}; no-TCP-listen' -f
            $item.Row.AgeMin, $MinAgeMinutes, $item.Row.IdleSamples, $ConfirmSamples,
            $item.Row.MemoryMB, $MinPrivateMB)
        if (-not $AutoStop) {
            Write-Host ("[CANDIDATE, dry-run] PID={0} {1} {2}MB reason={3}" -f
                $id, $item.Process.Name, $item.Row.MemoryMB, $reason)
            Write-Log ("CANDIDATE pid={0} name={1} private={2}MB reason={3} cmd={4}" -f
                $id, $item.Process.Name, $item.Row.MemoryMB, $reason, $item.Process.CommandLine)
            continue
        }
        try {
            $verified = Confirm-SafeToStop $item.Process $item.Cpu
            if ($null -eq $verified) { continue }
            # Stop a single verified process object, never a whole tree or an unscoped process.
            $verified | Stop-Process -Force -ErrorAction Stop
            Write-Host ("[STOPPED] PID={0} {1} {2}MB reason={3}" -f
                $id, $item.Process.Name, $item.Row.MemoryMB, $reason)
            Write-Log ("STOPPED pid={0} name={1} private={2}MB reason={3} cmd={4}" -f
                $id, $item.Process.Name, $item.Row.MemoryMB, $reason, $item.Process.CommandLine)
            return  # Stop at most one process per scan.
        } catch {
            Write-Warning ("PID={0} stop skipped/failed: {1}" -f $id, $_.Exception.Message)
            Write-Log ("STOP-FAILED pid={0} reason={1} error={2}" -f $id, $reason, $_.Exception.Message)
        }
    }
}

Write-Host "Project: $resolvedRoot"
Write-Host 'Scope: known dev executables whose command lines reference the project root.'
Write-Host 'Safety: stale parent + age + persistent CPU idle + memory pressure + no TCP listener.'
if (-not $AutoStop) { Write-Host 'Observation-only. Add -AutoStop to enable guarded termination.' }
if ($Once) {
    Invoke-Scan
} else {
    Write-Host 'Monitoring. Press Ctrl+C to stop the watchdog.'
    while ($true) {
        try { Invoke-Scan } catch { Write-Warning ("Scan failed: {0}" -f $_.Exception.Message) }
        Start-Sleep -Seconds $IntervalSeconds
    }
}
