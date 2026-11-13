// 跨工具传递文件：发送方调用 handoff 后切换到目标工具，目标工具在 mount 时用 takeHandoff 取走。
// 只保存在内存里，取走即清空。

let pending = null;

/** @param {string} toolId 目标工具 id @param {File[]} files */
export function handoff(toolId, files) {
  pending = { toolId, files };
  location.hash = toolId;
}

/** @returns {File[] | null} */
export function takeHandoff(toolId) {
  if (pending?.toolId !== toolId) return null;
  const { files } = pending;
  pending = null;
  return files;
}
