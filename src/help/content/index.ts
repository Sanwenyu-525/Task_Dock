//! 帮助内容聚合：全部文章的唯一清单（注册中心从这里取数）。
//!
//! 新增文章：在对应分类文件里追加，保持本文件只做聚合不写正文；
//! 契约测试（npm run help:check）会校验 ID / 引用 / 翻译结构。

import { QUICKSTART_ARTICLES } from "./quickstart";
import { TASKS_ARTICLES } from "./tasks";
import { AGENTS_ARTICLES } from "./agents";
import { CLIPBOARD_ARTICLES } from "./clipboard";
import { CAPTURE_ARTICLES } from "./capture";
import { WORKFLOWS_ARTICLES } from "./workflows";
import { PERSONALIZE_ARTICLES } from "./personalize";
import { TROUBLESHOOTING_ARTICLES } from "./troubleshooting";
import { COMMANDS_ARTICLES } from "./commands";
import type { HelpArticle } from "../types";

export const HELP_ARTICLES: readonly HelpArticle[] = [
  ...QUICKSTART_ARTICLES,
  ...TASKS_ARTICLES,
  ...AGENTS_ARTICLES,
  ...CLIPBOARD_ARTICLES,
  ...CAPTURE_ARTICLES,
  ...WORKFLOWS_ARTICLES,
  ...PERSONALIZE_ARTICLES,
  ...TROUBLESHOOTING_ARTICLES,
  ...COMMANDS_ARTICLES,
];
