// 四角缩放命中层（主窗圆角区域裁剪的补偿，验收记录见
// tmp/acceptance/window-corner-resize/report.md）。
//
// 主窗用 SetWindowRgn 裁出与 CSS 圆角一致的「像素支撑区域」，区域外的像素既不绘制
// 也不接收鼠标消息。原生 4×4 物理像素的角热区（tao hit_test 的 border 宽度）恰好全部
// 落在圆角被裁掉的部分，系统因此不会把角点上的鼠标消息派发给窗口，tao 的 WM_NCHITTEST
// 四角分支（HTTOPLEFT 13 / HTTOPRIGHT 14 / HTBOTTOMLEFT 16 / HTBOTTOMRIGHT 17）没有机会
// 执行；四条边因为边缘中点仍在区域内所以正常。Win32 没有「视觉区域」之外的独立命中
// 区域，所以只能在区域内的最靠角像素上接住缩放意图，再交给原生缩放循环。
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

type ResizeDirection = Parameters<Window["startResizeDragging"]>[0];

const GRIPS: ReadonlyArray<{ corner: string; direction: ResizeDirection }> = [
  { corner: "tl", direction: "NorthWest" },
  { corner: "tr", direction: "NorthEast" },
  { corner: "bl", direction: "SouthWest" },
  { corner: "br", direction: "SouthEast" },
];

export default function WindowResizeGrips() {
  return (
    <div className="resize-grips" aria-hidden="true">
      {GRIPS.map(({ corner, direction }) => (
        <div
          key={corner}
          className={`resize-grip grip-${corner}`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            void getCurrentWindow().startResizeDragging(direction);
          }}
        />
      ))}
    </div>
  );
}
