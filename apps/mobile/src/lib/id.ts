// 本地 id 生成：不引入额外依赖，时间前缀保证大致有序，随机后缀避免同毫秒碰撞。
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${time}${rand}`;
}
