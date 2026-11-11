/* Task Dock 启动看门狗（经典脚本，无构建步骤；由 index.html 在模块脚本之前加载）。
 *
 * 契约文档：tmp/acceptance/startup-experience-v1/BOOT_PROTOCOL.md（§2–§5）。
 * 与 src/boot/bootProtocol.ts 互为镜像：本文件安装 window.__TASK_DOCK_BOOT__，
 * TS 侧（bootStage/bootReady/bootFail）在该 API 缺失时全部 no-op 安全；
 * bootReady 另有「API 缺失时直接移除占位」的双保险（见 bootProtocol.ts）。
 *
 * 职责：
 * - 维护 #boot-splash 状态机 data-state=boot|slow|timeout|error，ready 后 160ms
 *   淡出移除；「继续等待/重新加载/复制诊断」三个恢复入口在此接线。
 * - 捕获模块图加载/执行前的异常（error/unhandledrejection，≤5 条、message 截
 *   300、文件名 basename），随终态补报诊断。
 * - 15s 未 ready 写一次 boot_timeout（WARN，UI_BOOT_TIMEOUT，diagnostics_record 直写），
 *   保证「模块根本没执行」在诊断中心可见。
 * - 终态（ready / fail）：耗时 ≥4s 或有捕获错误 → boot_slow（UI_BOOT_SLOW /
 *   UI_BOOT_ERROR）；显式 fail() 与 modules 前的入口资源加载失败写一次
 *   UI_BOOT_FATAL（ERROR），此后终态不再重复 ERROR 记录。
 * - 就绪判定只认 React 显式 ready()（main.tsx / App / ErrorBoundary 调用）——
 *   2026-11-12 起「#root 有子元素」不再视为就绪（设置加载门期间工作区未就绪）。
 *
 * 硬约束（协议 §2）：计时器全局仅一对（slow + timeout），ready/error 时清空；
 * 禁止任何自动刷新/自动重试循环（重新加载只由用户点击触发）。
 */
(function () {
  "use strict";

  /* 阈值常量：契约测试按名字检索，改名前先改 BOOT_PROTOCOL.md §2 并同步
   * src/boot/bootProtocol.ts（BOOT_SLOW_MS / BOOT_TIMEOUT_MS）。 */
  var SLOW_MS = 4000;
  var TIMEOUT_MS = 15000;
  /* ready 后淡出时长（协议 §2；对应 index.html 的 transition，B 所有）。 */
  var FADE_MS = 160;
  /* 恢复入口反馈用的只读提示，不自动恢复，避免引入第二对计时器。 */
  var COPY_OK_TEXT = "已复制到剪贴板";
  var COPY_FAIL_TEXT = "复制失败，请在诊断中心查看启动记录";

  var startedAt = performance.now();
  var state = (window.__TASK_DOCK_BOOT__ = {
    startedAt: startedAt,
    stages: {},
    state: "boot",
    errors: [],
    timeoutReported: false,
    fatalReported: false,
    stage: stage,
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

  /* ── 错误捕获（≤5 条；message 截 300；来源只留 basename，不带路径） ── */

  function noteError(message, source) {
    if (state.errors.length >= 5) return;
    var text = String(message || "未知错误");
    var file = String(source || "");
    file = file.split(/[\\/]/).pop() || "";
    state.errors.push({
      message: text.slice(0, 300),
      source: file.slice(0, 80),
      at_ms: Math.round(performance.now() - startedAt),
    });
  }

  /* 资源加载失败的 error 事件不冒泡（bubbles=false），非捕获监听收不到 —— 必须
   * 用捕获阶段（第三参 true）才能在入口脚本加载失败时触发 error 态（集成审查
   * 2026-11-12 修复）。捕获阶段同样能收到发生在 window 本身的未捕获异常。 */
  window.addEventListener("error", function (event) {
    var target = event && event.target;
    var tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
    var isEntryResource = (tag === "script" || tag === "link") && !!(target.src || target.href);
    var err = event && event.error;
    noteError(
      (err && (err.name ? err.name + ": " : "") + (err.message || "")) ||
        (event && event.message) ||
        "资源加载失败",
      (event && event.filename) || (target && (target.src || target.href)) || "",
    );
    /* 入口 script/link 在 modules 阶段前加载失败：模块图不可能再执行，React
     * 无法接管 → 走 fail() 统一进入 error 态并写一次 UI_BOOT_FATAL（协议 §2/§5）。
     * modules 之后的资源失败（如应用内图标）只记录，不改变状态机。 */
    if (isEntryResource && state.stages.modules === undefined && state.state !== "ready") {
      fail({ stage: "modules", message: "入口" + tag + "资源加载失败，界面无法启动" });
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

  function elapsedMs() {
    return Math.round(performance.now() - startedAt);
  }

  function timeoutPayload() {
    var last = state.errors.length ? state.errors[state.errors.length - 1].message : "";
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
        event_count: state.errors.length,
      },
    };
  }

  function reportFatal(info) {
    if (state.fatalReported) return;
    state.fatalReported = true;
    report(fatalPayload(info));
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

  /* 淡出移除占位。这里的 setTimeout 是 DOM 清理一次性定时器，不属于
   * 「计时器全局仅一对」约束的启动计时器（协议 §2 淡出 160ms 后移除）。 */
  function removeSplash() {
    var splash = splashEl();
    if (!splash || !splash.parentNode) return;
    splash.classList.remove("is-stuck");
    splash.classList.add("is-leaving");
    setTimeout(function () {
      if (splash.parentNode) splash.parentNode.removeChild(splash);
    }, FADE_MS);
  }

  /* 阶段信号（协议 §3）：只记时间，不写诊断；同名阶段首见为准。 */
  function stage(name) {
    if (typeof name !== "string" || !name) return;
    if (state.stages[name] === undefined) {
      state.stages[name] = elapsedMs();
    }
  }

  /* 就绪：幂等；清空全部启动计时器并写终态记录（慢启动/有错误才写，避免噪声）。
   * 致命失败已写 UI_BOOT_FATAL 时终态不再重复 ERROR 记录（协议 §5）。 */
  function ready() {
    if (state.state === "ready") return;
    var fatalAlready = state.fatalReported;
    state.state = "ready";
    clearTimers();
    removeSplash();
    if (fatalAlready) return;
    var elapsed = elapsedMs();
    if (state.timeoutReported || elapsed >= SLOW_MS || state.errors.length > 0) {
      report(slowPayload(elapsed));
    }
  }

  /* 致命失败（协议 §3）：React 无法渲染（main.tsx 同步抛错）或入口资源加载失败。
   * 进入 error 态 + 写一次 UI_BOOT_FATAL；重复调用幂等。React 仍活着（ErrorBoundary
   * 捕获渲染异常）时调用方应走 ready()，不得走 fail()。 */
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
    if (splash) splash.setAttribute("role", "alert"); // 协议 §7：error 态切换
    reportFatal(info);
  }

  /* ── 恢复入口（协议 §2/§7；元素由 index.html 提供，缺失时安全跳过） ── */

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
        /* 继续等待：回到 slow（超时必然已过 4s）；不重设 15s 计时器，
         * UI_BOOT_TIMEOUT 只报一次（协议 §2）。 */
        setState("slow");
        var statusEl = byId("boot-status");
        if (statusEl) statusEl.textContent = "继续等待中……若仍无界面，可重新加载或复制诊断信息。";
      });
    }

    var copyEl = byId("boot-copy");
    if (copyEl) {
      copyEl.addEventListener("click", function () {
        copyDiagnostics().then(function (ok) {
          /* 文案一次性替换、不自动还原：既给反馈，也不引入额外计时器。 */
          if (typeof copyEl.textContent === "string") {
            copyEl.textContent = ok ? COPY_OK_TEXT : COPY_FAIL_TEXT;
          }
        });
      });
    }
  }

  /* ── 剪贴板诊断（协议 §4）：navigator.clipboard 优先，textarea 回退；
   * 内容只含耗时/阶段/错误摘要/UA，不含任务数据、文件路径、剪贴板正文。 ── */

  function copyDiagnostics() {
    var lines = ["Task Dock 启动诊断"];
    lines.push("状态: " + state.state);
    lines.push("启动耗时: " + (elapsedMs() / 1000).toFixed(1) + " 秒");
    var names = Object.keys(state.stages);
    if (names.length) {
      var parts = [];
      for (var i = 0; i < names.length; i++) {
        parts.push(names[i] + "=" + state.stages[names[i]] + "ms");
      }
      lines.push("阶段: " + parts.join(", "));
    } else {
      lines.push("阶段: 模块脚本尚未执行");
    }
    lines.push("捕获错误: " + state.errors.length + " 条");
    for (var j = 0; j < state.errors.length; j++) {
      var e = state.errors[j];
      lines.push("- [" + e.at_ms + "ms] " + e.message + (e.source ? " (" + e.source + ")" : ""));
    }
    try {
      lines.push("UA: " + navigator.userAgent);
    } catch (e2) {
      /* UA 不可得时跳过 */
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
            function () {
              finish(true);
            },
            function () {
              finish(fallbackCopy(text));
            },
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
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
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
    /* 旧版 index.html（is-stuck 驱动重试按钮显隐）的过渡兼容；B 落地新 DOM 后
     * 由 data-state 驱动。 */
    if (splash && splash.parentNode) splash.classList.add("is-stuck");
    var statusEl = byId("boot-status");
    if (statusEl) {
      statusEl.textContent = "启动超时：可继续等待、重新加载，或复制诊断信息。";
    }
    reportTimeout();
  }, TIMEOUT_MS);
})();
