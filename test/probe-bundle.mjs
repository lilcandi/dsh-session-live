/**
 * 探测 DSH 运行实例真正服务的客户端 bundle。
 *
 * 为什么要这么做：`dsh-client-modules` 在插件激活那一刻用
 * `initialBundleSnapshot()` 把 client.js 的字节读进内存（快照），
 * `buildComboScript()` 直接吐这份快照。所以 combo URL 返回的内容
 * 等于「DSH 当前进程实际加载的代码」，而不是磁盘上的最新版本。
 *
 * 这是判断「修复是否已在运行实例里生效」的唯一权威证据 ——
 * 磁盘哈希相等只说明文件同步了，不说明进程读到了它。
 */
import { createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";

const PROFILE_PKG = "C:/Users/candi/.dsh/profiles/web/node_modules/dsh-session-live";
const CLIENT_PATH = `${PROFILE_PKG}/client.js`;
const BASE = "http://127.0.0.1:3080";
const ID = "dsh-session-live";
const HASH_LEN = 12;

function framedHash(domain, parts) {
  const hash = createHash("sha1").update(domain).update("\0");
  for (const part of parts) {
    hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
  }
  return hash.digest("hex").slice(0, HASH_LEN);
}

function artifactRevision(baseline) {
  return framedHash("plugin-artifact", [
    String(baseline.mtimeMs),
    String(baseline.ctimeMs),
    String(baseline.size),
  ]);
}

const stat = statSync(CLIENT_PATH);
const rev = artifactRevision({
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
  size: stat.size,
});

console.log("=== 磁盘上的客户端 bundle ===");
console.log(`  path : ${CLIENT_PATH}`);
console.log(`  size : ${stat.size}B`);
console.log(`  mtime: ${stat.mtime.toISOString()}`);
console.log(`  算出 rev: ${rev}`);

const url = `${BASE}/plugins/??${ID}/client.js&rev=${rev}`;
console.log(`\n=== 请求 combo: ${url} ===`);

let res;
try {
  res = await fetch(url);
} catch (error) {
  console.log(`  fetch 失败: ${error.message}`);
  process.exit(1);
}

console.log(`  HTTP ${res.status}  content-type=${res.headers.get("content-type")}`);
if (res.status !== 200) {
  console.log("  !! combo 未命中。rev 可能与会话启动时的文件元数据不符（文件被改过）。");
  process.exit(1);
}

const body = await res.text();
console.log(`  收到 ${body.length}B`);

const disk = readFileSync(CLIENT_PATH, "utf8");

/*
 * combo 端点不是原样吐字节：`buildComboScript()` 会在每个 resource 的源码后
 * 追加 `;\n`，再由 `comboScript()` 加上 `//# sourceMappingURL=...` 尾注。
 * 所以比对前必须剥掉这两样，否则长度永远不等 —— 那是比对方法的错，不是运行时的错。
 */
function stripComboAdditions(text) {
  return text
    .replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, "")
    .replace(/;\s*$/, "")
    .replace(/\n+$/, "");
}

const served = stripComboAdditions(body);
const onDisk = disk.replace(/\n+$/, "");
const byteIdentical = served === onDisk;

console.log("\n=== 内容断言 ===");
const checks = [
  [`服务端字节 == 磁盘字节（剥 combo 追加物后 ${served.length}B vs ${onDisk.length}B）`, byteIdentical],
  ["含 readService 定义（修复版标志）", /function readService\s*\(/.test(body)],
  ["含 ctx.get(name, false) 逃生路径", /ctx\.get\(\s*name\s*,\s*false\s*\)/.test(body)],
  ["不含裸读 var sessions = ctx && ctx.sessions", !/var sessions = ctx && ctx\.sessions;/.test(body)],
  ["inject 声明含 sessions", /var inject = \[[^\]]*'sessions'[^\]]*\]/.test(body)],
  ["含 createImageViewer 定义（缩略图点击放大）", /function createImageViewer\s*\(/.test(body)],
  ["含 .dsl-lightbox 遮罩样式", body.includes(".dsl-lightbox{position:fixed")],
  ["缩略图绑定了 onClick", /className: 'dsl-thumb',/.test(body) && /onClick: function \(event\) \{/.test(body)],
  ["含 hover 插槽注册", body.includes("sidebar.session.row.hover")],
  ["含 settings 插槽注册", body.includes("settings.section")],
  ["CJS 装载形态正确", /__ModuleLoader__\.load\(\s*\{/.test(body)],
  ["有 sourceMappingURL 尾注（combo 会加）", /\/\/# sourceMappingURL=/.test(body)],
];

let pass = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (ok) pass += 1;
}

console.log(
  `\n结论：${pass}/${checks.length} 通过 —— ` +
    (pass === checks.length
      ? "运行实例服务的正是修复版客户端代码。"
      : "存在不一致，需重启 DSH 让快照更新。")
);
process.exit(pass === checks.length ? 0 : 1);
