//! 只读资源诊断：应用自身进程指标与开发相关进程列表。
//!
//! 产品定位是「轻量诊断」，不是任务管理器：
//! - 只在用户显式刷新/展开时采样，不注册后台轮询；
//! - 归属分级基于可解释证据（自身 PID、父进程链、镜像路径），名称匹配只作线索；
//! - 状态只表达「已退出 / 指标不可读 / 资源占用较高 / 正常」，绝不据此建议或执行结束进程；
//! - 不读取命令行、不返回可执行文件路径、不写入任何持久化表。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::probes::{self, ProcessMetrics, RawProcess};

/// 单次诊断最多返回的进程行数。
pub const MAX_ROWS: usize = 40;
/// 外部/未确认进程的展示上限：名称匹配的 node.exe 在开发机上可能有很多，
/// 全部铺开只会淹没真正有用的「本应用 / 子进程 / 项目进程」，因此分组内封顶。
const MAX_EXTERNAL_TOOLS: usize = 6;
const MAX_UNKNOWN_OWNERS: usize = 6;
/// 参与指标读取的最大候选数（防止异常环境下无界读取）。
const MAX_CANDIDATES: usize = 120;
/// 冷启动 CPU 差分窗口：首次无基线时在 blocking worker 内短采样一次。
const CPU_WINDOW: Duration = Duration::from_millis(200);
/// 两次读数小于该间隔时不做差分（避免把调度抖动当成占用）。
const MIN_CPU_WINDOW: Duration = Duration::from_millis(120);
/// 资源占用较高的展示阈值（占整机逻辑核心总容量），仅用于呈现提示。
const HIGH_USAGE_PERCENT: f64 = 70.0;
const MAX_BASELINES: usize = 512;
const BASELINE_TTL: Duration = Duration::from_secs(10 * 60);
/// 超过该窗口的旧基线不再参与差分：平均值会掩盖真实占用，改为重新起算。
const MAX_CPU_WINDOW: Duration = Duration::from_secs(5 * 60);
const MAX_ANCESTOR_DEPTH: usize = 32;

/// 已知开发工具/运行时进程名（只作归属线索，不构成所有权证明）。
const DEV_TOOL_NAMES: &[&str] = &[
    "node.exe",
    "npm.exe",
    "npx.exe",
    "pnpm.exe",
    "yarn.exe",
    "bun.exe",
    "deno.exe",
    "cargo.exe",
    "rustc.exe",
    "rustup.exe",
    "esbuild.exe",
    "vite.exe",
    "tauri.exe",
    "webpack.exe",
    "rollup.exe",
    "tsc.exe",
    "typescript.exe",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRow {
    pub pid: u32,
    pub name: String,
    /// self | managed_child | project_dev | external_tool | unknown_owner
    pub association: String,
    /// self | parent_chain | image_path | name_and_path | unverified
    pub association_basis: String,
    pub cpu_percent: Option<f64>,
    pub working_set_bytes: Option<u64>,
    pub private_bytes: Option<u64>,
    pub uptime_secs: Option<u64>,
    /// normal | high_usage | exited | unknown
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDiagnostics {
    pub sampled_at: String,
    pub cpu_window_ms: u64,
    pub supported: bool,
    pub truncated: bool,
    /// 名称匹配但归属未确认、被折叠未展示的外部工具数量。
    pub omitted_external: usize,
    /// 归属不明、被折叠未展示的进程数量。
    pub omitted_unknown: usize,
    pub processes: Vec<ProcessRow>,
}

/// 应用自身进程快照（资源概览与进程诊断共用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfProcessSnapshot {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: Option<f64>,
    pub cpu_window_ms: u64,
    pub working_set_bytes: Option<u64>,
    pub private_bytes: Option<u64>,
    pub uptime_secs: Option<u64>,
    /// normal | high_usage | exited | unknown
    pub status: String,
}

struct Baseline {
    cpu_100ns: u64,
    at: Instant,
    created_unix: Option<i64>,
}

/// CPU 差分采样器：保存每个 PID 上一次的累计 CPU 时间与采样时刻。
///
/// 复用同一实例可以跨命令（概览 ↔ 进程诊断）建立基线；首次无基线时返回
/// `None`，由调用方决定是否在当前 blocking 任务内做一次短窗口采样。
#[derive(Default)]
pub struct CpuSampler {
    baselines: Mutex<HashMap<u32, Baseline>>,
}

impl CpuSampler {
    /// 记录本次读数并返回与上次的差分（占整机逻辑核心总容量的百分比）。
    /// 无有效基线、PID 被复用或窗口过短时返回 `None`。
    pub fn observe(&self, pid: u32, metrics: &ProcessMetrics) -> Option<(f64, u64)> {
        let now = Instant::now();
        let cores = logical_cores();
        let mut baselines = self.baselines.lock().ok()?;
        if let Some(previous) = baselines.get(&pid) {
            // 创建时间变化说明 PID 被复用：丢弃旧基线，重新起算。
            if previous.created_unix.is_some() && metrics.created_unix != previous.created_unix {
                baselines.insert(pid, baseline(metrics, now));
                return None;
            }
            let elapsed = now.duration_since(previous.at);
            if elapsed > MAX_CPU_WINDOW {
                // 基线过旧：区间平均值不再代表当前占用，重新起算。
                baselines.insert(pid, baseline(metrics, now));
                return None;
            }
            if elapsed < MIN_CPU_WINDOW {
                // 窗口不足时保留旧基线继续累积，不刷新采样时刻。
                return None;
            }
            let delta = metrics.cpu_100ns.saturating_sub(previous.cpu_100ns);
            let percent = cpu_percent(delta, elapsed, cores);
            baselines.insert(pid, baseline(metrics, now));
            return Some((percent, elapsed.as_millis() as u64));
        }
        baselines.insert(pid, baseline(metrics, now));
        prune(&mut baselines, now);
        None
    }

    /// 采样自身进程 CPU：无基线时在当前 blocking 任务内做一次短窗口差分。
    pub fn sample_with_warmup(&self, pid: u32) -> (Option<f64>, u64) {
        let Some(first) = probes::process_metrics(pid) else {
            return (None, 0);
        };
        if let Some(sample) = self.observe(pid, &first) {
            return (Some(sample.0), sample.1);
        }
        std::thread::sleep(CPU_WINDOW);
        match probes::process_metrics(pid).and_then(|second| self.observe(pid, &second)) {
            Some(sample) => (Some(sample.0), sample.1),
            None => (None, 0),
        }
    }
}

fn baseline(metrics: &ProcessMetrics, at: Instant) -> Baseline {
    Baseline {
        cpu_100ns: metrics.cpu_100ns,
        at,
        created_unix: metrics.created_unix,
    }
}

fn prune(baselines: &mut HashMap<u32, Baseline>, now: Instant) {
    if baselines.len() <= MAX_BASELINES {
        return;
    }
    baselines.retain(|_, entry| now.duration_since(entry.at) < BASELINE_TTL);
}

fn logical_cores() -> u32 {
    std::thread::available_parallelism()
        .map(|count| count.get() as u32)
        .unwrap_or(1)
        .max(1)
}

/// 累计 CPU 时间差 → 占整机容量的百分比（与任务管理器口径一致，上限 100）。
pub fn cpu_percent(delta_100ns: u64, elapsed: Duration, cores: u32) -> f64 {
    let elapsed_100ns = elapsed.as_nanos() as f64 / 100.0;
    let capacity = elapsed_100ns * cores.max(1) as f64;
    if capacity <= 0.0 {
        return 0.0;
    }
    ((delta_100ns as f64 / capacity) * 100.0).clamp(0.0, 100.0)
}

/// 直接父进程为 `self_pid` 之外，是否还有更强证据（只用于过滤候选）。
fn is_descendant(pid: u32, ancestor: u32, parents: &HashMap<u32, u32>) -> bool {
    if pid == ancestor {
        return false;
    }
    let mut current = pid;
    for _ in 0..MAX_ANCESTOR_DEPTH {
        let Some(parent) = parents.get(&current).copied() else {
            return false;
        };
        if parent == ancestor {
            return true;
        }
        if parent == 0 || parent == current {
            return false;
        }
        current = parent;
    }
    false
}

fn is_dev_tool(name: &str) -> bool {
    DEV_TOOL_NAMES.contains(&name.to_ascii_lowercase().as_str())
}

/// 路径是否位于工程目录内（大小写与分隔符归一化后按目录边界比较）。
fn under_project(image_path: &str, project_root: &str) -> bool {
    let normalize = |value: &str| value.replace('\\', "/").to_ascii_lowercase();
    let path = normalize(image_path);
    let root = normalize(project_root);
    let root = root.trim_end_matches('/');
    if root.is_empty() || path.len() <= root.len() {
        return false;
    }
    path.starts_with(root) && path.as_bytes().get(root.len()) == Some(&b'/')
}

/// 归属判定输入：只包含本地可获得的证据，不含命令行。
struct Candidate<'a> {
    pid: u32,
    name: &'a str,
    image_path: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Verdict {
    association: &'static str,
    basis: &'static str,
}

/// 纯函数归属分级：
/// 1. 本进程 → self；
/// 2. 父链可达本进程，或为工程进程的直接子进程 → managed_child / project_dev；
/// 3. 镜像路径位于工程目录内 → project_dev（开发工具）或 unknown_owner（路径强证据但非工具名）；
/// 4. 已知开发工具名且路径在工程外 → external_tool；
/// 5. 开发工具名但读不到路径 → unknown_owner（未验证）。
fn classify(
    candidates: &[Candidate<'_>],
    parents: &HashMap<u32, u32>,
    self_pid: u32,
    project_root: Option<&str>,
) -> HashMap<u32, Verdict> {
    let mut verdicts = HashMap::new();
    for candidate in candidates {
        let dev_tool = is_dev_tool(candidate.name);
        let in_project = match (candidate.image_path, project_root) {
            (Some(path), Some(root)) => under_project(path, root),
            _ => false,
        };
        let verdict = if candidate.pid == self_pid {
            Verdict { association: "self", basis: "self" }
        } else if is_descendant(candidate.pid, self_pid, parents) || parents.get(&candidate.pid) == Some(&self_pid) {
            Verdict { association: "managed_child", basis: "parent_chain" }
        } else if in_project && dev_tool {
            Verdict { association: "project_dev", basis: "image_path" }
        } else if in_project {
            // 路径在工程内但不是已知工具名：证据较强但仍不声称所有权。
            Verdict { association: "unknown_owner", basis: "image_path" }
        } else if dev_tool && candidate.image_path.is_some() {
            Verdict { association: "external_tool", basis: "name_and_path" }
        } else if dev_tool {
            Verdict { association: "unknown_owner", basis: "unverified" }
        } else {
            continue;
        };
        verdicts.insert(candidate.pid, verdict);
    }

    // 第二遍：开发工具若是工程进程（或本应用）的后代，提升为 project_dev。
    let anchors: HashSet<u32> = verdicts
        .iter()
        .filter(|(_, verdict)| matches!(verdict.association, "self" | "project_dev"))
        .map(|(pid, _)| *pid)
        .collect();
    let pending: Vec<u32> = verdicts
        .iter()
        .filter(|(_, verdict)| matches!(verdict.association, "external_tool" | "unknown_owner"))
        .map(|(pid, _)| *pid)
        .collect();
    for pid in pending {
        if anchors.contains(&pid) {
            continue;
        }
        let mut current = pid;
        for _ in 0..MAX_ANCESTOR_DEPTH {
            let Some(parent) = parents.get(&current).copied() else {
                break;
            };
            if anchors.contains(&parent) {
                verdicts.insert(
                    pid,
                    Verdict { association: "project_dev", basis: "parent_chain" },
                );
                break;
            }
            if parent == 0 || parent == current {
                break;
            }
            current = parent;
        }
    }
    verdicts
}

/// 选中需要展示的候选进程：自身、直接子进程、已知开发工具。
fn select_candidates(table: &[RawProcess], self_pid: u32) -> Vec<u32> {
    let mut seen = HashSet::new();
    let mut pids = Vec::new();
    let push = |pid: u32, seen: &mut HashSet<u32>, pids: &mut Vec<u32>| {
        if pid != 0 && seen.insert(pid) {
            pids.push(pid);
        }
    };
    push(self_pid, &mut seen, &mut pids);
    for process in table {
        if process.parent_pid == self_pid {
            push(process.pid, &mut seen, &mut pids);
        } else if is_dev_tool(&process.name) {
            push(process.pid, &mut seen, &mut pids);
        }
    }
    pids.truncate(MAX_CANDIDATES);
    pids
}

fn row_status(metrics: Option<&ProcessMetrics>, cpu: Option<f64>, pid: u32) -> &'static str {
    match metrics {
        None => {
            if probes::process_alive(pid) {
                "unknown"
            } else {
                "exited"
            }
        }
        Some(_) => match cpu {
            Some(percent) if percent >= HIGH_USAGE_PERCENT => "high_usage",
            _ => "normal",
        },
    }
}

fn uptime_secs(metrics: &ProcessMetrics, now_unix: i64) -> Option<u64> {
    metrics
        .created_unix
        .map(|created| now_unix.saturating_sub(created).max(0) as u64)
}

/// 采集自身进程快照（供资源概览与进程诊断共用）。
pub fn self_process(sampler: &CpuSampler) -> SelfProcessSnapshot {
    let pid = probes::current_pid();
    let metrics = probes::process_metrics(pid);
    let (cpu_percent, cpu_window_ms) = sampler.sample_with_warmup(pid);
    let now_unix = chrono::Utc::now().timestamp();
    SelfProcessSnapshot {
        pid,
        name: probes::current_process_name(),
        cpu_percent,
        cpu_window_ms,
        working_set_bytes: metrics
            .as_ref()
            .and_then(|m| (m.working_set_bytes > 0).then_some(m.working_set_bytes)),
        private_bytes: metrics
            .as_ref()
            .and_then(|m| (m.private_bytes > 0).then_some(m.private_bytes)),
        uptime_secs: metrics.as_ref().and_then(|m| uptime_secs(m, now_unix)),
        status: row_status(metrics.as_ref(), cpu_percent, pid).into(),
    }
}

/// 生成一次只读进程诊断。调用方必须把它放在 blocking worker 中执行。
pub fn diagnostics(sampler: &CpuSampler) -> ProcessDiagnostics {
    let sampled_at = chrono::Utc::now().to_rfc3339();
    if !cfg!(windows) {
        // 非 Windows 平台没有等价的可信进程表与指标来源：明确报告不支持。
        return ProcessDiagnostics {
            sampled_at,
            cpu_window_ms: 0,
            supported: false,
            truncated: false,
            omitted_external: 0,
            omitted_unknown: 0,
            processes: Vec::new(),
        };
    }

    let self_pid = probes::current_pid();
    let table = probes::enumerate_processes();
    let parents: HashMap<u32, u32> = table
        .iter()
        .map(|process| (process.pid, process.parent_pid))
        .collect();
    let names: HashMap<u32, String> = table
        .iter()
        .map(|process| (process.pid, process.name.clone()))
        .collect();

    let project_root = probes::project_root();
    let project_root_text = project_root.as_ref().map(|path| path.to_string_lossy().to_string());
    let candidate_pids = select_candidates(&table, self_pid);

    // 只对候选读取镜像路径：路径只用于归属判定，不返回、不落日志。
    let image_paths: HashMap<u32, String> = candidate_pids
        .iter()
        .filter_map(|pid| probes::image_path(*pid).map(|path| (*pid, path)))
        .collect();
    let candidates: Vec<Candidate<'_>> = candidate_pids
        .iter()
        .map(|pid| Candidate {
            pid: *pid,
            name: names.get(pid).map(String::as_str).unwrap_or(""),
            image_path: image_paths.get(pid).map(String::as_str),
        })
        .collect();
    let verdicts = classify(
        &candidates,
        &parents,
        self_pid,
        project_root_text.as_deref(),
    );

    // 第一轮读数：建立基线，同时保留内存与运行时长。
    let mut readings: HashMap<u32, ProcessMetrics> = HashMap::new();
    let mut cpu: HashMap<u32, (f64, u64)> = HashMap::new();
    let mut pending: Vec<u32> = Vec::new();
    for pid in &candidate_pids {
        let Some(metrics) = probes::process_metrics(*pid) else {
            continue;
        };
        readings.insert(*pid, metrics);
        match sampler.observe(*pid, &metrics) {
            Some(sample) => {
                cpu.insert(*pid, sample);
            }
            None => pending.push(*pid),
        }
    }
    // 冷启动：一次短窗口差分，让首次展开也能得到真实数值而不是永远「未知」。
    let mut cpu_window_ms = 0u64;
    if !pending.is_empty() {
        std::thread::sleep(CPU_WINDOW);
        for pid in pending {
            if let Some(sample) = probes::process_metrics(pid)
                .and_then(|metrics| sampler.observe(pid, &metrics).map(|value| (metrics, value)))
            {
                readings.insert(pid, sample.0);
                cpu.insert(pid, sample.1);
                cpu_window_ms = cpu_window_ms.max(sample.1.1);
            }
        }
    }
    if cpu_window_ms == 0 {
        cpu_window_ms = cpu.values().map(|(_, window)| *window).max().unwrap_or(0);
    }

    let now_unix = chrono::Utc::now().timestamp();
    let mut rows: Vec<ProcessRow> = candidate_pids
        .iter()
        .filter_map(|pid| {
            let verdict = verdicts.get(pid)?;
            let metrics = readings.get(pid);
            let sample = cpu.get(pid);
            let percent = sample.map(|(percent, _)| round_percent(*percent));
            Some(ProcessRow {
                pid: *pid,
                name: names.get(pid).cloned().unwrap_or_else(|| "unknown".into()),
                association: verdict.association.into(),
                association_basis: verdict.basis.into(),
                cpu_percent: percent,
                working_set_bytes: metrics
                    .and_then(|m| (m.working_set_bytes > 0).then_some(m.working_set_bytes)),
                private_bytes: metrics.and_then(|m| (m.private_bytes > 0).then_some(m.private_bytes)),
                uptime_secs: metrics.and_then(|m| uptime_secs(m, now_unix)),
                status: row_status(metrics, percent, *pid).into(),
            })
        })
        .collect();

    let association_rank = |association: &str| match association {
        "self" => 0,
        "managed_child" => 1,
        "project_dev" => 2,
        "unknown_owner" => 3,
        _ => 4,
    };
    rows.sort_by(|left, right| {
        association_rank(&left.association)
            .cmp(&association_rank(&right.association))
            .then_with(|| {
                right
                    .cpu_percent
                    .unwrap_or(0.0)
                    .partial_cmp(&left.cpu_percent.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.pid.cmp(&right.pid))
    });

    let truncated = rows.len() > MAX_ROWS;
    rows.truncate(MAX_ROWS);
    let (processes, omitted_external, omitted_unknown) = apply_display_caps(rows);

    ProcessDiagnostics {
        sampled_at,
        cpu_window_ms,
        supported: true,
        truncated,
        omitted_external,
        omitted_unknown,
        processes,
    }
}

/// 分组封顶：外部工具与归属不明只保留前若干个，并如实报告被折叠的数量。
/// 本应用、子进程与项目进程不受封顶影响。
fn apply_display_caps(rows: Vec<ProcessRow>) -> (Vec<ProcessRow>, usize, usize) {
    let (mut kept, mut externals, mut unknown): (Vec<ProcessRow>, Vec<ProcessRow>, Vec<ProcessRow>) =
        (Vec::new(), Vec::new(), Vec::new());
    for row in rows {
        match row.association.as_str() {
            "external_tool" => externals.push(row),
            "unknown_owner" => unknown.push(row),
            _ => kept.push(row),
        }
    }
    let omitted_external = externals.len().saturating_sub(MAX_EXTERNAL_TOOLS);
    let omitted_unknown = unknown.len().saturating_sub(MAX_UNKNOWN_OWNERS);
    externals.truncate(MAX_EXTERNAL_TOOLS);
    unknown.truncate(MAX_UNKNOWN_OWNERS);
    kept.append(&mut unknown);
    kept.append(&mut externals);
    (kept, omitted_external, omitted_unknown)
}

fn round_percent(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(entries: &[(u32, u32, &str)]) -> (HashMap<u32, u32>, Vec<RawProcess>) {
        let parents = entries
            .iter()
            .map(|(pid, parent, _)| (*pid, *parent))
            .collect();
        let rows = entries
            .iter()
            .map(|(pid, parent, name)| RawProcess {
                pid: *pid,
                parent_pid: *parent,
                name: (*name).to_string(),
            })
            .collect();
        (parents, rows)
    }

    #[test]
    fn cpu_percent_is_normalized_by_core_capacity() {
        // 1 秒内消耗 1 秒 CPU、8 核 → 12.5%
        let percent = cpu_percent(10_000_000, Duration::from_secs(1), 8);
        assert!((percent - 12.5).abs() < 0.01, "got {percent}");
        // 满负荷单核在全机容量下不可能超过 100%
        assert_eq!(cpu_percent(10_000_000, Duration::from_secs(1), 1), 100.0);
        assert_eq!(cpu_percent(0, Duration::from_secs(1), 4), 0.0);
    }

    #[test]
    fn self_and_children_are_classified_without_name_guessing() {
        let (parents, _) = table(&[
            (100, 1, "task-dock.exe"),
            (200, 100, "msedgewebview2.exe"),
            (300, 200, "node.exe"),
        ]);
        let candidates = vec![
            Candidate { pid: 100, name: "task-dock.exe", image_path: None },
            Candidate { pid: 200, name: "msedgewebview2.exe", image_path: None },
            Candidate { pid: 300, name: "node.exe", image_path: Some("c:/program files/nodejs/node.exe") },
        ];
        let verdicts = classify(&candidates, &parents, 100, None);
        assert_eq!(verdicts[&100].association, "self");
        assert_eq!(verdicts[&200].association, "managed_child");
        // 后代仍是本应用的受管子树：父链证据优先于名称线索
        assert_eq!(verdicts[&300].association, "managed_child");
        assert_eq!(verdicts[&300].basis, "parent_chain");
    }

    #[test]
    fn dev_tool_spawned_by_project_process_inherits_project_dev() {
        let (parents, _) = table(&[
            (100, 1, "task-dock.exe"),
            (700, 1, "vite.exe"),
            (701, 700, "node.exe"),
        ]);
        let candidates = vec![
            Candidate { pid: 100, name: "task-dock.exe", image_path: None },
            Candidate {
                pid: 700,
                name: "vite.exe",
                image_path: Some("d:\\develop\\task_dock\\src-tauri\\target\\debug\\vite.exe"),
            },
            Candidate {
                pid: 701,
                name: "node.exe",
                image_path: Some("c:/program files/nodejs/node.exe"),
            },
        ];
        let verdicts = classify(&candidates, &parents, 100, Some("d:/develop/task_dock"));
        assert_eq!(verdicts[&700].association, "project_dev");
        assert_eq!(verdicts[&700].basis, "image_path");
        // node 自身路径不在工程内，但父进程是工程进程：按父链归入项目开发进程
        assert_eq!(verdicts[&701].association, "project_dev");
        assert_eq!(verdicts[&701].basis, "parent_chain");
    }

    #[test]
    fn name_match_alone_is_external_not_owned() {
        let (parents, _) = table(&[(100, 1, "task-dock.exe"), (900, 1, "node.exe")]);
        let candidates = vec![
            Candidate { pid: 100, name: "task-dock.exe", image_path: None },
            Candidate { pid: 900, name: "node.exe", image_path: Some("c:/other-project/node.exe") },
        ];
        let verdicts = classify(&candidates, &parents, 100, Some("d:/develop/task_dock"));
        assert_eq!(verdicts[&900].association, "external_tool");
        assert_eq!(verdicts[&900].basis, "name_and_path");
    }

    #[test]
    fn unreadable_path_is_unknown_owner() {
        let (parents, _) = table(&[(100, 1, "task-dock.exe"), (901, 1, "node.exe")]);
        let candidates = vec![
            Candidate { pid: 100, name: "task-dock.exe", image_path: None },
            Candidate { pid: 901, name: "node.exe", image_path: None },
        ];
        let verdicts = classify(&candidates, &parents, 100, Some("d:/develop/task_dock"));
        assert_eq!(verdicts[&901].association, "unknown_owner");
        assert_eq!(verdicts[&901].basis, "unverified");
    }

    #[test]
    fn project_path_is_matched_on_directory_boundary() {
        assert!(under_project(
            "d:\\develop\\task_dock\\src-tauri\\target\\debug\\task-dock.exe",
            "D:/Develop/task_dock"
        ));
        assert!(!under_project(
            "d:\\develop\\task_dock_other\\node.exe",
            "D:/Develop/task_dock"
        ));
        assert!(!under_project("d:\\develop\\task_dock", "D:/Develop/task_dock"));
    }

    #[test]
    fn non_tool_process_outside_project_is_not_listed() {
        let (parents, _) = table(&[(100, 1, "task-dock.exe"), (902, 1, "explorer.exe")]);
        let candidates = vec![
            Candidate { pid: 100, name: "task-dock.exe", image_path: None },
            Candidate { pid: 902, name: "explorer.exe", image_path: Some("c:/windows/explorer.exe") },
        ];
        let verdicts = classify(&candidates, &parents, 100, Some("d:/develop/task_dock"));
        assert!(!verdicts.contains_key(&902));
    }

    #[test]
    fn caregivers_are_not_promoted_without_anchor() {
        let (parents, _) = table(&[(100, 1, "task-dock.exe"), (903, 5555, "cargo.exe")]);
        let candidates = vec![
            Candidate { pid: 100, name: "task-dock.exe", image_path: None },
            Candidate { pid: 903, name: "cargo.exe", image_path: Some("c:/rust/cargo.exe") },
        ];
        let verdicts = classify(&candidates, &parents, 100, Some("d:/develop/task_dock"));
        assert_eq!(verdicts[&903].association, "external_tool");
    }

    #[test]
    fn candidate_selection_is_bounded_and_deduplicated() {
        let mut rows = vec![RawProcess { pid: 100, parent_pid: 1, name: "task-dock.exe".into() }];
        for pid in 200..260 {
            rows.push(RawProcess { pid, parent_pid: 1, name: "node.exe".into() });
        }
        rows.push(RawProcess { pid: 300, parent_pid: 1, name: "explorer.exe".into() });
        let pids = select_candidates(&rows, 100);
        assert!(pids.contains(&100));
        assert!(pids.contains(&200));
        assert!(!pids.contains(&300), "非开发工具且非子进程不应进入候选");
        assert!(pids.len() <= MAX_CANDIDATES);
    }

    #[test]
    fn first_observation_only_seeds_the_baseline() {
        let sampler = CpuSampler::default();
        let metrics = ProcessMetrics {
            cpu_100ns: 1_000_000,
            working_set_bytes: 1024,
            private_bytes: 512,
            created_unix: Some(1_700_000_000),
        };
        assert_eq!(sampler.observe(1234, &metrics), None);
        // 同一窗口内的二次读数仍不足以差分
        assert_eq!(sampler.observe(1234, &metrics), None);
    }

    fn row(pid: u32, association: &str) -> ProcessRow {
        ProcessRow {
            pid,
            name: format!("proc-{pid}.exe"),
            association: association.into(),
            association_basis: "unverified".into(),
            cpu_percent: Some(0.0),
            working_set_bytes: None,
            private_bytes: None,
            uptime_secs: None,
            status: "normal".into(),
        }
    }

    #[test]
    fn external_and_unknown_rows_are_capped_but_owned_rows_are_not() {
        let mut rows = Vec::new();
        for pid in 1..=12 {
            rows.push(row(pid, "self"));
            rows.push(row(1000 + pid, "managed_child"));
            rows.push(row(2000 + pid, "project_dev"));
        }
        for pid in 1..=20 {
            rows.push(row(3000 + pid, "external_tool"));
            rows.push(row(4000 + pid, "unknown_owner"));
        }
        let (kept, omitted_external, omitted_unknown) = apply_display_caps(rows);
        assert_eq!(omitted_external, 20 - MAX_EXTERNAL_TOOLS);
        assert_eq!(omitted_unknown, 20 - MAX_UNKNOWN_OWNERS);
        assert_eq!(
            kept.iter().filter(|row| row.association == "self").count(),
            12,
            "本应用行不得被封顶裁剪"
        );
        assert_eq!(
            kept.iter().filter(|row| row.association == "managed_child").count(),
            12
        );
        assert_eq!(
            kept.iter().filter(|row| row.association == "project_dev").count(),
            12
        );
        assert_eq!(
            kept.iter().filter(|row| row.association == "external_tool").count(),
            MAX_EXTERNAL_TOOLS
        );
        // 本应用/子进程/项目进程排在外部工具之前
        assert_eq!(kept.last().map(|row| row.association.as_str()), Some("external_tool"));
    }
}

#[cfg(all(test, windows))]
mod live_tests {
    use super::*;

    /// 真机只读诊断：自身进程必须出现在列表里，冷启动也要拿到一次真实 CPU 窗口。
    #[test]
    fn diagnostics_reports_self_with_a_real_sample_window() {
        let diagnostics = diagnostics(&CpuSampler::default());
        assert!(diagnostics.supported, "Windows 应支持进程诊断");
        assert!(diagnostics.processes.len() <= MAX_ROWS);

        let self_pid = probes::current_pid();
        let row = diagnostics
            .processes
            .iter()
            .find(|row| row.association == "self")
            .expect("自身进程必须出现在诊断列表中");
        assert_eq!(row.pid, self_pid);
        assert_eq!(row.status, "normal");
        assert!(row.working_set_bytes.unwrap_or(0) > 0, "自身工作集应可读");
        assert!(row.uptime_secs.is_some(), "自身运行时长应可读");
        assert!(
            row.cpu_percent.is_some(),
            "冷启动应通过短窗口差分得到真实 CPU 值"
        );
        assert!(
            diagnostics.cpu_window_ms >= MIN_CPU_WINDOW.as_millis() as u64,
            "采样窗口过短: {}",
            diagnostics.cpu_window_ms
        );
    }
}
