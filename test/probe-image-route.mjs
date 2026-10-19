/**
 * 图片路由实测：真 cordis boot + 真 HTTP handler 调用。
 *
 * 覆盖：
 *   - 合法 ref（真实附件，字节级比对）→ 200 + content-type + immutable 缓存头
 *   - 非法 ref（穿越/空/坏格式）→ 400 bad-ref
 *   - 合法 ref 但文件不存在 → 404 attachment-not-found
 *   - type 白名单外的回落 image/png
 *
 * 运行：node test/probe-image-route.mjs
 */
import { Context } from 'file:///C:/Users/candi/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { Writable } from 'node:stream';
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, inject, name } from '../index.js';

process.env.DSH_HOME = 'C:\\Users\\candi\\.dsh';

const failures = [];
function record(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** 可捕获 writeHead/头/体 的 Writable —— stream.pipe(res) 直接可用。 */
class CaptureRes extends Writable {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.headersSent = false;
    this.chunks = [];
  }
  writeHead(code, headers) {
    this.statusCode = code;
    Object.assign(this.headers, headers || {});
    this.headersSent = true;
    return this;
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  body() {
    return Buffer.concat(this.chunks);
  }
}

// ---- boot：真 cordis fiber，webServer stub 保留完整 route 对象 ----
const root = new Context();
const routes = [];
root.provide('logger', { debug() {}, info() {}, warn() {}, error() {} });
root.provide('sessionProjections', {
  register() {
    return () => {};
  },
  snapshot: () => ({ asOfSeq: 1, values: {} }),
  stateOf: () => ({ seq: 1 }),
});
root.provide('webServer', {
  register(route) {
    routes.push(route);
    return () => {};
  },
});
root.provide('settings', { describe: () => [], update: () => Promise.resolve() });
root.provide('sessions', { list: () => [], get: () => undefined });

const entry = root.plugin({ name, inject, apply });
await Promise.race([
  entry,
  new Promise((resolve, reject) => setTimeout(() => reject(new Error('boot timeout')), 5000)),
]);

const imageRoute = routes.find((route) => route.path === '/session-live/api/image');
record('图片路由已注册', imageRoute !== undefined, `routes=${routes.map((r) => r.path).join(', ')}`);
if (imageRoute === undefined) process.exit(1);
const handler = imageRoute.handler;
record('image 路由 kind=exact', imageRoute.kind === 'exact', `kind=${imageRoute.kind}`);

// 真实附件（本会话用户上传图）作为正向样本
const REAL_SHA = 'ea18a633689d99162bc8f6fc6a0915aa3ddff8daed4d68011e7cd2916428ae04';
const realPath = join('C:\\Users\\candi\\.dsh\\attachments\\v1\\objects', REAL_SHA.slice(0, 2), REAL_SHA);
const realBytes = readFileSync(realPath).length;

async function call(url) {
  const res = new CaptureRes();
  await new Promise((resolve) => {
    handler({ url, method: 'GET' }, res);
    // pipe 完成或 sendJson 同步结束都以 end 收口
    res.on('finish', resolve);
    res.on('close', resolve);
    setTimeout(resolve, 2000);
  });
  return res;
}

// 1. 合法 ref → 200，字节等于原文件，content-type/缓存头正确
{
  const res = await call(`/session-live/api/image?ref=sha256:${REAL_SHA}&type=image/png`);
  record('合法 ref → 200', res.statusCode === 200, `status=${res.statusCode}`);
  record('字节级等于原附件', res.body().length === realBytes, `body=${res.body().length} file=${realBytes}`);
  record('content-type=image/png', res.headers['content-type'] === 'image/png', `${res.headers['content-type']}`);
  record('cache-control immutable', String(res.headers['cache-control']).includes('immutable'), `${res.headers['cache-control']}`);
}

// 2. type 白名单外的值回落 image/png
{
  const res = await call(`/session-live/api/image?ref=sha256:${REAL_SHA}&type=text/html`);
  record('type 不在白名单 → 回落 image/png（不透传用户值）', res.headers['content-type'] === 'image/png', `${res.headers['content-type']}`);
}

// 3. 非法 ref 全家 → 400 bad-ref
for (const bad of ['sha256:XYZ', 'sha256:' + 'a'.repeat(63), '', '../../etc/passwd', 'sha256:../../winnt']) {
  const res = await call(`/session-live/api/image?ref=${encodeURIComponent(bad)}`);
  record(`非法 ref ${JSON.stringify(bad.slice(0, 20))} → 400 bad-ref`, res.statusCode === 400 && res.body().includes('bad-ref'), `status=${res.statusCode}`);
}

// 4. 合法 sha 但文件不存在 → 404
{
  const res = await call(`/session-live/api/image?ref=sha256:${'f'.repeat(64)}`);
  record('合法 sha 无文件 → 404 attachment-not-found', res.statusCode === 404 && res.body().includes('attachment-not-found'), `status=${res.statusCode}`);
}

// 5. 无 url（req.url 为空）→ 400 而不是抛
{
  const res = new CaptureRes();
  let threw = false;
  try {
    handler({ url: undefined, method: 'GET' }, res);
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch {
    threw = true;
  }
  record('req.url 缺失 → 400 不抛', !threw && res.statusCode === 400, `status=${res.statusCode} threw=${threw}`);
}

console.log('');
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：${failures.join('；')}`);
  process.exit(1);
}
console.log('probe-image-route 全部通过。');
