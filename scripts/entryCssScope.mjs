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

/**
 * 拆分逗号选择器列表：`html, body, #root` → `["html", "body", "#root"]`。
 * 括号/方括号/字符串内的逗号不是分隔符（`:is(a, b) .c` 仍是一个选择器）。
 */
export function splitSelectorList(selector) {
  const parts = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (quote) {
      current += ch;
      if (ch === quote && selector[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    else if ((ch === ")" || ch === "]") && depth > 0) depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/** 去掉括号/方括号内部内容（保留括号占位），用于只检查顶层的组合器与空白。 */
function stripParenthetical(input) {
  let out = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote && input[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") {
      depth += 1;
      continue;
    }
    if ((ch === ")" || ch === "]") && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * 选择器是否是「裸根」：单个 html / body / :root / #root / * 复合选择器
 * （可有伪类，不能带类/属性）。
 *
 * **必须传入单个选择器**：分组列表先经 `splitSelectorList` 拆分，逐个判断。
 * 否则 `html, .tab-hint-page #root` 会因为列表里有一个带作用域的选择器而整体放行。
 */
export function isBareRootSelector(selector) {
  const s = selector.trim();
  if (!s) return false;
  if (splitSelectorList(s).length > 1) return false; // 顶层逗号列表
  // 顶层组合器/后代空白 → 不是单个复合选择器（括号内的空白不算，如 :is(a, b)）
  if (/[\s>+~]/.test(stripParenthetical(s))) return false;
  // 独立的 :is(html, body) / :where(...) 等价于分组列表：递归判断内部选择器
  const functional = /^:(?:is|where|matches)\(([\s\S]*)\)$/i.exec(s);
  if (functional) {
    return splitSelectorList(functional[1]).some(isBareRootSelector);
  }
  if (/^:root$/i.test(s)) return true; // :root 就是 html
  const stripped = s
    .replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, "") // 去伪类/伪元素
    .trim();
  return /^(html|body|\#root|\*)$/i.test(stripped); // 标签名大小写不敏感（CSS 语义）
}

/**
 * 找出「裸根选择器 + 布局模型属性」的违规规则。
 * 分组选择器逐项判断：一条规则里出现一个裸根就报一条，不因同组其他选择器
 * 已限定作用域而放行。返回 [{ file, selector, props, atPath, list? }]，
 * `selector` 是实际命中的单个选择器，`list` 是它来自的分组原文（仅分组时存在）。
 */
export function findUnscopedRootLayoutRules(rules, file = "") {
  const found = [];
  for (const rule of rules) {
    const props = rule.declarations
      .filter(([prop]) => FORBIDDEN_PROPS.has(prop))
      .map(([prop, value]) => `${prop}:${value}`);
    if (props.length === 0) continue;
    const parts = splitSelectorList(rule.selector);
    for (const part of parts) {
      if (!isBareRootSelector(part)) continue;
      found.push({
        file,
        selector: part,
        props,
        atPath: rule.atPath,
        ...(parts.length > 1 ? { list: rule.selector.trim() } : {}),
      });
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
