//! 模拟控制台：无真实 Agent 环境下测试完整状态流（明确标注模拟）。

import { useState } from "react";
import { Play, FlaskConical } from "lucide-react";
import { mockStartScenario } from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import { Select } from "../ui";

export default function MockControls() {
  const showToast = useUiStore((s) => s.showToast);
  const [title, setTitle] = useState("模拟：重构登录模块");
  const [outcome, setOutcome] = useState("completed");
  const [running, setRunning] = useState(false);

  return (
    <div className="panel-block mock-block">
      <div className="panel-block-head">
        <span>
          <FlaskConical size={12} /> 模拟控制台
        </span>
        <span className="mock-badge">MOCK · 非真实 Agent</span>
      </div>
      <div className="mock-row">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="会话标题" />
        <Select
          size="sm"
          ariaLabel="模拟结果"
          value={outcome}
          options={[
            { value: "completed", label: "完成（含待处理事项）" },
            { value: "failed", label: "失败" },
            { value: "waiting_only", label: "仅等待处理" },
          ]}
          onChange={setOutcome}
        />
        <button
          className="btn primary sm"
          disabled={running}
          onClick={async () => {
            setRunning(true);
            try {
              await mockStartScenario(title || "模拟会话", outcome);
            } catch (e) {
              showToast(String(e), { kind: "error" });
            } finally {
              setRunning(false);
            }
          }}
        >
          <Play size={12} /> {running ? "运行中…" : "运行"}
        </button>
      </div>
      <div className="mock-hint">
        运行后会依次产生 运行中 → 等待处理 → 运行中 → {outcome === "failed" ? "失败" : "完成"} 的状态跃迁与通知，
        用于验证 UI、托盘图标、通知与任务关联逻辑。
      </div>
    </div>
  );
}
