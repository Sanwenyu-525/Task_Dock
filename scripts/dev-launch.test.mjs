import assert from "node:assert/strict";
import test from "node:test";
import { isOwnDebugExe, parseProcessList } from "./dev-launch.mjs";

test("parseProcessList: 只接受 pid|path 行，忽略噪声与无效 PID", () => {
  const stdout = [
    "1234|C:\\Repo\\src-tauri\\target\\debug\\task-dock.exe",
    "",
    "not-a-row",
    "0|C:\\Zero\\task-dock.exe",
    "5678|C:\\Other\\task-dock.exe",
    "",
  ].join("\r\n");
  assert.deepEqual(parseProcessList(stdout), [
    { pid: 1234, path: "C:\\Repo\\src-tauri\\target\\debug\\task-dock.exe" },
    { pid: 5678, path: "C:\\Other\\task-dock.exe" },
  ]);
});

test("parseProcessList: 空输出不产生任何进程", () => {
  assert.deepEqual(parseProcessList(""), []);
  assert.deepEqual(parseProcessList(undefined), []);
});

test("isOwnDebugExe: 大小写/分隔符不敏感，只认本仓库调试程序", () => {
  const exe = "D:\\Develop\\task_dock\\src-tauri\\target\\debug\\task-dock.exe";
  assert.equal(
    isOwnDebugExe("d:/develop/TASK_DOCK/src-tauri/target/debug/task-dock.exe", exe),
    true,
  );
  assert.equal(isOwnDebugExe("C:\\Program Files\\Task Dock\\task-dock.exe", exe), false);
  assert.equal(isOwnDebugExe("D:\\Develop\\task_dock\\src-tauri\\target\\release\\task-dock.exe", exe), false);
  assert.equal(isOwnDebugExe("", exe), false);
  assert.equal(isOwnDebugExe(null, exe), false);
});
