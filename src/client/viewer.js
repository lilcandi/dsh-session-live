/**
 * 原图放大预览（lightbox）。
 *
 * 为什么是原生 DOM 而不是 React 组件：缩略图住在宿主的悬停卡片里，
 * 鼠标一旦离开会话行，宿主就卸载整棵插件组件树——任何挂在 React 树里的
 * 遮罩都会跟着消失，用户连大图都来不及看。所以遮罩直接挂到 body，
 * 生命周期由自己管（Esc / 点遮罩 / 点图片以外区域）。
 *
 * 视觉基准抄宿主官方 lightbox（dsh-client-ui-attachment 的 mask 规则）：
 * fixed + inset:0 + 主题感知遮罩色 + blur(10px) + .16s ease-out 淡入。
 * 层级取 1300——实测宿主全部客户端包的最高 z-index 是 1250，
 * 高于它才能盖住设置弹窗之类的浮层。
 */

const LIGHTBOX_CLASS = 'dsl-lightbox';

/**
 * @param {{doc?: Document, translate?: (key: string) => string}} [options]
 * @returns {{open: (url: string, meta?: {alt?: string}) => boolean, close: () => boolean, isOpen: () => boolean}}
 */
export function createImageViewer(options) {
  const opts = options || {};
  const translate = typeof opts.translate === 'function' ? opts.translate : function (key) { return key; };
  let teardown = null;

  function docOf() {
    if (opts.doc) return opts.doc;
    return typeof document === 'undefined' ? null : document;
  }

  function close() {
    if (typeof teardown !== 'function') return false;
    const run = teardown;
    teardown = null;
    run();
    return true;
  }

  function open(url, meta) {
    const doc = docOf();
    if (!doc || !doc.body || typeof url !== 'string' || url === '') return false;
    close();

    const overlay = doc.createElement('div');
    overlay.className = LIGHTBOX_CLASS;

    const img = doc.createElement('img');
    img.className = LIGHTBOX_CLASS + '-img';
    img.setAttribute('src', url);
    img.setAttribute('alt', (meta && meta.alt) || translate('image.alt'));
    img.setAttribute('draggable', 'false');

    const hint = doc.createElement('div');
    hint.className = LIGHTBOX_CLASS + '-hint';
    hint.textContent = translate('image.closeHint');

    const box = doc.createElement('div');
    box.className = LIGHTBOX_CLASS + '-box';
    box.appendChild(img);

    overlay.appendChild(box);
    overlay.appendChild(hint);

    // 点图片本身不关（用户可能正在看图），点其余任何位置都关。
    const onOverlayClick = function (event) {
      if (event && event.target === img) return;
      close();
    };
    const onKey = function (event) {
      if (event && (event.key === 'Escape' || event.keyCode === 27)) close();
    };

    overlay.addEventListener('click', onOverlayClick);
    if (typeof doc.addEventListener === 'function') doc.addEventListener('keydown', onKey, true);

    teardown = function () {
      overlay.removeEventListener('click', onOverlayClick);
      if (typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onKey, true);
      if (overlay.parentNode && typeof overlay.parentNode.removeChild === 'function') {
        overlay.parentNode.removeChild(overlay);
      }
    };

    doc.body.appendChild(overlay);
    return true;
  }

  return {
    open: open,
    close: close,
    isOpen: function () { return typeof teardown === 'function'; },
  };
}
