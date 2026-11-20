// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const watchdog = readFileSync("public/boot/boot-watchdog.js", "utf8");

describe.each(["index.html", "workspace.html"])("%s 启动恢复", (entry) => {
  it("超时后继续等待仍保留重新加载与复制诊断，迟到的 ready 能移除占位", () => {
    document.documentElement.innerHTML = readFileSync(entry, "utf8");
    try {
      const timers = new Map<number, () => void>();
      const schedule = vi.fn((callback: () => void, delay: number) => {
        timers.set(delay, callback);
        return delay;
      });
      const bootWindow = { addEventListener: vi.fn() } as {
        addEventListener: ReturnType<typeof vi.fn>;
        __TASK_DOCK_BOOT__: { ready(): void };
      };
      runInNewContext(watchdog, {
        window: bootWindow, document, performance, location,
        setTimeout: schedule, clearTimeout: vi.fn(), URL,
      });
      timers.get(15000)!();
      const wait = document.getElementById("boot-wait")!;
      wait.click();

      for (const id of ["boot-recovery", "boot-retry", "boot-copy"]) {
        expect(getComputedStyle(document.getElementById(id)!).display, id)
          .not.toBe("none");
      }
      expect(document.getElementById("boot-detail")!.textContent).toContain("继续等待");
      expect(schedule).toHaveBeenCalledTimes(2); // 不增加轮询/重载/新的超时
      bootWindow.__TASK_DOCK_BOOT__.ready();
      timers.get(160)!();
      expect(document.getElementById("boot-splash")).toBeNull();
    } finally {
      document.documentElement.innerHTML = "<head></head><body></body>";
    }
  });
});
