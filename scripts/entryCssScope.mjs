// 入口 CSS 作用域检查（共享工具）：
// `vite.config.ts` 关闭了 CSS 拆分（cssCodeSplit: false），六个入口共享同一份
// 打包 CSS。**任何无作用域的 html / body / #root 布局规则都会同时作用到主窗**，
// 历史故障：tab-hint 页的 `#root{position:absolute;display:flex}` 把主窗
// `.dock-window` 压成 0 宽，右/上/下停靠的标签被排到窗口之外。
//
// 这里提供一个小型 CSS 解析器（够用即可，不引依赖）：
//   parseCssRules(css) → [{ selector, declarations, atPath }]
// findUnscopedRootLayoutRules(rules) → 返回「裸根选择器 + 布局模型属性」的违规清单。
//
// 覆盖范围说明：本检查针对**改变根节点布局模型**的规则（position/display/flex/
// inset/…）。纯主题色、字号等不改变盒模型的规则不属于此类故障。

const FORBIDDEN_PROPS = new Set([
  "position",
  "display",
  "inset",
  "inset-block",
  "inset-inline",
  "top",
  "right",
  "bottom",
  "left",
  "float",
  "transform",
  "flex",
  "flex-direction",
  "flex-flow",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "align-self",
  "align-content",
  "justify-content",
  "justify-items",
  "justify-self",
  "grid",
  "grid-area",
  "grid-template",
  "grid-template-areas",
  "grid-template-columns",
  "grid-template-rows",
  "place-items",
  "place-content",
  "place-self",
  "gap",
  "row-gap",
  "column-gap",
  "columns",
  "column-span",
]);

/** 跳过内容块（这些 at 规则内部的「选择器」不是选择器）。 */
const SKIP_INNER = new Set(["keyframes", "font-face", "counter-style", "property", "page"]);

/** 解析 CSS 文本为规则列表（不做完整 CSS 解析，只保证覆盖本仓库的写法）。 */
export function parseCssRules(css) {
  const rules = [];
  const stack = []; // 未闭合的 at 规则前缀（如 "@media (…)"）
  let buffer = "";
  let depth = 0;
  let inComment = false;
  let inString = null;

  const flushRule = (selector, declText, atPath) => {
    const declarations = [];
    for (const decl of declText.split(";")) {
      const idx = decl.indexOf(":");
      if (idx <= 0) continue;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const value = decl.slice(idx + 1).trim();
      if (prop && value) declarations.push([prop, value]);
    }
    if (declarations.length > 0) {
      rules.push({ selector: selector.trim(), declarations, atPath });
    }
  };

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    const next = css[i + 1];
    if (inComment) {
      if (ch === "*" && next === "/") {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      buffer += ch;
      if (ch === inString && css[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === "/" && next === "*") {
      inComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      buffer += ch;
      continue;
    }
    if (ch === "{") {
      const prelude = buffer.trim();
      buffer = "";
      depth += 1;
      if (prelude.startsWith("@")) {
        const atName = prelude.slice(1).split(/[\s(]/)[0].toLowerCase();
        stack.push({ prelude, atName, isBlock: true });
        // @keyframes / @font-face 的内容块不是规则列表
        if (SKIP_INNER.has(atName)) {
          // 直接吞到匹配的闭括号
          let inner = 1;
          while (i + 1 < css.length && inner > 0) {
            i += 1;
            if (css[i] === "{") inner += 1;
            else if (css[i] === "}") inner -= 1;
          }
          depth -= 1;
          stack.pop();
          buffer = "";
        }
      } else {
        stack.push({ prelude, atName: null, isBlock: false });
      }
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      const frame = stack.pop();
      if (frame && frame.isBlock === false) {
        // 这是一个普通规则块：prelude 是选择器，buffer 是声明
        const selector = frame.prelude;
        const atPath = stack.filter((f) => f.isBlock).map((f) => f.prelude);
        const innerKeyframe = atPath.some((p) =>
          SKIP_INNER.has(p.slice(1).split(/[\s(]/)[0].toLowerCase()),
        );
        if (!innerKeyframe) flushRule(selector, buffer, atPath);
      }
      buffer = "";
      continue;
    }
    if (ch === ";" && depth === 0) {
      // 语句型 at 规则（@import / @charset / @layer 声明）
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  return rules;
}

/** 选择器是否是「裸根」：单个 html / body / #root / * 复合选择器（可有伪类，不能带类/属性）。 */
export function isBareRootSelector(selector) {
  const s = selector.trim();
  if (/[\s>+~,]/.test(s)) return false; // 有组合器/列表 → 不是单个复合选择器
  const stripped = s
    .replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, "") // 去伪类/伪元素
    .trim();
  return /^(html|body|\#root|\*)$/.test(stripped);
}

/**
 * 找出「裸根选择器 + 布局模型属性」的违规规则。
 * 返回 [{ file?, selector, props, atPath }]。
 */
export function findUnscopedRootLayoutRules(rules, file = "") {
  const found = [];
  for (const rule of rules) {
    if (!isBareRootSelector(rule.selector)) continue;
    const props = rule.declarations
      .filter(([prop]) => FORBIDDEN_PROPS.has(prop))
      .map(([prop, value]) => `${prop}:${value}`);
    if (props.length > 0) {
      found.push({ file, selector: rule.selector, props, atPath: rule.atPath });
    }
  }
  return found;
}

export const ENTRY_CSS_FILES = [
  "src/styles.css",
  "src/styles-themes.css",
  "src/context-menu/styles-context-menu.css",
  "src/notifications/styles-notifications.css",
  "src/capture/styles-capture.css",
  "src/tab-hint/styles-tab-hint.css",
  "src/widgets/widgets-desktop.css",
];
