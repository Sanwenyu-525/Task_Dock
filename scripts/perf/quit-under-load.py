#!/usr/bin/env python3
"""用户退出（托盘）时并发 Hook 投递：验证排空与文件回退不丢关键事件。"""
import json, os, subprocess, threading, time, sqlite3
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

BASE = Path(r'C:\Users\ASUS\AppData\Local\Temp\taskdock-accept-v05')
EXE = BASE / 'task-dock-accept.exe'
DATA = BASE / 'data-v3'
DB = DATA / 'task-dock.db'
TS = time.strftime('%Y%m%d-%H%M%S')
OUT = Path(r'D:\Develop\task_dock\docs\performance\results') / f'E6-quit-under-load-{TS}.json'
EVENTS = ['PreToolUse', 'Stop', 'PermissionRequest', 'PostToolUse', 'Stop']
stop = threading.Event()
records = []
lock = threading.Lock()
counter = 0

def one(i):
    ev = EVENTS[i % len(EVENTS)]
    session = f'Q-{TS}-{i:05d}'
    payload = json.dumps({'session_id': session, 'cwd': 'D:/Develop/task_dock', 'tool_name': 'Bash', 'task_title': 'quit under load'})
    env = dict(os.environ); env['TASK_DOCK_DATA_DIR'] = str(DATA)
    t0 = time.time()
    p = subprocess.run([str(EXE), '--agent-hook', '--source', 'codex', '--event', ev],
                       input=payload.encode(), capture_output=True, env=env, timeout=60)
    with lock:
        records.append({'i': i, 'event': ev, 'session': session, 'critical': ev in ('Stop', 'PermissionRequest'),
                        'exit': p.returncode, 'ms': round((time.time()-t0)*1000), 'at': time.time()})

def worker():
    global counter
    while not stop.is_set():
        with lock:
            i = counter; counter += 1
        one(i)

executor = ThreadPoolExecutor(max_workers=8)
futures = [executor.submit(worker) for _ in range(8)]
time.sleep(8)
quit_t0 = time.time()
q = subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(BASE/'tray-quit5.ps1')],
                   capture_output=True, text=True, timeout=60)
quit_out = (q.stdout or '') + (q.stderr or '')
# 等待进程退出（最长 30 秒）
pid = int((BASE/'app-v3.pid').read_text().strip())
exited_at = None
for _ in range(300):
    out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}'], capture_output=True, text=True, errors='replace').stdout
    if 'task-dock-accept' not in out:
        exited_at = time.time(); break
    time.sleep(0.1)
time.sleep(6)  # 退出后继续投递，验证文件回退
stop.set()
for f in futures: f.result()
executor.shutdown()
time.sleep(1)

report = json.loads((DATA/'last-shutdown-report.json').read_text(encoding='utf-8')) if (DATA/'last-shutdown-report.json').exists() else None
inbox = DATA/'agent-inbox'
inbox_files = sorted(p.name for p in inbox.glob('hook-*.json')) if inbox.exists() else []
fail_log = (inbox/'.inbox-failures.log').read_text(encoding='utf-8', errors='replace').splitlines()[-5:] if (inbox/'.inbox-failures.log').exists() else []

con = sqlite3.connect(DB)
crit_sessions = [r['session'] for r in records if r['critical']]
rows = {}
for s in crit_sessions:
    n = con.execute("select count(*) from agent_events where session_external_id=?", (s,)).fetchone()[0]
    rows[s] = n
con.close()
db_present = sum(1 for v in rows.values() if v == 1)
db_dup = {k: v for k, v in rows.items() if v > 1}
db_missing = [k for k, v in rows.items() if v == 0]
inbox_names = set(inbox_files)
# 文件回退文件内部带 session_id，用于区分关键与运行事件
inbox_critical = []
for name in inbox_files:
    try:
        body = json.loads((inbox/name).read_text(encoding='utf-8'))
    except Exception:
        continue
    if body.get('state') in ('waiting', 'completed', 'failed'):
        inbox_critical.append({'file': name, 'session': body.get('session_id'), 'state': body.get('state')})
inbox_crit_sessions = {x['session'] for x in inbox_critical}
submitted_crit = set(crit_sessions)
covered = {s for s in submitted_crit if rows.get(s) == 1 or s in inbox_crit_sessions}
out = {
    'scenario': 'quit-under-load',
    'started_at': TS,
    'submitted_total': len(records),
    'submitted_critical': len(submitted_crit),
    'quit_t0': quit_t0,
    'quit_exited_after_s': None if exited_at is None else round(exited_at - quit_t0, 2),
    'quit_automation': quit_out.strip().splitlines()[-3:],
    'shutdown_report': report,
    'inbox_after_exit': {'files': len(inbox_files), 'critical': len(inbox_critical), 'sample': inbox_critical[:5]},
    'inbox_failure_log_tail': fail_log,
    'critical_db_present': db_present,
    'critical_db_duplicates': db_dup,
    'critical_missing_db_not_in_inbox': sorted(submitted_crit - covered),
    'critical_covered': len(covered),
    'records': records,
    'ok': (not exited_at is None) and len(covered) == len(submitted_crit) and not db_dup,
}
json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(json.dumps(out, ensure_ascii=False, indent=2)[:4000])
print('[result]', OUT)
