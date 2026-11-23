//! 轻量语法高亮：单遍扫描、按行 token 化，只产出「文本 + 语义类」数据。
//!
//! 设计边界（刻意不做 IDE 级解析）：
//! - 不建语法树、不做类型推断；函数名 = 紧跟 `(` 的标识符，类型名 = 大写开头的标识符，
//!   属性名 = 紧跟在 `.` 后的标识符。这些都是**视觉提示**，不参与任何业务判断。
//! - 只为「有辨识价值」的 token 生成 span：关键字 / 字符串 / 数字 / 注释 / 函数 /
//!   类型 / 属性 / 布尔 / JSON key / 标签 / 属性名 / 选择器 / 多字符运算符。
//!   标点与单字符运算符保持正文色，避免每行几十个 span 把 DOM 放大一个量级。
//! - 跨行状态只有「块注释 / HTML 标签内 / CSS 块深度」三种，由调用方持有的
//!   `HighlightCursor` 承载；不做多行字符串（模板字符串整体按字符串着色）。
//! - 超过长度预算时返回 `degraded: true`，由调用方降级为纯文本，不在这里偷偷
//!   截断内容（截断会改变用户看到的文件）。

export type TokenClass =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "property"
  | "boolean"
  | "key"
  | "tag"
  | "attr"
  | "selector"
  | "operator"
  | "markup"
  | "emphasis"
  | "strike"
  | "link";

/** 一个 token：`cls === null` 表示正文（渲染为纯文本节点）。 */
export interface SourceToken {
  text: string;
  cls: TokenClass | null;
}

export type HighlightLanguage =
  | "ts"
  | "js"
  | "python"
  | "rust"
  | "json"
  | "yaml"
  | "toml"
  | "ini"
  | "css"
  | "html"
  | "xml"
  | "sql"
  | "shell"
  | "powershell"
  | "c"
  | "cpp"
  | "java"
  | "go"
  | "markdown"
  | "plain";

export interface HighlightCursor {
  inBlockComment: boolean;
  inTag: boolean;
  /** CSS/SCSS 花括号深度（决定 `a { color: red }` 里的属性名识别）。 */
  depth: number;
}

export function createHighlightCursor(): HighlightCursor {
  return { inBlockComment: false, inTag: false, depth: 0 };
}

const LANG_BY_EXT: Record<string, HighlightLanguage> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  py: "python",
  pyw: "python",
  rs: "rust",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  bat: "shell",
  cmd: "shell",
  ps1: "powershell",
  psm1: "powershell",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  java: "java",
  kt: "java",
  go: "go",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
};

/** 扩展名 → 高亮语言。未知扩展名归 `plain`（不猜、不乱染色）。 */
export function highlightLanguageOf(ext: string): HighlightLanguage {
  return LANG_BY_EXT[ext.toLowerCase()] ?? "plain";
}

const LANG_BY_NAME: Record<string, HighlightLanguage> = {
  ts: "ts",
  typescript: "ts",
  tsx: "ts",
  js: "js",
  javascript: "js",
  jsx: "js",
  node: "js",
  py: "python",
  python: "python",
  python3: "python",
  rs: "rust",
  rust: "rust",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  console: "shell",
  bat: "shell",
  cmd: "shell",
  ps1: "powershell",
  powershell: "powershell",
  pwsh: "powershell",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  java: "java",
  kotlin: "java",
  go: "go",
  golang: "go",
  md: "markdown",
  markdown: "markdown",
};

/** 代码块语言标识（```ts）→ 高亮语言；未知语言返回 `plain`。 */
export function highlightLanguageOfName(name: string): HighlightLanguage {
  const key = name.trim().toLowerCase();
  if (!key) return "plain";
  return LANG_BY_NAME[key] ?? LANG_BY_EXT[key] ?? "plain";
}

// ── 字符分类（避免逐字符正则，热点路径保持单遍扫描）─────────────────────

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentStart(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code > 127
  );
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || isDigit(code);
}

function pushToken(tokens: SourceToken[], text: string, cls: TokenClass | null): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.cls === cls) last.text += text;
  else tokens.push({ text, cls });
}

/** 多字符运算符：只收录「有语义辨识度」的，单字符 `=`/`+` 等留给正文色。 */
const MULTI_OPERATORS = [
  "===",
  "!==",
  ">>>",
  "=>",
  "->",
  "::",
  "??",
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "|>",
  "?.",
  "...",
];

/** 字符串读取：支持反斜杠转义；不跨行（每行独立扫描）。 */
function readString(line: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return line.length;
}

function readNumber(line: string, start: number): number {
  let i = start;
  if (line[i] === "0" && (line[i + 1] === "x" || line[i + 1] === "X" || line[i + 1] === "b" || line[i + 1] === "B")) {
    i += 2;
    while (i < line.length && (isDigit(line.charCodeAt(i)) || /[a-fA-F_]/.test(line[i]))) i += 1;
    return i;
  }
  while (i < line.length && (isDigit(line.charCodeAt(i)) || line[i] === "_")) i += 1;
  if (line[i] === "." && isDigit(line.charCodeAt(i + 1))) {
    i += 1;
    while (i < line.length && (isDigit(line.charCodeAt(i)) || line[i] === "_")) i += 1;
  }
  if (line[i] === "e" || line[i] === "E") {
    const sign = line[i + 1] === "+" || line[i + 1] === "-" ? 1 : 0;
    if (isDigit(line.charCodeAt(i + 1 + sign))) {
      i += 1 + sign;
      while (i < line.length && isDigit(line.charCodeAt(i))) i += 1;
    }
  }
  return i;
}

function prevNonSpace(line: string, index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (line[i] !== " " && line[i] !== "\t") return line[i];
  }
  return "";
}

function nextNonSpace(line: string, index: number): number {
  let i = index;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  return i;
}

// ── 语言词表 ────────────────────────────────────────────────────────────

interface Grammar {
  keywords: Set<string>;
  types: Set<string>;
  booleans: Set<string>;
  lineComment: string[];
  block?: [string, string];
  quotes: string[];
  caseInsensitive?: boolean;
}

function words(raw: string): Set<string> {
  return new Set(raw.split(/\s+/).filter(Boolean));
}

const C_LIKE_KEYWORDS = words(`
  abstract as async await break case catch class const continue debugger declare default delete do else enum
  export extends finally for from function get if implements import in instanceof interface let namespace new
  of package private protected public readonly return set static super switch this throw try type typeof var
  void while with yield override satisfies keyof infer asserts is
`);

const C_LIKE_TYPES = words(`
  any unknown never string number boolean object symbol bigint true false null undefined void Array Promise Map Set
  Record Partial Readonly Pick Omit jQuery HTMLElement Element Event MouseEvent KeyboardEvent
`);

const PYTHON = words(`
  and as assert async await break class continue def del elif else except finally for from global if import in is
  lambda nonlocal not or pass raise return try while with yield match case self cls
`);

const RUST = words(`
  as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut
  pub ref return self Self static struct super trait type unsafe use where while yield macro_rules
`);

const RUST_TYPES = words(`
  i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc
  HashMap HashSet BTreeMap Path PathBuf Cow
`);

const JAVA = words(`
  abstract assert break case catch class continue default do else enum extends final finally for if implements
  import instanceof interface native new package private protected public return static strictfp super switch
  synchronized throw throws transient try volatile while record sealed permits var yield
`);

const GO = words(`
  break case chan const continue default defer else fallthrough for func go goto if import interface map
  package range return select struct switch type var nil
`);

const C = words(`
  auto break case char const continue default do double else enum extern float for goto if inline int long
  register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while
  include define ifdef ifndef endif pragma
`);

const SHELL = words(`
  if then else elif fi for while until do done case esac function in select time export local readonly declare
  unset shift return exit set unset trap source alias echo printf cd pwd test
`);

const POWERSHELL = words(`
  begin break catch class continue data define do dynamicparam else elseif end enum exit filter finally for
  foreach from function hidden if in param process return static switch throw trap try until using var while
  workflow
`);

const SQL = words(`
  select from where insert into values update set delete create table alter drop index view join left right
  inner outer full on as and or not null is in like between group by order having limit offset union all
  distinct case when then else end primary key foreign references default unique check constraint
`);

const TS: Grammar = {
  keywords: C_LIKE_KEYWORDS,
  types: C_LIKE_TYPES,
  booleans: words("true false null undefined"),
  lineComment: ["//"],
  block: ["/*", "*/"],
  quotes: ['"', "'", "`"],
};

const GRAMMARS: Partial<Record<HighlightLanguage, Grammar>> = {
  ts: TS,
  js: { ...TS, types: words("Array Promise Map Set Object String Number Boolean Date RegExp Error") },
  python: {
    keywords: PYTHON,
    types: words("int float str bool list dict set tuple bytes object Exception"),
    booleans: words("True False None"),
    lineComment: ["#"],
    quotes: ['"', "'"],
  },
  rust: {
    keywords: RUST,
    types: RUST_TYPES,
    booleans: words("true false"),
    lineComment: ["//"],
    block: ["/*", "*/"],
    quotes: ['"', "'"],
  },
  java: {
    keywords: JAVA,
    types: words("String Integer Long Double Float Boolean Object List Map Set"),
    booleans: words("true false null"),
    lineComment: ["//"],
    block: ["/*", "*/"],
    quotes: ['"', "'"],
  },
  go: {
    keywords: GO,
    types: words("string int int64 float64 bool byte rune error any"),
    booleans: words("true false nil"),
    lineComment: ["//"],
    block: ["/*", "*/"],
    quotes: ['"', "'", "`"],
  },
  c: {
    keywords: C,
    types: words("int char float double void long short unsigned signed size_t bool"),
    booleans: words("true false NULL"),
    lineComment: ["//"],
    block: ["/*", "*/"],
    quotes: ['"', "'"],
  },
  cpp: {
    keywords: words(`${[...C].join(" ")} class namespace template typename public private protected virtual override noexcept constexpr auto nullptr`),
    types: words("string vector map set unique_ptr shared_ptr size_t int32_t uint32_t"),
    booleans: words("true false nullptr NULL"),
    lineComment: ["//"],
    block: ["/*", "*/"],
    quotes: ['"', "'"],
  },
  shell: {
    keywords: SHELL,
    types: words("PATH HOME USER PWD"),
    booleans: words("true false"),
    lineComment: ["#"],
    quotes: ['"', "'"],
  },
  powershell: {
    keywords: POWERSHELL,
    types: words("string int bool array hashtable pscustomobject"),
    booleans: words("$true $false $null"),
    lineComment: ["#"],
    block: ["<#", "#>"],
    quotes: ['"', "'"],
  },
  sql: {
    keywords: SQL,
    types: words("int integer varchar text timestamp date boolean decimal numeric bigint json uuid"),
    booleans: words("true false null"),
    lineComment: ["--"],
    block: ["/*", "*/"],
    quotes: ["'", '"'],
    caseInsensitive: true,
  },
};

// ── 通用代码扫描 ────────────────────────────────────────────────────────

function scanCode(line: string, grammar: Grammar, cursor: HighlightCursor): SourceToken[] {
  const tokens: SourceToken[] = [];
  let i = 0;
  let plain = "";
  const flushPlain = () => {
    if (plain) {
      pushToken(tokens, plain, null);
      plain = "";
    }
  };

  while (i < line.length) {
    if (cursor.inBlockComment) {
      const terminator = grammar.block?.[1] ?? "*/";
      const end = line.indexOf(terminator, i);
      flushPlain();
      if (end < 0) {
        pushToken(tokens, line.slice(i), "comment");
        return tokens;
      }
      pushToken(tokens, line.slice(i, end + terminator.length), "comment");
      cursor.inBlockComment = false;
      i = end + terminator.length;
      continue;
    }

    const rest = line.slice(i);

    if (grammar.block && rest.startsWith(grammar.block[0])) {
      // 不跳过起始符：下一轮从这里开始找结束符，token 才能包含完整的起始符。
      flushPlain();
      cursor.inBlockComment = true;
      continue;
    }

    const lineComment = grammar.lineComment.find((marker) => rest.startsWith(marker));
    if (lineComment) {
      // SQL 的 `--` 与 PowerShell 的 `#` 都可能在字符串外出现；字符串分支在前，不会被吞。
      flushPlain();
      pushToken(tokens, rest, "comment");
      return tokens;
    }

    const ch = line[i];

    if (grammar.quotes.includes(ch)) {
      flushPlain();
      const end = readString(line, i, ch);
      pushToken(tokens, line.slice(i, end), "string");
      i = end;
      continue;
    }

    if (isDigit(line.charCodeAt(i)) || (ch === "." && isDigit(line.charCodeAt(i + 1)))) {
      flushPlain();
      const end = readNumber(line, i);
      pushToken(tokens, line.slice(i, end), "number");
      i = end;
      continue;
    }

    if (isIdentStart(line.charCodeAt(i))) {
      const start = i;
      i += 1;
      while (i < line.length && isIdentPart(line.charCodeAt(i))) i += 1;
      const word = line.slice(start, i);
      const lookup = grammar.caseInsensitive ? word.toLowerCase() : word;
      let cls: TokenClass | null = null;
      if (grammar.keywords.has(lookup)) cls = "keyword";
      else if (grammar.booleans.has(lookup)) cls = "boolean";
      else if (grammar.types.has(lookup)) cls = "type";
      else {
        const after = nextNonSpace(line, i);
        const before = prevNonSpace(line, start);
        // 大写开头 → 类型（含 `new Foo()` 构造调用）；小写紧跟 `(` → 函数调用。
        if (/^[A-Z][A-Za-z0-9_$]*$/.test(word) && word.length > 1) cls = "type";
        else if (line[after] === "(") cls = "function";
        else if (before === ".") cls = "property";
      }
      flushPlain();
      if (cls) pushToken(tokens, word, cls);
      else plain += word;
      continue;
    }

    const operator = MULTI_OPERATORS.find((candidate) => rest.startsWith(candidate));
    if (operator) {
      flushPlain();
      pushToken(tokens, operator, "operator");
      i += operator.length;
      continue;
    }

    plain += ch;
    i += 1;
  }

  flushPlain();
  return tokens;
}

// ── JSON / JSONC ────────────────────────────────────────────────────────

function scanJson(line: string, cursor: HighlightCursor): SourceToken[] {
  const tokens: SourceToken[] = [];
  let i = 0;
  let plain = "";
  const flushPlain = () => {
    if (plain) {
      pushToken(tokens, plain, null);
      plain = "";
    }
  };

  while (i < line.length) {
    if (cursor.inBlockComment) {
      const end = line.indexOf("*/", i);
      flushPlain();
      if (end < 0) {
        pushToken(tokens, line.slice(i), "comment");
        return tokens;
      }
      pushToken(tokens, line.slice(i, end + 2), "comment");
      cursor.inBlockComment = false;
      i = end + 2;
      continue;
    }
    const rest = line.slice(i);
    if (rest.startsWith("/*")) {
      flushPlain();
      cursor.inBlockComment = true;
      continue;
    }
    if (rest.startsWith("//")) {
      flushPlain();
      pushToken(tokens, rest, "comment");
      return tokens;
    }
    const ch = line[i];
    if (ch === '"') {
      flushPlain();
      const end = readString(line, i, '"');
      const text = line.slice(i, end);
      const after = nextNonSpace(line, end);
      pushToken(tokens, text, line[after] === ":" ? "key" : "string");
      i = end;
      continue;
    }
    if (isDigit(line.charCodeAt(i)) || ch === "-") {
      flushPlain();
      const end = readNumber(line, i + (ch === "-" ? 1 : 0));
      pushToken(tokens, line.slice(i, end), "number");
      i = end;
      continue;
    }
    if (isIdentStart(line.charCodeAt(i))) {
      const start = i;
      i += 1;
      while (i < line.length && isIdentPart(line.charCodeAt(i))) i += 1;
      const word = line.slice(start, i);
      flushPlain();
      if (word === "true" || word === "false" || word === "null") pushToken(tokens, word, "boolean");
      else plain += word;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flushPlain();
  return tokens;
}

// ── CSS ─────────────────────────────────────────────────────────────────

function scanCss(line: string, cursor: HighlightCursor): SourceToken[] {
  const tokens: SourceToken[] = [];
  let i = 0;
  let plain = "";
  const flushPlain = () => {
    if (plain) {
      pushToken(tokens, plain, null);
      plain = "";
    }
  };

  while (i < line.length) {
    if (cursor.inBlockComment) {
      const end = line.indexOf("*/", i);
      flushPlain();
      if (end < 0) {
        pushToken(tokens, line.slice(i), "comment");
        return tokens;
      }
      pushToken(tokens, line.slice(i, end + 2), "comment");
      cursor.inBlockComment = false;
      i = end + 2;
      continue;
    }
    const rest = line.slice(i);
    if (rest.startsWith("/*")) {
      flushPlain();
      cursor.inBlockComment = true;
      continue;
    }
    const ch = line[i];

    if (ch === '"' || ch === "'") {
      flushPlain();
      const end = readString(line, i, ch);
      pushToken(tokens, line.slice(i, end), "string");
      i = end;
      continue;
    }

    if (ch === "#" && /[0-9a-fA-F]/.test(line[i + 1] ?? "")) {
      flushPlain();
      let end = i + 1;
      while (end < line.length && /[0-9a-fA-F]/.test(line[end])) end += 1;
      pushToken(tokens, line.slice(i, end), "number");
      i = end;
      continue;
    }

    if (isDigit(line.charCodeAt(i))) {
      flushPlain();
      let end = readNumber(line, i);
      while (end < line.length && /[a-zA-Z%]/.test(line[end])) end += 1;
      pushToken(tokens, line.slice(i, end), "number");
      i = end;
      continue;
    }

    if (ch === "@" && isIdentStart(line.charCodeAt(i + 1))) {
      flushPlain();
      let end = i + 1;
      while (end < line.length && isIdentPart(line.charCodeAt(end))) end += 1;
      pushToken(tokens, line.slice(i, end), "keyword");
      i = end;
      continue;
    }

    if (isIdentStart(line.charCodeAt(i))) {
      const start = i;
      i += 1;
      while (i < line.length && isIdentPart(line.charCodeAt(i))) i += 1;
      const word = line.slice(start, i);
      const after = nextNonSpace(line, i);
      flushPlain();
      if (line[after] === ":" && cursor.depth > 0) pushToken(tokens, word, "property");
      else if (line[after] === "{" || cursor.depth === 0) pushToken(tokens, word, "selector");
      else plain += word;
      continue;
    }

    if (ch === "{") {
      cursor.depth += 1;
      plain += ch;
      i += 1;
      continue;
    }
    if (ch === "}") {
      cursor.depth = Math.max(0, cursor.depth - 1);
      plain += ch;
      i += 1;
      continue;
    }

    plain += ch;
    i += 1;
  }
  flushPlain();
  return tokens;
}

// ── HTML / XML ──────────────────────────────────────────────────────────

function scanHtml(line: string, cursor: HighlightCursor): SourceToken[] {
  const tokens: SourceToken[] = [];
  let i = 0;
  let plain = "";
  const flushPlain = () => {
    if (plain) {
      pushToken(tokens, plain, null);
      plain = "";
    }
  };

  while (i < line.length) {
    if (cursor.inBlockComment) {
      const end = line.indexOf("-->", i);
      flushPlain();
      if (end < 0) {
        pushToken(tokens, line.slice(i), "comment");
        return tokens;
      }
      pushToken(tokens, line.slice(i, end + 3), "comment");
      cursor.inBlockComment = false;
      i = end + 3;
      continue;
    }

    const rest = line.slice(i);
    if (rest.startsWith("<!--")) {
      // 与代码块注释一致：起始符留给下一轮一起输出，避免丢字符。
      flushPlain();
      cursor.inBlockComment = true;
      continue;
    }

    const ch = line[i];

    if (cursor.inTag) {
      if (ch === ">") {
        cursor.inTag = false;
        plain += ch;
        i += 1;
        continue;
      }
      if (ch === "/" && line[i + 1] === ">") {
        cursor.inTag = false;
        plain += "/>";
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        flushPlain();
        const end = readString(line, i, ch);
        pushToken(tokens, line.slice(i, end), "string");
        i = end;
        continue;
      }
      if (isIdentStart(line.charCodeAt(i))) {
        const start = i;
        i += 1;
        while (i < line.length && (isIdentPart(line.charCodeAt(i)) || line[i] === "-" || line[i] === ":")) {
          i += 1;
        }
        flushPlain();
        pushToken(tokens, line.slice(start, i), "attr");
        continue;
      }
      plain += ch;
      i += 1;
      continue;
    }

    if (ch === "<") {
      const next = line[i + 1];
      if (next === "!" || next === "?" || next === "/" || isIdentStart(line.charCodeAt(i + 1))) {
        flushPlain();
        let j = i + 1;
        if (next === "/" || next === "!" || next === "?") j += 1;
        const nameStart = j;
        while (j < line.length && (isIdentPart(line.charCodeAt(j)) || line[j] === "-" || line[j] === ":")) j += 1;
        const name = line.slice(nameStart, j);
        plain += line.slice(i, nameStart);
        flushPlain();
        if (name) pushToken(tokens, name, "tag");
        i = j;
        cursor.inTag = true;
        continue;
      }
    }

    plain += ch;
    i += 1;
  }

  flushPlain();
  return tokens;
}

// ── YAML / TOML / INI ───────────────────────────────────────────────────

const YAML_BOOL = new Set(["true", "false", "yes", "no", "on", "off", "null", "~"]);

function scanKeyValue(line: string, language: "yaml" | "toml" | "ini", _cursor: HighlightCursor): SourceToken[] {
  const tokens: SourceToken[] = [];
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  if (i >= line.length) return [{ text: line, cls: null }];
  if (i > 0) pushToken(tokens, line.slice(0, i), null);

  const rest = line.slice(i);
  const commentMarker = language === "ini" ? ";" : "#";
  if (rest.startsWith(commentMarker) || (language === "yaml" && rest.startsWith("#"))) {
    pushToken(tokens, rest, "comment");
    return tokens;
  }

  if (rest.startsWith("[") && (language === "toml" || language === "ini")) {
    const end = rest.indexOf("]");
    if (end > 0) {
      pushToken(tokens, rest.slice(0, end + 1), "tag");
      pushToken(tokens, rest.slice(end + 1), null);
      return tokens;
    }
  }

  const listMatch = /^-(\s|$)/.exec(rest);
  if (listMatch) {
    pushToken(tokens, "-", "markup");
    pushToken(tokens, rest.slice(1), null);
    return tokens;
  }

  // 键：第一个不在引号内的 `:`（YAML）或 `=`（TOML/INI）。
  const separator = language === "yaml" ? ":" : "=";
  let quote: string | null = null;
  let sepIndex = -1;
  for (let k = 0; k < rest.length; k += 1) {
    const ch = rest[k];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === separator) {
      sepIndex = k;
      break;
    }
    if (ch === commentMarker && (k === 0 || rest[k - 1] === " ")) break;
  }
  if (sepIndex <= 0) {
    pushToken(tokens, rest, null);
    return tokens;
  }

  pushToken(tokens, rest.slice(0, sepIndex).trimEnd(), "key");

  // 值部分再按字符串/数字/布尔细分：只做「整体识别」，不拆表达式。
  const valueStart = sepIndex + 1;
  const rawValue = rest.slice(valueStart);
  const trimmed = rawValue.trim();
  const leading = rawValue.length - rawValue.trimStart().length;
  // 分隔符 + 键值之间的空白：与键分开，保持「键 : 值」的原始间距。
  pushToken(tokens, rest.slice(sepIndex, valueStart) + rawValue.slice(0, leading), null);
  if (!trimmed) return tokens;

  const first = trimmed[0];
  let cls: TokenClass | null = null;
  if (first === '"' || first === "'") cls = "string";
  else if (YAML_BOOL.has(trimmed.toLowerCase())) cls = "boolean";
  else if (/^[-+]?\d/.test(trimmed)) cls = "number";

  // 值后的行内注释（YAML/TOML 的 ` #`、INI 的 ` ;`）：引号内的不算。
  let valueText = trimmed;
  let commentText = "";
  if (first !== '"' && first !== "'") {
    const marker = language === "ini" ? ";" : "#";
    for (let k = 0; k < trimmed.length; k += 1) {
      if (trimmed[k] === marker && (k === 0 || trimmed[k - 1] === " ")) {
        valueText = trimmed.slice(0, k).trimEnd();
        // 连同值后的空白一起交给注释 token，保证 token 拼回去仍是原文。
        commentText = trimmed.slice(valueText.length);
        break;
      }
    }
    if (valueText !== trimmed) {
      cls = /^[-+]?\d/.test(valueText) ? "number" : YAML_BOOL.has(valueText.toLowerCase()) ? "boolean" : null;
    }
  }

  if (valueText) {
    if (cls) pushToken(tokens, valueText, cls);
    else pushToken(tokens, valueText, null);
  }
  if (commentText) pushToken(tokens, commentText, "comment");
  return tokens;
}

// ── Markdown 源码 ───────────────────────────────────────────────────────

function scanMarkdownInline(text: string, tokens: SourceToken[]): void {
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) {
      pushToken(tokens, plain, null);
      plain = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("`")) {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        pushToken(tokens, text.slice(i, end + 1), "string");
        i = end + 1;
        continue;
      }
    }
    const pair = rest.startsWith("**") ? "**" : rest.startsWith("__") ? "__" : rest.startsWith("~~") ? "~~" : null;
    if (pair) {
      const end = text.indexOf(pair, i + 2);
      if (end > i) {
        flush();
        pushToken(tokens, text.slice(i, end + 2), pair === "~~" ? "strike" : "emphasis");
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith("*") || rest.startsWith("_")) {
      const marker = rest[0];
      const end = text.indexOf(marker, i + 1);
      if (end > i + 1) {
        flush();
        pushToken(tokens, text.slice(i, end + 1), "emphasis");
        i = end + 1;
        continue;
      }
    }
    const link = /^!?\[[^\]]*\]\([^)\s]*\)/.exec(rest);
    if (link) {
      flush();
      pushToken(tokens, link[0], "link");
      i += link[0].length;
      continue;
    }
    plain += text[i];
    i += 1;
  }
  flush();
}

function scanMarkdownSource(line: string, _cursor: HighlightCursor): SourceToken[] {
  const tokens: SourceToken[] = [];
  const fence = /^(\s*)(```+|~~~+)(.*)$/.exec(line);
  if (fence) {
    pushToken(tokens, fence[1] + fence[2], "markup");
    if (fence[3]) pushToken(tokens, fence[3], "string");
    return tokens;
  }
  const heading = /^(\s*)(#{1,6})(\s+)(.*)$/.exec(line);
  if (heading) {
    pushToken(tokens, heading[1] + heading[2], "markup");
    pushToken(tokens, heading[3], null);
    scanMarkdownInline(heading[4], tokens);
    return tokens;
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    pushToken(tokens, line, "markup");
    return tokens;
  }
  const list = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/.exec(line);
  if (list) {
    pushToken(tokens, list[1] + list[2], "markup");
    pushToken(tokens, list[3], null);
    scanMarkdownInline(list[4], tokens);
    return tokens;
  }
  const quote = /^(\s*>+\s?)(.*)$/.exec(line);
  if (quote) {
    pushToken(tokens, quote[1], "markup");
    scanMarkdownInline(quote[2], tokens);
    return tokens;
  }
  scanMarkdownInline(line, tokens);
  return tokens;
}

// ── 入口 ────────────────────────────────────────────────────────────────

/** 单行 token 化。`cursor` 由调用方跨行持有（块注释/标签/花括号深度）。 */
export function tokenizeLine(
  line: string,
  language: HighlightLanguage,
  cursor: HighlightCursor,
): SourceToken[] {
  if (!line) return [];
  if (language === "plain") return [{ text: line, cls: null }];
  if (language === "json") return scanJson(line, cursor);
  if (language === "css") return scanCss(line, cursor);
  if (language === "html" || language === "xml") return scanHtml(line, cursor);
  if (language === "yaml" || language === "toml" || language === "ini") {
    return scanKeyValue(line, language, cursor);
  }
  if (language === "markdown") return scanMarkdownSource(line, cursor);
  const grammar = GRAMMARS[language];
  if (!grammar) return [{ text: line, cls: null }];
  return scanCode(line, grammar, cursor);
}

export interface HighlightResult {
  /** 与 `content.split("\n")` 一一对应；降级时为空数组。 */
  lines: SourceToken[][];
  degraded: boolean;
}

/**
 * 整段内容按行 token 化。超过 `maxChars` 直接降级（返回空行数组），
 * 由调用方显示「已关闭高亮」提示并保留纯文本内容。
 */
export function highlightSource(
  content: string,
  language: HighlightLanguage,
  maxChars: number,
): HighlightResult {
  if (!content) return { lines: [], degraded: false };
  if (content.length > maxChars) return { lines: [], degraded: true };
  const cursor = createHighlightCursor();
  const lines = content.split("\n").map((line) => tokenizeLine(line, language, cursor));
  return { lines, degraded: false };
}
