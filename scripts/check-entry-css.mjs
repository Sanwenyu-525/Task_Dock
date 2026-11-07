// 打包产物上的入口 CSS 作用域复查（在 `npm run build` 之后运行）。
//
// 单测（src/styles-entry-scope.test.ts）守卫源码；本脚本守卫**实际交付**的
// dist/assets/*.css：六入口合并后，确认没有无作用域的根节点布局规则混进
// 共享样式表，并确认 tab-hint 的作用域规则真实存在。
//
// 用法：node scripts/check-entry-css.mjs [distDir]
// 退出码 0 = 通过；1 = 存在违规（并打印违规规则）。

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { findUnscopedRootLayoutRules, parseCssRules } from "./entryCssScope.mjs";

const distDir = process.argv[2] || "dist";
const assetsDir = join(distDir, "assets");

if (!existsSync(assetsDir)) {
  console.error(`CHECK-SKIPPED：未找到 ${assetsDir}（先执行 npm run build）`);
  process.exit(2);
}

const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".css"));
if (cssFiles.length === 0) {
  console.error(`CHECK-SKIPPED：${assetsDir} 内没有 CSS 产物`);
  process.exit(2);
}

const violations = [];
let ruleCount = 0;
let scopedHint = false;

for (const file of cssFiles) {
  const css = readFileSync(join(assetsDir, file), "utf8");
  const rules = parseCssRules(css);
  ruleCount += rules.length;
  for (const v of findUnscopedRootLayoutRules(rules, file)) {
    violations.push(`${file} → «${v.selector}» 声明了 ${v.props.join(", ")}`);
  }
  if (/html\.tab-hint-page\s*#root/.test(css)) scopedHint = true;
}

console.log(`扫描 ${cssFiles.length} 个打包 CSS / ${ruleCount} 条规则`);

if (!scopedHint) {
  violations.push("打包 CSS 中找不到 html.tab-hint-page #root（tab-hint 作用域规则丢失？）");
}

if (violations.length > 0) {
  console.error("CHECK-FAILED：入口 CSS 作用域违规");
  for (const v of violations) console.error("  - " + v);
  process.exit(1);
}

console.log("CHECK-PASSED：无裸根布局规则；tab-hint 作用域规则已在产物中");
