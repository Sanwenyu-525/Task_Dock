// entryCssScope.mjs 的类型声明（ESM 入口，供 src 下的 TS 测试引用）。

export interface CssRule {
  selector: string;
  declarations: [string, string][];
  atPath: string[];
}

export interface CssScopeViolation {
  file: string;
  selector: string;
  props: string[];
  atPath: string[];
  /** 命中的选择器来自的分组原文（仅当规则是逗号分组时存在）。 */
  list?: string;
}

export declare function parseCssRules(css: string): CssRule[];
export declare function splitSelectorList(selector: string): string[];
export declare function isBareRootSelector(selector: string): boolean;
export declare function findUnscopedRootLayoutRules(
  rules: CssRule[],
  file?: string,
): CssScopeViolation[];
export declare const ENTRY_CSS_FILES: string[];
