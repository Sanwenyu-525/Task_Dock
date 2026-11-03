# Windows PowerShell 5.1+ / PowerShell 7+
# Project-scoped, conservative cleanup of stale developer processes.
# Default is observation only. -AutoStop permits narrowly gated termination.
# Examples:
# powershell -NoProfile -ExecutionPolicy Bypass -File .\watch-dev-processes.ps1 -ProjectRoot 'D:\code\task_dock' -Once -Samples 3
# powershell -NoProfile -ExecutionPolicy Bypass -File .\watch-dev-processes.ps1 -ProjectRoot 'D:\code\task_dock' -AutoStop -LogPath .\tmp\watch.log

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [switch]$Once,
    [switch]$AutoStop,
    # Number of scans performed by -Once (ignored in continuous mode). Enables offline gating checks.
    [ValidateRange(1, 20)][int]$Samples = 1,
    [ValidateRange(10, 3600)][int]$IntervalSeconds = 45,
    [ValidateRange(5, 1440)][int]$MinAgeMinutes = 15,
    # N consecutive idle deltas; the first snapshot only seeds the baseline, so N+1 samples are needed.
    [ValidateRange(2, 20)][int]$ConfirmSamples = 3,
    [ValidateRange(64, 65536)][int]$MinPrivateMB = 256,
    # 0 = auto: min(4096MB, 15% of total physical memory). Use this to override the computed floor.
    [ValidateRange(0, 131072)][int]$MemoryFloorMB = 0,
    # Exclusions by PID, process name (glob or exact, with/without .exe) or path prefix. Repeatable.
    [string[]]$Exclude = @(),
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
$script:excludes = @()
if ($null -ne $Exclude) {
    $script:excludes = @($Exclude | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

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
# Built-in NeverStop: long-lived tools / the user-facing app must never be auto-stopped by name.
$neverStopPatterns = @('task-dock*.exe', 'tsserver*', 'typingsinstaller*', 'codex*', 'esbuild*', 'vite*')
# Prefix match is enough: hyphenated tool names (codex-with-chatgpt, opencode-cli) must still be protected.
# Editor language services and bundlers are never "stale build processes" of this project.
$protectedTools = '(?i)(?:^|[/\\\s"''])(?:codex|claude|gemini|opencode|cursor|windsurf|tsserver|typingsinstaller|esbuild|vite)'

function Get-PathTokens([string]$text) {
    if ([string]::IsNullOrWhiteSpace($text)) { return @() }
    return @($text -split '[\s",;=\(\)\[\]]+' | Where-Object { $_.Length -gt 0 })
}

function Test-ProjectPathToken([string]$text) {
    # Token-boundary match: the token must equal the root or start with "<root>/".
    # This rejects sibling/prefix names such as task_dock2 or task_dock_backup.
    if ([string]::IsNullOrWhiteSpace($text)) { return $false }
    foreach ($tok in (Get-PathTokens $text)) {
        $t = $tok.Replace('\', '/').TrimEnd('/')
        if ($t.Equals($script:rootText, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        if ($t.StartsWith($script:rootText + '/', [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Test-NeverStop($p) {
    $name = [string]$p.Name
    foreach ($pat in $neverStopPatterns) {
        if ($name -like $pat) { return $true }
    }
    return ([string]$p.CommandLine -match $protectedTools)
}

function Test-Excluded($p) {
    if ($script:excludes.Count -eq 0) { return $false }
    $id = [int]$p.ProcessId
    $name = [string]$p.Name
    $exeText = ([string]$p.ExecutablePath).Replace('\', '/').TrimEnd('/')
    foreach ($raw in $script:excludes) {
        $v = $raw.Trim()
        if ($v -match '^\d+$') {
            if ($id -eq [int]$v) { return $true }
            continue
        }
        if ($name -like $v -or $name -ieq $v -or $name -ieq ($v + '.exe')) { return $true }
        $vn = $v.Replace('\', '/').TrimEnd('/')
        if ($exeText.StartsWith($vn, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        foreach ($tok in (Get-PathTokens ([string]$p.CommandLine))) {
            $t = $tok.Replace('\', '/').TrimEnd('/')
            if ($t.StartsWith($vn, [StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
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

function Get-AncestorBasis($p, $pidMap, [int]$maxDepth = 6) {
    # Auxiliary ownership signal: any ancestor whose command line/exe path token-matches the project.
    $id = [int]$p.ParentProcessId
    for ($depth = 1; $depth -le $maxDepth -and $id -gt 4; $depth++) {
        if (-not $pidMap.ContainsKey($id)) { break }
        $a = $pidMap[$id]
        if ((Test-ProjectPathToken ([string]$a.CommandLine)) -or
            (Test-ProjectPathToken ([string]$a.ExecutablePath))) {
            return [pscustomobject]@{ Matched = $true; Name = [string]$a.Name; Depth = $depth }
        }
        $id = [int]$a.ParentProcessId
    }
    return [pscustomobject]@{ Matched = $false; Name = ''; Depth = 0 }
}

function Get-MemoryGate {
    # Available memory (standby cache included) is the meaningful pressure metric. FreePhysicalMemory
    # counts only truly free pages and stays below the threshold on machines with a large standby list.
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $totalMB = [int][math]::Round(([double]$os.TotalVisibleMemorySize / 1024), 0)
    if ($MemoryFloorMB -gt 0) {
        $thresholdMB = [int]$MemoryFloorMB
        $rule = 'user -MemoryFloorMB'
    } else {
        # Calibration: 15% of physical RAM keeps a proportional reserve; capped at 4096MB so large
        # machines are not required to keep an unbounded absolute buffer (8GB -> 1228MB, 16GB -> 2400MB,
        # 32GB+ -> 4096MB).
        $thresholdMB = [int][math]::Min(4096, [math]::Round($totalMB * 0.15, 0))
        $rule = 'min(4096, 15% total)'
    }
    $source = 'available'
    try {
        $mem = Get-CimInstance -ClassName Win32_PerfRawData_PerfOS_Memory -ErrorAction Stop
        $availMB = [int][math]::Round(([double]$mem.AvailableBytes / 1MB), 0)
    } catch {
        $availMB = [int][math]::Round(([double]$os.FreePhysicalMemory / 1024), 0)
        $source = 'free-physical'
    }
    return [pscustomobject]@{
        AvailableMB = $availMB; Source = $source; TotalMB = $totalMB
        ThresholdMB = $thresholdMB; Rule = $rule
        Pressure = ($availMB -lt $thresholdMB)
    }
}

function Get-ScopeSnapshot {
    $all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $pidMap = @{}
    foreach ($p in $all) { $pidMap[[int]$p.ProcessId] = $p }

    $scoped = @()
    $outOfView = @()
    foreach ($p in $all) {
        $name = [string]$p.Name
        $exeMatch = Test-ProjectPathToken ([string]$p.ExecutablePath)
        $cmdMatch = Test-ProjectPathToken ([string]$p.CommandLine)
        $ancestor = Get-AncestorBasis $p $pidMap

        if ($name -notin $names) {
            # Visibility only: report project-related processes the watchdog will never evaluate.
            if ($exeMatch -or $cmdMatch -or $name -like 'task-dock*' -or $name -like 'task_dock*') {
                $outOfView += [pscustomobject]@{
                    PID = [int]$p.ProcessId; Name = $name
                    MemoryMB = [int][math]::Round(([double]$p.PrivatePageCount / 1MB), 0)
                    Why = 'not in executable whitelist'
                }
            }
            continue
        }

        # Ownership basis: exe-token > ancestor-token > cmd-token.
        # cmd-token alone is a hint only and is never eligible for -AutoStop.
        $basis = if ($exeMatch) { 'exe' }
                 elseif ($ancestor.Matched) { 'ancestor' }
                 elseif ($cmdMatch) { 'cmd' }
                 else { 'none' }
        if ($basis -eq 'none') { continue }

        $scoped += [pscustomobject]@{
            Process = $p
            Basis = $basis
            HintOnly = ($basis -eq 'cmd')
            NeverStop = (Test-NeverStop $p)
            Excluded = (Test-Excluded $p)
            Ancestor = $ancestor
        }
    }
    return [pscustomobject]@{ All = $all; Map = $pidMap; Scoped = $scoped; OutOfView = $outOfView }
}

function Confirm-SafeToStop($item, [double]$sampleCpu) {
    # All predicates are rechecked immediately before stopping; unknown -> skip.
    $p = $item.Process
    $id = [int]$p.ProcessId
    $live = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $id" -ErrorAction Stop
    if ($null -eq $live) { return $null }
    if ([datetime]$live.CreationDate -ne [datetime]$p.CreationDate) { return $null }
    if ($item.HintOnly) { return $null }
    if (Test-NeverStop $live) { return $null }
    if (Test-Excluded $live) { return $null }
    $exeMatch = Test-ProjectPathToken ([string]$live.ExecutablePath)
    $cmdMatch = Test-ProjectPathToken ([string]$live.CommandLine)
    if (-not $exeMatch -and -not $cmdMatch) { return $null }
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

function Get-ListeningMap {
    $map = @{}
    foreach ($conn in @(Get-NetTCPConnection -State Listen -ErrorAction Stop)) {
        $map[[int]$conn.OwningProcess] = $true
    }
    return $map
}

function Invoke-Scan([bool]$Detail = $false) {
    $snap = Get-ScopeSnapshot
    $mem = Get-MemoryGate
    $pressure = $mem.Pressure
    $now = Get-Date
    $next = @{}
    $rows = @()
    $candidates = @()

    $listening = $null
    try { $listening = Get-ListeningMap } catch {
        Write-Warning 'Cannot inspect listening TCP ports; no process will be stopped in this cycle.'
    }

    foreach ($item in $snap.Scoped) {
        $p = $item.Process
        $id = [int]$p.ProcessId
        $started = [datetime]$p.CreationDate
        $key = '{0}|{1}' -f $id, $started.Ticks
        $ageMin = ($now - $started).TotalMinutes
        $privateMB = [int][math]::Round(([double]$p.PrivatePageCount / 1MB), 0)
        $orphan = Test-Orphan $p $snap.Map
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
                    $orphan -and -not $item.NeverStop -and -not $item.Excluded -and
                    $ageMin -ge $MinAgeMinutes -and $privateMB -ge $MinPrivateMB) {
                    $streak = [int]$prior.Streak + 1
                }
            }
        }
        $next[$key] = [pscustomobject]@{ Cpu = $cpu; Time = $now; Streak = $streak }

        $blockers = @()
        if ($item.HintOnly) { $blockers += 'hint-only(cmd-token)' }
        if ($item.NeverStop) { $blockers += 'never-stop' }
        if ($item.Excluded) { $blockers += 'excluded' }
        if (-not $orphan) { $blockers += 'parent-alive' }
        if ($ageMin -lt $MinAgeMinutes) { $blockers += "age<$MinAgeMinutes min" }
        if ($privateMB -lt $MinPrivateMB) { $blockers += "private<$MinPrivateMB MB" }
        if ($streak -lt $ConfirmSamples) { $blockers += "idle=$streak/$ConfirmSamples" }

        $row = [pscustomobject]@{
            PID = $id; Name = [string]$p.Name; Basis = $item.Basis
            MemoryMB = $privateMB; AgeMin = [int][math]::Floor($ageMin); Orphan = $orphan
            IdleSamples = $streak; NeverStop = $item.NeverStop; Excluded = $item.Excluded
            Blockers = ($blockers -join '; ')
        }
        $rows += $row
        if ($blockers.Count -eq 0) {
            $candidates += [pscustomobject]@{ Item = $item; Cpu = [double]$cpu; Row = $row }
        }
    }
    $script:seen = $next

    $mode = if ($Once) { 'ONCE' } elseif ($AutoStop) { 'AUTO' } else { 'DRY-RUN' }
    Write-Host ("[{0}] scoped={1} availRAM={2}MB({3}) threshold={4}MB({5}) totalRAM={6}MB pressure={7} mode={8}" -f
        $now.ToString('HH:mm:ss'), $rows.Count, $mem.AvailableMB, $mem.Source,
        $mem.ThresholdMB, $mem.Rule, $mem.TotalMB, $pressure, $mode)
    Write-Log ("scan scoped={0} availRAM={1}MB({2}) threshold={3}MB({4}) totalRAM={5}MB pressure={6} mode={7}" -f
        $rows.Count, $mem.AvailableMB, $mem.Source, $mem.ThresholdMB, $mem.Rule,
        $mem.TotalMB, $pressure, $mode)

    if ($Detail) {
        Write-Host '=== Scope (current sample) ==='
        if ($rows.Count) {
            $rows | Sort-Object MemoryMB -Descending | Select-Object -First 20 |
                Format-Table -AutoSize -Wrap | Out-Host
        } else {
            Write-Host 'No project-scoped dev processes found.'
        }

        Write-Host '=== Candidates (all gates passed; -AutoStop also requires memory pressure and no TCP listener) ==='
        if ($candidates.Count -eq 0) { Write-Host 'None.' }
        foreach ($c in $candidates) {
            $id = [int]$c.Item.Process.ProcessId
            $tcp = if ($null -eq $listening) { 'unknown' } elseif ($listening.ContainsKey($id)) { 'listening' } else { 'none' }
            $wouldStop = ($pressure -and $null -ne $listening -and -not $listening.ContainsKey($id))
            Write-Host ("[CANDIDATE] PID={0} {1} basis={2} private={3}MB age={4}min idle={5}/{6} tcp={7} pressure={8} would-stop={9}" -f
                $id, $c.Item.Process.Name, $c.Item.Basis, $c.Row.MemoryMB, $c.Row.AgeMin,
                $c.Row.IdleSamples, $ConfirmSamples, $tcp, $pressure, $wouldStop)
            Write-Log ("CANDIDATE pid={0} name={1} basis={2} private={3}MB idle={4}/{5} tcp={6} pressure={7} would-stop={8} cmd={9}" -f
                $id, $c.Item.Process.Name, $c.Item.Basis, $c.Row.MemoryMB, $c.Row.IdleSamples,
                $ConfirmSamples, $tcp, $pressure, $wouldStop, $c.Item.Process.CommandLine)
        }

        Write-Host '=== Near-candidates (pass orphan/age/size but blocked by a gate) ==='
        $near = @($rows | Where-Object {
                $_.Orphan -and $_.AgeMin -ge $MinAgeMinutes -and $_.MemoryMB -ge $MinPrivateMB -and
                -not $_.NeverStop -and -not $_.Excluded -and $_.Basis -ne 'cmd' -and
                $_.IdleSamples -gt 0 -and $_.Blockers -ne ''
            })
        if ($near.Count -eq 0) { Write-Host 'None.' }
        foreach ($r in $near) {
            Write-Host ("[NEAR] PID={0} {1} basis={2} private={3}MB age={4}min idle={5}/{6} blocked={7}" -f
                $r.PID, $r.Name, $r.Basis, $r.MemoryMB, $r.AgeMin, $r.IdleSamples, $ConfirmSamples, $r.Blockers)
        }

        Write-Host '=== Out of view (never evaluated) ==='
        if ($snap.OutOfView.Count -eq 0) { Write-Host 'None.' }
        else {
            $snap.OutOfView | Sort-Object MemoryMB -Descending | Select-Object -First 10 |
                Format-Table -AutoSize -Wrap | Out-Host
        }
    } elseif (-not $Once) {
        foreach ($c in $candidates) {
            $id = [int]$c.Item.Process.ProcessId
            $tcp = if ($null -eq $listening) { 'unknown' } elseif ($listening.ContainsKey($id)) { 'listening' } else { 'none' }
            Write-Host ("[CANDIDATE, dry-run] PID={0} {1} basis={2} private={3}MB idle={4}/{5} tcp={6} pressure={7}" -f
                $id, $c.Item.Process.Name, $c.Item.Basis, $c.Row.MemoryMB, $c.Row.IdleSamples,
                $ConfirmSamples, $tcp, $pressure)
            Write-Log ("CANDIDATE pid={0} name={1} basis={2} private={3}MB idle={4}/{5} tcp={6} pressure={7} cmd={8}" -f
                $id, $c.Item.Process.Name, $c.Item.Basis, $c.Row.MemoryMB, $c.Row.IdleSamples,
                $ConfirmSamples, $tcp, $pressure, $c.Item.Process.CommandLine)
        }
    }

    if ($Once -or -not $AutoStop) { return }
    if (-not $pressure -or $candidates.Count -eq 0) { return }
    if ($null -eq $listening) { return }

    foreach ($c in $candidates) {
        $id = [int]$c.Item.Process.ProcessId
        if ($listening.ContainsKey($id)) { continue }
        $reason = ('basis={0}; orphan; age={1}min>={2}; idle={3}samples>={4}; private={5}MB>={6}; no-TCP-listen; pressure={7}' -f
            $c.Item.Basis, $c.Row.AgeMin, $MinAgeMinutes, $c.Row.IdleSamples, $ConfirmSamples,
            $c.Row.MemoryMB, $MinPrivateMB, $pressure)
        try {
            $verified = Confirm-SafeToStop $c.Item $c.Cpu
            if ($null -eq $verified) {
                Write-Log ("STOP-FAILED pid={0} reason={1} error=confirm-recheck-rejected" -f $id, $reason)
                continue
            }
            # Stop a single verified process object, never a whole tree or an unscoped process.
            $verified | Stop-Process -Force -ErrorAction Stop
            Write-Host ("[STOPPED] PID={0} {1} {2}MB reason={3}" -f
                $id, $c.Item.Process.Name, $c.Row.MemoryMB, $reason)
            Write-Log ("STOPPED pid={0} name={1} private={2}MB reason={3} cmd={4}" -f
                $id, $c.Item.Process.Name, $c.Row.MemoryMB, $reason, $c.Item.Process.CommandLine)
            return  # Stop at most one process per scan.
        } catch {
            Write-Warning ("PID={0} stop skipped/failed: {1}" -f $id, $_.Exception.Message)
            Write-Log ("STOP-FAILED pid={0} reason={1} error={2}" -f $id, $reason, $_.Exception.Message)
        }
    }
}

Write-Host "Project: $resolvedRoot"
Write-Host 'Scope: known dev executables with a token-boundary path match (exe path, ancestor chain, or command line).'
Write-Host 'Command-line-only matches are reported as hint-only and are never auto-stopped.'
Write-Host 'Safety: stale parent + age + persistent CPU idle + memory pressure + no TCP listener + NeverStop/Exclude.'
if (-not $AutoStop) { Write-Host 'Observation-only. Add -AutoStop to enable guarded termination.' }
if ($Once) {
    # Offline gating check: sample a few times so IdleSamples is meaningful. Short interval by design.
    $sampleDelay = [int][math]::Min($IntervalSeconds, 5)
    for ($i = 1; $i -le $Samples; $i++) {
        Invoke-Scan -Detail ($i -eq $Samples)
        if ($i -lt $Samples) { Start-Sleep -Seconds $sampleDelay }
    }
} else {
    Write-Host 'Monitoring. Press Ctrl+C to stop the watchdog.'
    while ($true) {
        try { Invoke-Scan -Detail $false } catch { Write-Warning ("Scan failed: {0}" -f $_.Exception.Message) }
        Start-Sleep -Seconds $IntervalSeconds
    }
}
