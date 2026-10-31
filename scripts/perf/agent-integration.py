#!/usr/bin/env python3
"""P1-03 真实 Agent 自动接入验收（Codex / DeepSeek Harness / OpenCode）。

隔离原则：
- 独立的 Task Dock 数据目录 + 独立 APPDATA / USERPROFILE / CODEX_HOME / DSH_HOME；
- 真实用户配置只读复制（凭据），Hook/插件一律写进隔离目录；
- 只终止本脚本自己启动的进程，绝不触碰真实 Task Dock 实例。

用法：
    python scripts/perf/agent-integration.py --exe src-tauri/target/release/task-dock.exe
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

APP_IDENTIFIER = "com.taskdock.desktop"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def find_first(candidates: list[Path]) -> Path | None:
    for c in candidates:
        if c.exists():
            return c
    return None


def resolve_tools(args: argparse.Namespace) -> dict[str, dict]:
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    user = Path(os.environ.get("USERPROFILE", ""))
    tools = {}
    # 桌面版把当前版本放在 bin\<hash>\codex.exe；bin\codex.exe 可能是历史残留的旧版，
    # 取版本号最高的那个（与产品侧 codex::find_codex_exe 的选择一致）。
    codex = Path(args.codex) if args.codex else newest_codex(local / "OpenAI/Codex/bin")
    if codex is None:
        codex = find_first(
            [user / "AppData/Local/OpenAI/Codex/bin/codex.exe"]
        )
    dsh = Path(args.dsh) if args.dsh else find_first(
        [local / "Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"]
    )
    opencode = Path(args.opencode) if args.opencode else find_first(
        [Path(os.environ.get("TEMP", ".")) / "oc-isolated/node_modules/.bin/opencode.cmd"]
    )
    tools["codex"] = {"exe": str(codex) if codex else None, "found": codex is not None}
    tools["dsh"] = {"exe": str(dsh) if dsh else None, "found": dsh is not None}
    tools["opencode"] = {"exe": str(opencode) if opencode else None, "found": opencode is not None}
    return tools


def codex_version(exe: Path) -> str:
    try:
        p = subprocess.run(
            [str(exe), "--version"], capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL
        )
        return p.stdout.strip().splitlines()[0] if p.stdout.strip() else ""
    except Exception:  # noqa: BLE001
        return ""


def newest_codex(bin_dir: Path) -> Path | None:
    """挑选版本号最高的 codex 可执行文件（桌面版实际运行的是 bin\\<hash>\\codex.exe）。"""
    cands = []
    flat = bin_dir / "codex.exe"
    if flat.exists():
        cands.append(flat)
    if bin_dir.is_dir():
        cands.extend(sorted(p for p in bin_dir.glob("*/codex.exe") if p.is_file()))

    def key(p: Path) -> tuple:
        v = codex_version(p)
        m = re.search(r"(\d+(?:\.\d+)*)", v)
        return tuple(int(x) for x in m.group(1).split(".")) if m else ()

    if not cands:
        return None
    return max(cands, key=key)


def base_env(root: Path, extra: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env["TASK_DOCK_DATA_DIR"] = str(root / "data")
    env["APPDATA"] = str(root / "appdata")
    env["USERPROFILE"] = str(root / "home")
    env["HOME"] = str(root / "home")
    env["HOMEDRIVE"], env["HOMEPATH"] = os.path.splitdrive(str(root))
    env["CODEX_HOME"] = str(root / "codex")
    env["XDG_CONFIG_HOME"] = str(root / "home/.config")
    env["XDG_DATA_HOME"] = str(root / "home/.local/share")
    env["XDG_CACHE_HOME"] = str(root / "home/.cache")
    env["TEMP"] = str(root / "tmp")
    env["TMP"] = str(root / "tmp")
    env["TMPDIR"] = str(root / "tmp")
    env["DSH_HOME"] = str(root / "home/.dsh")
    if extra:
        env.update({k: str(v) for k, v in extra.items() if v})
    return env


def run(cmd: list[str], env: dict[str, str], timeout: int, cwd: Path | None = None) -> dict:
    started = time.perf_counter()
    try:
        p = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            cwd=str(cwd) if cwd else None,
            shell=False,
            stdin=subprocess.DEVNULL,
        )
        rc, out, err = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        rc, out, err = -1, (e.stdout or ""), (e.stderr or "")
    except FileNotFoundError as e:
        rc, out, err = -2, "", str(e)
    return {
        "cmd": [str(c) for c in cmd],
        "rc": rc,
        "ms": round((time.perf_counter() - started) * 1000),
        "stdout": out[-4000:],
        "stderr": err[-4000:],
    }


def http_json(url: str, token: str | None, timeout: float = 3.0) -> dict | None:
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - 健康探测失败即返回 None
        return None


def wait_health(
    port: int, token: str, timeout: float = 90.0, proc: subprocess.Popen | None = None
) -> dict | None:
    """等待实例健康；若进程提前退出则立即返回（避免空等满超时）。"""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = http_json(f"http://127.0.0.1:{port}/api/v1/health", token)
        if last and last.get("ok"):
            return last
        if proc is not None and proc.poll() is not None:
            return last
        time.sleep(0.5)
    return last


def windows_crash_events(since_minutes: int = 120) -> list[dict]:
    """抓取 Windows 事件日志里与 task-dock 相关的崩溃/应用错误记录。"""
    ps = (
        "Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-"
        + str(since_minutes)
        + ")} -ErrorAction SilentlyContinue | "
        "Where-Object { $_.Message -like '*task-dock*' } | "
        "Select-Object TimeCreated,Id,ProviderName | ConvertTo-Json -Compress"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        ).stdout.strip()
    except Exception:  # noqa: BLE001
        return []
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = [data]
    return data


def file_sha256(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def existing_task_dock_instances() -> list[dict]:
    """列出本机已在运行的 Task Dock 实例（单实例插件按应用标识互斥）。"""
    ps = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.Name -eq 'task-dock.exe' } | "
        "Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        ).stdout.strip()
    except Exception:  # noqa: BLE001
        return []
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = [data]
    return data


def patch_settings(db_path: Path, port: int) -> tuple[str, dict]:
    settings = {
        "http_enabled": True,
        "http_port": port,
        "mock_enabled": False,
        "clipboard_enabled": False,
        "auto_backup": False,
        "notify_agent": False,
        "notify_reminder": False,
        "notify_muted": False,
        "snap_enabled": False,
        "hotkey_enabled": False,
        "stale_run_minutes": 15,
        "perf_diagnostics_enabled": True,
    }
    now = now_iso()
    con = sqlite3.connect(db_path)
    try:
        for k, v in settings.items():
            con.execute(
                "INSERT INTO application_settings(key,value,updated_at) VALUES (?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (k, json.dumps(v), now),
            )
        con.commit()
        token = json.loads(
            con.execute("SELECT value FROM application_settings WHERE key='http_token'").fetchone()[0]
        )
    finally:
        con.close()
    return token, settings


def enabled_sources(db_path: Path) -> dict[str, dict]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT id, adapter, enabled, verified, transport_verified FROM agent_sources"
        ).fetchall()
    finally:
        con.close()
    return {
        r[0]: {"adapter": r[1], "enabled": r[2], "verified": r[3], "transport_verified": r[4]}
        for r in rows
    }


def events_by_source(db_path: Path) -> dict[str, dict]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            """
            SELECT source_id,
                   COUNT(*)                                            AS n,
                   COUNT(DISTINCT session_external_id)                 AS sessions,
                   GROUP_CONCAT(DISTINCT state)                        AS states,
                   GROUP_CONCAT(DISTINCT transport)                    AS transports,
                   MIN(received_at)                                    AS first_at,
                   MAX(received_at)                                    AS last_at
            FROM agent_events GROUP BY source_id ORDER BY n DESC
            """
        ).fetchall()
        dedupe = con.execute(
            "SELECT COUNT(*) FROM agent_events WHERE dedupe_key IS NOT NULL"
        ).fetchone()[0]
        dupes = con.execute(
            """
            SELECT COUNT(*) FROM (
              SELECT dedupe_key FROM agent_events
              WHERE dedupe_key IS NOT NULL GROUP BY dedupe_key HAVING COUNT(*) > 1
            )
            """
        ).fetchone()[0]
    finally:
        con.close()
    out = {}
    for r in rows:
        out[r[0]] = {
            "events": r[1],
            "sessions": r[2],
            "states": sorted((r[3] or "").split(",")),
            "transports": sorted((r[4] or "").split(",")),
            "first_at": r[5],
            "last_at": r[6],
        }
    return {"by_source": out, "dedupe_keys": dedupe, "duplicate_dedupe_keys": dupes}


def status_update_latency(db_path: Path, source_id: str) -> dict:
    """状态更新延迟：事件发生时间 → 落库时间（毫秒）。"""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT occurred_at, received_at FROM agent_events "
            "WHERE source_id = ?1 AND occurred_at IS NOT NULL AND received_at IS NOT NULL",
            (source_id,),
        ).fetchall()
    except Exception:  # noqa: BLE001
        return {}
    finally:
        con.close()
    deltas = []
    for occurred, received in rows:
        try:
            o = datetime.fromisoformat(str(occurred).replace("Z", "+00:00"))
            r = datetime.fromisoformat(str(received).replace("Z", "+00:00"))
            deltas.append((r - o).total_seconds() * 1000)
        except ValueError:
            continue
    if not deltas:
        return {}
    deltas.sort()

    def pct(p: float) -> float:
        return round(deltas[min(len(deltas) - 1, int(round((len(deltas) - 1) * p)))], 1)

    return {
        "n": len(deltas),
        "p50_ms": pct(0.50),
        "p95_ms": pct(0.95),
        "p99_ms": pct(0.99),
        "max_ms": round(deltas[-1], 1),
        "mean_ms": round(sum(deltas) / len(deltas), 1),
    }


def third_party_probe_files(root: Path, codex_model: str) -> None:
    """预置第三方 Hook 配置：安装必须保留它们，且可逆卸载。"""
    codex = root / "codex"
    codex.mkdir(parents=True, exist_ok=True)
    (codex / "hooks.json").write_text(
        json.dumps(
            {
                "hooks": {
                    "Stop": [
                        {"hooks": [{"type": "command", "command": "echo third-party-stop", "timeout": 5}]}
                    ]
                }
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (codex / "config.toml").write_text(
        f'model = "{codex_model}"\nmodel_reasoning_effort = "low"\n'
        'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n',
        encoding="utf-8",
    )
    real_codex = Path(os.environ.get("USERPROFILE", "")) / ".codex/auth.json"
    if real_codex.exists():
        shutil.copyfile(real_codex, codex / "auth.json")

    oc_cfg = root / "home/.config/opencode"
    oc_cfg.mkdir(parents=True, exist_ok=True)
    (oc_cfg / "plugins").mkdir(parents=True, exist_ok=True)
    (oc_cfg / "plugins/third-party.ts").write_text("// third-party plugin\nexport default {};\n", encoding="utf-8")
    real_oc_auth = Path(os.environ.get("USERPROFILE", "")) / ".local/share/opencode/auth.json"
    oc_data = root / "home/.local/share/opencode"
    oc_data.mkdir(parents=True, exist_ok=True)
    if real_oc_auth.exists():
        shutil.copyfile(real_oc_auth, oc_data / "auth.json")
    real_oc_cfg = Path(os.environ.get("USERPROFILE", "")) / ".config/opencode/opencode.json"
    if real_oc_cfg.exists():
        shutil.copyfile(real_oc_cfg, oc_cfg / "opencode.json")

    dsh = root / "home/.dsh"
    (dsh / "plugins").mkdir(parents=True, exist_ok=True)
    user_plugin = dsh / "plugins/third-party-plugin"
    user_plugin.mkdir(parents=True, exist_ok=True)
    (user_plugin / "package.json").write_text(
        json.dumps({"name": "third-party-plugin", "version": "0.0.1"}), encoding="utf-8"
    )
    real_dsh_cred = Path(os.environ.get("USERPROFILE", "")) / ".dsh/.credentials.yaml"
    if real_dsh_cred.exists():
        shutil.copyfile(real_dsh_cred, dsh / ".credentials.yaml")


def preserved(path: Path, needle: str) -> bool:
    return path.exists() and needle in path.read_text(encoding="utf-8", errors="replace")


def materialize_dsh_profile(exe: Path, env: dict[str, str], profile: str, cwd: Path) -> dict:
    """首次运行 dsh 会自动创建 profile 目录。

    DSH 的宿主插件必须以 profile bundle 形式安装，而 bundle 只能装进已初始化的
    profile —— 所以必须先让 dsh 建出 `profiles/<name>/package.json`，适配器才知道
    该往哪个 profile 的 bundles 列表里登记自己。
    """
    r = run([str(exe), "--profile", profile, "--help"], env, 300, cwd=cwd)
    pdir = Path(env["DSH_HOME"]) / "profiles" / profile
    return {
        "rc": r["rc"],
        "profile_dir": str(pdir),
        "package_json": (pdir / "package.json").is_file(),
        "stdout_tail": r["stdout"][-600:],
        "stderr_tail": r["stderr"][-600:],
    }


def dsh_profile_manifest(profile_dir: Path) -> dict:
    try:
        m = json.loads((profile_dir / "package.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 清单不存在/损坏都视为「读不到」
        return {}
    return {
        "bundles": m.get("dsh", {}).get("profile", {}).get("bundles", []),
        "dependencies": m.get("dependencies", {}),
        "raw": m,
    }


def dsh_model_setup(env: dict[str, str]) -> dict:
    """隔离目录里的 dsh 模型配置。

    - API key 只从真实 `.credentials.yaml` **只读**解析，只注入子进程环境，
      不写进证据 JSON；
    - `settings.yaml` 与 patch 文件都写在隔离的 DSH_HOME 内，不动用户真实配置。
    """
    dsh_home = Path(env["DSH_HOME"])
    dsh_home.mkdir(parents=True, exist_ok=True)
    real_cred = Path(os.environ.get("USERPROFILE", "")) / ".dsh/.credentials.yaml"
    key = ""
    if real_cred.exists():
        m = re.search(
            r"^\s*AGNES_API_KEY:\s*(\S+)\s*$",
            real_cred.read_text(encoding="utf-8", errors="replace"),
            re.M,
        )
        key = m.group(1) if m else ""
    (dsh_home / "settings.yaml").write_text(
        "llm-pi-ai:\n  providers:\n    agnes:\n      displayName: Agnes\n      apiKeyEnv: AGNES_API_KEY\n"
        "      api: openai-completions\n      baseURL: https://api.agnes-ai.cn/v1\n      models:\n"
        "        - id: agnes-2.5-flash\n          name: agnes-2.5-flash\n          contextWindow: 1000000\n"
        "agent-default-model:\n  provider: agnes\n  model: agnes-2.5-flash\n"
        "permission:\n  defaultPreset: danger-full-access\n",
        encoding="utf-8",
    )
    patch = dsh_home / "agnes.patch.yml"
    patch.write_text(
        "- id: agent-default-model\n  config:\n    provider: agnes\n    model: agnes-2.5-flash\n",
        encoding="utf-8",
    )
    return {
        "settings_yaml": str(dsh_home / "settings.yaml"),
        "patch_file": str(patch),
        "api_key_present": bool(key),
        "api_key_env": "AGNES_API_KEY",
        # 仅供注入子进程环境；main 里立刻 pop 掉，不进证据文件
        "api_key": key,
    }


def hook_latency(exe: Path, env: dict[str, str], port: int, token: str, n: int) -> dict:
    """直接驱动原生 Hook CLI：测单次进程开销与落库延迟（真实 Agent 用的就是这条路径）。"""
    stats_before = http_json(f"http://127.0.0.1:{port}/api/v1/stats", token) or {}
    received_before = stats_before.get("pipeline", {}).get("events_received", 0)
    samples: list[int] = []
    errors = 0
    for i in range(n):
        payload = json.dumps(
            {
                "session_id": f"lat-{uuid.uuid4().hex[:8]}",
                "hook_event_name": "PostToolUse" if i % 2 else "PreToolUse",
                "run_id": f"lat-run-{i}",
            }
        )
        started = time.perf_counter()
        p = subprocess.run(
            [str(exe), "--agent-hook", "--source", "codex", "--event", "PostToolUse"],
            input=payload,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        ms = round((time.perf_counter() - started) * 1000, 1)
        samples.append(int(ms))
        if p.returncode != 0:
            errors += 1
    samples.sort()
    stats_after = http_json(f"http://127.0.0.1:{port}/api/v1/stats", token) or {}
    pct = lambda p: samples[min(len(samples) - 1, int(round((len(samples) - 1) * p)))]  # noqa: E731
    return {
        "calls": n,
        "errors": errors,
        "process_ms": {
            "p50": pct(0.50),
            "p95": pct(0.95),
            "p99": pct(0.99),
            "max": samples[-1],
            "mean": round(statistics.fmean(samples), 1),
        },
        "events_received_delta": stats_after.get("pipeline", {}).get("events_received", 0)
        - received_before,
        "http_requests_delta": stats_after.get("http", {}).get("requests", 0)
        - stats_before.get("http", {}).get("requests", 0),
        "http_accepted_delta": stats_after.get("http", {}).get("accepted", 0)
        - stats_before.get("http", {}).get("accepted", 0),
        "note": "直接驱动原生 Hook CLI 测进程开销；真实 Agent 自动接入证据见 agents 段",
    }


def lingering_hook_procs(exe_name: str) -> list[dict]:
    ps = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.CommandLine -like '*--agent-hook*' } | "
        "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        ).stdout.strip()
    except Exception:  # noqa: BLE001
        return []
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = [data]
    return [{"pid": d.get("ProcessId"), "cmd": (d.get("CommandLine") or "")[:160]} for d in data]


def main() -> int:  # noqa: C901 - 顺序式验收脚本，保持线性可读
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True)
    ap.add_argument("--port", type=int, default=0, help="0=自动挑选空闲端口（默认，避免与历史实例的端口占用/TIME_WAIT 冲突）")
    ap.add_argument("--root", default=None, help="隔离根目录（默认 %%TEMP%%/taskdock-agent-int-<ts>）")
    ap.add_argument("--out", default="docs/performance/results")
    ap.add_argument("--codex", default=None)
    ap.add_argument("--dsh", default=None)
    ap.add_argument("--opencode", default=None)
    ap.add_argument("--hook-calls", type=int, default=40)
    ap.add_argument("--agent-timeout", type=int, default=240)
    ap.add_argument("--only", default=None, help="逗号分隔：codex,dsh,opencode")
    ap.add_argument("--dsh-profile", default="headless", help="dsh profile 名（宿主插件按 profile bundle 装载）")
    ap.add_argument("--codex-model", default="gpt-6.1-sol")
    ap.add_argument(
        "--opencode-model",
        default="",
        help="opencode 使用的模型（留空=用其默认模型；默认模型在本机无受支持 provider）",
    )
    ap.add_argument(
        "--codex-bypass-hook-trust",
        default="1",
        help="Codex CLI 要求 hook 通过信任审核，否则静默跳过；非交互场景需 --dangerously-bypass-hook-trust",
    )
    args = ap.parse_args()

    exe = Path(args.exe).resolve()
    if not exe.exists():
        log(f"找不到可执行文件: {exe}")
        return 2
    if args.port == 0:
        import socket

        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            args.port = s.getsockname()[1]
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    root = Path(args.root) if args.root else Path(os.environ.get("TEMP", ".")) / f"taskdock-agent-int-{ts}"
    root.mkdir(parents=True, exist_ok=True)
    for sub in ("data", "appdata", "home", "tmp"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    env = base_env(root)
    tools = resolve_tools(args)
    only = set((args.only or "").split(",")) - {""}

    log(f"隔离根目录: {root}")
    others = existing_task_dock_instances()
    log(f"端口: {args.port}；本机已存在的 Task Dock 实例: {others}")
    if others:
        log("警告：单实例插件按应用标识互斥，已有实例在跑时本隔离实例会在 setup 前退出")
    log("工具: " + json.dumps({k: v["exe"] for k, v in tools.items()}, ensure_ascii=False))
    codex_version_str = codex_version(Path(tools["codex"]["exe"])) if tools["codex"]["found"] else ""
    codex_extra = ["--dangerously-bypass-hook-trust"] if args.codex_bypass_hook_trust == "1" else []
    log(f"codex 版本: {codex_version_str or 'n/a'}；hook 信任绕过: {bool(codex_extra)}")

    third_party_probe_files(root, args.codex_model)

    # 1. 建库 + 写入测试设置
    seed = run([str(exe), "--agentctl", "status", "codex"], env, 120)
    db_path = root / "data/task-dock.db"
    if not db_path.exists():
        log("建库失败: " + seed["stderr"][:400])
        return 2
    token, settings = patch_settings(db_path, args.port)

    # 1b. dsh profile 必须先初始化（宿主插件以 profile bundle 装载，只有已初始化的
    #     profile 才能登记 bundle），模型配置写进隔离 DSH_HOME。
    cwd = root / "workspace"
    cwd.mkdir(parents=True, exist_ok=True)
    dsh_profile_dir = root / "home/.dsh/profiles" / args.dsh_profile
    dsh_setup: dict = {"profile_materialized": None, "model": {}}
    dsh_api_key = ""
    if tools["dsh"]["found"]:
        dsh_setup["profile_materialized"] = materialize_dsh_profile(
            Path(tools["dsh"]["exe"]), env, args.dsh_profile, cwd
        )
        dsh_setup["model"] = dsh_model_setup(env)
        dsh_api_key = dsh_setup["model"].pop("api_key", "")
        log(
            "dsh profile 初始化: "
            f"{dsh_setup['profile_materialized']['package_json']}；"
            f"api_key_present={dsh_setup['model']['api_key_present']}"
        )

    # 2. 安装 Hook（隔离配置目录；必须保留第三方条目）
    installs = {}
    for adapter in ("codex", "dsh", "opencode"):
        r = run([str(exe), "--agentctl", "install", adapter], env, 180)
        parsed = None
        try:
            parsed = json.loads(r["stdout"])
        except json.JSONDecodeError:
            pass
        installs[adapter] = {"rc": r["rc"], "ms": r["ms"], "result": parsed, "stderr": r["stderr"][:400]}

    dsh_manifest_after_install = dsh_profile_manifest(dsh_profile_dir)
    preserved_checks = {
        "codex_third_party_stop_preserved": preserved(root / "codex/hooks.json", "echo third-party-stop"),
        "codex_marker_written": preserved(root / "codex/hooks.json", "--agent-hook"),
        "opencode_third_party_plugin_kept": (root / "home/.config/opencode/plugins/third-party.ts").exists(),
        "opencode_bridge_written": (root / "home/.config/opencode/plugins/task-dock-bridge.ts").exists(),
        "dsh_third_party_plugin_kept": (root / "home/.dsh/plugins/third-party-plugin/package.json").exists(),
        "dsh_bridge_written": (root / "home/.dsh/plugins/task-dock-bridge").exists(),
        "dsh_bridge_points_port": preserved(root / "home/.dsh/plugins/task-dock-bridge/lib/index.js", str(args.port))
        or any(
            preserved(p, str(args.port))
            for p in (root / "home/.dsh/plugins/task-dock-bridge").glob("**/*.js")
        ),
        # profile bundle 机制：宿主只在 profile 的 bundles 列表里装载插件
        "dsh_profile_bundle_package_written": (
            dsh_profile_dir / "node_modules/task-dock-bridge/package.json"
        ).is_file(),
        "dsh_profile_listed_in_bundles": "task-dock-bridge"
        in (dsh_manifest_after_install.get("bundles") or []),
        "dsh_profile_base_bundles_kept": all(
            b in (dsh_manifest_after_install.get("bundles") or [])
            for b in ("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless")
        ),
        "dsh_profile_manifest_other_fields_kept": bool(
            dsh_manifest_after_install.get("raw", {}).get("name")
        ),
    }

    installed_hook_artifacts = {}
    for rel in (
        "codex/hooks.json",
        "home/.config/opencode/plugins/task-dock-bridge.ts",
        "home/.dsh/plugins/task-dock-bridge/lib/index.js",
    ):
        p = root / rel
        if p.exists():
            installed_hook_artifacts[rel] = p.read_text(encoding="utf-8", errors="replace")[:2500]

    # 3. 启动隔离实例（stdout/stderr 落盘，实例崩溃时必须可诊断）
    app_log_path = root / "app.log"
    app_log = open(app_log_path, "wb")
    proc = subprocess.Popen(
        [str(exe)],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=app_log,
        stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    health = wait_health(args.port, token, proc=proc)
    if not health or not health.get("ok"):
        log(f"实例健康检查失败: {health}")
        exit_code = proc.poll()
        log(f"实例退出码: {exit_code}；本机其他 Task Dock 实例: {existing_task_dock_instances()}")
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        app_log.close()
        log(f"应用日志: {app_log_path}")
        out_dir = Path(args.out)
        out_dir.mkdir(parents=True, exist_ok=True)
        fail_path = out_dir / f"AGENT-agent-integration-FAILED-{ts}.json"
        fail_path.write_text(
            json.dumps(
                {
                    "test": "real-agent-automatic-integration",
                    "phase": "app-startup",
                    "generated_at": now_iso(),
                    "source_exe": str(exe),
                    "isolated_root": str(root),
                    "port": args.port,
                    "health": health,
                    "app_exit_code": exit_code,
                    "other_task_dock_instances": existing_task_dock_instances(),
                    "app_log_path": str(app_log_path),
                    "app_log_tail": app_log_path.read_text(encoding="utf-8", errors="replace")[-4000:],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        log(f"失败证据已写入 {fail_path}")
        return 2
    log(f"隔离实例已启动 pid={proc.pid} port={args.port}")

    # 看门狗：实例在验收过程中异常退出必须被抓住（记录死亡时刻、退出码、应用日志尾部、
    # Windows 事件日志），否则「事件没落库」会被误判成 Agent 没接入。
    watchdog: dict = {"death_at": None, "exit_code": None, "event_log": []}

    def watchdog_loop() -> None:
        while True:
            time.sleep(2.0)
            if proc.poll() is None:
                continue
            watchdog["death_at"] = now_iso()
            watchdog["exit_code"] = proc.poll()
            try:
                app_log.flush()
            except Exception:  # noqa: BLE001
                pass
            try:
                tail = app_log_path.read_text(encoding="utf-8", errors="replace")[-3000:]
            except OSError:
                tail = ""
            watchdog["app_log_tail"] = tail
            watchdog["event_log"] = windows_crash_events()
            log(f"看门狗捕获：实例在验收期间退出，退出码={watchdog['exit_code']}")
            return

    threading.Thread(target=watchdog_loop, daemon=True).start()

    stats_start = http_json(f"http://127.0.0.1:{args.port}/api/v1/stats", token) or {}

    # 4. 真实 Agent 会话（自动事件由 Agent 自己的 Hook/插件产生）
    agents = {}
    prompt = "只回复两个字母 OK，不要调用任何工具。"
    liveness: list[dict] = []

    def probe_liveness(tag: str) -> None:
        liveness.append(
            {
                "tag": tag,
                "at": now_iso(),
                "alive": proc.poll() is None,
                "exit_code": proc.poll(),
                "health": bool((http_json(f"http://127.0.0.1:{args.port}/api/v1/health", token) or {}).get("ok")),
            }
        )

    def observe(name: str, source_id: str, cmd: list[str], env_over: dict | None) -> None:
        if only and name not in only:
            return
        if not tools[name]["found"]:
            agents[name] = {"status": "NOT TESTED", "reason": "本机未找到可执行的 Agent CLI"}
            return
        e = dict(env)
        if env_over:
            e.update(env_over)
        before = events_by_source(db_path)["by_source"].get(source_id, {}).get("events", 0)
        r = run(cmd, e, args.agent_timeout, cwd=cwd)
        deadline = time.time() + 20
        after = before
        while time.time() < deadline:
            after = events_by_source(db_path)["by_source"].get(source_id, {}).get("events", before)
            if after > before:
                break
            time.sleep(1.0)
        detail = events_by_source(db_path)["by_source"].get(source_id, {})
        combined = (r["stderr"] or "") + "\n" + (r["stdout"] or "")
        hook_lines = [ln for ln in combined.splitlines() if "hook:" in ln.lower()]
        bridge_lines = [
            ln for ln in combined.splitlines() if "task-dock-bridge" in ln
        ]
        agents[name] = {
            "status": "PASS" if after > before else ("FAIL" if r["rc"] == 0 else "NOT TESTED"),
            "source_id": source_id,
            "rc": r["rc"],
            "wall_ms": r["ms"],
            "events_before": before,
            "events_after": after,
            "detail": detail,
            "agent_reported_hook_lines": hook_lines[:40],
            "agent_reported_bridge_lines": bridge_lines[:40],
            "stdout_tail": r["stdout"][-1200:],
            "stderr_tail": r["stderr"][-1200:],
        }
        probe_liveness(f"after-{name}")
        log(f"{name}: rc={r['rc']} events {before}->{after} {detail.get('states')} hook_lines={len(hook_lines)}")

    probe_liveness("before-agents")
    observe(
        "codex",
        "codex",
        [
            tools["codex"]["exe"],
            "exec",
            "--skip-git-repo-check",
            *codex_extra,
            prompt,
        ],
        None,
    )
    observe(
        "dsh",
        "deepseek-harness",
        [
            tools["dsh"]["exe"],
            "--profile",
            args.dsh_profile,
            "--patch",
            str(root / "home/.dsh/agnes.patch.yml"),
            "--json",
            prompt,
        ],
        {"AGNES_API_KEY": dsh_api_key},
    )
    observe(
        "opencode",
        "opencode",
        [
            tools["opencode"]["exe"],
            "run",
            *(["--model", args.opencode_model] if args.opencode_model else []),
            "--format",
            "json",
            prompt,
        ],
        None,
    )

    # 5. Hook 传输开销与残留进程
    latency = hook_latency(exe, env, args.port, token, args.hook_calls) if proc.poll() is None else {}
    lingering = lingering_hook_procs(exe.name)
    final_events = events_by_source(db_path)
    latency_by_source = {
        src: status_update_latency(db_path, src) for src in final_events["by_source"]
    }
    stats_end = http_json(f"http://127.0.0.1:{args.port}/api/v1/stats", token) or {}
    sources = enabled_sources(db_path)

    # 6. 卸载可逆性（隔离目录）
    uninstall = {}
    for adapter in ("codex", "dsh", "opencode"):
        r = run([str(exe), "--agentctl", "uninstall", adapter], env, 120)
        uninstall[adapter] = {
            "rc": r["rc"],
            "marker_removed": not preserved(root / "codex/hooks.json", "--agent-hook")
            if adapter == "codex"
            else None,
            "third_party_kept": preserved(root / "codex/hooks.json", "echo third-party-stop")
            if adapter == "codex"
            else (
                (root / "home/.config/opencode/plugins/third-party.ts").exists()
                if adapter == "opencode"
                else (root / "home/.dsh/plugins/third-party-plugin/package.json").exists()
            ),
        }
        if adapter == "dsh":
            after_uninstall = dsh_profile_manifest(dsh_profile_dir)
            uninstall[adapter]["profile_bundle_removed"] = not (
                dsh_profile_dir / "node_modules/task-dock-bridge"
            ).exists()
            uninstall[adapter]["profile_listing_removed"] = "task-dock-bridge" not in (
                after_uninstall.get("bundles") or []
            )
            uninstall[adapter]["profile_base_bundles_kept"] = all(
                b in (after_uninstall.get("bundles") or [])
                for b in ("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless")
            )

    subprocess.run(
        ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
        capture_output=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        pass
    app_log.flush()
    app_log.close()
    try:
        app_log_text = app_log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        app_log_text = ""

    evidence = {
        "test": "real-agent-automatic-integration",
        "generated_at": now_iso(),
        "source_exe": str(exe),
        "source_exe_bytes": exe.stat().st_size,
        "source_exe_sha256": file_sha256(exe),
        "git_head": run(["git", "-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "--short", "HEAD"], os.environ.copy(), 30)["stdout"].strip(),
        "isolated_root": str(root),
        "real_user_configs": "只读复制 auth/credentials；未写入任何真实 Agent 配置目录",
        "codex_version": codex_version_str,
        "codex_hook_trust_bypass": bool(codex_extra),
        "codex_model": args.codex_model,
        "tools": tools,
        "settings": settings,
        "installs": installs,
        "installed_hook_artifacts": installed_hook_artifacts,
        "config_preservation": preserved_checks,
        "dsh_profile": {
            "profile": args.dsh_profile,
            "setup": dsh_setup,
            "manifest_after_install": dsh_manifest_after_install,
        },
        "sources": sources,
        "agents": agents,
        "hook_latency": latency,
        "lingering_hook_processes": lingering,
        "events": final_events,
        "status_update_latency": latency_by_source,
        "stats_start": stats_start,
        "stats_end": stats_end,
        "uninstall": uninstall,
        "app_liveness": liveness,
        "app_exit_code": proc.poll(),
        "watchdog": watchdog,
        "app_log_path": str(app_log_path),
        "app_log_tail": app_log_text[-4000:],
    }
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"AGENT-agent-integration-{ts}.json"
    out_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"证据已写入 {out_path}")
    log(
        "汇总: "
        + json.dumps(
            {k: v.get("status") for k, v in agents.items()},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
