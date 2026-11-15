// 采集数据变更信号：相机页/处理页/暂存页都在同一栈里，返回时不会重新挂载。
// 用极小的订阅器让「保存/删除/裁剪/重拍」后各页同步刷新，不引入全局 Store。
type Listener = () => void;

const listeners = new Set<Listener>();

export function bumpCaptureRevision(): void {
  for (const listener of listeners) listener();
}

export function subscribeCaptureRevision(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
