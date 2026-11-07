//! 卷类型 → 文案。只读展示；不参与清理判定。

import type { MessageKey } from "../../i18n";
import type { ResourceSnapshot } from "../../lib/bridge";

export type VolumeKind = ResourceSnapshot["disks"][number]["kind"];

export const VOLUME_KIND_KEYS: Record<VolumeKind, MessageKey> = {
  fixed: "resource.volume.kind.fixed",
  removable: "resource.volume.kind.removable",
  remote: "resource.volume.kind.remote",
  ramdisk: "resource.volume.kind.ramdisk",
  optical: "resource.volume.kind.optical",
  unknown: "resource.volume.kind.unknown",
};
