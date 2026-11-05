//! 折叠分组的本地偏好读写（仅 UI 偏好，不进业务配置、备份或 IPC）。
//!
//! 规则：
//! - 键由调用方提供，分组 ID 使用稳定的英文标识，绝不以中文标题持久化；
//! - 存储结构为 `{ version: 1, sections: { [id]: boolean } }`；
//! - 无记录、损坏、版本不兼容或存储不可用时，一律回退到调用方给定的默认值；
//! - 只接受 defaults 中声明的键与 boolean 值，避免外部数据污染状态。

const STORAGE_VERSION = 1;

export function readCollapsibleState<Id extends string>(
  storageKey: string,
  defaults: Record<Id, boolean>,
): Record<Id, boolean> {
  const state = { ...defaults };
  try {
    if (typeof localStorage === "undefined") return state;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return state;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== STORAGE_VERSION
    ) {
      return state;
    }
    const sections = (parsed as { sections?: unknown }).sections;
    if (typeof sections !== "object" || sections === null) return state;
    for (const [id, open] of Object.entries(sections)) {
      if (id in defaults && typeof open === "boolean") {
        state[id as Id] = open;
      }
    }
    return state;
  } catch {
    return state;
  }
}

/** 立即写入完整折叠状态；存储被拒（配额/权限/隐私模式）时静默忽略。 */
export function persistCollapsibleState<Id extends string>(
  storageKey: string,
  state: Record<Id, boolean>,
): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      storageKey,
      JSON.stringify({ version: STORAGE_VERSION, sections: state }),
    );
  } catch {
    // 存储不可用时不降级写入其他键，本次会话内交互仍然有效。
  }
}
