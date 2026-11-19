//! 工作篮 IPC 客户端：只做参数整形与命令调用，不在这里写业务规则。
//!
//! 所有写操作都返回后端真实结果（批次 / 删除条数 / 校验结果），事件只用于刷新。

import { invokeCommand } from "../errors";
import type {
  BatchUndoResult,
  EntityLink,
  EntityLinkInput,
  TargetValidation,
  TransferAddReport,
  TransferBatch,
  TransferContext,
  TransferCounts,
  TransferFilter,
  TransferItem,
  TransferItemInput,
  TransferOptions,
  TransferPage,
  TransferPreview,
  TransferTarget,
} from "./types";

export const DEFAULT_OPTIONS: TransferOptions = {
  conflict: "rename",
  textFormat: "txt",
  textMode: "separate",
  fileOperation: "copy",
  urlMode: "url",
};

export const addItems = (items: TransferItemInput[]) =>
  invokeCommand<TransferAddReport>("transfer_add", { items }, "transfer.add");

export const listItems = (filter: TransferFilter = {}) =>
  invokeCommand<TransferPage>("transfer_list", { filter }, "transfer.list");

export const getItem = (itemId: string) =>
  invokeCommand<TransferItem>("transfer_get", { itemId }, "transfer.get");

export const updateItem = (
  itemId: string,
  patch: {
    title?: string;
    description?: string;
    content?: string;
    pinned?: boolean;
    status?: string;
  },
) => invokeCommand<TransferItem>("transfer_update", { itemId, patch }, "transfer.update");

export const removeItems = (ids: string[]) =>
  invokeCommand<{ removed: number }>("transfer_remove", { ids }, "transfer.remove");

export const reorderItems = (ids: string[]) =>
  invokeCommand<void>("transfer_reorder", { ids }, "transfer.reorder");

export const pinItem = (itemId: string, pinned: boolean) =>
  invokeCommand<TransferItem>("transfer_pin", { itemId, pinned }, "transfer.pin");

export const clearTemporary = () =>
  invokeCommand<number>("transfer_clear_temporary", undefined, "transfer.clearTemporary");

export const getCounts = () =>
  invokeCommand<TransferCounts>("transfer_counts", undefined, "transfer.counts");

export const validateTarget = (target: TransferTarget) =>
  invokeCommand<TargetValidation>("transfer_validate_target", { target }, "transfer.validateTarget");

export const previewTransfer = (
  ids: string[],
  target: TransferTarget,
  options: TransferOptions = DEFAULT_OPTIONS,
) =>
  invokeCommand<TransferPreview>(
    "transfer_preview",
    { ids, target, options },
    "transfer.preview",
  );

export const executeTransfer = (
  ids: string[],
  target: TransferTarget,
  options: TransferOptions = DEFAULT_OPTIONS,
  operationId?: string,
) =>
  invokeCommand<TransferBatch>(
    "transfer_execute",
    { ids, target, options, operationId },
    "transfer.execute",
  );

export const getBatch = (batchId: string) =>
  invokeCommand<TransferBatch>("transfer_batch", { batchId }, "transfer.batch");

export const listBatches = (limit = 10) =>
  invokeCommand<TransferBatch[]>("transfer_batches", { limit }, "transfer.batches");

export const retryBatch = (
  batchId: string,
  options: TransferOptions = DEFAULT_OPTIONS,
) => invokeCommand<TransferBatch>("transfer_retry", { batchId, options }, "transfer.retry");

export const undoBatch = (batchId: string) =>
  invokeCommand<BatchUndoResult>("transfer_undo", { batchId }, "transfer.undo");

export const getContext = () =>
  invokeCommand<TransferContext>("transfer_context_get", undefined, "transfer.context");

export const updateContext = (patch: Partial<TransferContext>) =>
  invokeCommand<TransferContext>(
    "transfer_context_update",
    { patch },
    "transfer.contextUpdate",
  );

export const clearContext = () =>
  invokeCommand<TransferContext>("transfer_context_clear", undefined, "transfer.contextClear");

/** 创建实体关联；同一关系重复创建由后端幂等处理。 */
export const createEntityLink = (input: EntityLinkInput) =>
  invokeCommand<EntityLink>("entity_link_create", { input }, "entityLink.create");
