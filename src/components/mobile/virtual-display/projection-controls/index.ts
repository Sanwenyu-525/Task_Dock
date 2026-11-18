//! projection-controls 统一出口：投屏窗口导航栏（一体化子窗口 WebView）。

export { default as ProjectionToolbar } from "./ProjectionToolbar";
export type {
  ProjectionSessionSummary,
  ProjectionToolbarProps,
} from "./ProjectionToolbar";
export { ProjectionTooltipLayer, calculateTooltipPosition, resolveTooltipSide } from "./ProjectionTooltip";
export type { TooltipRect, TooltipSide, TooltipSize } from "./ProjectionTooltip";
export { ProjectionNavigation } from "./ProjectionNavigation";
export { ProjectionActions } from "./ProjectionActions";
export { ProjectionMoreMenu } from "./ProjectionMoreMenu";
export {
  capabilitiesForSession,
  defaultProjectionCapabilities,
} from "./types-capabilities";
export type { ProjectionCapabilities, ProjectionLayoutModeUi, ProjectionActionKind } from "./types";
export {
  getNavigationButtonSize,
  getNavigationContainerSize,
  getNavigationColumnSize,
  getNavigationSpacing,
  NAV_BUTTON_LOGICAL,
  NAV_COLUMN_LOGICAL,
  NAV_GAP_LOGICAL,
  NAV_ICON_LOGICAL,
  NAV_PADDING_LOGICAL,
  TOOLTIP_HIDE_DELAY_MS,
  TOOLTIP_SHOW_DELAY_MS,
} from "./projection-sizes";
export {
  getProjectionToolbarActions,
  filterDuplicateProjectionActions,
  getSecondaryProjectionActions,
  shouldShowMoreButton,
  type ProjectionActionDefinition,
  type ProjectionActionId,
} from "./projection-actions";
export {
  useProjectionLayout,
  useProjectionSessionId,
  useProjectionToolbarCapabilities,
} from "./use-projection-layout";
