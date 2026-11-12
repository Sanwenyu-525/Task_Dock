// expo-secure-store 的 node 测试替身：内存键值，行为与真机一致（存取删除）。
const store = new Map<string, string>();

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function getItemAsync(key: string): Promise<string | null> {
  return store.get(key) ?? null;
}

export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}

/** 测试辅助：清空全部键（模拟重装）。 */
export function __reset(): void {
  store.clear();
}
