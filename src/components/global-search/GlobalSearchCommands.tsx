//! 命令面板分组：全局搜索弹窗内「命令」能力层的渲染组件。
//!
//! - 与八类数据结果明确区分：独立分组置于结果最前、组头带命令图标与徽标文案、
//!   条目图标用强调色底衬（数据条目是字母色块）。
//! - 键盘选中沿用全局 flat 序（命令组占据 0..n-1），Active 高亮与滚动保持可见。
//! - 文案全部走全局词典（commandPalette.*）；动态实体标题是用户数据，不走词典。

import { memo, useEffect, useRef } from "react";
import { Command as CommandIcon } from "lucide-react";

import { useLocale } from "../../hooks/useLocale";
import { COMMAND_MATCH_LIMIT, type CommandDef } from "../../lib/commandRegistry";

interface CommandsProps {
  commands: CommandDef[];
  /** 全局 flat 选中序号（命令组固定占据 0..commands.length-1）。 */
  activeIndex: number;
  onSelect: (cmd: CommandDef) => void;
  onHoverIndex: (flatIndex: number) => void;
}

export const GlobalSearchCommands = memo(function GlobalSearchCommands({
  commands,
  activeIndex,
  onSelect,
  onHoverIndex,
}: CommandsProps) {
  const { t } = useLocale();
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // 键盘导航在命令组内移动时保持选中项可见（数据组组件对命令序号不滚动）。
  useEffect(() => {
    if (activeIndex < commands.length) activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, commands.length]);

  if (commands.length === 0) return null;

  return (
    <section className="gs-commands" role="listbox" aria-label={t("commandPalette.group")}>
      <header className="gs-group-head gs-cmd-head">
        <span className="gs-cmd-head-label">
          <CommandIcon size={12} strokeWidth={2} aria-hidden="true" />
          {t("commandPalette.group")}
        </span>
        {commands.length >= COMMAND_MATCH_LIMIT ? (
          <span className="gs-group-more">{t("commandPalette.groupMore", { n: COMMAND_MATCH_LIMIT })}</span>
        ) : null}
      </header>
      {commands.map((cmd, i) => {
        const active = i === activeIndex;
        return (
          <button
            key={cmd.id}
            type="button"
            role="option"
            aria-selected={active}
            className={`gs-item gs-cmd${active ? " active" : ""}`}
            data-gs-cmd-id={cmd.id}
            ref={active ? activeRef : undefined}
            onClick={() => onSelect(cmd)}
            onMouseEnter={() => onHoverIndex(i)}
          >
            <span className="gs-item-icon gs-cmd-icon" aria-hidden="true">
              <cmd.icon size={15} strokeWidth={1.9} />
            </span>
            <span className="gs-item-main">
              <span className="gs-item-title">{cmd.titleKey ? t(cmd.titleKey) : cmd.title}</span>
              <span className="gs-item-sub">
                <span className="gs-item-from">{t(cmd.subtitleKey)}</span>
              </span>
            </span>
          </button>
        );
      })}
    </section>
  );
});
