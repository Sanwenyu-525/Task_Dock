//! 手机互传：桌面端的独立功能页（左侧导航入口）。
//!
//! 2026-11-16 R6 信息架构：页面拆成「文件互传 / 屏幕控制」两个功能区。
//! 只挂载当前 pane；投屏 pane 卸载不会停止后端 scrcpy 会话，重新进入会重新
//! 读取真实设备/工具链/会话状态。文件互传继续复用 MobileSyncSection。

import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, MonitorSmartphone, Smartphone } from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import MobileSyncSection from "../settings/MobileSyncSection";
import VirtualDisplaySection from "./VirtualDisplaySection";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import "./mobile-page.css";

type MobilePane = "files" | "screen";

export default function MobileTransferPanel() {
  const { t } = useLocale();
  const [pane, setPane] = useState<MobilePane>("files");
  const bodyRef = useRef<HTMLDivElement>(null);
  const filesTabRef = useRef<HTMLButtonElement>(null);
  const screenTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 两个功能区的滚动内容长度差异很大，切换时回到顶部，避免进入空白中段。
    // jsdom 等宿主可能没有 scrollTo，这里做能力判断而不是假定实现存在。
    const body = bodyRef.current;
    if (body && typeof body.scrollTo === "function") body.scrollTo({ top: 0 });
  }, [pane]);

  const focusTab = (next: MobilePane) => {
    setPane(next);
    window.requestAnimationFrame(() => {
      (next === "files" ? filesTabRef.current : screenTabRef.current)?.focus();
    });
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusTab(pane === "files" ? "screen" : "files");
    } else if (event.key === "Home") {
      event.preventDefault();
      focusTab("files");
    } else if (event.key === "End") {
      event.preventDefault();
      focusTab("screen");
    }
  };

  return (
    <div className="mobile-transfer-panel page-fill">
      <WorkbenchPageHeader
        icon={Smartphone}
        title={t("mobileTransfer.title")}
        subtitle={
          pane === "screen"
            ? t("mobileTransfer.screenSubtitle")
            : t("mobileTransfer.subtitle")
        }
      />

      <div className="mobile-pane-nav">
        <div
          className="mobile-pane-tabs"
          role="tablist"
          aria-label={t("mobileTransfer.tabsLabel")}
        >
          <button
            ref={filesTabRef}
            type="button"
            role="tab"
            id="mobile-tab-files"
            className={`mobile-pane-tab${pane === "files" ? " is-active" : ""}`}
            aria-selected={pane === "files"}
            aria-controls="mobile-pane-files"
            tabIndex={pane === "files" ? 0 : -1}
            onClick={() => setPane("files")}
            onKeyDown={onTabKeyDown}
          >
            <span className="mobile-pane-tab-icon" aria-hidden="true">
              <ArrowLeftRight size={15} />
            </span>
            <span className="mobile-pane-tab-copy">
              <span className="mobile-pane-tab-title">
                {t("mobileTransfer.tabFiles")}
              </span>
              <span className="mobile-pane-tab-hint">
                {t("mobileTransfer.tabFilesHint")}
              </span>
            </span>
          </button>
          <button
            ref={screenTabRef}
            type="button"
            role="tab"
            id="mobile-tab-screen"
            className={`mobile-pane-tab${pane === "screen" ? " is-active" : ""}`}
            aria-selected={pane === "screen"}
            aria-controls="mobile-pane-screen"
            tabIndex={pane === "screen" ? 0 : -1}
            onClick={() => setPane("screen")}
            onKeyDown={onTabKeyDown}
          >
            <span className="mobile-pane-tab-icon" aria-hidden="true">
              <MonitorSmartphone size={15} />
            </span>
            <span className="mobile-pane-tab-copy">
              <span className="mobile-pane-tab-title">
                {t("mobileTransfer.tabScreen")}
              </span>
              <span className="mobile-pane-tab-hint">
                {t("mobileTransfer.tabScreenHint")}
              </span>
            </span>
          </button>
        </div>
      </div>

      <div ref={bodyRef} className="page-scroll mobile-body">
        {pane === "files" ? (
          <div
            id="mobile-pane-files"
            role="tabpanel"
            aria-labelledby="mobile-tab-files"
            className="mobile-pane-panel"
          >
            <MobileSyncSection />
          </div>
        ) : (
          <div
            id="mobile-pane-screen"
            role="tabpanel"
            aria-labelledby="mobile-tab-screen"
            className="mobile-pane-panel"
          >
            <VirtualDisplaySection />
          </div>
        )}
      </div>
    </div>
  );
}
