/* Task Dock 启动看门狗（经典脚本，无构建步骤；由 index.html / workspace.html
 * 在模块入口之前加载）。
 *
 * 契约文档：docs/boot/README.md（§2–§6）。
 * 与 src/boot/bootProtocol.ts 互为镜像：本文件安装 window.__TASK_DOCK_BOOT__，
 * TS 侧（bootStage/bootTiming/importState/bootReady/bootFail）在该 API 缺失时
 * 全部 no-op 安全；bootReady 另有「API 缺失时直接移除占位」的双保险。
 *
 * 职责：
 * - 维护 #boot-splash 状态机 data-state=boot|slow|timeout|error，ready 后 160ms
 *   淡出移除；「继续等待/重新加载/复制诊断」三个恢复入口在此接线。
 * - 捕获模块图加载/执行前的异常（error/unhandledrejection，≤5 条、message 截
 *   300、文件名 basename），随终态补报诊断。
 * - 阶段信号（首见为准）：bootstrap-start → main-import-start/resolved/failed →
 *   modules → init:<fn>:start/end → react-root → mounted → settings → ready。
 * - 同步初始化函数耗时（timings，单一 performance.now() 时间轴）。
 * - 动态导入状态机 mainImport：not-requested/requested/pending/resolved/rejected。
 * - 资源请求采样（同源、去 query、限量、字段容错）+ PerformanceObserver，
 *   CSP 违规采样（securitypolicyviolation），入口 script 的 load/error 事件。
 *   这些让「模块脚本尚未执行」能被定位到具体请求/CSP/同步函数。
 * - 15s 未 ready 写一次 boot_timeout（WARN，UI_BOOT_TIMEOUT，diagnostics_record
 *   直写），保证「模块根本没执行」在诊断中心可见；metadata 附资源/导入/CSP 摘要。
 * - 终态（ready / fail）：耗时 ≥4s 或有捕获错误 → boot_slow（UI_BOOT_SLOW /
 *   UI_BOOT_ERROR）；显式 fail() 与入口资源加载失败写一次 UI_BOOT_FATAL（ERROR）。
 *
 * 硬约束（协议 §2）：计时器全局仅一对（slow + timeout），ready/error 时清空；
 * 禁止任何自动刷新/自动重试循环（重新加载只由用户点击触发）。不得延长超时。
 * 所有时间取自 performance.now() 单一时间轴；诊断不记录任务正文/文件路径/密钥。
 */
(function () {
  "use strict";

  /* 阈值常量：契约测试按名字检索，改名前先改 docs/boot/README.md 并同步
   * src/boot/bootProtocol.ts。 */
  var SLOW_MS = 4000;
  var TIMEOUT_MS = 15000;
  /* ready 后淡出时长（对应 workspace.html / index.html 的 transition）。 */
  var FADE_MS = 160;
  var COPY_OK_TEXT = "已复制到剪贴板";
  var COPY_FAIL_TEXT = "复制失败，请在诊断中心查看启动记录";

  /* 采样上限：诊断是取证，不是全量日志，必须限量、限长。 */
  var MAX_RESOURCES = 40;
  var MAX_CSP = 8;
  var MAX_ENTRY_EVENTS = 8;
  var MAX_ERRORS = 5;
  var VALID_IMPORT_STATES = [
    "not-requested", "requested", "pending", "resolved", "rejected",
  ];
  /* 首屏关键资源：诊断时用于区分「pending（已请求未完成）」与「没有请求」。 */
  var KEY_RESOURCES = [
    "/@vite/client",
    "/src/workspace/bootstrap.ts",
    "/src/workspace/main.tsx",
  ];

  var startedAt = performance.now();
  var state = (window.__TASK_DOCK_BOOT__ = {
    startedAt: startedAt,
    stages: {},
    timings: {},
    mainImport: "not-requested",
    resources: [],
    csp: [],
    entryEvents: [],
    state: "boot",
    errors: [],
    timeoutReported: false,
    fatalReported: false,
    stage: stage,
    timing: timing,
    importState: importState,
    ready: ready,
    fail: fail,
    copyDiagnostics: copyDiagnostics,
  });

  var slowTimer = null;
  var timeoutTimer = null;

  function splashEl() {
    return document.getElementById("boot-splash");
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function elapsedMs() {
    return Math.round(performance.now() - startedAt);
  }

  /* ── 字符串/URL 规整：去 query、去除绝对路径、限长（隐私与体积约束） ── */

  function safeStr(value, max) {
    var text = value === undefined || value === null ? "" : String(value);
    return text.slice(0, max || 80);
  }

  /** 同源静态资源的 pathname（去 query/hash）；非同源或非 http(s) 返回 null。 */
  function sameOriginPath(raw) {
    try {
      var url = new URL(String(raw), location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      if (url.origin !== location.origin) return null;
      return url.pathname || "/";
    } catch (e) {
      return null;
    }
  }

  /** basename：错误文件名只留末段，不带目录。 */
  function basename(raw) {
    var text = safeStr(raw, 300);
    var clean = text.split("?")[0].split("#")[0];
    var parts = clean.split(/[\\/]/);
    return parts[parts.length - 1] || "";
  }

  /** stack 过滤：去 query，把 http(s)/Win/Unix 绝对路径压成 basename，限行数与长度。 */
  function sanitizeStack(stack) {
    if (!stack) return "";
    var lines = String(stack).split("\n").slice(0, 6);
    var out = [];
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      try {
        line = line.replace(/https?:\/\/[^\s)]+/g, function (u) {
          try {
            return new URL(u).pathname.split("/").pop() || "resource";
          } catch (e) {
            return "resource";
          }
        });
      } catch (e2) {
        /* 单条替换失败不影响其余 */
      }
      line = line.replace(/[A-Za-z]:\\[^\s)]+/g, function (p) {
        return p.split("\\").pop() || "file";
      });
      line = line.replace(/\/[^\s):]+\.(tsx?|jsx?|mjs|cjs)/g, function (p) {
        return p.split("/").pop() || p;
      });
      out.push(line.slice(0, 160));
    }
    return out.join("\n").slice(0, 800);
  }

  /* ── 错误捕获（≤5 条；message 截 300；来源只留 basename，不带路径） ── */

  function noteError(message, source, extra) {
    if (state.errors.length >= MAX_ERRORS) return;
    var text = String(message || "未知错误");
    var file = basename(source);
    var record = {
      message: text.slice(0, 300),
      source: file.slice(0, 80),
      at_ms: elapsedMs(),
    };
    if (extra) {
      if (extra.name) record.name = safeStr(extra.name, 80);
      if (extra.stack) record.stack = sanitizeStack(extra.stack);
    }
    state.errors.push(record);
  }

  /* 资源加载失败的 error 事件不冒泡（bubbles=false），必须用捕获阶段。 */
  window.addEventListener("error", function (event) {
    var target = event && event.target;
    var tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
    var isEntryResource =
      (tag === "script" || tag === "link") && !!(target.src || target.href);
    if (isEntryResource) {
      noteEntryEvent("error", target.src || target.href);
    }
    var err = event && event.error;
    noteError(
      (err && (err.name ? err.name + ": " : "") + (err.message || "")) ||
        (event && event.message) ||
        "资源加载失败",
      (event && event.filename) || (target && (target.src || target.href)) || "",
    );
    /* 入口 script/link 在模块图真正执行前加载失败：React 无法接管 → fail()。
     * modules 未定义涵盖「bootstrap 自身失败 / main 依赖失败」两类。 */
    if (
      isEntryResource &&
      state.stages.modules === undefined &&
      state.state !== "ready"
    ) {
      fail({
        stage: "modules",
        message: "入口" + tag + "资源加载失败，界面无法启动",
      });
    }
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    noteError(
      (reason && (reason.name ? reason.name + ": " : "") + (reason.message || String(reason))) ||
        "未处理的异步错误",
      "",
    );
  });

  /* ── 入口 script load/error 事件（load 也走捕获阶段，资源 load 不冒泡） ── */

  function noteEntryEvent(kind, raw) {
    if (state.entryEvents.length >= MAX_ENTRY_EVENTS) return;
    state.entryEvents.push({
      kind: kind,
      name: basename(raw).slice(0, 80),
      at_ms: elapsedMs(),
    });
  }

  window.addEventListener("load", function (event) {
    var target = event && event.target;
    var tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
    if ((tag === "script" || tag === "link") && (target.src || target.href)) {
      noteEntryEvent("load", target.src || target.href);
    }
  }, true);

  /* ── 资源请求采样 ── */

  function collectResource(entry) {
    if (!entry || typeof entry.name !== "string") return;
    var path = sameOriginPath(entry.name);
    if (!path) return;
    // 去重：同名资源（可能被 observer 与 initial entries 各采一次）只记首条。
    for (var i = 0; i < state.resources.length; i += 1) {
      if (state.resources[i].resourceName === path) return;
    }
    if (state.resources.length >= MAX_RESOURCES) return;
    var record = {
      resourceName: path.slice(0, 160),
      initiatorType: "",
      startTime: null,
      duration: null,
      responseStatus: null,
      transferSize: null,
      decodedBodySize: null,
    };
    // 字段容错：PerformanceResourceTiming 的部分字段在旧运行时可能缺失/为 0。
    try { record.initiatorType = safeStr(entry.initiatorType, 24); } catch (e) {}
    try {
      var st = entry.startTime;
      record.startTime = typeof st === "number" ? Math.round(st) : null;
    } catch (e2) {}
    try {
      var du = entry.duration;
      record.duration = typeof du === "number" ? Math.round(du) : null;
    } catch (e3) {}
    try {
      var rs = entry.responseStatus;
      if (typeof rs === "number" && rs > 0) record.responseStatus = rs;
    } catch (e4) {}
    try {
      var ts = entry.transferSize;
      if (typeof ts === "number") record.transferSize = ts;
    } catch (e5) {}
    try {
      var ds = entry.decodedBodySize;
      if (typeof ds === "number") record.decodedBodySize = ds;
    } catch (e6) {}
    state.resources.push(record);
  }

  function collectExistingResources() {
    try {
      var entries = performance.getEntriesByType("resource");
      for (var i = 0; i < entries.length; i += 1) collectResource(entries[i]);
    } catch (e) {
      /* Performance API 部分能力缺失时不影响状态机 */
    }
  }

  try {
    if (typeof PerformanceObserver === "function") {
      var observer = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i += 1) collectResource(entries[i]);
      });
      observer.observe({ type: "resource", buffered: true });
    }
  } catch (e7) {
    /* 不支持 buffered / type 的运行时：下面仍从 getEntriesByType 采一次快照 */
  }

  /* ── CSP 违规采样（重点排查 tauri.conf.json 的 devCsp；不放宽 CSP，只记录） ── */

  try {
    document.addEventListener("securitypolicyviolation", function (event) {
      if (state.csp.length >= MAX_CSP) return;
      state.csp.push({
        blockedURI: basename(event.blockedURI).slice(0, 80),
        violatedDirective: safeStr(event.violatedDirective, 40),
        effectiveDirective: safeStr(event.effectiveDirective, 40),
        sourceFile: basename(event.sourceFile).slice(0, 80),
        lineNumber:
          typeof event.lineNumber === "number" ? event.lineNumber : null,
        at_ms: elapsedMs(),
      });
    }, true);
  } catch (e8) {
    /* 无该事件的环境（老 WebView）跳过 */
  }

  // 首屏即刻采一次快照；后续由 observer 增量补齐。
  collectExistingResources();

  /* ── 诊断直写（不经 React 管道；失败静默，绝不影响占位） ── */

  function report(payload) {
    try {
      var internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== "function") return;
      var promise = internals.invoke("diagnostics_record", { events: [payload] });
      if (promise && typeof promise.catch === "function") promise.catch(function () {});
    } catch (e) {
      /* 诊断失败不得影响启动占位 */
    }
  }

  /** 资源摘要放进 metadata：区分 pending（未见完成）与无请求、标记失败状态。 */
  function resourceSummary() {
    var failed = 0;
    var latest = [];
    for (var i = 0; i < state.resources.length; i += 1) {
      var r = state.resources[i];
      if (r.responseStatus && r.responseStatus >= 400) failed += 1;
      if (latest.length < 6) {
        latest.push(
          r.resourceName +
            "@" + r.startTime +
            "+" + r.duration +
            (r.responseStatus ? ":" + r.responseStatus : ""),
        );
      }
    }
    return {
      count: state.resources.length,
      failed: failed,
      pendingExpected: pendingExpected(),
      latest: latest,
    };
  }

  /** 关键资源中「尚未出现在采样里」的项 = pending/未见完成，不能当成没请求。 */
  function pendingExpected() {
    var pending = [];
    for (var i = 0; i < KEY_RESOURCES.length; i += 1) {
      var key = KEY_RESOURCES[i];
      var seen = false;
      for (var j = 0; j < state.resources.length; j += 1) {
        if (state.resources[j].resourceName === key) { seen = true; break; }
      }
      if (!seen) pending.push(key);
    }
    return pending;
  }

  function timeoutPayload() {
    var last = state.errors.length ? state.errors[state.errors.length - 1].message : "";
    var summary = resourceSummary();
    return {
      level: "WARN",
      module: "ui",
      action: "boot_timeout",
      event: "timeout",
      status: "failed",
      error_code: "UI_BOOT_TIMEOUT",
      error_category: "unknown",
      message: last
        ? "界面在 15 秒内未就绪：" + last
        : "界面在 15 秒内未就绪（模块仍在加载或加载失败）",
      metadata: {
        reason: "frontend_not_ready",
        event_count: state.errors.length,
        mainImport: state.mainImport,
        resourceCount: summary.count,
        resourceFailed: summary.failed,
        pendingExpected: summary.pendingExpected.join(","),
        cspCount: state.csp.length,
        recentResources: summary.latest.join(" | "),
        stages: stageSummary(),
      },
    };
  }

  function reportTimeout() {
    if (state.timeoutReported) return;
    state.timeoutReported = true;
    report(timeoutPayload());
  }

  function fatalPayload(info) {
    return {
      level: "ERROR",
      module: "ui",
      action: "boot_fatal",
      event: "failed",
      status: "failed",
      error_code: "UI_BOOT_FATAL",
      error_category: "unknown",
      duration_ms: elapsedMs(),
      message: String(info.message || "启动过程中发生致命错误").slice(0, 300),
      metadata: {
        reason: "boot_fatal",
        stage: String(info.stage || ""),
        errorName: safeStr(info.name, 80),
        errorStack: sanitizeStack(info.stack),
        mainImport: state.mainImport,
        event_count: state.errors.length,
        cspCount: state.csp.length,
        recentResources: resourceSummary().latest.join(" | "),
      },
    };
  }

  function reportFatal(info) {
    if (state.fatalReported) return;
    state.fatalReported = true;
    report(fatalPayload(info || {}));
  }

  function slowPayload(elapsed) {
    var first = state.errors.length ? state.errors[0].message : "";
    return {
      level: state.errors.length ? "ERROR" : "WARN",
      module: "ui",
      action: "boot_slow",
      event: state.errors.length ? "failed" : "success",
      status: state.errors.length ? "failed" : "success",
      error_code: state.errors.length ? "UI_BOOT_ERROR" : "UI_BOOT_SLOW",
      duration_ms: elapsed,
      message: state.errors.length
        ? "界面启动期间捕获到 " + state.errors.length + " 个错误：" + first
        : "界面启动耗时 " + (elapsed / 1000).toFixed(1) + " 秒",
      metadata: {
        reason: state.errors.length ? "module_error" : "slow_module_load",
        event_count: state.errors.length,
        mainImport: state.mainImport,
        resourceCount: state.resources.length,
        cspCount: state.csp.length,
      },
    };
  }

  /* ── 状态机（协议 §2）：data-state=boot|slow|timeout|error → ready 移除 ── */

  function setState(next, detailText) {
    state.state = next;
    var splash = splashEl();
    if (splash) splash.setAttribute("data-state", next);
    var detail = byId("boot-detail");
    if (detail && detailText) detail.textContent = detailText;
  }

  function clearTimers() {
    if (slowTimer !== null) {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  }

  function removeSplash() {
    var splash = splashEl();
    if (!splash || !splash.parentNode) return;
    splash.classList.remove("is-stuck");
    splash.classList.add("is-leaving");
    setTimeout(function () {
      if (splash.parentNode) splash.parentNode.removeChild(splash);
    }, FADE_MS);
  }

  /* ── 阶段 / 耗时 / 导入状态信号（只记时间，不写诊断；同名阶段首见为准） ── */

  function stage(name) {
    if (typeof name !== "string" || !name) return;
    if (state.stages[name] === undefined) {
      state.stages[name] = elapsedMs();
    }
  }

  function timing(name, ms) {
    if (typeof name !== "string" || !name) return;
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return;
    if (state.timings[name] === undefined) {
      state.timings[name] = Math.round(ms);
    }
  }

  function importState(next) {
    if (VALID_IMPORT_STATES.indexOf(next) < 0) return;
    // 状态机只允许向前推进，避免乱序回执把 resolved 打回 pending。
    var order = {
      "not-requested": 0, requested: 1, pending: 2, resolved: 3, rejected: 3,
    };
    if (order[next] < order[state.mainImport]) return;
    state.mainImport = next;
  }

  function stageSummary() {
    var parts = [];
    var names = Object.keys(state.stages);
    for (var i = 0; i < names.length; i += 1) {
      parts.push(names[i] + "=" + state.stages[names[i]] + "ms");
    }
    return parts.join(", ");
  }

  /* 就绪：幂等；清空全部启动计时器并写终态记录。ready 自身记为最后阶段。 */
  function ready() {
    if (state.state === "ready") return;
    var fatalAlready = state.fatalReported;
    state.state = "ready";
    stage("ready");
    clearTimers();
    removeSplash();
    if (fatalAlready) return;
    var elapsed = elapsedMs();
    if (state.timeoutReported || elapsed >= SLOW_MS || state.errors.length > 0) {
      report(slowPayload(elapsed));
    }
  }

  /* 致命失败：React 无法渲染 / 入口资源失败 / 动态导入 reject。幂等。 */
  function fail(info) {
    info = info || {};
    if (state.state === "ready") return;
    clearTimers();
    setState("error", String(info.message || "启动过程中遇到致命错误。").slice(0, 300));
    var statusEl = byId("boot-status");
    if (statusEl) {
      statusEl.textContent = "启动遇到问题：可重新加载，或复制诊断信息后反馈。";
    }
    var splash = splashEl();
    if (splash) splash.setAttribute("role", "alert");
    // 富错误：name/stack 作为一条独立记录，stack 已过滤敏感路径。
    if (info.stack || info.name) {
      noteError(
        (info.name ? info.name + ": " : "") + (info.message || "致命错误"),
        "",
        { name: info.name, stack: info.stack },
      );
    }
    reportFatal(info);
  }

  /* ── 恢复入口（协议 §2；元素缺失时安全跳过） ── */

  function wireRecoveryButtons() {
    var retryEl = byId("boot-retry");
    if (retryEl) {
      retryEl.addEventListener("click", function () {
        location.reload(); // 唯一的刷新入口：仅用户点击，绝无自动重试循环
      });
    }
    var waitEl = byId("boot-wait");
    if (waitEl) {
      waitEl.addEventListener("click", function () {
        if (state.state !== "timeout") return;
        setState("slow"); // 回到 slow；不重设 15s 计时器
        var statusEl = byId("boot-status");
        if (statusEl) statusEl.textContent = "继续等待中……若仍无界面，可重新加载或复制诊断信息。";
      });
    }
    var copyEl = byId("boot-copy");
    if (copyEl) {
      copyEl.addEventListener("click", function () {
        copyDiagnostics().then(function (ok) {
          if (typeof copyEl.textContent === "string") {
            copyEl.textContent = ok ? COPY_OK_TEXT : COPY_FAIL_TEXT;
          }
        });
      });
    }
  }

  /* ── 剪贴板诊断（协议 §4）：固定格式；资源/错误限长，不含任务数据/路径正文 ── */

  function stageAt(name) {
    var value = state.stages[name];
    return value === undefined ? "未到达" : value + "ms";
  }

  function copyDiagnostics() {
    var lines = ["Task Dock 启动诊断"];
    lines.push("状态: " + state.state);
    lines.push("总耗时: " + (elapsedMs() / 1000).toFixed(1) + " 秒");
    try {
      lines.push("页面 URL: " + sameOriginPath(location.href) + (location.search || ""));
    } catch (e) {
      lines.push("页面 URL: 不可读");
    }
    try { lines.push("页面标题: " + safeStr(document.title, 80)); } catch (e2) {}
    try { lines.push("WebView UA: " + navigator.userAgent); } catch (e3) {}
    try { lines.push("document.readyState: " + document.readyState); } catch (e4) {}
    lines.push("");

    lines.push("Bootstrap: " + stageAt("bootstrap-start"));
    var importLine = state.mainImport;
    if (state.stages["main-import-start"] !== undefined) {
      importLine += " (start=" + stageAt("main-import-start");
      if (state.stages["main-import-resolved"] !== undefined) {
        importLine += ", resolved=" + stageAt("main-import-resolved");
      } else if (state.stages["main-import-failed"] !== undefined) {
        importLine += ", failed=" + stageAt("main-import-failed");
      }
      importLine += ")";
    }
    lines.push("Main import: " + importLine);
    lines.push("Main module: " + stageAt("modules"));
    lines.push("React root: " + stageAt("react-root"));
    lines.push("React mounted: " + stageAt("mounted"));
    lines.push("Settings settled: " + stageAt("settings"));
    lines.push("Workbench ready: " + stageAt("ready"));
    lines.push("");

    var timingNames = Object.keys(state.timings);
    if (timingNames.length) {
      var timingParts = [];
      for (var t = 0; t < timingNames.length; t += 1) {
        timingParts.push(timingNames[t].replace(/^init:/, "") + "=" + state.timings[timingNames[t]] + "ms");
      }
      lines.push("初始化函数耗时: " + timingParts.join(", "));
    } else {
      lines.push("初始化函数耗时: 未记录");
    }
    lines.push("资源请求总数: " + state.resources.length);
    lines.push("Pending 请求: " + (pendingExpected().join(", ") || "无"));

    var failedList = [];
    for (var f = 0; f < state.resources.length; f += 1) {
      var rf = state.resources[f];
      if (rf.responseStatus && rf.responseStatus >= 400) {
        failedList.push(rf.resourceName + "(" + rf.responseStatus + ")");
      }
    }
    for (var fe = 0; fe < state.entryEvents.length; fe += 1) {
      var ev = state.entryEvents[fe];
      if (ev.kind === "error") failedList.push(ev.name + "(脚本加载失败)");
    }
    lines.push("失败请求: " + (failedList.slice(0, 6).join(", ") || "无"));
    if (state.csp.length) {
      var cspParts = [];
      for (var c = 0; c < state.csp.length; c += 1) {
        var cv = state.csp[c];
        cspParts.push(cv.violatedDirective + ":" + cv.blockedURI);
      }
      lines.push("CSP 拦截: " + cspParts.slice(0, 6).join(", "));
    } else {
      lines.push("CSP 拦截: 无");
    }
    lines.push("");

    lines.push("捕获错误: " + state.errors.length + " 条");
    for (var j = 0; j < state.errors.length; j += 1) {
      var e = state.errors[j];
      lines.push(
        "- [" + e.at_ms + "ms] " +
          (e.name ? e.name + ": " : "") + e.message +
          (e.source ? " (" + e.source + ")" : ""),
      );
      if (e.stack) lines.push("  " + e.stack.split("\n")[0].slice(0, 120));
    }
    lines.push("最近资源请求:");
    var recent = state.resources.slice(-6);
    if (!recent.length) {
      lines.push("- 无（阶段信号早于资源采样，或 Performance API 不可用）");
    } else {
      for (var r2 = 0; r2 < recent.length; r2 += 1) {
        var rr = recent[r2];
        lines.push(
          "- [" + rr.startTime + "+" + rr.duration + "ms] " +
            rr.resourceName +
            (rr.responseStatus ? " -> " + rr.responseStatus : ""),
        );
      }
    }
    return writeClipboard(lines.join("\n"));
  }

  function writeClipboard(text) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(ok) {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      }
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).then(
            function () { finish(true); },
            function () { finish(fallbackCopy(text)); },
          );
          return;
        }
      } catch (e) {
        /* 非安全上下文等：落到回退通道 */
      }
      finish(fallbackCopy(text));
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "readonly");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }

  /* ── 启动：初始化 data-state + 唯一一对计时器（协议 §2） ── */

  var splash = splashEl();
  if (splash) {
    splash.setAttribute("data-state", "boot");
    splash.setAttribute("role", "status");
    splash.setAttribute("aria-live", "polite");
  }
  wireRecoveryButtons();

  slowTimer = setTimeout(function () {
    slowTimer = null;
    if (state.state !== "boot") return;
    setState("slow");
    var statusEl = byId("boot-status");
    if (statusEl) statusEl.textContent = "正在加载界面组件，首次启动可能需要稍久…";
  }, SLOW_MS);

  timeoutTimer = setTimeout(function () {
    timeoutTimer = null;
    if (state.state === "ready" || state.state === "error") return;
    setState("timeout");
    if (splash && splash.parentNode) splash.classList.add("is-stuck");
    var statusEl = byId("boot-status");
    if (statusEl) {
      statusEl.textContent = "启动超时：可继续等待、重新加载，或复制诊断信息。";
    }
    reportTimeout();
  }, TIMEOUT_MS);
})();
