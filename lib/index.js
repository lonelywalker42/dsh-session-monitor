/**
 * 本包的宿主侧入口（package.json 的 main，也是 `exports["."]`）。
 *
 * 它把真正的宿主监控实现转出，使**一行**按包名的注册即可同时生效：
 *   - 宿主侧：Loader 导入本文件，拿到 name / inject / apply 并激活监控；
 *   - 浏览器侧：dsh-client-modules 读取 package.json 的
 *     dsh.client.platform === "web" 与 exports["./client"]，下发 client.js。
 *
 * 宿主监控实现本身仍然放在 host/session-monitor.mjs，保持单文件自包含，
 * 便于直接用 file:/// 形式独立注册（见 README 的「方式 B」）。
 *
 * 注意：不要在这里 import 任何浏览器专有代码。client.js 顶层就调用
 * `window.__ModuleLoader__.load(...)`，在 Node 里导入会因 window 未定义而崩溃，
 * 因此它只能作为浏览器 bundle 下发，绝不能成为 Loader 行。
 */
export { apply, inject, name, default } from './../host/session-monitor.mjs'
