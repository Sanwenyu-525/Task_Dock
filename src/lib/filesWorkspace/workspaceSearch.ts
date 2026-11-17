//! 多目录联合搜索与重复文件查找：只在用户明确选择的窗格目录内扫描，
//! 有深度/数量上限，可中途停止（前端停止调度；IPC 单次目录不可抢占）。

import { fsHashFiles, fsListDir, type FsEntry } from "../bridge";
import { joinPath } from "./pathUtils";

export interface SearchSource {
  paneId: string;
  label: string;
  path: string;
}

export interface SearchHit {
  paneId: string;
  paneLabel: string;
  dirPath: string;
  entry: FsEntry;
  /** 完整路径，供定位与哈希使用。 */
  path: string;
}

export interface SearchOptions {
  query: string;
  /** 不带点的小写扩展名；空 = 不限。 */
  extensions: string[];
  /** 文件类别（folder/image/video/audio/text/doc/sheet/slide/archive/code/data/program/link/other）。 */
  category: string | null;
  modifiedWithinDays: number | null;
  maxDepth: number;
  maxResults: number;
  /** 硬上限：最多进入多少个目录，避免误选大目录后长时间扫描。 */
  maxDirs: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  query: "",
  extensions: [],
  category: null,
  modifiedWithinDays: null,
  maxDepth: 2,
  maxResults: 500,
  maxDirs: 200,
};

export interface SearchProgress {
  dirsVisited: number;
  filesScanned: number;
  hits: number;
  currentDir: string;
}

export interface SearchResult {
  hits: SearchHit[];
  dirsVisited: number;
  filesScanned: number;
  /**
   * 因结果数上限、目录数上限、扫描预算耗尽或分页停滞而未读全。
   * 普通中间页 `hasMore=true` 是正常分页，**不**置 truncated。
   */
  truncated: boolean;
  failedDirs: number;
  cancelled: boolean;
  /**
   * 完整读完所有选中目录：未命中任何上限、未取消、无读取失败目录、无分页停滞。
   * `truncated`/`cancelled`/`failedDirs` 字段保持对外兼容，本字段是合并后的完整性结论。
   */
  complete: boolean;
}

function matchesHit(entry: FsEntry, options: SearchOptions): boolean {
  if (entry.kind !== "file" && entry.kind !== "link") {
    // 文件夹是联合搜索的一等结果：名称、分类、修改时间都参与筛选。
    // 文件夹没有扩展名，扩展名筛选只对文件生效，不能因此把文件夹排除。
    if (options.category && options.category !== "folder") return false;
    if (options.extensions.length) return false;
    if (options.query && !entry.name.toLocaleLowerCase().includes(options.query.toLocaleLowerCase())) return false;
    if (options.modifiedWithinDays !== null) {
      const cutoff = Date.now() - options.modifiedWithinDays * 24 * 60 * 60 * 1000;
      if ((entry.modifiedMs ?? 0) < cutoff) return false;
    }
    return true;
  }
  if (options.category && entry.category !== options.category) return false;
  if (options.extensions.length && !options.extensions.includes(entry.ext.toLowerCase())) return false;
  if (options.query && !entry.name.toLocaleLowerCase().includes(options.query.toLocaleLowerCase())) return false;
  if (options.modifiedWithinDays !== null) {
    const cutoff = Date.now() - options.modifiedWithinDays * 24 * 60 * 60 * 1000;
    if ((entry.modifiedMs ?? 0) < cutoff) return false;
  }
  return true;
}

/** 递归搜索选定目录；目录/结果达到上限即停止，并在结果中标记 truncated。 */
export async function searchWorkspace(
  sources: SearchSource[],
  options: SearchOptions,
  onProgress?: (progress: SearchProgress) => void,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const queue: Array<{ dir: string; depth: number; pane: SearchSource }> = sources.map((pane) => ({
    dir: pane.path,
    depth: 0,
    pane,
  }));
  const hits: SearchHit[] = [];
  /** 已入结果的完整路径：重叠根/重复翻页不产生同路径重复命中。 */
  const seenPaths = new Set<string>();
  let dirsVisited = 0;
  let filesScanned = 0;
  let failedDirs = 0;
  let truncated = false;
  let cancelled = false;
  /** 分页停滞：hasMore=true 但 nextOffset 未推进，属真实不完整，不重复请求同一页。 */
  let stalled = false;

  while (queue.length) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    if (dirsVisited >= options.maxDirs || hits.length >= options.maxResults) {
      truncated = true;
      break;
    }
    const item = queue.shift()!;
    dirsVisited += 1;
    try {
      // 目录内按后端 nextOffset 契约续拉分页：offset 取上一页 nextOffset（绝对磁盘序），
      // 不重不漏，直到 hasMore=false 或中止/结果上限命中（与 dirCache 的翻页语义一致）。
      let offset = 0;
      for (;;) {
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        const listing = await fsListDir(item.dir, false, offset);
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        for (const entry of listing.entries) {
          filesScanned += 1;
          const path = joinPath(item.dir, entry.name);
          if (matchesHit(entry, options)) {
            if (!seenPaths.has(path)) {
              seenPaths.add(path);
              hits.push({ paneId: item.pane.paneId, paneLabel: item.pane.label, dirPath: item.dir, entry, path });
            }
            if (hits.length >= options.maxResults) {
              truncated = true;
              break;
            }
          }
          if (entry.kind === "dir" && item.depth < options.maxDepth) {
            queue.push({ dir: path, depth: item.depth + 1, pane: item.pane });
          }
        }
        if (cancelled || truncated) break;
        // 停滞保护：还有更多但偏移未推进 → 保留本页条目，停止本目录翻页，标记不完整。
        if (listing.hasMore && listing.nextOffset <= offset) {
          stalled = true;
          truncated = true;
          break;
        }
        if (!listing.hasMore) break;
        offset = listing.nextOffset;
      }
    } catch {
      failedDirs += 1;
    }
    onProgress?.({ dirsVisited, filesScanned, hits: hits.length, currentDir: item.dir });
    if (hits.length >= options.maxResults) {
      truncated = true;
      break;
    }
  }

  const complete = !truncated && !cancelled && failedDirs === 0 && !stalled;
  return { hits, dirsVisited, filesScanned, truncated, failedDirs, cancelled, complete };
}

export interface DuplicateFile {
  path: string;
  dirPath: string;
  paneId: string;
  paneLabel: string;
  name: string;
  size: number;
}

export interface DuplicateGroup {
  size: number;
  files: DuplicateFile[];
  /** 未做哈希时为 null；哈希确认后只有同哈希文件。 */
  hash: string | null;
}

/** 收集文件（不跟随符号链接），用于重复查找；目录同样受上限约束。 */
export async function collectWorkspaceFiles(
  sources: SearchSource[],
  maxDepth: number,
  onProgress?: (progress: SearchProgress) => void,
  signal?: AbortSignal,
  maxDirs = 200,
): Promise<{ files: DuplicateFile[]; truncated: boolean; failedDirs?: number; cancelled: boolean; complete: boolean }> {
  const result = await searchWorkspace(
    sources,
    { ...DEFAULT_SEARCH_OPTIONS, query: "", extensions: [], category: null, modifiedWithinDays: null, maxDepth, maxResults: 8000, maxDirs },
    onProgress,
    signal,
  );
  const files = result.hits
    .filter((hit) => hit.entry.kind === "file" && hit.entry.size !== null)
    .map((hit) => ({
      path: hit.path,
      dirPath: hit.dirPath,
      paneId: hit.paneId,
      paneLabel: hit.paneLabel,
      name: hit.entry.name,
      size: hit.entry.size ?? 0,
    }));
  return { files, truncated: result.truncated, failedDirs: result.failedDirs, cancelled: result.cancelled, complete: result.complete };
}

/** 按大小预筛：零字节文件也可成为候选；同大小至少 2 个文件才进入哈希确认。 */
export function sizeGroups(files: DuplicateFile[]): DuplicateGroup[] {
  const bySize = new Map<number, DuplicateFile[]>();
  for (const file of files) {
    if (file.size < 0 || !Number.isFinite(file.size)) continue;
    const group = bySize.get(file.size) ?? [];
    group.push(file);
    bySize.set(file.size, group);
  }
  return [...bySize.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([size, group]) => ({ size, files: group.sort((a, b) => a.path.localeCompare(b.path)), hash: null }))
    .sort((a, b) => b.size - a.size);
}

/** 对大小候选组做 SHA-256 确认；同组内按哈希再聚合，只保留真正重复的组。 */
export async function hashDuplicateGroups(
  groups: DuplicateGroup[],
  signal?: AbortSignal,
): Promise<DuplicateGroup[]> {
  const out: DuplicateGroup[] = [];
  const candidates = groups.flatMap((group) => group.files);
  const byPath = new Map<string, string | null>();
  for (let index = 0; index < candidates.length; index += 100) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const chunk = candidates.slice(index, index + 100);
    const entries = await fsHashFiles(chunk.map((file) => file.path));
    for (const entry of entries) byPath.set(entry.path, entry.hash ?? null);
  }
  for (const group of groups) {
    const byHash = new Map<string, DuplicateFile[]>();
    for (const file of group.files) {
      const hash = byPath.get(file.path);
      if (!hash) continue;
      const bucket = byHash.get(hash) ?? [];
      bucket.push(file);
      byHash.set(hash, bucket);
    }
    for (const [hash, files] of byHash) {
      if (files.length >= 2) out.push({ size: group.size, files, hash });
    }
  }
  return out.sort((a, b) => b.size - a.size).slice(0, 300);
}

export function parseExtensions(raw: string): string[] {
  return [...new Set(
    raw
      .split(/[\s,;]+/)
      .map((item) => item.trim().replace(/^\./, "").toLowerCase())
      .filter(Boolean),
  )].slice(0, 20);
}
