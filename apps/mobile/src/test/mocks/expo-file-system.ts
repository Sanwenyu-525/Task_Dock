// expo-file-system 的 node 测试替身：内存文件系统，只覆盖 fileIo.ts 用到的 API 面。
// 语义对齐真实 SAF 路径：
// - Directory.createFile(name, mime) 返回 File；File.open(WriteOnly) 持有写入句柄，
//   句柄未 close 时 delete() 失败（对应真机实测的 SAF 行为）；
// - File.open(ReadOnly) / readBytes 顺序读，读取不足时循环补齐；
// - 测试通过 `__fsTestStore` 读写内存目录与断言 delete/closed 状态。
// 不允许为了测试改写业务逻辑：业务代码原样运行，只有原生边界被替换。

import { createHash } from "node:crypto";

export const Paths = {
  document: "file:///data/user/0/dev.taskdock.mobile/files",
  cache: "file:///data/user/0/dev.taskdock.mobile/cache",
};

/** 测试辅助：列出内存文件系统里尚未删除的文件 uri（用于断言无半成品残留）。 */
export function __activeFiles(): string[] {
  const out: string[] = [];
  for (const dir of directories.values()) {
    for (const file of dir.files.values()) {
      if (!file.deleted) out.push(file.uri);
    }
  }
  return out;
}

export enum FileMode {
  ReadOnly = "read",
  WriteOnly = "write",
}

interface FileRecord {
  uri: string;
  name: string;
  mimeType: string;
  parts: Uint8Array[];
  size: number;
  handleOpen: boolean;
  deleted: boolean;
  deleteAttempts: number;
}

interface DirectoryRecord {
  uri: string;
  files: Map<string, FileRecord>;
}

const directories = new Map<string, DirectoryRecord>();

function dirRecord(uri: string): DirectoryRecord {
  let record = directories.get(uri);
  if (!record) {
    record = { uri, files: new Map() };
    directories.set(uri, record);
  }
  return record;
}

export function fileByUri(uri: string): FileRecord | undefined {
  for (const dir of directories.values()) {
    const found = dir.files.get(uri);
    if (found) return found;
  }
  return undefined;
}

/** 测试辅助：清空内存文件系统。 */
export function __resetFs(): void {
  directories.clear();
}

/** 测试辅助：把一个源文件放进内存目录（模拟手机本地已有文件）。 */
export function __seedFile(
  directoryUri: string,
  name: string,
  bytes: Uint8Array,
  mimeType: string = "application/octet-stream",
): File {
  const record = dirRecord(directoryUri);
  const uri = `${directoryUri}/${name}`;
  record.files.set(uri, {
    uri,
    name,
    mimeType,
    parts: [bytes],
    size: bytes.length,
    handleOpen: false,
    deleted: false,
    deleteAttempts: 0,
  });
  return new File(uri);
}

function totalLength(record: FileRecord): number {
  return record.parts.reduce((sum, part) => sum + part.length, 0);
}

function mergedBytes(record: FileRecord): Uint8Array {
  const out = new Uint8Array(totalLength(record));
  let offset = 0;
  for (const part of record.parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export class File {
  readonly uri: string;
  private get record(): FileRecord | null {
    return fileByUri(this.uri) ?? null;
  }

  constructor(uriOrDirectory: string | { uri: string }, name?: string) {
    if (name === undefined) {
      this.uri = String(uriOrDirectory);
    } else {
      const dir = typeof uriOrDirectory === "string" ? uriOrDirectory : uriOrDirectory.uri;
      this.uri = `${dir}/${name}`;
    }

  }

  get name(): string {
    const idx = this.uri.lastIndexOf("/");
    return idx >= 0 ? this.uri.slice(idx + 1) : this.uri;
  }

  get type(): string {
    return this.record?.mimeType ?? "";
  }

  get size(): number {
    return this.record ? this.record.size : 0;
  }

  get exists(): boolean {
    return this.record !== null && !this.record.deleted;
  }

  create(_options?: { intermediates?: boolean; overwrite?: boolean }): void {
    const uri = this.uri;
    const name = this.name;
    const slash = uri.lastIndexOf("/");
    const directoryUri = slash >= 0 ? uri.slice(0, slash) : uri;
    dirRecord(directoryUri).files.set(uri, {
      uri,
      name,
      mimeType: "application/octet-stream",
      parts: [],
      size: 0,
      handleOpen: false,
      deleted: false,
      deleteAttempts: 0,
    });
  }

  async copy(target: File, options?: { overwrite?: boolean }): Promise<void> {
    // 对齐 SAF：content:// 源不支持 File.copy，调用方应退回句柄复制；
    // file:// 源则按真实 API 复制字节，供导入流程测试使用。
    if (!this.record || this.record.deleted) throw new Error(`file not found: ${this.uri}`);
    if (this.uri.startsWith("content://")) {
      throw new Error("copy not supported for this uri");
    }
    if (target.exists && !options?.overwrite) {
      throw new Error(`target exists: ${target.uri}`);
    }
    const slash = target.uri.lastIndexOf("/");
    const directoryUri = slash >= 0 ? target.uri.slice(0, slash) : target.uri;
    dirRecord(directoryUri).files.set(target.uri, {
      uri: target.uri,
      name: target.name,
      mimeType: this.record.mimeType,
      parts: this.record.parts.map((part) => part.slice()),
      size: this.record.size,
      handleOpen: false,
      deleted: false,
      deleteAttempts: 0,
    });
  }

  /**
   * 同分区移动（real API 语义）：把本记录挂到目标 URI 下，源 URI 不再存在。
   * 由 `moveToLibrary` / 保存失败回滚使用；跨目录移动只改 map 归属，不复制字节。
   */
  async move(target: File, options?: { overwrite?: boolean }): Promise<void> {
    if (!this.record || this.record.deleted) throw new Error(`file not found: ${this.uri}`);
    if (this.record.handleOpen) throw new Error("cannot move file with open handle");
    if (target.exists && !options?.overwrite) throw new Error(`target exists: ${target.uri}`);
    const source = this.record;
    const targetName = target.name;
    const slash = target.uri.lastIndexOf("/");
    const directoryUri = slash >= 0 ? target.uri.slice(0, slash) : target.uri;
    const destination = dirRecord(directoryUri);
    destination.files.set(target.uri, {
      ...source,
      uri: target.uri,
      name: targetName,
      parts: source.parts.map((part) => part.slice()),
    });
    this.record.deleted = true;
    this.record.parts = [];
  }

  /** 内容摘要：用 node:crypto 计算真实 SHA-256，业务侧 `sha256OfFile` 原样运行。 */
  async digest(algorithm: string): Promise<string> {
    if (!this.record || this.record.deleted) throw new Error(`file not found: ${this.uri}`);
    if (algorithm.toUpperCase().replace("-", "") !== "SHA256") {
      throw new Error(`unsupported digest: ${algorithm}`);
    }
    return createHash("sha256").update(Buffer.from(mergedBytes(this.record))).digest("hex");
  }

  open(mode: FileMode): FileHandle {
    if (!this.record || this.record.deleted) {
      throw new Error(`file not found: ${this.uri}`);
    }
    const record = this.record;
    if (record.handleOpen) {
      throw new Error(`file already open: ${this.uri}`);
    }
    record.handleOpen = true;
    if (mode === FileMode.WriteOnly) {
      // 写模式：清空已有内容，按顺序追加
      record.parts = [];
      return new WriteHandle(record);
    }
    return new ReadHandle(mergedBytes(record), () => {
      record.handleOpen = false;
    });
  }

  delete(): void {
    if (!this.record) throw new Error(`file not found: ${this.uri}`);
    this.record.deleteAttempts += 1;
    if (this.record.handleOpen) {
      // 对齐 SAF：句柄未关闭时 delete 失败
      throw new Error("cannot delete file with open handle");
    }
    this.record.deleted = true;
    this.record.parts = [];
  }

  async preview(): Promise<void> {
    // 测试替身：无系统查看器
  }

  static async pickFileAsync(_options?: unknown): Promise<File[]> {
    return [];
  }
}

export class Directory {
  readonly uri: string;

  /** 对齐 real API：`new Directory(parent, "a", "b")` 逐级拼接路径。 */
  constructor(uri: string | Directory, ...names: string[]) {
    const base = typeof uri === "string" ? uri : uri.uri;
    this.uri = names.length === 0 ? base : [base.replace(/\/+$/, ""), ...names].join("/");
  }

  get exists(): boolean {
    return directories.has(this.uri);
  }

  create(_options?: { idempotent?: boolean; intermediates?: boolean }): void {
    dirRecord(this.uri);
  }

  delete(): void {
    directories.delete(this.uri);
  }

  createFile(name: string, mimeType: string): File {
    const record = dirRecord(this.uri);
    const uri = `${this.uri}/${name}`;
    record.files.set(uri, {
      uri,
      name,
      mimeType,
      parts: [],
      size: 0,
      handleOpen: false,
      deleted: false,
      deleteAttempts: 0,
    });
    return new File(uri);
  }

  static async pickDirectoryAsync(): Promise<string | null> {
    return null;
  }
}

interface FileHandle {
  writeBytes(bytes: Uint8Array): Promise<void>;
  readBytes(length: number): Promise<Uint8Array>;
  close(): void;
}

class WriteHandle implements FileHandle {
  constructor(private readonly record: FileRecord) {}

  async writeBytes(bytes: Uint8Array): Promise<void> {
    this.record.parts.push(bytes.slice());
    this.record.size += bytes.length;
  }

  async readBytes(_length: number): Promise<Uint8Array> {
    throw new Error("write handle does not support readBytes");
  }

  close(): void {
    this.record.handleOpen = false;
  }
}

class ReadHandle implements FileHandle {
  private offset = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly onClose: () => void,
  ) {}

  async readBytes(length: number): Promise<Uint8Array> {
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += slice.length;
    return slice;
  }

  async writeBytes(_bytes: Uint8Array): Promise<void> {
    throw new Error("read handle does not support writeBytes");
  }

  close(): void {
    this.onClose();
  }
}
