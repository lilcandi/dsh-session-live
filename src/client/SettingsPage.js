/**
 * 独立设置页：注册到 `settings.section`。
 *
 * 三条硬要求：
 * 1. 有单独页面（不是塞在插件行里）。
 * 2. 改动即时生效（写穿到 store，hover 卡片立刻变）。
 * 3. 显示当前持久化通道，让用户知道设置存在哪儿。
 */

import { SETTINGS_SPEC, NS } from './logic.js';

const h = (type, props, ...children) => ({ type, props, children });

export function createSettingsPage({ store, react, translate, version }) {
  const useState = react.useState;
  const useEffect = react.useEffect;

  return function LiveActivitySettingsPage() {
    const [settings, setSettings] = useState(store.get());
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);
    const t = translate;

    useEffect(() => store.subscribe(setSettings), []);

    useEffect(() => {
      let alive = true;
      store.load().then(() => {
        if (alive) setSettings(store.get());
      });
      return () => {
        alive = false;
      };
    }, []);

    async function update(key, value) {
      setBusy(true);
      setSettings({ ...store.get(), [key]: value });
      const result = await store.patch(key, value);
      setStatus(result && result.ok ? t('settings.saved') : t('settings.saveFailed'));
      setBusy(false);
      setTimeout(() => setStatus(''), 2200);
    }

    async function reset() {
      setBusy(true);
      const result = await store.save(undefined);
      void result;
      setBusy(false);
      setStatus(t('settings.resetDone'));
      setTimeout(() => setStatus(''), 2200);
    }

    const rows = SETTINGS_SPEC.map((spec) => renderRow({ spec, settings, update, busy, t }));

    return h(
      'div',
      { className: 'dsl-settings', 'data-plugin': NS },
      h(
        'div',
        { className: 'dsl-settings-head' },
        h('div', { className: 'dsl-settings-title' }, t('settings.title')),
        h('div', { className: 'dsl-settings-sub' }, t('settings.subtitle')),
      ),
      h('div', { className: 'dsl-settings-body' }, ...rows),
      h(
        'div',
        { className: 'dsl-settings-foot' },
        h(
          'button',
          { type: 'button', className: 'dsl-btn', onClick: reset, disabled: busy },
          t('settings.reset'),
        ),
        h('span', { className: 'dsl-settings-meta' }, `${t('settings.transport')}: ${store.transport()}`),
        h('span', { className: 'dsl-settings-meta' }, `v${version}`),
        status !== '' ? h('span', { className: 'dsl-settings-status' }, status) : null,
      ),
    );
  };
}

function renderRow({ spec, settings, update, busy, t }) {
  const value = settings[spec.key];
  const label = t(`opt.${spec.key}`) || spec.zh;
  const help = t(`opt.${spec.key}.help`) || spec.zhHelp;
  if (spec.kind === 'boolean') {
    return h(
      'label',
      { className: 'dsl-setting-row', key: spec.key },
      h(
        'span',
        { className: 'dsl-setting-text' },
        h('span', { className: 'dsl-setting-label' }, label),
        help ? h('span', { className: 'dsl-setting-help' }, help) : null,
      ),
      h('input', {
        type: 'checkbox',
        className: 'dsl-switch',
        checked: value === true,
        disabled: busy,
        onChange: (event) => update(spec.key, event.target.checked === true),
      }),
    );
  }
  const min = typeof spec.min === 'number' ? spec.min : 0;
  const max = typeof spec.max === 'number' ? spec.max : 100;
  const step = typeof spec.step === 'number' ? spec.step : 1;
  return h(
    'label',
    { className: 'dsl-setting-row', key: spec.key },
    h(
      'span',
      { className: 'dsl-setting-text' },
      h('span', { className: 'dsl-setting-label' }, label),
      help ? h('span', { className: 'dsl-setting-help' }, help) : null,
    ),
    h(
      'span',
      { className: 'dsl-setting-control' },
      h('input', {
        type: 'range',
        className: 'dsl-range',
        min,
        max,
        step,
        value: typeof value === 'number' ? value : spec.default,
        disabled: busy,
        onChange: (event) => update(spec.key, Number(event.target.value)),
      }),
      h('span', { className: 'dsl-range-value' }, String(value)),
    ),
  );
}
