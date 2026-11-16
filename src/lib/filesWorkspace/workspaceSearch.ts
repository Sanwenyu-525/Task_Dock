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
  truncated: boolean;
  failedDirs: number;
  cancelled: boolean;
}

function matchesHit(entry: FsEntry, options: SearchOptions): boolean {
  if (entry.kind !== "file" && entry.kind !== "link") {
    if (options.category !== "folder") return false;
    return options.query === "" && options.extensions.length === 0 && options.modifiedWithinDays === null;
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
  let dirsVisited = 0;
  let filesScanned = 0;
  let failedDirs = 0;
  let truncated = false;
  let cancelled = false;

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
      const listing = await fsListDir(item.dir, false, 0);
      if (listing.hasMore) truncated = true;
      for (const entry of listing.entries) {
        filesScanned += 1;
        const path = joinPath(item.dir, entry.name);
        if (matchesHit(entry, options)) {
          hits.push({ paneId: item.pane.paneId, paneLabel: item.pane.label, dirPath: item.dir, entry, path });
          if (hits.length >= options.maxResults) {
            truncated = true;
            break;
          }
        }
        if (entry.kind === "dir" && item.depth < options.maxDepth) {
          queue.push({ dir: path, depth: item.depth + 1, pane: item.pane });
        }
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

  return { hits, dirsVisited, filesScanned, truncated, failedDirs, cancelled };
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
): Promise<{ files: DuplicateFile[]; truncated: boolean; cancelled: boolean }> {
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
  return { files, truncated: result.truncated, cancelled: result.cancelled };
}

/** 按大小预筛：只有 >=2 个文件的 size 组才可能重复。 */
export function sizeGroups(files: DuplicateFile[]): DuplicateGroup[] {
  const bySize = new Map<number, DuplicateFile[]>();
  for (const file of files) {
    if (file.size <= 0) continue;
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
