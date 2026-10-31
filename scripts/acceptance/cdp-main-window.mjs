// P1-01 主窗口 CDP 目标识别（第五轮专项整改）。
//
// 历史事故：第四轮 GUI 验收把 `http://tauri.localhost/context-menu.html`
// （右键菜单辅助窗口）当成主窗口，6 轮全部找不到剪贴板入口
// （docs/clipboard/evidence/p1-05-gui-20261031/p1-05-ui-drive.json）。
//
// 设计原则（与任务书 §3.2 一一对应）：
//  1. 每轮通过 CDP HTTP `/json/list` 全量枚举 targets；
//  2. 按 URL 分类：主窗口候选 / 右键菜单（context-menu.html）/ 其他辅助页面 / 非 page；
//  3. 身份判定复用 Tauri 注入的 `__TAURI_INTERNALS__.metadata.currentWindow.label`
//     （tauri.conf.json 中主窗口 label 固定为 "main"），不新增任何全局标记；
//  4. 就绪判定：React 根节点 `#root` 已挂载 + invoke 可用；
//  5. 主窗口加载中允许**有限**重试（deadline 默认 20s、上限 60s，禁止无限等待）；
//  6. 每次枚举与判定都记录 targetId/URL/标题/依据；
//  7. 找不到合法主窗口 → 明确失败并附完整枚举记录；
//  8. 多个候选无法区分（≥2 个 label==="main"）→ 明确失败，不猜。

/** context-menu 辅助窗口的 URL 特征（release: http://tauri.localhost/context-menu.html）。 */
export const CONTEXT_MENU_URL_RE = /(^|\/)context-menu\.html?(\?|#|$)/i;

/** deadline 上限：不允许通过调大超时掩盖选择错误。 */
export const MAX_DEADLINE_MS = 60000;

/**
 * 把 CDP /json/list 的 targets 分类。
 * @param {Array<{id?:string,targetId?:string,url:string,title?:string,type:string}>} targets
 * @returns {{mainCandidates:any[], contextMenu:any[], devtools:any[], nonPage:any[]}}
 */
export function classifyTargets(targets) {
  const out = { mainCandidates: [], contextMenu: [], devtools: [], nonPage: [] };
  for (const t of targets ?? []) {
    const id = t.targetId ?? t.id;
    const item = { targetId: id, url: t.url, title: t.title ?? "", type: t.type };
    if (t.type !== "page") {
      out.nonPage.push(item);
    } else if (/^devtools:/i.test(t.url)) {
      out.devtools.push(item);
    } else if (CONTEXT_MENU_URL_RE.test(t.url)) {
      out.contextMenu.push(item);
    } else {
      out.mainCandidates.push(item);
    }
  }
  return out;
}

/**
 * 在候选里选定唯一主窗口（纯函数，便于回归测试）。
 *
 * @param {Array<{targetId:string,url:string,title:string,type:string}>} targets 全量 targets
 * @param {Map<string,{label:?string,webviewLabel:?string,tauri:boolean,mounted:boolean}>} identities
 *        每个 targetId 的页面内身份探测结果（探测失败的 target 不在表里）。
 * @returns {{status:'ok'|'ambiguous'|'loading'|'not-found', target?:object,
 *            candidates?:object[], seen?:object, rationale:string}}
 */
export function selectMainWindow(targets, identities) {
  const { mainCandidates, contextMenu, devtools, nonPage } = classifyTargets(targets);
  const seen = {
    enumerated: (targets ?? []).length,
    mainCandidates: mainCandidates.length,
    contextMenu: contextMenu.length,
    devtools: devtools.length,
    nonPage: nonPage.length,
  };

  const details = mainCandidates.map((t) => {
    const identity = identities?.get?.(t.targetId) ?? null;
    // 身份 = Tauri 窗口 label（tauri.conf.json: label "main"）+ invoke 可用。
    const matches = !!identity && identity.label === "main" && identity.tauri === true;
    const ready = !!identity && identity.mounted === true;
    return { ...t, identity, matches, ready };
  });
  const matches = details.filter((d) => d.matches);
  const qualified = matches.filter((d) => d.ready);

  if (matches.length > 1) {
    return {
      status: "ambiguous",
      candidates: matches,
      seen,
      rationale: `发现 ${matches.length} 个 label==="main" 的候选（targetId: ${matches
        .map((m) => m.targetId)
        .join(", ")}），无法区分，按任务书要求明确失败而不猜`,
    };
  }
  if (qualified.length === 1) {
    const t = qualified[0];
    return {
      status: "ok",
      target: t,
      seen,
      rationale: `唯一 label==="main" 且已挂载的页面：url=${t.url}，title="${t.title}"，identity=${JSON.stringify(t.identity)}`,
    };
  }
  if (matches.length === 1 && !qualified.length) {
    return {
      status: "loading",
      candidates: matches,
      seen,
      rationale: `label==="main" 的页面尚未完成挂载（mounted=false，url=${matches[0].url}）`,
    };
  }
  return {
    status: "not-found",
    seen,
    rationale: `没有 label==="main" 的候选页面（候选 ${details.length} 个：${details
      .map((d) => `${d.url}${d.identity ? ` label=${d.identity.label}` : " 不可探测"}`)
      .join("; ") || "无"}；context-menu ${contextMenu.length} 个已排除）`,
  };
}

/**
 * 通过 CDP HTTP 枚举 targets（零依赖，Node 18+ 自带 fetch）。
 * @param {number} port
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Array<{targetId:string,url:string,title:string,type:string}>>}
 */
export async function listTargets(port, fetchImpl = fetch) {
  const res = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`CDP /json/list HTTP ${res.status}`);
  const list = await res.json();
  // CDP 原生字段是 id；兼容已映射为 targetId 的输入（测试 mock / 复用场景）。
  return (Array.isArray(list) ? list : []).map((t) => ({
    targetId: t.id ?? t.targetId,
    url: t.url,
    title: t.title,
    type: t.type,
  }));
}

/**
 * 轮询式主窗口识别编排：有限重试 + 每轮记录。
 *
 * @param {{port:number, deadlineMs?:number, intervalMs?:number, fetchImpl?:typeof fetch,
 *          probe?:(info:{targetId:string,url:string})=>Promise<{label:?string,webviewLabel:?string,tauri:boolean,mounted:boolean}>,
 *          log?:(entry:object)=>void, now?:()=>number}} options
 * `probe` 由调用方注入（通常用 Playwright 对页面做 evaluate）；探测抛错按「不可探测」处理。
 * @returns {Promise<{ok:true,target:object,log:object[]}|{ok:false,reason:string,log:object[]}>}
 */
export async function attachMainWindow(options) {
  const {
    port,
    deadlineMs = 20000,
    intervalMs = 500,
    fetchImpl = fetch,
    probe,
    log = () => {},
    now = () => Date.now(),
  } = options;
  const deadline = Math.min(Math.max(1000, deadlineMs), MAX_DEADLINE_MS) + now();
  const entries = [];
  const maxRounds = 240; // 硬上限：即使时钟异常（注入/回拨）也不允许无限轮询
  const record = (entry) => {
    // 日志时间戳用真实时钟；注入的 now() 只用于 deadline 推进（测试可冻结/加速）。
    entry.at = new Date().toISOString();
    entries.push(entry);
    log(entry);
  };

  while (true) {
    let targets;
    try {
      targets = await listTargets(port, fetchImpl);
    } catch (err) {
      record({ round: entries.length, decision: "enumerate-failed", error: String(err?.message ?? err) });
      if (now() >= deadline) {
        return { ok: false, reason: `CDP 目标枚举持续失败：${String(err?.message ?? err)}`, log: entries };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    // 对每个候选页面做身份探测（探测失败=不可探测，不当主窗口）。
    const identities = new Map();
    const { mainCandidates } = classifyTargets(targets);
    for (const t of mainCandidates) {
      if (!probe) break; // 纯枚举模式（测试注入用）
      try {
        identities.set(t.targetId, await probe(t));
      } catch (err) {
        record({ round: entries.length, decision: "probe-failed", targetId: t.targetId, url: t.url, error: String(err?.message ?? err).slice(0, 200) });
      }
    }

    const picked = selectMainWindow(targets, identities);
    record({ round: entries.length, decision: picked.status, rationale: picked.rationale, seen: picked.seen });
    if (picked.status === "ok") return { ok: true, target: picked.target, log: entries };
    if (picked.status === "ambiguous") {
      return { ok: false, reason: `主窗口候选不唯一：${picked.rationale}`, log: entries };
    }
    if (entries.length >= maxRounds) {
      return { ok: false, reason: `识别轮次超过硬上限 ${maxRounds}，最后状态=${picked.status}`, log: entries };
    }
    if (now() >= deadline) {
      return {
        ok: false,
        reason: `在 ${Math.min(Math.max(1000, deadlineMs), MAX_DEADLINE_MS)}ms 内未能唯一确定主窗口，最后状态=${picked.status}；${picked.rationale}`,
        log: entries,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
