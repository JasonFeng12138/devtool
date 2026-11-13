// 统一的“保存到本地”：Chrome / Edge 写入用户选择的文件夹，其他浏览器或选择打包时下载 ZIP；
// 进度显示在右下角的进度卡片（ui.js startProgress），完成后变为提醒。

import { createZip } from './zip.js';
import { downloadBlob, formatBytes, toast } from './ui.js';

/**
 * 选择保存文件夹（必须在用户点击后、其他 await 之前调用）。
 * @returns {Promise<FileSystemDirectoryHandle | null | undefined>} 不支持时为 null（改用 ZIP），用户取消为 undefined
 */
export async function pickFolder(id) {
  if (!window.showDirectoryPicker) return null;
  try {
    return await window.showDirectoryPicker({ id, mode: 'readwrite' });
  } catch (err) {
    // 取消选择、选了浏览器禁止写入的文件夹、拒绝“允许修改文件”提示，都会得到 AbortError
    if (err.name === 'AbortError') {
      toast('未保存：已取消，或浏览器不允许写入该文件夹。桌面、下载、文档等文件夹请在其中新建子文件夹后选择', 6000);
    } else {
      toast(`无法打开文件夹：${err.message}`);
    }
    return undefined;
  }
}

/**
 * 写入文件夹或打包 ZIP 下载，并在进度卡片上显示进度与完成提醒。
 * @param {{name: string, blob: Blob}[]} files
 * @param {{ dir?: FileSystemDirectoryHandle | null, zipName: string, task: ReturnType<import('./ui.js').startProgress>, summary: string, check?: () => void }} options
 *   summary 用于完成提醒，如“12 张图片”
 */
export async function writeFiles(files, { dir, zipName, task, summary, check = () => {} }) {
  check();
  const n = files.length;
  if (dir) {
    for (let i = 0; i < n; i++) {
      const handle = await dir.getFileHandle(files[i].name, { create: true });
      check();
      const writable = await handle.createWritable();
      try {
        check();
        await writable.write(files[i].blob);
        check();
        await writable.close();
        check();
      } catch (err) {
        try { await writable.abort(); } catch { /* 已关闭的流无需再次中止 */ }
        throw err;
      }
      task.update(i + 1, n, `正在保存到文件夹「${dir.name}」`);
    }
    task.finish(`已保存 ${summary}到文件夹「${dir.name}」`);
    return;
  }
  task.update(0, n, '正在打包 ZIP');
  const zip = await createZip(files, (done) => { check(); task.update(done, n); });
  check();
  downloadBlob(zip, zipName);
  task.finish(`已打包 ${summary}（${formatBytes(zip.size)}），浏览器开始下载`);
}
