/**
 * 宿主半边入口（ESM，零构建）。
 *
 * 真正的实现放在 src/index.js，这里只做 re-export，
 * 保证 `main` 指向的文件和 `exports["."]` 指向的文件是同一份语义。
 *
 * ⚠️ 刻意**没有** default 导出：`cordis-plugin-loader` 的 `unwrapExports`
 * （`lib/index.js:667-672`）会执行 `exports = exports.default ?? exports`，
 * 有 default 就把整个命名空间顶替掉，`Config` 随之丢失，设置页因此读空。
 * 详见 `src/index.js` 文件末尾的长注释。
 */
export { name, inject, apply, Config, __test, readService } from './src/index.js';
