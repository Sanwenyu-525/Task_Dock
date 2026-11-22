# Task Dock 本地清理脚本
# 由 cleanup-tmp.bat 调用：
#   1. 清空当前用户的回收站（所有驱动器）
#   2. 删除仓库 tmp\ 目录下超过指定小时数未修改的文件
# 用法：cleanup-tmp.bat [小时数] [/y]
#   小时数  清理阈值（小时），默认 48；省略则交互输入
#   /y      跳过确认与结束等待

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# ---- 参数解析 ----
$hoursArg = $null
$skipConfirm = $false
foreach ($a in $args) {
    if ($a -is [string] -and $a -ieq '/y') { $skipConfirm = $true }
    elseif ($a -is [string] -and $a -match '^\d+$') { $hoursArg = [int]$a }
}

# ---- 目标目录：脚本所在目录的上一级 tmp\ ----
$repoRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repoRoot 'tmp'
if (-not (Test-Path -LiteralPath $target)) {
    $fallback = Join-Path (Get-Location).Path 'tmp'
    if (Test-Path -LiteralPath $fallback) { $target = $fallback }
}

function Read-Line([string]$Prompt) {
    Write-Host $Prompt -NoNewline
    return [Console]::ReadLine()
}

Write-Host ''
Write-Host '===== Task Dock 清理 ====='

# ---- 清理阈值（小时） ----
$defaultHours = 48
$hours = $null
if ($null -ne $hoursArg -and $hoursArg -gt 0) { $hours = $hoursArg }
if ($null -eq $hours) {
    while ($true) {
        $raw = Read-Line ('请输入清理阈值（小时，默认 {0}，直接回车使用默认值）: ' -f $defaultHours)
        if ([string]::IsNullOrWhiteSpace($raw)) { $hours = $defaultHours; break }
        $parsed = 0
        if ([int]::TryParse($raw.Trim(), [ref]$parsed) -and $parsed -gt 0) { $hours = $parsed; break }
        Write-Host '输入无效：请输入大于 0 的整数小时数。'
    }
}

Write-Host '回收站  ：当前用户，所有驱动器'
Write-Host ('目标目录：{0}' -f $target)
Write-Host ('清理条件：最后修改时间早于 {0} 小时前的文件' -f $hours)
Write-Host ('保留内容：最近 {0} 小时内的文件、全部目录结构' -f $hours)
Write-Host ''

if (-not $skipConfirm) {
    $ans = Read-Line '确认执行？[y/N] '
    if ($ans -notmatch '^\s*[yY]\s*$') {
        Write-Host '已取消，未做任何修改。'
        [void](Read-Line '按回车键退出...')
        exit 0
    }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$frames = @('|', '/', '-', '\')

# ---- 1. 清空回收站（带转圈动画与已用时） ----
Write-Host ''
Write-Host '[1/2] 清空回收站...'
$job = Start-Job -ScriptBlock { Clear-RecycleBin -Force -ErrorAction Stop }
$f = 0
while ($job.State -eq 'Running' -or $job.State -eq 'NotStarted') {
    [Console]::Write(("`r  清空回收站 {0}  已用时 {1} 秒    " -f $frames[$f % 4], [math]::Round($sw.Elapsed.TotalSeconds)))
    $f++
    Start-Sleep -Milliseconds 200
}
[Console]::WriteLine('')
if ($job.State -eq 'Completed') {
    Write-Host ('  回收站已清空（累计 {0} 秒）' -f [math]::Round($sw.Elapsed.TotalSeconds))
} else {
    $err = (Receive-Job $job 2>&1 | Select-Object -First 1)
    Write-Host ('  回收站未清空：{0}' -f $err)
}
Remove-Job $job -Force

# ---- 2. 删除过期的 tmp 文件（进度 + 转圈 + 已用时） ----
Write-Host ''
Write-Host ('[2/2] 清理 {0} 小时前的 tmp 文件...' -f $hours)
if (-not (Test-Path -LiteralPath $target)) {
    Write-Host ('  未找到目标目录：{0}' -f $target)
    Write-Host '  请把脚本放在仓库的 scripts 目录下，或从仓库根目录运行。'
    if (-not $skipConfirm) { [void](Read-Line '按回车键退出...') }
    exit 0
}

$cutoff = (Get-Date).AddHours(-$hours)
Write-Host ('  截止时间：{0}' -f $cutoff.ToString('yyyy-MM-dd HH:mm'))
Write-Host '  正在扫描符合条件的文件...'
$files = @(Get-ChildItem -LiteralPath $target -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff })
$total = $files.Count
$sum = ($files | Measure-Object -Property Length -Sum).Sum
if (-not $sum) { $sum = 0 }

if ($total -eq 0) {
    Write-Host '  没有符合条件的文件，跳过删除。'
    Write-Host ('总用时：{0} 秒' -f [math]::Round($sw.Elapsed.TotalSeconds))
    Write-Host ''
    Write-Host '清理完成。'
    if (-not $skipConfirm) { [void](Read-Line '按回车键退出...') }
    exit 0
}

Write-Host ('  命中 {0} 个文件，共 {1} MB，开始删除...' -f $total, [math]::Round($sum / 1MB, 1))

$ok = 0
$fail = 0
$i = 0
$f = 0
foreach ($file in $files) {
    try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop; $ok++ }
    catch { $fail++ }
    $i++
    if (($i % 200 -eq 0) -or ($i -eq $total)) {
        $pct = [math]::Floor($i * 100 / $total)
        [Console]::Write(("`r  进度 {0} {1}%（{2} / {3}），成功 {4}，失败 {5}，已用时 {6} 秒      " -f $frames[$f % 4], $pct, $i, $total, $ok, $fail, [math]::Round($sw.Elapsed.TotalSeconds)))
        $f++
    }
}
[Console]::WriteLine('')
Write-Host ('  成功删除：{0} 个' -f $ok)
if ($fail -gt 0) { Write-Host ('  删除失败：{0} 个（文件可能被其他程序占用）' -f $fail) }
Write-Host ('总用时：{0} 秒' -f [math]::Round($sw.Elapsed.TotalSeconds))
Write-Host ''
Write-Host '清理完成。'
if (-not $skipConfirm) { [void](Read-Line '按回车键退出...') }
