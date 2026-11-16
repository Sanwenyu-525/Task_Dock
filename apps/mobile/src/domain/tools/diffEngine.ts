// 纯函数行级 diff 引擎：不依赖 React、React Native、expo-*、数据库或 Node 内置模块，
// 可在手机端离线视图与单测 node 环境直接运行。
//
// 算法：Myers 最短编辑脚本（shortest edit script），复杂度 O((N+M)·D)，D 为最小编辑距离；
// 不使用 O(N·M) 全表 DP，避免大输入下内存膨胀。前沿路径按层拷贝为独立 Int32Array trace，
// 回溯时不会引用后续被原地改写的数组；回溯方向自底向上还原，最后反转得到正序脚本。
//
// 上限与降级：单端行数超过 MAX_DIFF_LINES、行列积超过 MAX_DIFF_CELLS 时前置拒绝（too-large）；
// 编辑距离超过内部安全上限 MAX_EDIT_DISTANCE 时按 complex 降级，不继续展开脚本。
// 本版不做 ops 截断，truncated 恒为 false；该字段保留给后续按块折叠大 diff，调用方暂不依赖。

export type DiffOpType = "equal" | "insert" | "delete";

export interface DiffOp {
  type: DiffOpType;
  text: string;
  aLine: number | null;
  bLine: number | null;
}

export interface DiffStats {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

export type DiffResult =
  | { ok: true; ops: DiffOp[]; stats: DiffStats; truncated: boolean }
  | { ok: false; code: "too-large" | "complex"; message: string };

/** 单端允许的最大行数（超过即前置拒绝） */
export const MAX_DIFF_LINES = 2000;
/** a 行数 × b 行数 的上限（防止 Myers 前沿过宽） */
export const MAX_DIFF_CELLS = 4_000_000;

/**
 * 内部编辑距离安全上限：最小编辑距离超过该值时按 complex 降级，不继续展开脚本。
 * 仅内部使用，不对外导出。
 */
const MAX_EDIT_DISTANCE = 2000;

/** 按 \n 切分并剥掉每行尾部 \r；空文本按零行处理，尾随换行不产生多余空行。 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const raw = text.split("\n");
  // "a\n" → ["a", ""] → 1 行；"a\n\n" → ["a", "", ""] → 2 行（保留中间空行）。
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const out: string[] = [];
  for (const line of raw) {
    out.push(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
  return out;
}

/** 忽略空白比较键：去首尾空白，内部连续空白折叠为单个空格。 */
function normalizeKey(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/** 回溯 Myers trace，把前沿快照还原成正序操作脚本。 */
function reconstruct(
  traces: Int32Array[],
  n: number,
  m: number,
  offset: number,
  a: string[],
  b: string[],
): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;

  for (let d = traces.length - 1; d >= 1; d--) {
    const prev = traces[d - 1];
    const k = x - y;
    let prevK: number;
    let cameFromDelete: boolean;
    if (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) {
      // 来源对角线 k+1：x 不变、y +1，即上一步向右走（插入 b 侧一行）。
      prevK = k + 1;
      cameFromDelete = false;
    } else {
      // 来源对角线 k-1：x +1、y 不变，即上一步向下走（删除 a 侧一行）。
      prevK = k - 1;
      cameFromDelete = true;
    }
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;

    if (cameFromDelete) {
      // 删除步落地在 (prevX+1, prevY)；先回溯其后的蛇形 equal 段，再落删除步。
      while (x > prevX + 1) {
        x -= 1;
        y -= 1;
        ops.push({ type: "equal", text: a[x], aLine: x + 1, bLine: y + 1 });
      }
      ops.push({ type: "delete", text: a[prevX], aLine: prevX + 1, bLine: null });
      x = prevX;
      y = prevY;
    } else {
      // 插入步落地在 (prevX, prevY+1)；先回溯其后的蛇形 equal 段，再落插入步。
      while (x > prevX) {
        x -= 1;
        y -= 1;
        ops.push({ type: "equal", text: a[x], aLine: x + 1, bLine: y + 1 });
      }
      ops.push({ type: "insert", text: b[prevY], aLine: null, bLine: prevY + 1 });
      x = prevX;
      y = prevY;
    }
  }

  // d=0 层：起点 (0,0) 到当前点的蛇形 equal。
  while (x > 0) {
    x -= 1;
    y -= 1;
    ops.push({ type: "equal", text: a[x], aLine: x + 1, bLine: y + 1 });
  }

  ops.reverse();
  return ops;
}

/** 跑 Myers 前沿；编辑距离超过 MAX_EDIT_DISTANCE 返回 null（调用方按 complex 降级）。 */
function buildOps(
  a: string[],
  b: string[],
  keysA: string[],
  keysB: string[],
): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const size = n + m + 1;
  const offset = size;
  const v = new Int32Array(2 * size + 1);
  const traces: Int32Array[] = [];

  for (let d = 0; d <= MAX_EDIT_DISTANCE; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        // 从 k+1 对角线落地：x 不变、y +1，对应插入 b 侧一行。
        x = v[offset + k + 1];
      } else {
        // 从 k-1 对角线落地：x +1、y 不变，对应删除 a 侧一行。
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && keysA[x] === keysB[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;

      if (x >= n && y >= m) {
        // 拷贝本层快照后回溯；不能直接持有 v 引用，下一层会原地改写。
        traces.push(Int32Array.from(v));
        return reconstruct(traces, n, m, offset, a, b);
      }
    }
    traces.push(Int32Array.from(v));
  }
  return null;
}

/**
 * 统计口径（UI 直接显示这四个数，不可换口径）：
 * 相邻的 delete 段紧跟 insert 段视为「修改」，逐行配对，pairCount = min(段长)；
 * changed = 配对总数；added = insert 总数 - changed；removed = delete 总数 - changed；
 * unchanged = equal 数量。不变式：ops.length === unchanged + added + removed + 2*changed。
 */
function computeStats(ops: DiffOp[]): DiffStats {
  let equal = 0;
  let insertTotal = 0;
  let deleteTotal = 0;
  let changed = 0;
  let i = 0;

  while (i < ops.length) {
    if (ops[i].type === "delete") {
      let j = i;
      while (j < ops.length && ops[j].type === "delete") j += 1;
      const delLen = j - i;
      let k = j;
      while (k < ops.length && ops[k].type === "insert") k += 1;
      const insLen = k - j;
      changed += Math.min(delLen, insLen);
      deleteTotal += delLen;
      insertTotal += insLen;
      i = k;
    } else if (ops[i].type === "insert") {
      let j = i;
      while (j < ops.length && ops[j].type === "insert") j += 1;
      insertTotal += j - i;
      i = j;
    } else {
      equal += 1;
      i += 1;
    }
  }

  return {
    added: insertTotal - changed,
    removed: deleteTotal - changed,
    changed,
    unchanged: equal,
  };
}

/** 行级 diff 入口：纯函数，合法输入内任何路径都不向调用方抛异常。 */
export function diffLines(
  a: string,
  b: string,
  options: { ignoreWhitespace: boolean },
): DiffResult {
  try {
    const linesA = splitLines(a);
    const linesB = splitLines(b);
    const n = linesA.length;
    const m = linesB.length;

    if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) {
      return {
        ok: false,
        code: "too-large",
        message: `行数超限：a=${n}，b=${m}，上限 MAX_DIFF_LINES=${MAX_DIFF_LINES}`,
      };
    }
    if (n * m > MAX_DIFF_CELLS) {
      return {
        ok: false,
        code: "too-large",
        message: `行列积超限：a=${n}，b=${m}，n×m=${n * m}，上限 MAX_DIFF_CELLS=${MAX_DIFF_CELLS}`,
      };
    }

    const keysA = options.ignoreWhitespace ? linesA.map(normalizeKey) : linesA;
    const keysB = options.ignoreWhitespace ? linesB.map(normalizeKey) : linesB;

    const ops = buildOps(linesA, linesB, keysA, keysB);
    if (ops === null) {
      return {
        ok: false,
        code: "complex",
        message: `编辑距离超过内部安全上限 MAX_EDIT_DISTANCE=${MAX_EDIT_DISTANCE}，脚本过于复杂，已拒绝展开`,
      };
    }

    const stats = computeStats(ops);
    // 本版不做 ops 截断：超限一律前置拒绝，该字段恒为 false，保留给后续按块折叠。
    return { ok: true, ops, stats, truncated: false };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "complex",
      message: `diff 计算失败：${detail}`,
    };
  }
}
