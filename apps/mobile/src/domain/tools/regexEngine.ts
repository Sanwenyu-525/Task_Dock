// 纯函数安全正则引擎：Thompson NFA 构造 + Pike VM 模拟，模拟阶段为线性时间
// （O(输入长度 × NFA 状态数)，任何输入下都不回溯爆炸）；不执行 JS RegExp，
// 前瞻/后顾/反向引用等需要上下文或回溯的构造在编译期直接拒绝。
// 本文件零依赖：不引入 react / react-native / expo-* / db / node 内置模块。

export const MAX_PATTERN_LENGTH = 200;
export const MAX_INPUT_LENGTH = 20000;
export const MAX_MATCHES = 500;

/** NFA 状态数硬上限（与任务口径一致：量词展开后总状态数 > 20000 判 too-long） */
const MAX_NFA_STATES = 20000;
/** 解析嵌套深度硬上限（分组/类嵌套 > 100 判 too-long） */
const MAX_PARSE_DEPTH = 100;

export type RegexFlags = { ignoreCase: boolean; multiline: boolean; dotAll: boolean };

export interface RegexMatch {
  start: number;
  end: number;
  text: string;
  /** groups[0] 对应捕获组 1；未参与匹配的组为 null */
  groups: (string | null)[];
}

export interface CompiledRegex {
  matchAll(text: string, limit: number): RegexMatch[];
  test(text: string): boolean;
}

export type RegexCompileResult =
  | { ok: true; regex: CompiledRegex }
  | { ok: false; code: "empty" | "too-long" | "unsupported" | "syntax"; message: string };

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

type Range = [number, number];
type PredefClass = "d" | "w" | "s";

type MatchKind =
  | { type: "literal"; code: number }
  | { type: "dot" }
  | { type: "class"; negated: boolean; ranges: Range[]; classes: PredefClass[] }
  | { type: "anchor"; kind: "start" | "end" };

type Ast =
  | { t: "empty" }
  | { t: "char"; match: MatchKind }
  | { t: "concat"; parts: Ast[] }
  | { t: "alt"; left: Ast; right: Ast }
  | { t: "repeat"; inner: Ast; min: number; max: number }
  | { t: "capture"; inner: Ast; index: number };

type FailCode = "too-long" | "unsupported" | "syntax";

class ParseError extends Error {
  readonly code: FailCode;
  readonly position: number;

  constructor(code: FailCode, message: string, position: number) {
    super(message);
    this.code = code;
    this.position = position;
  }
}

interface NfaState {
  /** ε 边（不消耗字符） */
  epsilon: number[];
  /** 字符边目标状态，-1 表示无字符边 */
  charNext: number;
  /** 交替分支的右分支目标，-1 表示不是交替入口状态 */
  altRight: number;
  match: MatchKind | null;
  accept: boolean;
  /** 捕获组起始标记，-1 表示无 */
  open: number;
  /** 捕获组结束标记，-1 表示无 */
  close: number;
  /** 量词入口：保存当前交替排名到排名栈 */
  pushRank: boolean;
  /** 量词出口：恢复量词入口保存的交替排名 */
  popRank: boolean;
}

interface Frag {
  start: number;
  end: number;
}

interface Thread {
  state: number;
  /** 本次匹配的起始码元位置 */
  start: number;
  /** 交替分支优先级：排名越小越优先（程序顺序，leftmost-first） */
  rank: number;
  /** 量词边界保存的交替排名栈（进入量词压栈，退出量词弹栈恢复） */
  rankStack: number[];
  starts: Array<number | null>;
  ends: Array<number | null>;
}

// ---------------------------------------------------------------------------
// 字符判定辅助（纯码元比较，不使用 JS RegExp）
// ---------------------------------------------------------------------------

const CODE_DIGIT_0 = 48;
const CODE_DIGIT_1 = 49;
const CODE_DIGIT_9 = 57;
const CODE_A = 65;
const CODE_Z = 90;
const CODE_LOW_A = 97;
const CODE_LOW_Z = 122;
const CODE_UNDERSCORE = 95;
const CODE_NEWLINE = 10;
const CODE_RETURN = 13;

function isDigitCode(code: number): boolean {
  return code >= CODE_DIGIT_0 && code <= CODE_DIGIT_9;
}

function inRange(code: number, range: Range): boolean {
  return code >= range[0] && code <= range[1];
}

function inPredef(cls: PredefClass, code: number): boolean {
  switch (cls) {
    case "d":
      return isDigitCode(code);
    case "w":
      return (
        isDigitCode(code) ||
        inRange(code, [CODE_A, CODE_Z]) ||
        inRange(code, [CODE_LOW_A, CODE_LOW_Z]) ||
        code === CODE_UNDERSCORE
      );
    case "s":
      return (
        code === 32 || // 空格
        code === 9 || // \t
        code === CODE_NEWLINE || // \n
        code === CODE_RETURN || // \r
        code === 12 || // \f
        code === 11 || // \v
        code === 160 ||
        code === 8232 ||
        code === 8233 ||
        code === 8239 ||
        code === 12288 ||
        code === 65279
      );
  }
}

function foldCode(code: number, ignoreCase: boolean): number {
  if (!ignoreCase) return code;
  if (code >= CODE_A && code <= CODE_Z) return code + 32;
  return code;
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

class Parser {
  private readonly src: string;
  private pos = 0;
  private depth = 0;
  groupCount = 0;

  constructor(src: string) {
    this.src = src;
  }

  get position(): number {
    return this.pos;
  }

  private peek(offset = 0): string | null {
    const i = this.pos + offset;
    return i < this.src.length ? this.src[i] : null;
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  get ended(): boolean {
    return this.atEnd();
  }

  private fail(code: FailCode, message: string, position: number): never {
    throw new ParseError(code, message, position);
  }

  parseAlternation(): Ast {
    const left = this.parseConcat();
    if (this.peek() === "|") {
      this.pos += 1;
      const right = this.parseAlternation();
      return { t: "alt", left, right };
    }
    return left;
  }

  private parseConcat(): Ast {
    const parts: Ast[] = [];
    while (!this.atEnd() && this.peek() !== "|" && this.peek() !== ")") {
      parts.push(this.parseQuantified());
    }
    if (parts.length === 0) return { t: "empty" };
    if (parts.length === 1) return parts[0];
    return { t: "concat", parts };
  }

  private parseQuantified(): Ast {
    const atom = this.parseAtom();
    const ch = this.peek();

    if (ch === "*" || ch === "+" || ch === "?") {
      this.pos += 1;
      const min = ch === "+" ? 1 : 0;
      const max = ch === "?" ? 1 : Number.POSITIVE_INFINITY;
      this.rejectQuantifierFollow();
      return { t: "repeat", inner: atom, min, max };
    }

    if (ch === "{") {
      const brace = this.tryParseBrace();
      if (brace) {
        this.rejectQuantifierFollow();
        return { t: "repeat", inner: atom, min: brace.min, max: brace.max };
      }
    }

    return atom;
  }

  /** 量词后再跟量词（如 a**、a*? 之外的堆叠）视为孤立量词语法错误 */
  private rejectQuantifierFollow(): void {
    const next = this.peek();
    if (next === "*" || next === "+" || next === "?" || next === "{") {
      this.fail("syntax", `位置 ${this.pos}: 量词后不允许再接量词`, this.pos);
    }
  }

  private tryParseBrace(): { min: number; max: number } | null {
    const start = this.pos;
    this.pos += 1; // 吞掉 '{'
    const minText = this.readDigits();
    if (minText === null) {
      this.pos = start;
      return null;
    }
    const min = Number(minText);
    if (!Number.isFinite(min)) {
      this.fail("syntax", `位置 ${start}: 量词 {n} 数字非法`, start);
    }

    let max: number = min;
    if (this.peek() === ",") {
      this.pos += 1;
      if (this.peek() === "}") {
        max = Number.POSITIVE_INFINITY;
      } else {
        const maxText = this.readDigits();
        if (maxText === null) {
          this.fail("syntax", `位置 ${this.pos}: 量词 {n,m} 缺少上界数字`, this.pos);
        }
        max = Number(maxText);
        if (!Number.isFinite(max)) {
          this.fail("syntax", `位置 ${start}: 量词 {n,m} 数字非法`, start);
        }
      }
    }

    if (this.peek() !== "}") {
      // 不是合法量词花括号：按字面量 '{' 处理
      this.pos = start;
      return null;
    }
    this.pos += 1;

    if (min > max) {
      this.fail("syntax", `位置 ${start}: 量词 {n,m} 中 n 大于 m`, start);
    }
    const expansion = max === Number.POSITIVE_INFINITY ? min : max;
    if (expansion > MAX_NFA_STATES) {
      this.fail(
        "too-long",
        `量词展开后总状态数 ${expansion} 超过上限 ${MAX_NFA_STATES}`,
        start,
      );
    }
    return { min, max };
  }

  private readDigits(): string | null {
    let text = "";
    while (this.peek() !== null && isDigitCode(this.peek()!.charCodeAt(0))) {
      text += this.peek();
      this.pos += 1;
    }
    return text === "" ? null : text;
  }

  private parseAtom(): Ast {
    const ch = this.peek();
    if (ch === "*" || ch === "+" || ch === "?") {
      this.fail("syntax", `位置 ${this.pos}: 孤立量词（量词前缺少匹配项）`, this.pos);
    }
    if (ch === "(") return this.parseGroup();
    if (ch === "[") return this.parseClass();
    if (ch === ".") {
      this.pos += 1;
      return { t: "char", match: { type: "dot" } };
    }
    if (ch === "^") {
      this.pos += 1;
      return { t: "char", match: { type: "anchor", kind: "start" } };
    }
    if (ch === "$") {
      this.pos += 1;
      return { t: "char", match: { type: "anchor", kind: "end" } };
    }
    if (ch === "\\") return this.parseEscape();
    if (ch === null) {
      this.fail("syntax", `位置 ${this.pos}: 表达式意外结束`, this.pos);
    }
    this.pos += 1;
    return { t: "char", match: { type: "literal", code: ch.charCodeAt(0) } };
  }

  private parseGroup(): Ast {
    const openPos = this.pos;
    this.pos += 1; // 吞掉 '('
    this.depth += 1;
    if (this.depth > MAX_PARSE_DEPTH) {
      this.fail("too-long", `分组嵌套深度超过上限 ${MAX_PARSE_DEPTH}`, openPos);
    }

    let capture = true;
    if (this.peek() === "?") {
      const markerPos = this.pos;
      this.pos += 1;
      const nxt = this.peek();
      if (nxt === ":") {
        // 非捕获分组 (?:...)：不占组号，本引擎予以支持
        this.pos += 1;
        capture = false;
      } else if (nxt === "=") {
        this.fail("unsupported", "前瞻 (?=...) 本引擎不支持", markerPos);
      } else if (nxt === "!") {
        this.fail("unsupported", "负向前瞻 (?!...) 本引擎不支持", markerPos);
      } else if (nxt === "<") {
        this.pos += 1;
        const after = this.peek();
        if (after === "=") {
          this.fail("unsupported", "后顾 (?<=...) 本引擎不支持", markerPos);
        }
        if (after === "!") {
          this.fail("unsupported", "负向后顾 (?<!...) 本引擎不支持", markerPos);
        }
        // 命名分组 (?<name>...)：跳过名字直到 '>'
        while (this.peek() !== null && this.peek() !== ">") this.pos += 1;
        this.fail("unsupported", "命名分组 (?<name>...) 本引擎不支持", markerPos);
      } else {
        this.fail("unsupported", "内联 flag (?...) 本引擎不支持", markerPos);
      }
    }

    // 组号先于内部解析分配，保证外层组号小于嵌套内层组号
    let index = -1;
    if (capture) {
      this.groupCount += 1;
      index = this.groupCount - 1;
    }

    const inner = this.parseAlternation();
    if (this.peek() !== ")") {
      this.fail("syntax", `位置 ${openPos}: 未闭合的分组 (`, openPos);
    }
    this.pos += 1;
    this.depth -= 1;

    if (!capture) return inner;
    return { t: "capture", inner, index };
  }

  private parseEscape(): Ast {
    const slashPos = this.pos;
    this.pos += 1; // 吞掉 '\'
    const c = this.peek();
    if (c === null) {
      this.fail("syntax", `位置 ${slashPos}: 末尾孤立的反斜杠`, slashPos);
    }
    this.pos += 1;

    switch (c) {
      case "t":
        return this.literalChar(9);
      case "n":
        return this.literalChar(10);
      case "r":
        return this.literalChar(13);
      case "v":
        return this.literalChar(11);
      case "f":
        return this.literalChar(12);
      case "0":
        return this.literalChar(0);
      case "d":
        return { t: "char", match: { type: "class", negated: false, ranges: [], classes: ["d"] } };
      case "w":
        return { t: "char", match: { type: "class", negated: false, ranges: [], classes: ["w"] } };
      case "s":
        return { t: "char", match: { type: "class", negated: false, ranges: [], classes: ["s"] } };
      case "D":
        return { t: "char", match: { type: "class", negated: true, ranges: [], classes: ["d"] } };
      case "W":
        return { t: "char", match: { type: "class", negated: true, ranges: [], classes: ["w"] } };
      case "S":
        return { t: "char", match: { type: "class", negated: true, ranges: [], classes: ["s"] } };
      case "b":
        this.fail("unsupported", "词边界 \\b 本引擎不支持", slashPos);
      case "B":
        this.fail("unsupported", "词边界 \\B 本引擎不支持", slashPos);
      case "p":
        this.fail("unsupported", "Unicode 属性类 \\p{...} 本引擎不支持", slashPos);
      case "P":
        this.fail("unsupported", "Unicode 属性类 \\P{...} 本引擎不支持", slashPos);
      default:
        break;
    }

    if (c !== null && isDigitCode(c.charCodeAt(0)) && c !== "0") {
      this.fail("unsupported", `反向引用 \\${c} 本引擎不支持`, slashPos);
    }

    // 转义的字面量标点与其它字符：按字面字符处理
    return this.literalChar(c.charCodeAt(0));
  }

  private literalChar(code: number): Ast {
    return { t: "char", match: { type: "literal", code } };
  }

  private parseClass(): Ast {
    const openPos = this.pos;
    this.pos += 1; // 吞掉 '['
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.pos += 1;
    }

    const ranges: Range[] = [];
    const classes: PredefClass[] = [];
    let first = true;

    while (true) {
      const c = this.peek();
      if (c === null) {
        this.fail("syntax", `位置 ${openPos}: 未闭合的字符类 [`, openPos);
      }
      if (c === "]" && !first) {
        this.pos += 1;
        break;
      }
      first = false;

      const atom = this.readClassAtom();

      if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== null) {
        this.pos += 1; // 吞掉 '-'
        const right = this.readClassAtom();
        if (atom.kind !== "literal" || right.kind !== "literal") {
          this.fail("syntax", `位置 ${openPos}: 字符类范围两端必须是字面字符`, openPos);
        }
        if (atom.code > right.code) {
          this.fail(
            "syntax",
            `位置 ${openPos}: 非法字符类范围 [${String.fromCharCode(atom.code)}-${String.fromCharCode(right.code)}]`,
            openPos,
          );
        }
        ranges.push([atom.code, right.code]);
      } else if (atom.kind === "literal") {
        ranges.push([atom.code, atom.code]);
      } else {
        classes.push(atom.cls);
      }
    }

    return { t: "char", match: { type: "class", negated, ranges, classes } };
  }

  private readClassAtom(): { kind: "literal"; code: number } | { kind: "predef"; cls: PredefClass } {
    const c = this.peek();
    if (c === null) {
      this.fail("syntax", `位置 ${this.pos}: 字符类意外结束`, this.pos);
    }
    if (c !== "\\") {
      this.pos += 1;
      return { kind: "literal", code: c!.charCodeAt(0) };
    }
    this.pos += 1; // 吞掉 '\'
    const esc = this.peek();
    if (esc === null) {
      this.fail("syntax", `位置 ${this.pos}: 字符类内末尾孤立的反斜杠`, this.pos);
    }
    this.pos += 1;
    switch (esc) {
      case "d":
        return { kind: "predef", cls: "d" };
      case "w":
        return { kind: "predef", cls: "w" };
      case "s":
        return { kind: "predef", cls: "s" };
      case "D":
        this.fail("unsupported", "字符类内 \\D 本引擎不支持（请使用 [^\\d]）", this.pos - 2);
      case "W":
        this.fail("unsupported", "字符类内 \\W 本引擎不支持（请使用 [^\\w]）", this.pos - 2);
      case "S":
        this.fail("unsupported", "字符类内 \\S 本引擎不支持（请使用 [^\\s]）", this.pos - 2);
      case "b":
        return { kind: "literal", code: 8 }; // \b 退格
      case "t":
        return { kind: "literal", code: 9 };
      case "n":
        return { kind: "literal", code: 10 };
      case "r":
        return { kind: "literal", code: 13 };
      case "v":
        return { kind: "literal", code: 11 };
      case "f":
        return { kind: "literal", code: 12 };
      case "0":
        return { kind: "literal", code: 0 };
      default:
        return { kind: "literal", code: esc!.charCodeAt(0) };
    }
  }
}

// ---------------------------------------------------------------------------
// NFA 构造
// ---------------------------------------------------------------------------

class Builder {
  readonly states: NfaState[] = [];

  private addState(): number {
    const id = this.states.length;
    this.states.push({
      epsilon: [],
      charNext: -1,
      altRight: -1,
      match: null,
      accept: false,
      open: -1,
      close: -1,
      pushRank: false,
      popRank: false,
    });
    return id;
  }

  build(ast: Ast): Frag {
    switch (ast.t) {
      case "empty": {
        const s = this.addState();
        return { start: s, end: s };
      }
      case "char": {
        const s = this.addState();
        const e = this.addState();
        this.states[s].match = ast.match;
        // 锚点是零宽断言，走 ε 边；其余匹配项走字符边
        if (ast.match.type === "anchor") {
          this.states[s].epsilon = [e];
        } else {
          this.states[s].charNext = e;
        }
        return { start: s, end: e };
      }
      case "concat": {
        const frags = ast.parts.map((part) => this.build(part));
        return this.concatFrags(frags);
      }
      case "alt": {
        const left = this.build(ast.left);
        const right = this.build(ast.right);
        const entry = this.addState();
        const exit = this.addState();
        // 左分支进常规 ε 边，右分支记到 altRight，运行时排名 +1（左优先）
        this.states[entry].epsilon = [left.start];
        this.states[entry].altRight = right.start;
        this.states[left.end].epsilon.push(exit);
        this.states[right.end].epsilon.push(exit);
        return { start: entry, end: exit };
      }
      case "capture": {
        const open = this.addState();
        const inner = this.build(ast.inner);
        const close = this.addState();
        this.states[open].open = ast.index;
        this.states[open].epsilon = [inner.start];
        this.states[inner.end].epsilon = [close];
        this.states[close].close = ast.index;
        return { start: open, end: close };
      }
      case "repeat":
        return this.buildRepeat(ast.inner, ast.min, ast.max);
    }
  }

  private concatFrags(frags: Frag[]): Frag {
    if (frags.length === 0) {
      const s = this.addState();
      return { start: s, end: s };
    }
    for (let i = 0; i < frags.length - 1; i += 1) {
      this.states[frags[i].end].epsilon.push(frags[i + 1].start);
    }
    return { start: frags[0].start, end: frags[frags.length - 1].end };
  }

  private buildRepeat(inner: Ast, min: number, max: number): Frag {
    // 量词入口保存交替排名、出口恢复：量词体内部的交替选择不影响
    // 整个量词匹配的优先级（内部左/右分支只作用于捕获组），保证贪心
    // 延续的长匹配不会被量词体内更早的右分支候选压过。
    const push = this.addState();
    const pop = this.addState();
    this.states[push].pushRank = true;
    this.states[pop].popRank = true;

    if (max === Number.POSITIVE_INFINITY) {
      if (min === 0) {
        const loop = this.build(inner);
        this.states[push].epsilon = [loop.start, pop];
        // 循环边排在退出边之前（贪心语义：先尝试继续重复，再退出）
        this.states[loop.end].epsilon = [loop.start, pop];
        return { start: push, end: pop };
      }

      const first = this.build(inner);
      let prevEnd = first.end;
      for (let i = 1; i < min; i += 1) {
        const body = this.build(inner);
        this.states[prevEnd].epsilon = [body.start];
        prevEnd = body.end;
      }
      this.states[prevEnd].epsilon = [first.start, pop];
      this.states[push].epsilon = [first.start];
      return { start: push, end: pop };
    }

    const bodies: Frag[] = [];
    for (let i = 0; i < min; i += 1) bodies.push(this.build(inner));
    for (let i = min; i < max; i += 1) {
      const body = this.build(inner);
      const entry = this.addState();
      const exit = this.addState();
      this.states[entry].epsilon = [body.start, exit];
      this.states[body.end].epsilon = [exit];
      bodies.push({ start: entry, end: exit });
    }
    for (let i = 0; i < bodies.length - 1; i += 1) {
      this.states[bodies[i].end].epsilon.push(bodies[i + 1].start);
    }
    this.states[push].epsilon = [bodies[0].start];
    this.states[bodies[bodies.length - 1].end].epsilon = [pop];
    return { start: push, end: pop };
  }
}

// ---------------------------------------------------------------------------
// Pike VM 模拟
// ---------------------------------------------------------------------------

class Runner {
  private readonly states: NfaState[];
  private readonly startState: number;
  private readonly groupCount: number;
  private readonly flags: RegexFlags;
  private text = "";

  constructor(states: NfaState[], startState: number, groupCount: number, flags: RegexFlags) {
    this.states = states;
    this.startState = startState;
    this.groupCount = groupCount;
    this.flags = flags;
  }

  matchAll(text: string, limit: number): RegexMatch[] {
    if (text.length > MAX_INPUT_LENGTH) {
      throw new RangeError("输入超过安全上限");
    }
    const cap = limit <= 0 ? 0 : Math.min(limit, MAX_MATCHES);
    const out: RegexMatch[] = [];
    let from = 0;
    while (out.length < cap && from <= text.length) {
      const m = this.scan(text, from);
      if (!m) break;
      out.push(m);
      // 零长度匹配必须推进一位，同一位置只产生一次零长度匹配
      from = m.end === m.start ? m.end + 1 : m.end;
    }
    return out;
  }

  test(text: string): boolean {
    if (text.length > MAX_INPUT_LENGTH) {
      throw new RangeError("输入超过安全上限");
    }
    return this.scan(text, 0) !== null;
  }

  /**
   * 单遍 Pike VM：从 fromPos 起扫描到串尾，返回最靠左的匹配。
   * 活动线程为空时在下一位置重新播种；每码元只推进一次线程集合，
   * 单遍复杂度 O(输入长度 × NFA 状态数)。
   */
  private scan(text: string, fromPos: number): RegexMatch | null {
    this.text = text;
    const emptyCaps = (): Array<number | null> => Array<number | null>(this.groupCount).fill(null);

    let clist: Thread[] = [];
    let pos = fromPos;
    const seed = (p: number): void => {
      const caps = emptyCaps();
      clist = this.closure(this.startState, caps, caps, p, 0, [], p);
    };
    seed(fromPos);

    let best: {
      start: number;
      end: number;
      rank: number;
      starts: Array<number | null>;
      ends: Array<number | null>;
    } | null = null;

    while (pos <= text.length) {
      if (clist.length === 0) {
        pos += 1;
        if (pos > text.length) break;
        seed(pos);
        continue;
      }

      // 线程按状态 id 排序，保证同位置接受线程取程序顺序第一
      clist.sort((a, b) => a.state - b.state);
      for (const thread of clist) {
        if (!this.states[thread.state].accept) continue;
        const better =
          best === null ||
          thread.start < best.start ||
          (thread.start === best.start &&
            (thread.rank < best.rank || (thread.rank === best.rank && pos > best.end)));
        if (better) {
          best = {
            start: thread.start,
            end: pos,
            rank: thread.rank,
            starts: thread.starts,
            ends: thread.ends,
          };
        }
        break;
      }

      if (pos >= text.length) break;

      const code = text.charCodeAt(pos);
      const nlist: Thread[] = [];
      const nseen = new Set<number>();

      for (const thread of clist) {
        const st = this.states[thread.state];
        if (st.match === null || st.match.type === "anchor") continue;
        if (st.charNext < 0) continue;
        if (!this.matchChar(st.match, code)) continue;
        if (nseen.has(st.charNext)) continue;
        const reached = this.closure(
          st.charNext,
          thread.starts,
          thread.ends,
          thread.start,
          thread.rank,
          thread.rankStack,
          pos + 1,
        );
        for (const r of reached) {
          const existing = nlist.find((t) => t.state === r.state);
          if (existing === undefined) {
            nseen.add(r.state);
            nlist.push(r);
          } else {
            this.mergeCaps(existing, r);
          }
        }
      }

      clist = nlist;
      if (clist.length === 0) continue; // 线程已死：交给空线程分支在下一位置重新播种
      pos += 1;
    }

    if (best === null) return null;

    const groups: Array<string | null> = best.ends.map((end, i) => {
      const start = best.starts[i];
      if (end === null || start === null) return null;
      return text.slice(start, end);
    });
    return {
      start: best.start,
      end: best.end,
      text: text.slice(best.start, best.end),
      groups,
    };
  }

  /** 合并两条到达同一状态线程的捕获快照：空缺的组位置采用非空的一侧 */
  private mergeCaps(existing: Thread, incoming: Thread): void {
    for (let i = 0; i < existing.starts.length; i += 1) {
      if (existing.starts[i] === null && incoming.starts[i] !== null) {
        existing.starts[i] = incoming.starts[i];
      }
    }
    for (let i = 0; i < existing.ends.length; i += 1) {
      if (existing.ends[i] === null && incoming.ends[i] !== null) {
        existing.ends[i] = incoming.ends[i];
      }
    }
  }

  private closure(
    stateId: number,
    starts: Array<number | null>,
    ends: Array<number | null>,
    start: number,
    rank: number,
    rankStack: number[],
    pos: number,
  ): Thread[] {
    const list: Thread[] = [];
    const byState = new Map<number, Thread>();
    const queue: Array<{
      id: number;
      starts: Array<number | null>;
      ends: Array<number | null>;
      start: number;
      rank: number;
      rankStack: number[];
    }> = [{ id: stateId, starts, ends, start, rank, rankStack }];

    while (queue.length > 0) {
      const item = queue.shift()!;
      const st = this.states[item.id];

      if (st.match !== null && st.match.type === "anchor" && !this.anchorHolds(st.match.kind, pos)) {
        continue;
      }

      const s = [...item.starts];
      const e = [...item.ends];
      if (st.open >= 0) s[st.open] = pos;
      if (st.close >= 0) e[st.close] = pos;

      let rank = item.rank;
      let stack = item.rankStack;
      if (st.pushRank) {
        stack = [...stack, rank];
      } else if (st.popRank) {
        if (stack.length > 0) {
          rank = stack[stack.length - 1];
          stack = stack.slice(0, -1);
        }
      }

      const existing = byState.get(item.id);
      if (existing !== undefined) {
        this.mergeCaps(existing, { state: item.id, start, rank, rankStack: stack, starts: s, ends: e });
        continue;
      }

      const thread: Thread = { state: item.id, start: item.start, rank, rankStack: stack, starts: s, ends: e };
      byState.set(item.id, thread);
      list.push(thread);

      for (const nx of st.epsilon) {
        if (!byState.has(nx)) {
          queue.push({ id: nx, starts: s, ends: e, start: item.start, rank, rankStack: stack });
        }
      }
      if (st.altRight >= 0 && !byState.has(st.altRight)) {
        queue.push({
          id: st.altRight,
          starts: s,
          ends: e,
          start: item.start,
          rank: rank + 1,
          rankStack: stack,
        });
      }
    }
    return list;
  }

  private anchorHolds(kind: "start" | "end", pos: number): boolean {
    if (kind === "start") {
      return pos === 0 || (this.flags.multiline && this.text.charCodeAt(pos - 1) === CODE_NEWLINE);
    }
    return pos === this.text.length || (this.flags.multiline && this.text.charCodeAt(pos) === CODE_NEWLINE);
  }

  private matchChar(match: MatchKind, code: number): boolean {
    switch (match.type) {
      case "literal":
        return foldCode(code, this.flags.ignoreCase) === foldCode(match.code, this.flags.ignoreCase);
      case "dot": {
        if (this.flags.dotAll) return true;
        return code !== CODE_NEWLINE && code !== CODE_RETURN;
      }
      case "class": {
        let base = match.ranges.some((range) => inRange(code, range));
        if (!base) {
          for (const cls of match.classes) {
            if (inPredef(cls, code)) {
              base = true;
              break;
            }
          }
        }
        return match.negated ? !base : base;
      }
      case "anchor":
        return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 对外契约
// ---------------------------------------------------------------------------

export function compileRegex(pattern: string, flags: RegexFlags): RegexCompileResult {
  if (pattern.length === 0) {
    return { ok: false, code: "empty", message: "模式为空" };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      code: "too-long",
      message: `模式长度 ${pattern.length} 超过上限 ${MAX_PATTERN_LENGTH}`,
    };
  }

  const parser = new Parser(pattern);
  let ast: Ast;
  try {
    ast = parser.parseAlternation();
    if (!parser.ended) {
      throw new ParseError("syntax", `位置 ${parser.position}: 表达式存在未解析的尾部内容`, parser.position);
    }
  } catch (err) {
    return mapParseError(err);
  }

  const builder = new Builder();
  let frag: Frag;
  try {
    frag = builder.build(ast);
    if (builder.states.length > MAX_NFA_STATES) {
      throw new ParseError(
        "too-long",
        `NFA 状态数 ${builder.states.length} 超过上限 ${MAX_NFA_STATES}`,
        0,
      );
    }
  } catch (err) {
    return mapParseError(err);
  }

  builder.states[frag.end].accept = true;
  const runner = new Runner(builder.states, frag.start, parser.groupCount, flags);
  const regex: CompiledRegex = {
    matchAll: (text: string, limit: number) => runner.matchAll(text, limit),
    test: (text: string) => runner.test(text),
  };
  return { ok: true, regex };
}

function mapParseError(err: unknown): RegexCompileResult {
  if (err instanceof ParseError) {
    return { ok: false, code: err.code, message: err.message };
  }
  return { ok: false, code: "syntax", message: `解析失败: ${String(err)}` };
}

/**
 * 替换串展开：
 * - `$&`、`$0` → 整个匹配；
 * - `$1`..`$9` → 对应捕获组（groups[0] 即组 1），未参与匹配的组按空串；
 * - 越界组号（如只有 2 个组时写 `$3`）原样保留字面量 `$3`；
 * - `$12` 按单组号 `$1` 展开后接字面量 "2"（本引擎只识别一位组号）；
 * - 其余 `$` 原样保留。
 * `input` 保留在签名中与调用方契约一致，当前展开直接使用 match 上的切片。
 */
export function expandReplacement(
  replacement: string,
  match: RegexMatch,
  input: string,
): string {
  void input;
  let out = "";
  for (let i = 0; i < replacement.length; i += 1) {
    const c = replacement[i];
    if (c !== "$") {
      out += c;
      continue;
    }
    const next = replacement[i + 1];
    if (next === "&") {
      out += match.text;
      i += 1;
      continue;
    }
    if (next === "0") {
      out += match.text;
      i += 1;
      continue;
    }
    if (next !== undefined && next.charCodeAt(0) >= CODE_DIGIT_1 && next.charCodeAt(0) <= CODE_DIGIT_9) {
      const groupIndex = Number(next) - 1;
      if (groupIndex < match.groups.length) {
        out += match.groups[groupIndex] ?? "";
      } else {
        out += `$${next}`;
      }
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}
