/**
 * dsh-session-live 客户端自检：缩略图点击放大（lightbox）。
 *
 * 为什么单独立一套：放大遮罩是**原生 DOM**，刻意不挂 React 树——
 * 宿主的悬停卡片在鼠标离开时会卸载整棵插件组件树，遮罩要是挂在树里，
 * 用户连大图都来不及看。代价是它躲开了 accept-live-render 的渲染断言，
 * 必须单独用假 document 做行为验证。
 *
 * 这里全部是行为断言：真的把遮罩挂进假 body、真的派发事件、
 * 真的检查节点有没有被摘掉、监听有没有被解除。
 *
 * 运行：node test/probe-zoom.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'client.js');
const source = readFileSync(BUNDLE, 'utf8');

let checks = 0;
const failures = [];

function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 假 DOM：够真到能承载遮罩的全部行为（append / remove / 事件 / 属性）
 * ------------------------------------------------------------------ */
function makeElement(tag, owner) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    parentNode: null,
    children: [],
    attrs: {},
    listeners: [],
    style: {},
    setAttribute(name, value) {
      el.attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null;
    },
    appendChild(node) {
      node.parentNode = el;
      el.children.push(node);
      return node;
    },
    removeChild(node) {
      const index = el.children.indexOf(node);
      if (index >= 0) {
        el.children.splice(index, 1);
        node.parentNode = null;
      }
      return node;
    },
    addEventListener(type, handler) {
      el.listeners.push({ type, handler });
    },
    removeEventListener(type, handler) {
      const index = el.listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) el.listeners.splice(index, 1);
    },
    fire(type, event) {
      for (const entry of el.listeners.slice()) {
        if (entry.type === type) entry.handler(event || {});
      }
    },
    listenerCount(type) {
      return el.listeners.filter((entry) => entry.type === type).length;
    },
    owner,
  };
  return el;
}

function makeDocument() {
  const doc = {
    docListeners: [],
    createElement(tag) {
      return makeElement(tag, doc);
    },
    addEventListener(type, handler) {
      doc.docListeners.push({ type, handler });
    },
    removeEventListener(type, handler) {
      const index = doc.docListeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) doc.docListeners.splice(index, 1);
    },
    fire(type, event) {
      for (const entry of doc.docListeners.slice()) {
        if (entry.type === type) entry.handler(event || {});
      }
    },
    docListenerCount(type) {
      return doc.docListeners.filter((entry) => entry.type === type).length;
    },
  };
  doc.body = makeElement('body', doc);
  return doc;
}

/** 极简 React：hooks 直接求值，createElement 造出可断言的元素对象。 */
function makeFakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial;
      return [value, () => {}];
    },
    useEffect() {},
    useMemo(fn) {
      return fn();
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 沙箱 1：带 DOM 的浏览器环境
 * ------------------------------------------------------------------ */
const documentStub = makeDocument();
const registrations = [];

function makeSandbox(withDocument) {
  const sandbox = {
    window: { __ModuleLoader__: null, location: { href: 'http://127.0.0.1:3080/' } },
    location: { href: 'http://127.0.0.1:3080/' },
    localStorage: { getItem: () => null, setItem: () => {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: () => Promise.reject(new Error('offline in test')),
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    isFinite,
    Symbol,
    Promise,
    URL,
    URLSearchParams,
  };
  if (withDocument) sandbox.document = documentStub;
  sandbox.globalThis = sandbox;
  return sandbox;
}

function loadBundle(sandbox) {
  const loader = {
    load(registration) {
      registrations.push(registration);
    },
  };
  sandbox.window.__ModuleLoader__ = loader;
  vm.runInContext(source, vm.createContext(sandbox), { filename: 'client.js' });
  const registration = registrations[registrations.length - 1];
  return registration.factory((spec) => {
    if (spec === 'react') return makeFakeReact();
    throw new Error(`unexpected require: ${spec}`);
  });
}

const exported = loadBundle(makeSandbox(true));
const test = exported.__test;
/** bundle 里 CSS_TEXT 是 `[...].join('\n')` 的结果（字符串），这里兼容两种形态。 */
const CSS = Array.isArray(test.CSS_TEXT) ? test.CSS_TEXT.join('\n') : String(test.CSS_TEXT);
const t = (key) => (Object.prototype.hasOwnProperty.call(test.zh, key) ? test.zh[key] : key);

const HASH = 'a'.repeat(64);
const IMAGE_URL = `${test.routeUrl('/session-live/api/image')}?ref=${encodeURIComponent(`sha256:${HASH}`)}`;

/* ------------------------------------------------------------------ *
 * 1. 遮罩基本行为
 * ------------------------------------------------------------------ */
check('__test 暴露了 createImageViewer', () => {
  assert.equal(typeof test.createImageViewer, 'function');
});

check('open 把遮罩挂到 body 上，并返回 true', () => {
  const viewer = test.createImageViewer({ doc: documentStub, translate: t });
  assert.equal(viewer.open(IMAGE_URL, { alt: 'x' }), true);
  assert.equal(documentStub.body.children.length, 1);
  const overlay = documentStub.body.children[0];
  assert.equal(overlay.className, 'dsl-lightbox');
  assert.equal(overlay.parentNode, documentStub.body);
  assert.equal(viewer.isOpen(), true);
  viewer.close();
});

check('遮罩结构：box > img，另有提示行', () => {
  const viewer = test.createImageViewer({ doc: documentStub, translate: t });
  viewer.open(IMAGE_URL, { alt: '会话图' });
  const overlay = documentStub.body.children[0];
  assert.equal(overlay.children.length, 2);
  const box = overlay.children[0];
  assert.equal(box.className, 'dsl-lightbox-box');
  const img = box.children[0];
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.className, 'dsl-lightbox-img');
  assert.equal(img.getAttribute('src'), IMAGE_URL);
  assert.equal(img.getAttribute('alt'), '会话图');
  const hint = overlay.children[1];
  assert.equal(hint.className, 'dsl-lightbox-hint');
  assert.equal(hint.textContent, t('image.closeHint'));
  viewer.close();
});

check('未给 alt 时回落到 i18n 文案（不出现 undefined）', () => {
  const viewer = test.createImageViewer({ doc: documentStub, translate: t });
  viewer.open(IMAGE_URL);
  const img = documentStub.body.children[0].children[0].children[0];
  assert.equal(img.getAttribute('alt'), t('image.alt'));
  assert.equal(img.getAttribute('alt').includes('undefined'), false);
  viewer.close();
});

check('Esc 关闭遮罩，并解除 document 上的监听', () => {
  const viewer = test.createImageViewer({ doc: documentStub, translate: t });
  viewer.open(IMAGE_URL);
  assert.equal(documentStub.docListenerCount('keydown'), 1);
  documentStub.fire('keydown', { key: 'Escape' });
  assert.equal(documentStub.body.children.length, 0);
  assert.equal(documentStub.docListenerCount('keydown'), 0, '关闭后必须摘掉 keydown 监听，否则泄漏');
  assert.equal(viewer.isOpen(), false);
});

check('旧式 keyCode 27 也能关闭（部分浏览器不给 key）', () => {
  const viewer = test.createImageViewer({ doc: documentStub, translate: t });
  viewer.open(IMAGE_URL);
  documentStub.fire('keydown', { keyCode: 27 });
  assert.equal(documentStub.body.children.length, 0);
});

check('点遮罩空白处关闭', () => {
  const viewer = test.createImageViewer({ doc: documentStub, translate: t });
  viewer.open(IMAGE_URL);
  const overlay = documentStub.body.children[0];
  overlay.fire('click', { target: overlay });
  assert.equal(documentStub.body.children.length, 0);
});

check('点图片本身不关闭（用户可能正在看图）', () => {
  const viewer = test.createImageViewer({ doc: documentStub, translate: t });
  viewer.open(IMAGE_URL);
  const overlay = documentStub.body.children[0];
  const img = overlay.children[0].children[0];
  overlay.fire('click', { target: img });
  assert.equal(documentStub.body.children.length, 1, '点图片不该关掉遮罩');
  assert.equal(viewer.isOpen(), true);
  viewer.close();
});

check('重复 open 只留一个遮罩（前一个先被摘掉）', () => {
  const viewer = test.createImageViewer({ doc: documentStub, translate: t });
  viewer.open(IMAGE_URL);
  viewer.open(IMAGE_URL);
  assert.equal(documentStub.body.children.length, 1);
  assert.equal(documentStub.docListenerCount('keydown'), 1, '旧遮罩的监听必须一并解除');
  viewer.close();
  assert.equal(documentStub.body.children.length, 0);
});

check('open 拒绝空/非法 url，返回 false 且不挂任何节点', () => {
  const viewer = test.createImageViewer({ doc: documentStub, translate: t });
  assert.equal(viewer.open(''), false);
  assert.equal(viewer.open(null), false);
  assert.equal(viewer.open(undefined), false);
  assert.equal(viewer.open(42), false);
  assert.equal(documentStub.body.children.length, 0);
});

check('未打开时 close 返回 false（幂等，不抛）', () => {
  const viewer = test.createImageViewer({ doc: documentStub, translate: t });
  assert.equal(viewer.close(), false);
  viewer.open(IMAGE_URL);
  assert.equal(viewer.close(), true);
  assert.equal(viewer.close(), false);
});

/* ------------------------------------------------------------------ *
 * 2. 无 DOM 环境（SSR / 极早期 apply）不能抛错
 * ------------------------------------------------------------------ */
check('没有 document 时 open 安静返回 false，不抛错', () => {
  const headless = loadBundle(makeSandbox(false));
  const viewer = headless.__test.createImageViewer({ translate: (key) => key });
  assert.equal(viewer.open('/x.png'), false);
  assert.equal(viewer.isOpen(), false);
  assert.equal(viewer.close(), false);
});

/* ------------------------------------------------------------------ *
 * 3. 缩略图点击 → 真的挂出遮罩（端到端：组件 → viewer → DOM）
 * ------------------------------------------------------------------ */
const ACTIVITY = {
  seq: 9,
  turn: 2,
  step: 3,
  phase: 'idle',
  prompt: '看看这张图',
  reply: '看到了',
  toolCalls: 0,
  recent: [],
  error: null,
  compaction: null,
  turnStart: 1,
  turnEnd: 2,
  stepStart: 3,
  tool: null,
  model: { provider: 'autoclaw-cn', model: 'claude-sonnet-4', reasoningEffort: 'high' },
  image: { attachmentId: `sha256:${HASH}`, mediaType: 'image/png', width: 800, height: 600 },
};

const settings = test.defaultSettings();
const store = {
  get: () => settings,
  subscribe: () => () => {},
  load: () => Promise.resolve(settings),
  save: () => Promise.resolve({ ok: true }),
};

function renderPanel() {
  documentStub.body.children.length = 0;
  const Panel = test.createHoverPanel({
    getRow: () => ({ projectionValues: { liveActivity: ACTIVITY } }),
    store,
    react: makeFakeReact(),
    t,
  });
  return Panel({ sessionId: 'session-zoom-test' });
}

check('面板真的渲染出缩略图 <img>，且 src 指向图片路由', () => {
  const tree = renderPanel();
  assert.ok(tree, '有活动时必须渲染出面板');
  // 渲染树第一项就是缩略图（HoverPanel 的顺序：ImageThumb → ActivityLine → …）
  const thumbElement = tree.children[0];
  assert.equal(typeof thumbElement.type, 'function');
  const node = thumbElement.type(thumbElement.props);
  const img = node.children[0];
  assert.equal(img.type, 'img');
  assert.equal(img.props.className, 'dsl-thumb');
  assert.ok(img.props.src.includes('/session-live/api/image'), `src 应指向图片路由，实际 ${img.props.src}`);
  assert.ok(img.props.src.includes('ref='), 'src 必须带 ref 参数');
});

check('缩略图 title 带「点击放大」提示文案', () => {
  const tree = renderPanel();
  const node = tree.children[0].type(tree.children[0].props);
  const img = node.children[0];
  assert.ok(img.props.title.includes(t('image.zoomHint')), `title 实际为 ${img.props.title}`);
  assert.ok(img.props.title.includes('800×600'), 'title 应带上原始尺寸');
});

check('点击缩略图：掐断冒泡 + 真的挂出遮罩', () => {
  const tree = renderPanel();
  const node = tree.children[0].type(tree.children[0].props);
  const img = node.children[0];
  assert.equal(typeof img.props.onClick, 'function', '缩略图必须绑定 onClick');

  let prevented = 0;
  let stopped = 0;
  img.props.onClick({
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  });

  // 掐断冒泡是硬要求：会话行自身带点击处理，放过去会顺带把会话打开。
  assert.equal(prevented, 1, '必须 preventDefault');
  assert.equal(stopped, 1, '必须 stopPropagation，否则会连带打开会话');

  assert.equal(documentStub.body.children.length, 1, '点击后遮罩应挂在 body 上');
  const overlay = documentStub.body.children[0];
  assert.equal(overlay.className, 'dsl-lightbox');
  const bigImg = overlay.children[0].children[0];
  assert.equal(bigImg.getAttribute('src'), img.props.src, '大图必须是同一张图');

  // 两个遮罩实例各管各的：卸载掉这次渲染挂出来的
  documentStub.fire('keydown', { key: 'Escape' });
  assert.equal(documentStub.body.children.length, 0);
});

check('每次渲染出的面板各有独立遮罩，互不干扰', () => {
  const first = renderPanel();
  const firstImg = first.children[0].type(first.children[0].props).children[0];
  firstImg.props.onClick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(documentStub.body.children.length, 1);

  const second = renderPanel();
  const secondImg = second.children[0].type(second.children[0].props).children[0];
  secondImg.props.onClick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(documentStub.body.children.length, 1, '新实例 open 时旧遮罩应被摘掉（而不是堆两个）');

  documentStub.fire('keydown', { key: 'Escape' });
  assert.equal(documentStub.body.children.length, 0);
});

/* ------------------------------------------------------------------ *
 * 4. 样式与层级
 * ------------------------------------------------------------------ */
check('CSS 含 .dsl-lightbox 规则且层级高于宿主所有浮层', () => {
  const css = CSS;
  const found = /\.dsl-lightbox\{[^}]*z-index:(\d+)/.exec(css);
  assert.ok(found, 'CSS 里找不到 .dsl-lightbox 的 z-index');
  // 1250 = 宿主全部客户端包 client.js 里出现的最大 z-index（实测聚合）。
  assert.ok(Number(found[1]) > 1250, `遮罩层级必须高于宿主最高浮层 1250，实际 ${found[1]}`);
});

check('遮罩底色用宿主主题变量（不能钉死颜色，否则换主题会瞎）', () => {
  const css = CSS;
  const found = /\.dsl-lightbox\{([^}]*)\}/.exec(css);
  assert.ok(found);
  assert.ok(found[1].includes('--dsw-alias-bg-mask-drop'), '遮罩底色应取宿主 bg-mask-drop 变量');
  assert.ok(found[1].includes('position:fixed'), '遮罩必须 fixed 全屏');
});

check('缩略图有放大光标，大图有尺寸上限', () => {
  const css = CSS;
  assert.ok(/\.dsl-thumb\{[^}]*cursor:zoom-in/.test(css), '缩略图应有 cursor:zoom-in');
  assert.ok(/\.dsl-lightbox-img\{[^}]*max-height:86vh/.test(css), '大图应有 max-height 上限');
});

check('中英文都有放大相关文案，键名不含缺失项', () => {
  for (const key of ['image.zoomHint', 'image.closeHint']) {
    assert.equal(typeof test.zh[key], 'string', `zh 缺 ${key}`);
    assert.equal(typeof test.en[key], 'string', `en 缺 ${key}`);
    assert.ok(test.zh[key].length > 0 && test.en[key].length > 0, `${key} 不能为空`);
  }
});

/* ------------------------------------------------------------------ */
console.log('');
if (failures.length === 0) {
  console.log(`全部通过 ${checks} 项`);
  process.exit(0);
}
console.log(`${failures.length}/${checks} 项失败：`);
for (const { label, error } of failures) {
  console.log(`  - ${label}: ${error.message}`);
}
process.exit(1);
