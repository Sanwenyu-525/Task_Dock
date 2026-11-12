//! 快速捕获纯逻辑：类型归一 / 链接识别 / 类型建议 / 提交校验 / 草稿状态机。
//! 全部是纯函数，放在默认 node 环境即可；UI 编排另见 CaptureApp.test.tsx。

import { describe, expect, it } from "vitest";

import {
  CONTENT_MAX,
  NOTE_MAX,
  TASK_TITLE_MAX,
  appendDictation,
  composeSubmitInput,
  describeDraft,
  draftReducer,
  extractFirstUrl,
  formatClock,
  formatError,
  initialDraftState,
  isCaptureKind,
  kindAt,
  looksLikeTask,
  newClientId,
  nextKind,
  normalizeKind,
  suggestKind,
  validateCapture,
  voiceListeningMessage,
  wrapKindIndex,
} from "./captureUtils";

describe("captureUtils / 类型", () => {
  it("isCaptureKind 只接受五种已知类型", () => {
    expect(isCaptureKind("task")).toBe(true);
    expect(isCaptureKind("idea")).toBe(true);
    expect(isCaptureKind("text")).toBe(true);
    expect(isCaptureKind("todo")).toBe(true);
    expect(isCaptureKind("link")).toBe(true);
    expect(isCaptureKind("Task")).toBe(false);
    expect(isCaptureKind(null)).toBe(false);
    expect(isCaptureKind(undefined)).toBe(false);
    expect(isCaptureKind(3)).toBe(false);
  });

  it("normalizeKind 对未知值回落，默认任务", () => {
    expect(normalizeKind("idea")).toBe("idea");
    expect(normalizeKind("nope")).toBe("task");
    expect(normalizeKind(undefined)).toBe("task");
    expect(normalizeKind(undefined, "todo")).toBe("todo");
  });

  it("单选组索引循环：wrapKindIndex / kindAt / nextKind", () => {
    expect(wrapKindIndex(0)).toBe(0);
    expect(wrapKindIndex(5)).toBe(0);
    expect(wrapKindIndex(-1)).toBe(4);
    expect(wrapKindIndex(7)).toBe(2);
    expect(kindAt(0)).toBe("task");
    expect(kindAt(7)).toBe("text");
    expect(nextKind("task", 1)).toBe("idea");
    expect(nextKind("link", 1)).toBe("task");
    expect(nextKind("task", -1)).toBe("link");
  });
});

describe("captureUtils / 链接识别", () => {
  it("识别 http(s) 与 www. 链接并剥掉句末标点", () => {
    expect(extractFirstUrl("看下 https://example.com/a?b=1。")).toBe(
      "https://example.com/a?b=1",
    );
    expect(extractFirstUrl("https://example.com/path.")).toBe("https://example.com/path");
    expect(extractFirstUrl("（https://a.example/x）")).toBe("https://a.example/x");
    expect(extractFirstUrl("www.example.com 挺有用")).toBe("www.example.com");
  });

  it("没有链接时返回 null，避免把英文单词当网址", () => {
    expect(extractFirstUrl("这是一段普通想法")).toBeNull();
    expect(extractFirstUrl("example.com 没有协议前缀")).toBeNull();
    expect(extractFirstUrl("")).toBeNull();
  });

  it("suggestKind 只给建议：空内容不建议，链接优先于时间词", () => {
    expect(suggestKind("")).toBeNull();
    expect(suggestKind("   ")).toBeNull();
    expect(suggestKind("随手记一段想法")).toBeNull();
    expect(suggestKind("https://example.com")).toBe("link");
    expect(suggestKind("明天 10 点交周报")).toBe("task");
    expect(suggestKind("https://example.com 明天再看")).toBe("link");
    expect(looksLikeTask("3 天后跟进")).toBe(true);
    expect(looksLikeTask("12:30 开会")).toBe(true);
    expect(looksLikeTask("一段没有时间词的想法")).toBe(false);
  });
});

describe("captureUtils / 提交校验", () => {
  it("空内容拒绝", () => {
    expect(validateCapture("task", "")).toBe("内容不能为空");
    expect(validateCapture("idea", "   \n  ")).toBe("内容不能为空");
  });

  it("超过内容上限拒绝", () => {
    const tooLong = "a".repeat(CONTENT_MAX + 1);
    expect(validateCapture("text", tooLong)).toBe(`内容最多 ${CONTENT_MAX} 字`);
    expect(validateCapture("text", "a".repeat(CONTENT_MAX))).toBeNull();
  });

  it("链接类型校验链接长度", () => {
    const longUrl = `https://example.com/${"a".repeat(2048)}`;
    expect(validateCapture("link", longUrl)).toBe("链接过长（最多 2048 字符）");
    expect(validateCapture("link", "https://example.com/x")).toBeNull();
    // 非链接类型不套用链接长度
    expect(validateCapture("text", "https://example.com/x")).toBeNull();
  });

  it("任务/待办只限制首行标题，不静默截断", () => {
    const longTitle = "a".repeat(TASK_TITLE_MAX + 1);
    expect(validateCapture("task", longTitle)).toBe(
      `任务标题过长（最多 ${TASK_TITLE_MAX} 字，当前 ${TASK_TITLE_MAX + 1}）`,
    );
    expect(validateCapture("todo", "  标题\n" + "正".repeat(1000))).toBeNull();
    // 想法/文字不套用任务标题限制
    expect(validateCapture("idea", longTitle)).toBeNull();
  });
});

describe("captureUtils / 提交载荷", () => {
  it("非链接类型只提交内容", () => {
    expect(composeSubmitInput("task", "  写周报  ", "cid-1")).toEqual({
      client_id: "cid-1",
      kind: "task",
      content: "写周报",
    });
  });

  it("链接类型把首个链接拆到 url，其余文本作 note", () => {
    expect(composeSubmitInput("link", "看这个 https://example.com/x 很有用", "cid-1")).toEqual({
      client_id: "cid-1",
      kind: "link",
      content: "看这个 https://example.com/x 很有用",
      url: "https://example.com/x",
      note: "看这个 很有用",
    });
  });

  it("链接类型补全 www. 协议，没有链接时整段作备注", () => {
    expect(composeSubmitInput("link", "www.example.com", "cid-2")).toEqual({
      client_id: "cid-2",
      kind: "link",
      content: "www.example.com",
      url: "https://www.example.com",
    });
    expect(composeSubmitInput("link", "一段没有链接的备注", "cid-3")).toEqual({
      client_id: "cid-3",
      kind: "link",
      content: "一段没有链接的备注",
      note: "一段没有链接的备注",
    });
  });

  it("备注长度按上限截断（后端另有校验兜底）", () => {
    const note = "备".repeat(NOTE_MAX + 50);
    const input = composeSubmitInput("link", note, "cid-4");
    expect(input.note).toHaveLength(NOTE_MAX);
  });
});

describe("captureUtils / 草稿状态机", () => {
  it("change → saving → saved 保留后端确认时间", () => {
    let state = draftReducer(initialDraftState, { type: "change" });
    expect(state).toEqual({ status: "dirty", savedAt: null });
    state = draftReducer(state, { type: "saving" });
    expect(state).toEqual({ status: "saving", savedAt: null });
    state = draftReducer(state, { type: "saved", savedAt: "2026-11-03T04:05:00Z" });
    expect(state.status).toBe("saved");
    expect(state.savedAt).toBe("2026-11-03T04:05:00Z");
    // 再次编辑：有过保存时间但状态必须回到 dirty，不能继续显示已保存
    state = draftReducer(state, { type: "change" });
    expect(state).toEqual({ status: "dirty", savedAt: "2026-11-03T04:05:00Z" });
  });

  it("failed / reset 与非法动作", () => {
    const failed = draftReducer(
      { status: "saving", savedAt: "2026-11-03T04:05:00Z" },
      { type: "failed" },
    );
    expect(failed.status).toBe("error");
    expect(draftReducer(failed, { type: "reset" })).toEqual(initialDraftState);
    expect(draftReducer(initialDraftState, { type: "unknown" } as never)).toBe(initialDraftState);
  });

  it("describeDraft 只有 saved 才展示具体时间", () => {
    expect(describeDraft(initialDraftState)).toBe("");
    expect(describeDraft({ status: "dirty", savedAt: null })).toBe("待保存…");
    expect(describeDraft({ status: "saving", savedAt: null })).toBe("正在保存…");
    expect(describeDraft({ status: "saved", savedAt: "2026-11-03T04:05:00" })).toBe(
      "草稿已保存 04:05",
    );
    // 无法解析的时间宁可不显示，绝不显示假时间
    expect(describeDraft({ status: "saved", savedAt: "not-a-date" })).toBe("草稿已保存");
    expect(describeDraft({ status: "error", savedAt: null })).toBe("保存失败，点击重试");
  });

  it("formatClock 对空值/非法值返回空串", () => {
    expect(formatClock(null)).toBe("");
    expect(formatClock(undefined)).toBe("");
    expect(formatClock("")).toBe("");
    expect(formatClock("bad")).toBe("");
    expect(formatClock("2026-11-03T04:05:00")).toBe("04:05");
  });
});

describe("captureUtils / 幂等键与错误文案", () => {
  it("newClientId 每次唯一且非空", () => {
    const first = newClientId();
    const second = newClientId();
    expect(first.length).toBeGreaterThan(8);
    expect(second.length).toBeGreaterThan(8);
    expect(first).not.toBe(second);
  });

  it("formatError 保留原因、空原因给兜底文案", () => {
    expect(formatError(new Error("db locked"))).toBe("db locked");
    expect(formatError("网络中断")).toBe("网络中断");
    expect(formatError(new Error("   "))).toBe("未知错误");
    expect(formatError(null)).toBe("未知错误");
  });
});

describe("captureUtils / 语音听写", () => {
  it("appendDictation 不改已有正文，中文直接拼接", () => {
    expect(appendDictation("", "明天十点开会")).toEqual({
      content: "明天十点开会",
      overflow: false,
    });
    expect(appendDictation("写周报", "周五前发出去")).toEqual({
      content: "写周报周五前发出去",
      overflow: false,
    });
    // 已有正文以空白结尾时不再补空格
    expect(appendDictation("记一下\n", "买牛奶").content).toBe("记一下\n买牛奶");
  });

  it("appendDictation 只在两个 ASCII 词之间补一个空格", () => {
    expect(appendDictation("send email", "to Bob").content).toBe("send email to Bob");
    expect(appendDictation("版本 v2", "beta").content).toBe("版本 v2 beta");
    // 中文与英文相邻不插空格
    expect(appendDictation("安装", "Node").content).toBe("安装Node");
    expect(appendDictation("Node", "安装").content).toBe("Node安装");
  });

  it("appendDictation 空片段不产生任何变化", () => {
    expect(appendDictation("已有内容", "   ")).toEqual({
      content: "已有内容",
      overflow: false,
    });
  });

  it("appendDictation 超出上限时截断并报告 overflow", () => {
    const existing = "a".repeat(CONTENT_MAX - 3);
    const result = appendDictation(existing, "bcdef");
    expect(result.content).toHaveLength(CONTENT_MAX);
    // 词间空格也占用额度：只剩 2 个字符可写
    expect(result.content.endsWith("a bc")).toBe(true);
    expect(result.overflow).toBe(true);

    const full = appendDictation("a".repeat(CONTENT_MAX), "再来一句");
    expect(full).toEqual({ content: "a".repeat(CONTENT_MAX), overflow: true });
  });

  it("voiceListeningMessage 对非中文语音包如实说明回退语言", () => {
    expect(voiceListeningMessage("zh-CN")).toBe("正在听写，点击麦克风结束");
    expect(voiceListeningMessage("en-US")).toContain("系统未提供中文语音包");
    expect(voiceListeningMessage("en-US")).toContain("en-US");
    expect(voiceListeningMessage("")).toContain("系统语音");
  });
});
