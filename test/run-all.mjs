#!/usr/bin/env node
/**
 * 全量自检 runner。
 *
 * 逐套以子进程跑 `test/*.mjs`，按 **exit code** 判定，不解析 stdout
 * （早期版本靠解析汇总行判定，PadEnd 对齐一乱就误报）。
 *
 * 用法：
 *   node test/run-all.mjs            # 跑全部
 *   node test/run-all.mjs usage zoom # 只跑名字含 usage 或 zoom 的
 *
 * 需要活实例（:3080）的套件会自动跳过并标为 SKIP，不计入失败。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);

// 需要活实例的套件：连不上就 SKIP。
const NEEDS_LIVE = new Set([
  'accept-live-render.mjs',
  'probe-usage-snapshot.mjs',
  'probe-bundle.mjs',
  'probe-image-route.mjs',
]);

const files = readdirSync(HERE)
  .filter((name) => name.endsWith('.mjs') && name !== 'run-all.mjs')
  .filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))
  .sort();

if (files.length === 0) {
  console.error('没有匹配的测试文件');
  process.exit(1);
}

const rows = [];

for (const name of files) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [join(HERE, name)], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 180_000,
  });
  const ms = Date.now() - started;
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const skip = NEEDS_LIVE.has(name) && /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(out);
  rows.push({
    name,
    status: skip ? 'SKIP' : res.status === 0 ? 'PASS' : 'FAIL',
    ms,
    tail: out.trim().split('\n').slice(-3).join(' | '),
  });
}

const width = Math.min(34, Math.max(...rows.map((r) => r.name.length)) + 1);
for (const r of rows) {
  console.log(`${r.status.padEnd(5)}${r.name.padEnd(width)}${String(r.ms).padStart(6)}ms  ${r.tail}`);
}

const pass = rows.filter((r) => r.status === 'PASS').length;
const fail = rows.filter((r) => r.status === 'FAIL').length;
const skip = rows.filter((r) => r.status === 'SKIP').length;

console.log('');
console.log(`合计 ${rows.length} 套：PASS ${pass} / FAIL ${fail} / SKIP ${skip}`);
process.exit(fail === 0 ? 0 : 1);
