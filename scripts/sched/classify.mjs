//! 构建任务分类：按命令**及其调用链**决定资源等级，不靠「命令里有没有 build」这种字面判断。
//!
//! 等级：light（静态检查/小范围测试）、medium（Vite 构建、Rust 局部检查、全量单测）、
//!      heavy（完整编译、Tauri 打包、Gradle、大型集成测试、组合构建）、
//!      dev（长期运行的开发服务器）。
//!
//! 关键设计：
//!   1) `npm run <script>` / `npm test` 会到 package.json 里展开脚本体再做判定，
//!      因此 `npm run build` → `npm run build:raw` → `tsc --noEmit && vite build` 会被识别为组合构建；
//!   2) 多个子命令（`&&`、`;`、npm 的 `run-s`）取**最高**等级，避免把组合命令判轻；
//!   3) 未识别命令按 conservative 策略落到 heavy，并在 reason 里说明；
//!   4) `--class` 显式指定永远优先，用于覆盖误判（并在历史记录里留下 override 痕迹）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLASS_RANK = { light: 0, medium: 1, heavy: 2, dev: 0 };
export const CLASSES = ["light", "medium", "heavy", "dev"];

function worst(a, b) {
  const ra = CLASS_RANK[a] ?? 1;
  const rb = CLASS_RANK[b] ?? 1;
  return ra >= rb ? a : b;
}

function stripPath(arg) {
  return String(arg).replace(/^["']|["']$/g, "").replace(/\\/g, "/");
}

function baseName(arg) {
  const p = stripPath(arg);
  return p.slice(p.lastIndexOf("/") + 1);
}

/** 拆分复合命令（`a && b`、`a ; b`、`a | b`），只用于分类，不参与执行。 */
export function splitCommandLine(line) {
  const parts = String(line ?? "").split(/\s*(?:&&|\|\||;|\|)\s*/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function tokenize(part) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let m;
  while ((m = re.exec(part)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function packageScripts(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    return pkg && typeof pkg.scripts === "object" ? pkg.scripts : null;
  } catch { return null; }
}

const LIGHT_TOOLS = new Set([
  "eslint", "prettier", "stylelint", "tsc-check-one", "biome", "oxlint",
  "build-guard.mjs", "worktree-guard.mjs", "gen-icons.mjs", "check-entry-css.mjs",
  "rail-contract.mjs", "entryCssScope.mjs",
]);

/**
 * 分类一条 argv。
 * @param {string[]} argv 至少含命令名
 * @param {{cwd?:string, explicitClass?:string|null, depth?:number}} opts
 * @returns {{taskClass:string, reason:string, rule:string}}
 */
export function classifyArgv(argv, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.explicitClass && CLASSES.includes(opts.explicitClass)) {
    return {
      taskClass: opts.explicitClass,
      reason: `显式指定 --class ${opts.explicitClass}`,
      rule: "explicit",
    };
  }
  return classifyTokens(argv, cwd, opts.depth ?? 0);
}

function classifyTokens(argv, cwd, depth) {
  const cmdRaw = argv[0] ?? "";
  const cmd = baseName(cmdRaw).replace(/\.(cmd|exe|bat|ps1|sh)$/i, "").toLowerCase();
  const args = argv.slice(1);
  const joined = argv.map(stripPath).join(" ");
  const explicitUnknown = (reason) => ({ taskClass: "heavy", reason, rule: "conservative-default" });

  if (!cmd) return explicitUnknown("空命令，按保守策略归为重型");

  // ---- 包管理器脚本：展开 package.json 的脚本体
  if (["npm", "pnpm", "yarn"].includes(cmd)) {
    const sub = args[0];
    if (sub === "run" || sub === "run-script") {
      const name = args[1];
      if (!name) return { taskClass: "light", reason: `${cmd} run 未指定脚本名（会直接报错）`, rule: "npm-run-noscript" };
      // `npm run <script> <参数...>`：脚本名之后的实参会透传给脚本体执行（例如 tauri:raw dev），
      // 分类必须把这段参数接回脚本体，否则 `tauri dev` 会退化成 `tauri` 被当成未识别。
      return classifyNpmScript(name, cwd, depth, cmd, args.slice(2));
    }
    if (sub === "test" || sub === "t") {
      return classifyNpmScript("test", cwd, depth, cmd);
    }
    if (sub === "exec" || sub === "x") {
      return classifyTokens(args.slice(1), cwd, depth);
    }
    if (sub === "ci" || sub === "install" || sub === "i" || sub === "add") {
      return { taskClass: "medium", reason: `${cmd} ${sub}：依赖安装会写 node_modules（可能触发脚本与网络 I/O）`, rule: "npm-install" };
    }
    return { taskClass: "medium", reason: `${cmd} ${sub ?? ""} 未识别，按中型处理`, rule: "npm-unknown" };
  }

  if (cmd === "npx" || cmd === "bunx") {
    // npx <tool> ... : 去掉可能存在的 --no-install 等前缀参数
    const rest = args.filter((a) => a !== "--no-install" && a !== "--yes" && a !== "-y");
    if (rest.length === 0) return explicitUnknown("npx 无目标命令");
    return classifyTokens(rest, cwd, depth);
  }

  // ---- Node 脚本：本仓库 scripts/*.mjs
  if (cmd === "node") {
    if (args.includes("-e") || args.includes("--eval") || args.includes("-p") || args.includes("--print")) {
      return { taskClass: "light", reason: "node -e：内联脚本，无构建产物", rule: "node-eval" };
    }
    const first = args.find((a) => !a.startsWith("-")) ?? "";
    const script = baseName(first);
    if (LIGHT_TOOLS.has(script)) {
      return { taskClass: "light", reason: `node ${script}：仓库内轻量工具脚本`, rule: "node-light" };
    }
    if (script === "make-preview.mjs" || script === "visual-audit.mjs" || script === "layout-regression.mjs") {
      return { taskClass: "medium", reason: `node ${script}：浏览器/预览渲染脚本，内存中等到偏高`, rule: "node-preview" };
    }
    if (script.startsWith("serve-preview") || script.startsWith("native-cdp")) {
      return { taskClass: "dev", reason: `node ${script}：本地服务/调试进程`, rule: "node-dev" };
    }
    if (/gate-|memory-|perf|acceptance/i.test(script)) {
      return { taskClass: "heavy", reason: `node ${script}：性能/门禁类脚本，视为重型`, rule: "node-perf" };
    }
    return { taskClass: "medium", reason: `node ${script || "(内联)"}：未登记的脚本，按中型保守处理`, rule: "node-unknown" };
  }

  if (cmd === "vitest") return classifyVitest(args);
  if (cmd === "tsc") return classifyTsc(args);
  if (cmd === "eslint" || cmd === "prettier") {
    return { taskClass: "light", reason: `${cmd}：只读分析与格式化检查`, rule: `${cmd}-light` };
  }
  if (cmd === "vite") {
    if (args.includes("build")) return { taskClass: "medium", reason: "vite build：前端构建（Babel/esbuild + Rollup）", rule: "vite-build" };
    if (args.length === 0 || args.includes("dev") || args.includes("serve")) {
      return { taskClass: "dev", reason: "vite dev：长期运行的开发服务器", rule: "vite-dev" };
    }
    // `vite preview` 是**长期运行**的静态预览服务（不 Ctrl+C 就不退出），按 light 归类会让它
    // 占轻量槽位、并能与另一条轻量任务同时拉起两个预览服务（抢端口）。归 dev 与 `dev` 一致。
    if (args.includes("preview")) {
      return { taskClass: "dev", reason: "vite preview：长期运行的预览服务（与 dev 同槽位约束）", rule: "vite-preview" };
    }
    return { taskClass: "light", reason: `vite ${args.join(" ")}：非构建子命令`, rule: "vite-other" };
  }

  if (cmd === "cargo") return classifyCargo(args);
  if (cmd === "rustc") return { taskClass: "medium", reason: "rustc 单文件编译", rule: "rustc" };
  if (cmd === "tauri" || /@tauri-apps[/\\]cli/.test(joined)) return classifyTauri(args);
  if (cmd === "gradle" || cmd === "gradlew" || cmd === "gradlew.bat") {
    return { taskClass: "heavy", reason: "Gradle 构建：会启动 Gradle/Kotlin 编译守护进程", rule: "gradle" };
  }
  if (cmd === "adb" || cmd === "expo" || cmd === "eas") {
    if (["build", "run:android", "run:ios", "prebuild"].includes(args[0])) {
      return { taskClass: "heavy", reason: `${cmd} ${args[0]}：移动端完整构建`, rule: `${cmd}-build` };
    }
    return { taskClass: "dev", reason: `${cmd} ${args[0] ?? ""}：移动端开发/调试进程`, rule: `${cmd}-dev` };
  }
  if (["powershell", "pwsh"].includes(cmd)) {
    const script = args.find((a) => /\.ps1$/i.test(a)) ?? "";
    if (/capture|native-verify|notification-focus|corner|visual/i.test(script)) {
      return { taskClass: "medium", reason: `${baseName(script)}：原生窗口取证脚本`, rule: "ps-native" };
    }
    if (/watch-dev-processes/i.test(script)) {
      return { taskClass: "light", reason: `${baseName(script)}：只读进程观察`, rule: "ps-watch" };
    }
    return { taskClass: "medium", reason: "PowerShell 脚本未识别，按中型处理", rule: "ps-unknown" };
  }
  if (cmd === "git") {
    return { taskClass: "light", reason: "git 只读/元数据命令", rule: "git" };
  }
  if (cmd.startsWith("build-guard") || cmd.startsWith("worktree-guard")) {
    return { taskClass: "light", reason: `${cmd}：仓库内轻量工具`, rule: "guard" };
  }

  // 形如 `tsc && vite build` 被当作单个可执行串时，按子命令拆开取最高等级
  if (/\s|&&/.test(cmdRaw)) {
    const sub = splitCommandLine(cmdRaw).flatMap((p) => {
      const t = tokenize(p);
      return t.length ? [classifyTokens(t, cwd, depth)] : [];
    });
    if (sub.length) {
      const best = sub.reduce((acc, cur) => (CLASS_RANK[cur.taskClass] >= CLASS_RANK[acc.taskClass] ? cur : acc), sub[0]);
      return { ...best, reason: `组合命令，最高等级取自「${best.reason}」`, rule: "composite" };
    }
  }

  return explicitUnknown(
    `${cmd} 未在分类表中登记，按保守策略归为重型（避免把高内存任务误判为轻量）；如确认开销较小，请用 --class 覆盖`,
  );
}

function classifyNpmScript(name, cwd, depth, pkgCmd, extraArgs = []) {
  const scripts = packageScripts(cwd);
  if (!scripts) {
    return { taskClass: "medium", reason: `${pkgCmd} run ${name}：读不到 package.json，按中型处理`, rule: "npm-script-unknown-pkg" };
  }
  const body = scripts[name];
  if (!body) {
    return { taskClass: "medium", reason: `${pkgCmd} run ${name}：package.json 中无此脚本`, rule: "npm-script-missing" };
  }
  if (depth > 3) {
    return { taskClass: "medium", reason: `脚本链 ${name} 递归过深，按中型处理`, rule: "npm-script-depth" };
  }
  const parts = splitCommandLine(body);
  if (parts.length === 0) {
    return { taskClass: "light", reason: `脚本 ${name} 为空`, rule: "npm-script-empty" };
  }
  // 透传实参只接在脚本体最后一段命令上（npm 把参数追加给脚本的最终命令）
  const passedArgs = extraArgs.filter((a) => a !== "--");
  if (passedArgs.length) {
    parts[parts.length - 1] = `${parts[parts.length - 1]} ${passedArgs.join(" ")}`;
  }
  let best = null;
  for (const part of parts) {
    const tokens = tokenize(part);
    if (!tokens.length) continue;
    const r = classifyTokens(tokens, cwd, depth + 1);
    if (!best || CLASS_RANK[r.taskClass] > CLASS_RANK[best.taskClass]) best = r;
  }
  if (!best) return { taskClass: "light", reason: `脚本 ${name} 无法解析`, rule: "npm-script-unparsed" };
  return {
    taskClass: best.taskClass,
    reason: `${pkgCmd} run ${name} → 「${body}」→ ${best.reason}`,
    rule: `npm-script:${best.rule}`,
  };
}

function classifyCargo(args) {
  const sub = args[0] ?? "build";
  const has = (flag) => args.includes(flag);
  if (sub === "fmt") return { taskClass: "light", reason: "cargo fmt：只读格式检查", rule: "cargo-fmt" };
  if (sub === "metadata" || sub === "tree" || sub === "locate-project" || sub === "pkgid") {
    return { taskClass: "light", reason: `cargo ${sub}：仅解析元数据`, rule: `cargo-${sub}` };
  }
  if (sub === "check") {
    if (has("--release")) {
      return { taskClass: "heavy", reason: "cargo check --release：release 依赖树完整编译", rule: "cargo-check-release" };
    }
    return { taskClass: "medium", reason: "cargo check：Rust 局部检查（仍会编译依赖）", rule: "cargo-check" };
  }
  if (sub === "clippy") {
    return has("--release") || has("--all-targets")
      ? { taskClass: "heavy", reason: "cargo clippy --all-targets/--release：全目标重新编译", rule: "cargo-clippy-heavy" }
      : { taskClass: "medium", reason: "cargo clippy：局部 lint 编译", rule: "cargo-clippy" };
  }
  if (sub === "test" || sub === "nextest" || sub === "bench") {
    const filtered = args.some((a) => !a.startsWith("-") && a !== "test" && a !== "nextest" && a !== "bench");
    const allTargets = has("--all-targets") || has("--workspace") || has("--all");
    if (has("--release")) {
      return { taskClass: "heavy", reason: `cargo ${sub} --release：release 全量编译 + 测试`, rule: "cargo-test-release" };
    }
    if (!filtered && !allTargets) {
      return { taskClass: "heavy", reason: `cargo ${sub}：全量编译全部测试目标（本仓库体量属重型）`, rule: "cargo-test-full" };
    }
    return { taskClass: "medium", reason: `cargo ${sub} ${filtered ? `（已限定目标：${args.filter((a) => !a.startsWith("-")).slice(1).join(" ")}）` : ""}：中型测试`, rule: "cargo-test-partial" };
  }
  if (sub === "build" || sub === "run" || sub === "install") {
    if (has("--release")) return { taskClass: "heavy", reason: `cargo ${sub} --release：release 完整编译（LTO 链接耗时长）`, rule: "cargo-release" };
    return { taskClass: "heavy", reason: `cargo ${sub}：dev 完整编译（首次数分钟）`, rule: "cargo-build" };
  }
  if (sub === "clean") {
    return { taskClass: "heavy", reason: "cargo clean：删除整个缓存，后续构建全部冷启动（禁止随手执行）", rule: "cargo-clean" };
  }
  if (sub === "doc") return { taskClass: "medium", reason: "cargo doc：编译文档", rule: "cargo-doc" };
  return { taskClass: "medium", reason: `cargo ${sub} 未识别，按中型保守处理`, rule: "cargo-unknown" };
}

function classifyTauri(args) {
  const sub = args[0] ?? "";
  if (sub === "dev") return { taskClass: "dev", reason: "tauri dev：长期运行的开发服务器（会监管 Vite + Rust 编译）", rule: "tauri-dev" };
  if (sub === "build" || sub === "bundle") {
    return { taskClass: "heavy", reason: "tauri build：Rust release 编译 + 前端构建 + 打包", rule: "tauri-build" };
  }
  if (["android", "ios"].includes(sub)) {
    return { taskClass: "heavy", reason: `tauri ${sub}：移动端完整构建（Gradle/Xcode）`, rule: `tauri-${sub}` };
  }
  if (sub === "info" || sub === "icon" || sub === "--version" || sub === "-V") {
    return { taskClass: "light", reason: `tauri ${sub}：只读/轻量操作`, rule: "tauri-light" };
  }
  return { taskClass: "medium", reason: `tauri ${sub} 未识别，按中型处理`, rule: "tauri-unknown" };
}

function classifyTsc(args) {
  const files = args.filter((a) => !a.startsWith("-") && !a.startsWith("--"));
  if (files.length > 0) {
    return { taskClass: "light", reason: `tsc ${files.join(" ")}：单文件/局部类型检查`, rule: "tsc-partial" };
  }
  return { taskClass: "medium", reason: "tsc --noEmit：整工程类型检查（会领用 tsbuildinfo 缓存）", rule: "tsc-full" };
}

function classifyVitest(args) {
  const hasRun = args.includes("run") || args.length === 0;
  const positional = args.filter((a) => !a.startsWith("-") && a !== "run" && a !== "watch");
  if (args.includes("watch")) return { taskClass: "dev", reason: "vitest watch：长期运行进程", rule: "vitest-watch" };
  if (positional.length > 0) {
    return { taskClass: "light", reason: `vitest ${positional.join(" ")}：指定用例的局部测试`, rule: "vitest-partial" };
  }
  if (args.includes("--coverage")) {
    return { taskClass: "medium", reason: "vitest --coverage：全量单测 + 覆盖率插桩", rule: "vitest-coverage" };
  }
  return { taskClass: "medium", reason: hasRun ? "vitest run：全量前端单测" : "vitest：全量前端单测", rule: "vitest-full" };
}

/** 分类一条命令行字符串（用于从日志/脚本文本里推断）。 */
export function classifyCommandLine(line, opts = {}) {
  const parts = splitCommandLine(line);
  let best = null;
  for (const part of parts) {
    const tokens = tokenize(part);
    if (!tokens.length) continue;
    const r = classifyArgv(tokens, opts);
    if (!best || CLASS_RANK[r.taskClass] > CLASS_RANK[best.taskClass]) best = r;
  }
  return best ?? { taskClass: "heavy", reason: "空命令行，按保守策略归为重型", rule: "empty" };
}
