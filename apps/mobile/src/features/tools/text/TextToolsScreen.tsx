// 文本处理聚合页（2026-11-16 产品整改）。
//
// 产品定位：JSON / 时间戳 / 编解码是低频输入型工具，不再各占一个首页入口。
// 保留独立页面与真实处理能力，但从这一个「高级工具」入口按需进入；
// 输入只在本页内存中处理，不写数据库。
import { useEffect } from "react";

import type { IconName } from "../../../components/icons/AppIcon";
import { recordToolUse } from "../../../db/toolUsage";
import type { AppNav, RouteKey } from "../../../lib/nav";
import { ToolHubCard } from "../shared/ToolHubCard";
import { ToolNote, ToolScreen, ToolSection } from "../shared/ToolUI";

interface TextToolEntry {
  title: string;
  description: string;
  icon: IconName;
  route: RouteKey;
}

const ENTRIES: TextToolEntry[] = [
  {
    title: "JSON 格式化",
    description: "格式化、压缩、校验与树形查看；超大数据有明确上限",
    icon: "json",
    route: "tool_json",
  },
  {
    title: "时间戳转换",
    description: "秒 / 毫秒、ISO 8601、本地与 UTC 互转，一键复制",
    icon: "clock",
    route: "tool_timestamp",
  },
  {
    title: "文本编解码",
    description: "URL、Base64、Unicode 转义、换行格式与文本统计",
    icon: "codeTerminal",
    route: "tool_text_codec",
  },
];

export function TextToolsScreen({ nav, onBack }: { nav: AppNav; onBack: () => void }) {
  useEffect(() => {
    void recordToolUse("tool.text");
  }, []);

  return (
    <ToolScreen
      title="文本处理"
      subtitle="低频文本工具 · 按需进入 · 输入不落库"
      onBack={onBack}
    >
      <ToolNote text="这些任务更适合电脑，手机只保留临时查看与转换。输入只在本页内存中处理，不会写入数据库或上传。" />
      <ToolSection title="选择工具">
        {ENTRIES.map((entry) => (
          <ToolHubCard
            key={entry.title}
            title={entry.title}
            description={entry.description}
            icon={entry.icon}
            onPress={() => nav.push(entry.route)}
          />
        ))}
      </ToolSection>
    </ToolScreen>
  );
}
