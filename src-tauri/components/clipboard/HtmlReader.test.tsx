/**
 * @vitest-environment jsdom
 */
//! HTML 阅读视图的安全边界守卫。
//!
//! 剪贴板 HTML 来自外部应用，按不可信输入处理。这里锁定渲染器契约：
//! 1. 主动内容（script/iframe/object/embed/img/表单/svg）连子树一起消失；
//! 2. 不携带任何源属性——事件属性、style、srcset 一律不出现；
//! 3. <a> 不渲染为 <a>（无导航面），只保留文本，http/https 的 href 进 title；
//! 4. 白名单排版（标题/段落/列表/表格/加粗）保留，未知标签解包保内容；
//! 5. 超大 HTML 触发截断提示而不是卡死渲染。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import HtmlReader from "./HtmlReader";

afterEach(cleanup);

function renderDoc(html: string) {
  const { container } = render(<HtmlReader html={html} />);
  const doc = container.querySelector<HTMLElement>(".clip-doc");
  expect(doc, "应渲染出 .clip-doc 容器").not.toBeNull();
  return doc!;
}

describe("HtmlReader 安全边界", () => {
  it("script/style/iframe/object/embed 连同子树整体丢弃", () => {
    const doc = renderDoc(
      `<p>安全段落</p>
       <script>window.evil = 1;<em>脚本里的内容也不留</em></script>
       <style>.x { color: red }</style>
       <iframe src="https://evil.example"><span>iframe 子内容</span></iframe>
       <object data="x"><p>object 子内容</p></object>
       <embed src="x">`,
    );
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("style")).toBeNull();
    expect(doc.querySelector("iframe")).toBeNull();
    expect(doc.querySelector("object")).toBeNull();
    expect(doc.querySelector("embed")).toBeNull();
    expect(doc.textContent).toContain("安全段落");
    expect(doc.textContent).not.toContain("脚本里的内容");
    expect(doc.textContent).not.toContain("iframe 子内容");
    expect(doc.textContent).not.toContain("object 子内容");
  });

  it("img/表单/多媒体不渲染，不产生任何资源加载", () => {
    const doc = renderDoc(
      `<p>正文</p>
       <img src="https://evil.example/track.png" srcset="x 2x" onerror="pwn()">
       <video src="x"></video><audio src="x"></audio>
       <form action="https://evil.example"><input name="a"><button>提交</button></form>
       <svg onload="pwn()"><circle r="1"></circle></svg>`,
    );
    for (const tag of ["img", "video", "audio", "form", "input", "button", "svg", "circle"]) {
      expect(doc.querySelector(tag), `${tag} 不应渲染`).toBeNull();
    }
    expect(doc.innerHTML).not.toContain("evil.example");
    expect(doc.innerHTML).not.toContain("pwn");
  });

  it("CSS url()/@import、SVG 外部引用、base 与 meta refresh 都不留加载面", () => {
    const doc = renderDoc(
      `<style>@import url("http://127.0.0.1:8899/a.css");
         .x { background: url("http://127.0.0.1:8899/b.png") }</style>
       <p style="background:url(http://127.0.0.1:8899/c.png)">正文</p>
       <svg><image xlink:href="http://127.0.0.1:8899/d.png"/>
            <use href="http://127.0.0.1:8899/e.svg#x"/></svg>
       <base href="http://127.0.0.1:8899/">
       <meta http-equiv="refresh" content="0;url=http://127.0.0.1:8899/f">
       <link rel="stylesheet" href="http://127.0.0.1:8899/g.css">`,
    );
    for (const tag of ["style", "svg", "image", "use", "base", "meta", "link"]) {
      expect(doc.querySelector(tag), `${tag} 不应渲染`).toBeNull();
    }
    // 外链地址一处都不留在 DOM 里：既没有 src/href，也没有 CSS 文本
    expect(doc.innerHTML).not.toContain("127.0.0.1:8899");
    expect(doc.textContent).toContain("正文");
  });

  it("事件属性与 style 属性绝不出现（渲染器不携带任何源属性）", () => {
    const doc = renderDoc(
      `<p onclick="pwn()" onmouseover="pwn()" style="position:fixed" data-x="y">带毒属性</p>`,
    );
    const p = doc.querySelector("p");
    expect(p).not.toBeNull();
    expect(p!.textContent).toBe("带毒属性");
    expect(p!.attributes.length, "除 React 内部外不应有任何源属性").toBe(0);
    expect(doc.innerHTML).not.toContain("pwn");
  });

  it("<a> 不渲染为链接元素：无 href、无导航面，仅文本 + title 提示", () => {
    const doc = renderDoc(
      `<p><a href="https://ok.example/page">安全链接</a>
           <a href="javascript:alert(1)">危险链接</a>
           <a href="file:///C:/x">文件链接</a></p>`,
    );
    expect(doc.querySelector("a")).toBeNull();
    const spans = Array.from(doc.querySelectorAll("span"));
    const ok = spans.find((s) => s.textContent === "安全链接");
    expect(ok?.getAttribute("title")).toBe("https://ok.example/page");
    const danger = spans.find((s) => s.textContent === "危险链接");
    expect(danger?.getAttribute("title")).toBeNull();
  });

  it("javascript: 伪协议即使作为文本也不产生可执行点", () => {
    const doc = renderDoc(`<a href="javascript:alert(document.cookie)">点我</a>`);
    expect(doc.innerHTML).not.toContain("javascript:");
  });

  it("白名单排版保留：标题/段落/列表/表格/加粗斜体", () => {
    const doc = renderDoc(
      `<h2>标题</h2><p><b>加粗</b><i>斜体</i>段落</p>
       <ul><li>无序项</li></ul><ol><li>有序项</li></ol>
       <table><tr><th>列 A</th><td>值</td></tr></table>
       <blockquote>引用</blockquote>`,
    );
    expect(doc.querySelector("h2")?.textContent).toBe("标题");
    expect(doc.querySelector("b")?.textContent).toBe("加粗");
    expect(doc.querySelector("ul li")?.textContent).toBe("无序项");
    expect(doc.querySelector("ol li")?.textContent).toBe("有序项");
    expect(doc.querySelector("th")?.textContent).toBe("列 A");
    expect(doc.querySelector("td")?.textContent).toBe("值");
    expect(doc.querySelector("blockquote")?.textContent).toBe("引用");
  });

  it("未知标签解包保留内容（article/section/font 等不丢正文）", () => {
    const doc = renderDoc(
      `<article><section><font color="red">正文内容</font></section></article>`,
    );
    expect(doc.textContent).toContain("正文内容");
  });

  it("畸形 HTML 不抛错，按解析结果尽力渲染", () => {
    const doc = renderDoc(`<p>未闭合段落<b>粗体<ul><li>混套</ul></b>尾部`);
    expect(doc.textContent).toContain("未闭合段落");
    expect(doc.textContent).toContain("尾部");
  });

  it("空 HTML 显示解析失败回退，不渲染空容器内容", () => {
    const { container } = render(<HtmlReader html="   " />);
    expect(container.querySelector(".clip-doc")).toBeNull();
    expect(container.textContent).toContain("无法解析");
  });

  it("超大 HTML：节点数超限触发截断提示，而不是无限渲染", () => {
    const many = Array.from({ length: 6000 }, (_, i) => `<p>段落${i}</p>`).join("");
    const doc = renderDoc(many);
    const pCount = doc.querySelectorAll("p").length;
    expect(pCount).toBeLessThanOrEqual(6000);
    expect(pCount).toBeGreaterThan(0);
    expect(doc.textContent).toContain("预览已截断");
  });
});
