import { describe, expect, it } from "vitest";
import {
  RICH_EMBED_BUDGET,
  RICH_HTML_ITEM_LIMIT,
  clipSource,
  copyPreflight,
  formatBytes,
  looksLikeCode,
  sourceAppKey,
  sourceAppName,
  sourceLabel,
  sourceTrustLabel,
  sourceWindowTitle,
  urlDomain,
} from "./clipboardUi";

describe("sourceAppName", () => {
  it("常见应用使用人类可读名称，而不是 exe 标识", () => {
    expect(sourceAppName("chrome.exe")).toBe("Google Chrome");
    expect(sourceAppName("MSEDGE.EXE")).toBe("Microsoft Edge");
    expect(sourceAppName("Code.exe")).toBe("Visual Studio Code");
    expect(sourceAppName("Cursor.exe")).toBe("Cursor");
    expect(sourceAppName("Trae.exe")).toBe("Trae");
    expect(sourceAppName("WeChat.exe")).toBe("微信");
    expect(sourceAppName("Weixin.exe")).toBe("微信");
    expect(sourceAppName("QQ.exe")).toBe("QQ");
    expect(sourceAppName("kugou.exe")).toBe("酷狗音乐");
    expect(sourceAppName("cloudmusic.exe")).toBe("网易云音乐");
    expect(sourceAppName("explorer.exe")).toBe("文件资源管理器");
  });

  it("大小写不敏感，完整路径与裸文件名等价", () => {
    expect(
      sourceAppName("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
    ).toBe("Google Chrome");
    expect(sourceAppKey("C:\\Apps\\CODE.EXE")).toBe("code.exe");
  });

  it("未知应用不猜测：只去扩展名，保留原名", () => {
    expect(sourceAppName("MyTool.exe")).toBe("MyTool");
    expect(sourceAppName("C:\\tools\\weird.bin")).toBe("weird.bin");
  });

  it("空来源与 unknown 统一显示未知应用", () => {
    expect(sourceAppName("")).toBe("未知应用");
    expect(sourceAppName("   ")).toBe("未知应用");
    expect(sourceAppName("unknown")).toBe("未知应用");
    expect(sourceAppName("UNKNOWN")).toBe("未知应用");
  });
});

describe("sourceWindowTitle", () => {
  it("浏览器标题去掉末尾重复的浏览器名，网页标题本身不动", () => {
    expect(sourceWindowTitle("chrome.exe", "Go | OpenCode Console - Google Chrome")).toBe(
      "Go | OpenCode Console",
    );
    expect(sourceWindowTitle("msedge.exe", "GitHub - Microsoft Edge")).toBe("GitHub");
    expect(sourceWindowTitle("firefox.exe", "MDN Web Docs - Mozilla Firefox")).toBe("MDN Web Docs");
  });

  it("只在末尾重复时才去掉，不动网页标题里的有效内容", () => {
    expect(sourceWindowTitle("chrome.exe", "Chrome 插件 - 我的页面")).toBe("Chrome 插件 - 我的页面");
    // 标题本身就等于浏览器名：去掉就成空串了，宁愿原样保留
    expect(sourceWindowTitle("chrome.exe", "Google Chrome")).toBe("Google Chrome");
  });

  it("非浏览器应用保留原始标题语义", () => {
    expect(sourceWindowTitle("notepad.exe", "无标题 - 记事本")).toBe("无标题 - 记事本");
  });

  it("空标题返回空串，交给调用方给占位文案", () => {
    expect(sourceWindowTitle("chrome.exe", "   ")).toBe("");
    expect(sourceWindowTitle("", "")).toBe("");
  });
});

describe("clipSource", () => {
  it("三个展示位置共用的结构：应用名 / 窗口标题 / 识别方式", () => {
    const s = clipSource({
      source_app: "chrome.exe",
      source_title: "Go | OpenCode Console - Google Chrome",
      source_kind: "owner",
    });
    expect(s.app).toBe("Google Chrome");
    expect(s.appRaw).toBe("chrome.exe");
    expect(s.window).toBe("Go | OpenCode Console");
    expect(s.windowRaw).toBe("Go | OpenCode Console - Google Chrome");
    expect(s.trust).toBe("剪贴板所有者窗口（系统记录）");
    expect(s.identified).toBe(true);
  });

  it("旧记录没有 source_kind 时，不假装知道识别方式", () => {
    const s = clipSource({ source_app: "notepad.exe", source_title: "记事本" });
    expect(s.kind).toBe("");
    expect(s.trust).toBe("旧记录未记录识别方式");
    expect(s.app).toBe("记事本");
  });

  it("无法识别的来源不冒充具体应用", () => {
    const s = clipSource({ source_app: "unknown", source_title: "", source_kind: "unknown" });
    expect(s.identified).toBe(false);
    expect(s.app).toBe("未知应用");
    expect(s.window).toBe("");
    expect(s.trust).toBe("未能识别来源");
  });
});

describe("sourceTrustLabel", () => {
  it("四档文案都不把系统记录说成实际写入方", () => {
    expect(sourceTrustLabel("owner")).toBe("剪贴板所有者窗口（系统记录）");
    expect(sourceTrustLabel("foreground")).toBe("前台窗口（推断来源）");
    expect(sourceTrustLabel("unknown")).toBe("未能识别来源");
    expect(sourceTrustLabel("")).toContain("旧记录");
    for (const kind of ["owner", "foreground", "unknown", ""]) {
      expect(sourceTrustLabel(kind)).not.toContain("确认");
      expect(sourceTrustLabel(kind)).not.toContain("真实写入");
    }
  });
});

describe("sourceLabel", () => {
  it("单行摘要：应用 · 窗口", () => {
    expect(sourceLabel("chrome.exe", "Go | OpenCode Console - Google Chrome")).toBe(
      "Google Chrome · Go | OpenCode Console",
    );
    expect(sourceLabel("unknown", "")).toBe("未知应用");
  });
});

describe("copyPreflight", () => {
  const MB = 1024 * 1024;

  it("没有图片时不产生内嵌警告", () => {
    const p = copyPreflight([{ kind: "text", byte_size: 12 }]);
    expect(p.images).toBe(0);
    expect(p.willEmbedAllImages).toBe(true);
    expect(p.warnings).toEqual([]);
    expect(p.totalBytes).toBe(12);
  });

  it("图片在 6 MB 内嵌预算内时说明 Base64 体积", () => {
    const p = copyPreflight([{ kind: "image", byte_size: 1 * MB }]);
    expect(p.willEmbedAllImages).toBe(true);
    expect(p.estimatedEmbedBytes).toBe(Math.ceil((1 * MB * 4) / 3));
    expect(p.warnings[0]).toContain("内嵌 1 张图片");
    expect(p.warnings[0]).toContain(formatBytes(p.estimatedEmbedBytes));
  });

  it("图片超过预算时明确降级为占位符并给出替代方案", () => {
    const p = copyPreflight([{ kind: "image", byte_size: RICH_EMBED_BUDGET }]);
    expect(p.willEmbedAllImages).toBe(false);
    expect(p.warnings.join("；")).toContain("占位符");
    expect(p.warnings.join("；")).toContain("逐项粘贴");
  });

  it("文件条目区分文件本体与富文本名称清单", () => {
    const p = copyPreflight([{ kind: "files", byte_size: 0 }]);
    expect(p.files).toBe(1);
    expect(p.warnings.join("；")).toContain("只保留名称清单");
  });

  it("超大富文本提示降级为纯文本", () => {
    const p = copyPreflight([{ kind: "html", byte_size: RICH_HTML_ITEM_LIMIT + 1 }]);
    expect(p.oversizedHtml).toBe(1);
    expect(p.warnings.join("；")).toContain("降级为纯文本");
  });

  it("混合分组同时统计图片与文件并累计总大小", () => {
    const p = copyPreflight([
      { kind: "text", byte_size: 10 },
      { kind: "image", byte_size: 2 * MB },
      { kind: "files", byte_size: 30 },
    ]);
    expect(p.images).toBe(1);
    expect(p.imageBytes).toBe(2 * MB);
    expect(p.files).toBe(1);
    expect(p.totalBytes).toBe(10 + 2 * MB + 30);
    expect(p.willEmbedAllImages).toBe(true);
  });

  it("非法大小按 0 处理，不产生 NaN", () => {
    const p = copyPreflight([{ kind: "text", byte_size: Number.NaN }]);
    expect(p.totalBytes).toBe(0);
    expect(Number.isNaN(p.estimatedEmbedBytes)).toBe(false);
  });
});

describe("urlDomain", () => {
  it("http/https 提取域名", () => {
    expect(urlDomain("https://example.com/a/b?x=1")).toBe("example.com");
    expect(urlDomain("http://127.0.0.1:8080/x")).toBe("127.0.0.1");
    // URL API 对国际化域名返回 punycode 形式（标准行为，且能防同形异义字符伪装）
    expect(urlDomain("  https://文档.example.cn/  ")).toBe("xn--7dvp7d.example.cn");
  });

  it("非 http/https 与解析失败返回空串，不产出假域名", () => {
    expect(urlDomain("javascript:alert(1)")).toBe("");
    expect(urlDomain("file:///C:/Windows")).toBe("");
    expect(urlDomain("not a url")).toBe("");
    expect(urlDomain("")).toBe("");
  });
});

describe("looksLikeCode", () => {
  it("缩进 + 关键字共现的代码判为 true", () => {
    const js = [
      "function add(a, b) {",
      "  const sum = a + b;",
      "  return sum;",
      "}",
    ].join("\n");
    expect(looksLikeCode(js)).toBe(true);

    const rust = [
      "fn main() {",
      "    let x = vec![1, 2, 3];",
      "    for v in &x {",
      "        println!(\"{}\", v);",
      "    }",
      "}",
    ].join("\n");
    expect(looksLikeCode(rust)).toBe(true);
  });

  it("普通中文/英文段落判为 false（自然语言反信号）", () => {
    const zh = [
      "task_dock 是一个 Windows 桌面任务启动器。",
      "这次升级把剪贴板变成轻量的多类型内容管理器。",
      "不同类型的内容提供专属的详情和操作，交互保持统一。",
    ].join("\n");
    expect(looksLikeCode(zh)).toBe(false);

    const en = [
      "The quick brown fox jumps over the lazy dog near the river bank.",
      "Then it ran across the field and disappeared into the woods.",
      "Nobody saw where it went, and the story ends there.",
    ].join("\n");
    expect(looksLikeCode(en)).toBe(false);
  });

  it("Markdown 列表与短文本不误判", () => {
    expect(looksLikeCode("- 第一项\n- 第二项\n- 第三项")).toBe(false);
    expect(looksLikeCode("单行内容")).toBe(false);
    expect(looksLikeCode("")).toBe(false);
  });

  it("两行以内不足置信度，按普通文本处理", () => {
    expect(looksLikeCode("npm install -g pnpm\nnpx tsc --noEmit")).toBe(false);
  });

  it("JSON 带缩进与符号判为 true（等宽阅读更合适）", () => {
    const json = [
      "{",
      '  "name": "task-dock",',
      '  "version": "0.7.0",',
      '  "deps": {',
      '    "react": "18.0.0"',
      "  }",
      "}",
    ].join("\n");
    expect(looksLikeCode(json)).toBe(true);
  });
});
