/**
 * 浏览器半边 bundle。
 *
 * 形态与 @deepseek-ai/dsh-client-modules 的懒加载 CJS 模型一致：
 *   window.__ModuleLoader__.load({ id, factory })
 * 只有 factory 被真正 require 时才执行，模块副作用（含样式注入）都在 factory 里。
 *
 * 为什么手写而不用 tsdown：
 * 1) 客户端 bundle purity gate 禁止 value-import 任何 @deepseek-ai/* 包，
 *    React 只能从宿主模块表 seed 里 require，bundler 反而要额外配置擦除。
 * 2) 手写 CJS 的 require 就是宿主给的 require，取的是同一份 React 实例，
 *    不存在双 React 导致 hooks 失效的风险。
 * 3) 零构建 = 改完即生效，交付物就是源码本身。
 */
(() => {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return;
  try {
    window.__ModuleLoader__.load({
      id: 'dsh-session-live',
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        var react = require('react');
        var h = react.createElement;

        /* ---------------- 共享规格（与宿主半边同源语义） ---------------- */

        var PLUGIN_ID = 'dsh-session-live';
        var NS = 'dsh-session-live';
        var PROJECTION_KEY = 'liveActivity';
        var ROUTE_PREFIX = '/session-live';
        var HOVER_SLOT = 'sidebar.session.row.hover';
        var HOVER_SLOT_ID = 'live-activity';
        var HOVER_SLOT_ORDER = 150;
        var SETTINGS_SLOT = 'settings.section';
        var SETTINGS_SLOT_ID = 'dsh-session-live';
        var SETTINGS_SLOT_ORDER = 300;
        var VERSION = '0.1.0';
        var STORAGE_KEY = PLUGIN_ID + ':settings';
        var STYLE_TAG_ID = PLUGIN_ID + '/client.css';

        var SETTINGS_SPEC = [
          { key: 'enabled', kind: 'boolean', default: true },
          { key: 'showActivity', kind: 'boolean', default: true },
          { key: 'showRecent', kind: 'boolean', default: true },
          { key: 'showPreview', kind: 'boolean', default: true },
          { key: 'showTiming', kind: 'boolean', default: true },
          { key: 'showError', kind: 'boolean', default: true },
          { key: 'showCompaction', kind: 'boolean', default: true },
          { key: 'showImage', kind: 'boolean', default: true },
          { key: 'showModel', kind: 'boolean', default: true },
          { key: 'showUsage', kind: 'boolean', default: true },
          { key: 'dense', kind: 'boolean', default: false },
          { key: 'recentCount', kind: 'number', default: 5, min: 0, max: 12, step: 1 }
        ];

        function defaultSettings() {
          var out = {};
          for (var i = 0; i < SETTINGS_SPEC.length; i += 1) out[SETTINGS_SPEC[i].key] = SETTINGS_SPEC[i].default;
          return out;
        }

        function normalizeSettings(input) {
          var out = defaultSettings();
          if (input === null || typeof input !== 'object') return out;
          for (var i = 0; i < SETTINGS_SPEC.length; i += 1) {
            var spec = SETTINGS_SPEC[i];
            if (!Object.prototype.hasOwnProperty.call(input, spec.key)) continue;
            var value = input[spec.key];
            if (spec.kind === 'boolean') {
              if (typeof value === 'boolean') out[spec.key] = value;
              else if (value === 'true' || value === '1' || value === 1) out[spec.key] = true;
              else if (value === 'false' || value === '0' || value === 0) out[spec.key] = false;
              continue;
            }
            if (spec.kind === 'number') {
              var num = typeof value === 'number' ? value : Number(value);
              if (!isFinite(num)) continue;
              var min = typeof spec.min === 'number' ? spec.min : 0;
              var max = typeof spec.max === 'number' ? spec.max : 100;
              out[spec.key] = Math.min(max, Math.max(min, Math.round(num)));
            }
          }
          return out;
        }

        /* ---------------- 文案 ---------------- */

        var zh = {
          'activity.title': '当前活动',
          'activity.tool': '工具',
          'activity.thinking': '思考中',
          'recent.label': '最近',
          'recent.title': '最近的工具调用序列',
          'preview.prompt': '问',
          'preview.reply': '答',
          'notice.failed': '失败',
          'notice.interrupted': '已中断',
          'notice.compacted': '已压缩上下文',
          'image.title': '最近图片',
          'image.alt': '会话最近一张图片',
          'image.zoomHint': '点击放大',
          'image.closeHint': '点击任意处关闭 · Esc',
          'model.label': '模型',
          'model.title': '会话当前使用的模型',
          'usage.label': '用量',
          'usage.title': '本会话累计用量',
          'usage.input': '输入',
          'usage.output': '输出',
          'usage.turns': '轮',
          'settings.nav': '会话预览',
    'settings.title': '会话实时预览',
          'settings.subtitle': '鼠标悬停在左侧会话行上时，卡片里多出一块「这个会话此刻在干什么」。',
          'settings.reset': '恢复默认',
          'settings.resetDone': '已恢复默认',
          'settings.saved': '已保存',
          'settings.saveFailed': '保存失败，已退回本机存储',
          'settings.transport': '存储通道',
          'opt.enabled': '启用悬停实时预览',
          'opt.enabled.help': '关闭后悬停卡片不再插入任何内容。',
          'opt.showActivity': '显示当前活动行',
          'opt.showActivity.help': '正在跑的工具（名称 + 参数摘要 + 已运行时长）。',
          'opt.showRecent': '显示最近工具序列',
          'opt.showRecent.help': '最近若干次工具调用的小图标条。',
          'opt.showPreview': '显示内容预览',
          'opt.showPreview.help': '最近一条用户提示与助手回复摘要。',
          'opt.showTiming': '显示耗时',
          'opt.showTiming.help': '本轮 / 当前步 / 当前工具已运行多久。',
          'opt.showError': '显示异常',
          'opt.showError.help': '工具失败、轮次异常终止、被中断。',
          'opt.showCompaction': '显示压缩标记',
          'opt.showCompaction.help': '上下文压缩发生时给一条提示。',
          'opt.showImage': '显示最近图片',
          'opt.showImage.help': '最近一条用户消息里的图片缩略图。',
          'opt.showModel': '显示模型名称',
          'opt.showModel.help': '会话当前使用的模型（provider/model）。',
          'opt.showUsage': '显示用量与轮数',
          'opt.showUsage.help': '把对话轮数、token 用量、模型名合并成一行摘要。',
          'opt.dense': '紧凑模式',
          'opt.dense.help': '减少行距与字号，适合长会话列表。',
          'opt.recentCount': '最近工具条长度',
          'opt.recentCount.help': '0 表示隐藏。'
        };

        var en = {
          'activity.title': 'Current activity',
          'activity.tool': 'tool',
          'activity.thinking': 'Thinking',
          'recent.label': 'Recent',
          'recent.title': 'Most recent tool calls',
          'preview.prompt': 'Ask',
          'preview.reply': 'Reply',
          'notice.failed': 'Failed',
          'notice.interrupted': 'Interrupted',
          'notice.compacted': 'Context compacted',
          'image.title': 'Latest image',
          'image.alt': 'Latest image in this session',
          'image.zoomHint': 'Click to enlarge',
          'image.closeHint': 'Click anywhere to close · Esc',
          'model.label': 'Model',
          'model.title': 'Model currently used by this session',
          'usage.label': 'Usage',
          'usage.title': 'Session totals',
          'usage.input': 'in',
          'usage.output': 'out',
          'usage.turns': 'turns',
          'settings.nav': 'Session preview',
    'settings.title': 'Session live preview',
          'settings.subtitle': 'Hovering a session row in the sidebar now shows what that session is doing right now.',
          'settings.reset': 'Reset to defaults',
          'settings.resetDone': 'Defaults restored',
          'settings.saved': 'Saved',
          'settings.saveFailed': 'Save failed — fell back to local storage',
          'settings.transport': 'Storage',
          'opt.enabled': 'Enable hover live preview',
          'opt.enabled.help': 'When off, the hover card gains nothing.',
          'opt.showActivity': 'Show current activity line',
          'opt.showActivity.help': 'The tool currently running, with its argument summary and elapsed time.',
          'opt.showRecent': 'Show recent tool sequence',
          'opt.showRecent.help': 'A compact strip of the most recent tool calls.',
          'opt.showPreview': 'Show content preview',
          'opt.showPreview.help': 'One-line previews of the latest prompt and reply.',
          'opt.showTiming': 'Show timing',
          'opt.showTiming.help': 'How long the turn, step, or tool has been running.',
          'opt.showError': 'Show errors',
          'opt.showError.help': 'Tool failures, aborted turns, interrupted streams.',
          'opt.showCompaction': 'Show compaction marker',
          'opt.showCompaction.help': 'A hint when context compaction happened.',
          'opt.showImage': 'Show latest image',
          'opt.showImage.help': 'A thumbnail of the latest image from user messages.',
          'opt.showModel': 'Show model name',
          'opt.showModel.help': 'The model currently in use (provider/model).',
          'opt.showUsage': 'Show usage and turns',
          'opt.showUsage.help': 'Turn count, token usage, and model name on one summary line.',
          'opt.dense': 'Compact mode',
          'opt.dense.help': 'Tighter spacing and smaller type for long session lists.',
          'opt.recentCount': 'Recent tool strip length',
          'opt.recentCount.help': '0 hides the strip.'
        };

        /* ---------------- 纯函数：状态推导 ---------------- */

        var CATEGORY_GLYPH = {
          read: '◍',
          readImage: '◍',
          search: '⌕',
          write: '✎',
          edit: '✎',
          commands: '❯',
          code: '❯',
          webSearch: '⌕',
          webFetch: '⌕',
          subagents: '⧉',
          plan: '☑',
          questions: '?',
          tools: '•'
        };

        function glyphOf(category) {
          return CATEGORY_GLYPH[category] || CATEGORY_GLYPH.tools;
        }

        function formatDuration(ms) {
          if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
          if (ms < 1000) return '<1s';
          var total = Math.round(ms / 1000);
          if (total < 60) return total + 's';
          var minutes = Math.floor(total / 60);
          var seconds = total % 60;
          if (minutes < 60) return seconds === 0 ? minutes + 'm' : minutes + 'm' + seconds + 's';
          var hours = Math.floor(minutes / 60);
          return hours + 'h' + (minutes % 60) + 'm';
        }

        function elapsedSince(start, now) {
          if (typeof start !== 'number' || start <= 0) return 0;
          var current = typeof now === 'number' ? now : Date.now();
          return Math.max(0, current - start);
        }

        function deriveState(activity, row, now) {
          var current = typeof now === 'number' ? now : Date.now();
          void current;
          var running =
            (row && typeof row.running === 'boolean' ? row.running : false) ||
            (activity && activity.running === true);
          if (!activity) {
            return { kind: running ? 'running' : 'idle', since: 0, category: '', label: '' };
          }
          var tool = activity.tool;
          if (running && tool && tool.name) {
            var toolStart = typeof tool.startedAt === 'number' ? tool.startedAt : activity.toolStart;
            return {
              kind: 'tool',
              since: typeof toolStart === 'number' ? toolStart : 0,
              category: tool.category || 'tools',
              label: tool.name
            };
          }
          if (running) {
            var started =
              typeof activity.stepStart === 'number' && activity.stepStart > 0
                ? activity.stepStart
                : typeof activity.turnStart === 'number'
                  ? activity.turnStart
                  : 0;
            return { kind: 'thinking', since: started, category: 'tools', label: '' };
          }
          if (activity.error && activity.error.label) {
            return {
              kind: activity.error.kind === 'interrupted' ? 'interrupted' : 'error',
              since: typeof activity.errorAt === 'number' ? activity.errorAt : 0,
              category: 'tools',
              label: activity.error.label
            };
          }
          return { kind: 'idle', since: 0, category: '', label: '' };
        }

        function findRow(items, sessionId) {
          if (!items || typeof items.length !== 'number') return undefined;
          var target = String(sessionId);
          for (var i = 0; i < items.length; i += 1) {
            var item = items[i];
            if (!item) continue;
            var id = String(item.id !== undefined ? item.id : item.sessionId);
            if (id === target) return item;
          }
          return undefined;
        }

        /*
         * 从会话列表快照里按 sessionId 取行 —— 面板能否拿到数据的唯一入口。
         *
         * 权威形态（核实自 dsh-api-session-controller/lib/client.js 的 projectList）：
         *   sessions.list.getSnapshot() -> { ids, byId, phase, projectionsBySession }
         *   其中 byId[sessionId] 行自带 projectionValues，
         *   官方全部消费者（workspace / subagent / terminal）都读 byId。
         *
         * 历史缺陷：此处曾只读 snapshot.items —— 该字段在会话列表快照里不存在
         * （items 属于 manager.getListSnapshot() 的另一形态），于是 getRow 恒为
         * undefined、面板恒不渲染。items 现降级为兜底分支。
         */
        function rowOfSnapshot(snapshot, sessionId) {
          if (!snapshot || typeof snapshot !== 'object') return undefined;
          var key = String(sessionId);

          var byId = snapshot.byId;
          if (byId && typeof byId === 'object' && byId[key]) return byId[key];

          var legacy = findRow(snapshot.items, key);
          if (legacy !== undefined) return legacy;

          var projections = snapshot.projectionsBySession;
          if (projections && typeof projections === 'object' && projections[key]) {
            var values = projections[key].values;
            if (values) return { sessionId: key, projectionValues: values, running: false };
          }
          return undefined;
        }

        function hasContent(activity, settings, row) {
          if (!settings || settings.enabled === false) return false;
          var state = deriveState(activity, row, 0);
          if (settings.showActivity && state.kind !== 'idle') return true;
          if (settings.showError && activity && activity.error) return true;
          if (settings.showCompaction && activity && activity.compaction) return true;
          if (settings.showPreview && activity && (activity.prompt || activity.reply)) return true;
          if (
            settings.showRecent &&
            settings.recentCount > 0 &&
            activity &&
            activity.recent &&
            activity.recent.length > 0
          ) {
            return true;
          }
          if (settings.showActivity && activity && activity.lastTool && state.kind !== 'tool') return true;
          if (settings.showImage && activity && validImage(activity.image)) return true;
          if (settings.showUsage && (turnCount(activity) > 0 || tokenUsageOf(row) !== null)) return true;
          if (settings.showModel && activity && validModel(activity.model)) return true;
          return false;
        }

        /* ---- 图片与模型（与宿主折叠器的 sha256 白名单同规） ---- */

        function validImage(image) {
          return Boolean(
            image &&
              typeof image === 'object' &&
              typeof image.attachmentId === 'string' &&
              /^sha256:[a-f0-9]{64}$/.test(image.attachmentId)
          );
        }

        function validModel(model) {
          return Boolean(
            model &&
              typeof model === 'object' &&
              ((typeof model.model === 'string' && model.model !== '') ||
                (typeof model.provider === 'string' && model.provider !== ''))
          );
        }

        function modelLabel(model) {
          if (!validModel(model)) return '';
          var name = typeof model.model === 'string' ? model.model : '';
          var provider = typeof model.provider === 'string' ? model.provider : '';
          return name !== '' ? name : provider;
        }

        /* ---- 用量与轮数 ----
           token 值直接读宿主内置的 tokenUsage 投影（每行快照都带），
           不自己折、不开新路由；缺失就整行不显示，绝不让面板因此变空。 */

        function num(value) {
          return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
        }

        function formatTokens(value) {
          var n = num(value);
          if (n <= 0) return '0';
          if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
          if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
          return String(Math.round(n));
        }

        function turnCount(activity) {
          var n = activity && typeof activity.turn === 'number' ? activity.turn : 0;
          return Number.isFinite(n) && n > 0 ? n : 0;
        }

        function tokenUsageOf(row) {
          var values = row && row.projectionValues;
          var usage = values && typeof values === 'object' ? values.tokenUsage : null;
          if (!usage || typeof usage !== 'object') return null;
          var input = num(usage.uncachedInputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens);
          var output = num(usage.outputTokens);
          if (input + output <= 0) return null;
          return { input: input, output: output, total: input + output };
        }

        function shortModel(name) {
          if (typeof name !== 'string' || name === '') return '';
          var tail = name.slice(name.lastIndexOf('/') + 1);
          var base = tail.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
          return base.length > 20 ? base.slice(0, 19) + '…' : base;
        }

        function imageUrl(image) {
          if (!validImage(image)) return '';
          var params = new URLSearchParams();
          params.set('ref', image.attachmentId);
          if (typeof image.mediaType === 'string' && image.mediaType !== '') params.set('type', image.mediaType);
          return routeUrl(ROUTE_PREFIX + '/api/image?' + params.toString());
        }

        function routeUrl(path) {
          var base =
            typeof document !== 'undefined' && document.baseURI
              ? document.baseURI
              : typeof location !== 'undefined'
                ? location.href
                : 'http://localhost/';
          return new URL(String(path).replace(/^\/+/, ''), base).href;
        }

        /* ---------------- 设置 store（configForms → 路由 → localStorage） ---------------- */

        function safeStorage() {
          try {
            if (typeof localStorage === 'undefined') return null;
            return localStorage;
          } catch (_error) {
            return null;
          }
        }

        function readLocal() {
          var storage = safeStorage();
          if (storage === null) return null;
          try {
            var raw = storage.getItem(STORAGE_KEY);
            if (typeof raw !== 'string' || raw === '') return null;
            return normalizeSettings(JSON.parse(raw));
          } catch (_error) {
            return null;
          }
        }

        function writeLocal(settings) {
          var storage = safeStorage();
          if (storage === null) return false;
          try {
            storage.setItem(STORAGE_KEY, JSON.stringify(settings));
            return true;
          } catch (_error) {
            return false;
          }
        }

        function settingsUrl() {
          try {
            return routeUrl(ROUTE_PREFIX + '/api/settings');
          } catch (_error) {
            return '';
          }
        }

        function createSettingsStore(ctx) {
          var current = readLocal() || defaultSettings();
          var transport = 'local';
          var listeners = [];

          function publish(next, nextTransport) {
            current = normalizeSettings(next);
            if (nextTransport !== undefined) transport = nextTransport;
            var copy = listeners.slice();
            for (var i = 0; i < copy.length; i += 1) {
              try {
                copy[i](current);
              } catch (_error) {
                /* 单个订阅者出错不能拖垮其他订阅者 */
              }
            }
          }

          function subscribe(listener) {
            listeners.push(listener);
            return function () {
              var index = listeners.indexOf(listener);
              if (index >= 0) listeners.splice(index, 1);
            };
          }

          function formOf() {
            try {
              var forms = ctx && ctx.configForms;
              if (!forms || typeof forms.get !== 'function') return null;
              var form = forms.get(PLUGIN_ID);
              if (!form || typeof form.getSnapshot !== 'function') return null;
              return form;
            } catch (_error) {
              return null;
            }
          }

          function loadFromForms() {
            var form = formOf();
            if (form === null) return null;
            try {
              var snapshot = form.getSnapshot();
              if (!snapshot || snapshot.status !== 'ready') return null;
              var value = snapshot.value;
              if (!value || typeof value !== 'object') return null;
              if (value.settings && typeof value.settings === 'object') return value.settings;
              return value;
            } catch (_error) {
              return null;
            }
          }

          function loadFromRoute() {
            if (typeof fetch !== 'function') return Promise.resolve(null);
            var url = settingsUrl();
            if (url === '') return Promise.resolve(null);
            return fetch(url, { credentials: 'same-origin' })
              .then(function (response) {
                if (!response.ok) return null;
                return response.json();
              })
              .then(function (body) {
                if (!body || typeof body !== 'object' || typeof body.settings !== 'object') return null;
                return body.settings;
              })
              .catch(function () {
                return null;
              });
          }

          function load() {
            return loadFromRoute()
              .then(function (viaRoute) {
                if (viaRoute !== null) {
                  publish(viaRoute, 'route');
                  return current;
                }
                var viaForms = loadFromForms();
                if (viaForms !== null) {
                  publish(viaForms, 'config');
                  return current;
                }
                publish(current, 'local');
                return current;
              })
              .catch(function () {
                return current;
              });
          }

          function saveToForms(settings) {
            var form = formOf();
            if (form === null) return Promise.resolve(false);
            try {
              var snapshot = form.getSnapshot();
              if (!snapshot || snapshot.status !== 'ready' || snapshot.writable === false) {
                return Promise.resolve(false);
              }
            } catch (_error) {
              return Promise.resolve(false);
            }
            var keys = Object.keys(settings);
            var wrote = 0;
            var chain = Promise.resolve();
            keys.forEach(function (key) {
              chain = chain.then(function () {
                return Promise.resolve()
                  .then(function () {
                    return form.set(key, settings[key]);
                  })
                  .then(function () {
                    wrote += 1;
                  })
                  .catch(function () {
                    /* 单字段失败不中断，最后按写成功数判断 */
                  });
              });
            });
            return chain.then(function () {
              return wrote > 0;
            });
          }

          function saveToRoute(settings) {
            if (typeof fetch !== 'function') return Promise.resolve(false);
            var url = settingsUrl();
            if (url === '') return Promise.resolve(false);
            return fetch(url, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ plugin: PLUGIN_ID, settings: settings })
            })
              .then(function (response) {
                return response.ok;
              })
              .catch(function () {
                return false;
              });
          }

          function save(next) {
            var settings = normalizeSettings(next);
            publish(settings, undefined);
            return saveToForms(settings)
              .then(function (ok) {
                if (ok) {
                  transport = 'config';
                  return { ok: true, transport: transport };
                }
                return saveToRoute(settings).then(function (okRoute) {
                  if (okRoute) {
                    transport = 'route';
                    return { ok: true, transport: transport };
                  }
                  var local = writeLocal(settings);
                  transport = local ? 'local' : 'memory';
                  return { ok: local, transport: transport };
                });
              })
              .catch(function () {
                var local = writeLocal(settings);
                transport = local ? 'local' : 'memory';
                return { ok: local, transport: transport };
              });
          }

          return {
            get: function () {
              return current;
            },
            transport: function () {
              return transport;
            },
            subscribe: subscribe,
            load: load,
            save: save,
            patch: function (key, value) {
              var next = {};
              for (var k in current) if (Object.prototype.hasOwnProperty.call(current, k)) next[k] = current[k];
              next[key] = value;
              return save(next);
            }
          };
        }

        /* ---------------- 样式 ---------------- */

        /*
         * 两套色系刻意分开，不要合并：
         *
         * 1. 悬停面板（.dsl-panel 子树）渲染在宿主的悬停卡片里，该卡片由宿主自己硬编码为
         *    深色底 + 浅色字，完全不跟随主题：
         *      .hoverTitle{color:#fff}  .hoverTime{color:#cfd3d6}  .hoverStatus{color:#adb2b8}
         *    （dsh-client-ui-workspace/lib/client.js 的 Rows.module CSS）
         *    所以这里也钉死同一套浅色。若改用 --dsw-alias-label-* 主题变量，浅色主题下会解析成
         *    bluish-700 深灰，落在深色卡片上就是「深底深字」，肉眼不可读。
         *
         * 2. 设置页（.dsl-settings 子树）渲染在常规设置面板里，跟随主题，继续用 alias 变量。
         *
         * 语义色用 --dsw-static-*-400 亮色档：static 色板定义在 body 上、不随主题翻转，
         * 正好适配恒定深色的卡片底。
         */
        var CSS_TEXT = [
          '.dsl-panel{display:flex;flex-direction:column;gap:3px;margin:1px 0 3px;font-size:12px;line-height:1.4;color:#cfd3d6}',
          '.dsl-panel.dsl-dense{gap:2px;font-size:11px;line-height:1.3}',
          '.dsl-row{display:flex;align-items:baseline;gap:6px;min-width:0}',
          '.dsl-row-live{color:#fff}',
          '.dsl-row-bad{color:var(--dsw-static-red-400,#ff8a80)}',
          '.dsl-row-warn{color:var(--dsw-static-amber-400,#f7ad31)}',
          '.dsl-row-dim{color:#adb2b8}',
          '.dsl-glyph{flex:0 0 auto;width:12px;text-align:center;opacity:.8;font-variant-numeric:tabular-nums}',
          '.dsl-glyph-live{opacity:1;color:var(--dsw-static-deepseek-400,#7aaaff);animation:dsl-pulse 1.4s ease-in-out infinite}',
          '.dsl-glyph-bad{opacity:1;color:var(--dsw-static-red-400,#ff8a80)}',
          '.dsl-glyph-warn{opacity:1;color:var(--dsw-static-amber-400,#f7ad31)}',
          '@keyframes dsl-pulse{0%,100%{opacity:1}50%{opacity:.38}}',
          '@media (prefers-reduced-motion:reduce){.dsl-glyph-live{animation:none}}',
          '.dsl-name{flex:0 0 auto;font-weight:500;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.dsl-detail{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}',
          '.dsl-time{flex:0 0 auto;margin-left:auto;font-variant-numeric:tabular-nums;opacity:.85}',
          '.dsl-label{flex:0 0 auto;opacity:.72;font-size:.92em}',
          '.dsl-recent-track{display:inline-flex;gap:3px;align-items:center;min-width:0;overflow:hidden}',
          '.dsl-dot{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:3px;font-size:10px;background:rgba(255,255,255,.1);color:inherit}',
          '.dsl-dot-bad{color:var(--dsw-static-red-400,#ff8a80)}',
          '.dsl-preview{display:flex;flex-direction:column;gap:2px}',
          '.dsl-preview-row{align-items:center}',
          '.dsl-preview-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.9}',
          '.dsl-notices{display:flex;flex-direction:column;gap:2px}',
          '.dsl-thumb-row{display:flex;margin:0}',
          '.dsl-thumb{display:block;max-width:58%;max-height:54px;border-radius:5px;border:1px solid rgba(255,255,255,.16);object-fit:cover;background:rgba(255,255,255,.06);cursor:zoom-in}',
          '.dsl-panel.dsl-dense .dsl-thumb{max-height:40px;border-radius:4px}',
          '.dsl-lightbox{position:fixed;inset:0;z-index:1300;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--dsw-alias-bg-mask-drop,rgba(0,0,0,.62));backdrop-filter:blur(10px);animation:.16s ease-out dsl-fade-in;cursor:zoom-out}',
          '.dsl-lightbox-box{display:flex;align-items:center;justify-content:center}',
          '.dsl-lightbox-img{display:block;max-width:92vw;max-height:86vh;object-fit:contain;border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.5);cursor:default}',
          '.dsl-lightbox-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#cfd3d6)}',
          '@keyframes dsl-fade-in{from{opacity:0}to{opacity:1}}',
          '@media (prefers-reduced-motion:reduce){.dsl-lightbox{animation:none}}',
          '.dsl-usage .dsl-name{font-family:inherit;font-weight:500;color:#fff;max-width:100%;font-variant-numeric:tabular-nums}',
          '.dsl-settings{display:flex;flex-direction:column;gap:14px;padding:2px 0 8px}',
          '.dsl-settings-head{display:flex;flex-direction:column;gap:4px}',
          '.dsl-settings-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
          '.dsl-settings-sub{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#81858c)}',
          '.dsl-settings-body{display:flex;flex-direction:column;gap:2px}',
          '.dsl-setting-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:9px 2px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.14));cursor:pointer}',
          '.dsl-setting-row:last-child{border-bottom:none}',
          '.dsl-setting-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
          '.dsl-setting-label{font-size:13px;color:var(--dsw-alias-label-primary,#1f2329)}',
          '.dsl-setting-help{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,#81858c)}',
          '.dsl-setting-control{display:inline-flex;align-items:center;gap:8px;flex:0 0 auto}',
          '.dsl-switch{width:15px;height:15px;accent-color:var(--dsw-alias-button-info-fill,#4d6bfe);cursor:pointer}',
          '.dsl-range{width:110px;accent-color:var(--dsw-alias-button-info-fill,#4d6bfe);cursor:pointer}',
          '.dsl-range-value{min-width:18px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px}',
          '.dsl-settings-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#a2a6ad)}',
          '.dsl-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.24));background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font-size:12px;cursor:pointer}',
          '.dsl-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
          '.dsl-btn:disabled{opacity:.5;cursor:default}',
          '.dsl-settings-status{color:var(--dsw-alias-button-info-fill,#4d6bfe)}'
        ].join('\n');

        function ensureStyle() {
          if (typeof document === 'undefined') return;
          try {
            if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') !== null) return;
            var tag = document.createElement('style');
            tag.dataset.plugin = PLUGIN_ID;
            tag.dataset.pluginCss = STYLE_TAG_ID;
            tag.textContent = CSS_TEXT;
            document.head.appendChild(tag);
          } catch (_error) {
            /* 样式失败只影响观感，不该阻断功能 */
          }
        }

        /* ---------------- React 组件 ---------------- */

        var useState = react.useState;
        var useEffect = react.useEffect;
        var useMemo = react.useMemo;

        function useSettings(store) {
          var pair = useState(store.get());
          var settings = pair[0];
          var setSettings = pair[1];
          useEffect(function () {
            return store.subscribe(setSettings);
          }, [store]);
          return settings;
        }

        /** 每秒一次的重绘：只在有活动且开启耗时时跑。 */
        function useTick(active) {
          var pair = useState(0);
          var tick = pair[0];
          var setTick = pair[1];
          useEffect(
            function () {
              if (!active) return undefined;
              var timer = setTimeout(function () {
                setTick(function (value) {
                  return value + 1;
                });
              }, 1000);
              return function () {
                clearTimeout(timer);
              };
            },
            [active, tick]
          );
          return tick;
        }

        function ActivityLine(props) {
          void props.tick;
          var activity = props.activity;
          var state = props.state;
          var settings = props.settings;
          var t = props.t;
          if (!settings.showActivity) return null;
          if (state.kind === 'tool') {
            var elapsed = settings.showTiming ? formatDuration(elapsedSince(state.since, Date.now())) : '';
            return h(
              'div',
              { className: 'dsl-row dsl-row-live', title: t('activity.title') },
              h('span', { className: 'dsl-glyph dsl-glyph-live' }, glyphOf(state.category)),
              h('span', { className: 'dsl-name' }, state.label || t('activity.tool')),
              activity && activity.tool && activity.tool.detail
                ? h('span', { className: 'dsl-detail' }, activity.tool.detail)
                : null,
              elapsed !== '' ? h('span', { className: 'dsl-time' }, elapsed) : null
            );
          }
          if (state.kind === 'thinking') {
            var thinking = settings.showTiming ? formatDuration(elapsedSince(state.since, Date.now())) : '';
            return h(
              'div',
              { className: 'dsl-row dsl-row-live' },
              h('span', { className: 'dsl-glyph dsl-glyph-live' }, '⋯'),
              h('span', { className: 'dsl-name' }, t('activity.thinking')),
              thinking !== '' ? h('span', { className: 'dsl-time' }, thinking) : null
            );
          }
          if (activity && activity.lastTool && activity.lastTool.name) {
            var took =
              settings.showTiming && activity.lastTool.durationMs > 0
                ? formatDuration(activity.lastTool.durationMs)
                : '';
            return h(
              'div',
              { className: 'dsl-row' },
              h(
                'span',
                { className: activity.lastTool.failed ? 'dsl-glyph dsl-glyph-bad' : 'dsl-glyph' },
                glyphOf(activity.lastTool.category)
              ),
              h('span', { className: 'dsl-name' }, activity.lastTool.name),
              activity.lastTool.detail ? h('span', { className: 'dsl-detail' }, activity.lastTool.detail) : null,
              took !== '' ? h('span', { className: 'dsl-time' }, took) : null
            );
          }
          return null;
        }

        function RecentStrip(props) {
          var activity = props.activity;
          var settings = props.settings;
          var t = props.t;
          if (!settings.showRecent || !activity || !activity.recent || !activity.recent.length) return null;
          var count = typeof settings.recentCount === 'number' ? settings.recentCount : 0;
          if (count <= 0) return null;
          var items = activity.recent.slice(0, count);
          if (items.length === 0) return null;
          var dots = items.map(function (item, index) {
            return h(
              'span',
              {
                key: index + '-' + item.name,
                className: item.failed ? 'dsl-dot dsl-dot-bad' : 'dsl-dot',
                title: item.detail ? item.name + ' · ' + item.detail : item.name
              },
              glyphOf(item.category)
            );
          });
          return h(
            'div',
            { className: 'dsl-row dsl-recent', title: t('recent.title') },
            h('span', { className: 'dsl-label' }, t('recent.label')),
            h.apply(null, ['span', { className: 'dsl-recent-track' }].concat(dots))
          );
        }

        function PreviewLines(props) {
          var activity = props.activity;
          var settings = props.settings;
          var t = props.t;
          if (!settings.showPreview || !activity) return null;
          var prompt = typeof activity.prompt === 'string' ? activity.prompt : '';
          var reply = typeof activity.reply === 'string' ? activity.reply : '';
          if (prompt === '' && reply === '') return null;
          return h(
            'div',
            { className: 'dsl-preview' },
            prompt !== ''
              ? h(
                  'div',
                  { className: 'dsl-row dsl-preview-row' },
                  h('span', { className: 'dsl-label' }, t('preview.prompt')),
                  h('span', { className: 'dsl-preview-text' }, prompt)
                )
              : null,
            reply !== ''
              ? h(
                  'div',
                  { className: 'dsl-row dsl-preview-row' },
                  h('span', { className: 'dsl-label' }, t('preview.reply')),
                  h('span', { className: 'dsl-preview-text' }, reply)
                )
              : null
          );
        }

        function NoticeLines(props) {
          var activity = props.activity;
          var state = props.state;
          var settings = props.settings;
          var t = props.t;
          var rows = [];
          if (settings.showError && state.kind === 'error') {
            rows.push(
              h(
                'div',
                { className: 'dsl-row dsl-row-bad', key: 'error' },
                h('span', { className: 'dsl-glyph dsl-glyph-bad' }, '!'),
                h('span', { className: 'dsl-name' }, t('notice.failed')),
                h('span', { className: 'dsl-detail' }, state.label || '')
              )
            );
          }
          if (settings.showError && state.kind === 'interrupted') {
            rows.push(
              h(
                'div',
                { className: 'dsl-row dsl-row-warn', key: 'interrupted' },
                h('span', { className: 'dsl-glyph dsl-glyph-warn' }, '!'),
                h('span', { className: 'dsl-name' }, t('notice.interrupted'))
              )
            );
          }
          if (settings.showCompaction && activity && activity.compaction) {
            rows.push(
              h(
                'div',
                { className: 'dsl-row dsl-row-dim', key: 'compaction' },
                h('span', { className: 'dsl-glyph' }, '⤵'),
                h('span', { className: 'dsl-name' }, t('notice.compacted'))
              )
            );
          }
          if (rows.length === 0) return null;
          return h.apply(null, ['div', { className: 'dsl-notices' }].concat(rows));
        }

        /* ---- 原图放大遮罩 ----
           原生 DOM，不挂 React 树：悬停卡片在鼠标离开时会带着整棵插件树卸载，
           遮罩要是挂在树里，用户连大图都来不及看。挂在 body 上，生命周期自管
           （Esc / 点遮罩 / 点图片以外区域）。
           层级 1300 高于宿主全部客户端浮层（实测宿主最高 z-index = 1250）。 */
        function createImageViewer(options) {
          var opts = options || {};
          var translate = typeof opts.translate === 'function' ? opts.translate : function (key) { return key; };
          var teardown = null;

          function close() {
            if (typeof teardown !== 'function') return false;
            var run = teardown;
            teardown = null;
            run();
            return true;
          }

          function open(url, meta) {
            var doc = opts.doc || (typeof document === 'undefined' ? null : document);
            if (!doc || !doc.body || typeof url !== 'string' || url === '') return false;
            close();
            var overlay = doc.createElement('div');
            overlay.className = 'dsl-lightbox';
            var img = doc.createElement('img');
            img.className = 'dsl-lightbox-img';
            img.setAttribute('src', url);
            img.setAttribute('alt', (meta && meta.alt) || translate('image.alt'));
            img.setAttribute('draggable', 'false');
            var hint = doc.createElement('div');
            hint.className = 'dsl-lightbox-hint';
            hint.textContent = translate('image.closeHint');
            var box = doc.createElement('div');
            box.className = 'dsl-lightbox-box';
            box.appendChild(img);
            overlay.appendChild(box);
            overlay.appendChild(hint);
            var onOverlayClick = function (event) {
              if (event && event.target === img) return;
              close();
            };
            var onKey = function (event) {
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

          return { open: open, close: close, isOpen: function () { return typeof teardown === 'function'; } };
        }

        /* 最近一张用户图片的缩略图；点击放大到原尺寸，加载失败时直接藏掉 <img>，整行塌缩。 */
        function ImageThumb(props) {
          var activity = props.activity;
          var t = props.t;
          var viewer = props.viewer;
          var image = activity && activity.image;
          if (!validImage(image)) return null;
          var url = imageUrl(image);
          if (url === '') return null;
          var width = typeof image.width === 'number' && image.width > 0 ? image.width : 0;
          var height = typeof image.height === 'number' && image.height > 0 ? image.height : 0;
          var title = width > 0 && height > 0 ? t('image.title') + ' · ' + width + '×' + height : t('image.title');
          return h(
            'div',
            { className: 'dsl-thumb-row' },
            h('img', {
              className: 'dsl-thumb',
              src: url,
              alt: t('image.alt'),
              title: title + ' · ' + t('image.zoomHint'),
              draggable: false,
              onClick: function (event) {
                /* 必须掐断冒泡：会话行自身带点击处理，放过去会顺带把会话打开。 */
                if (event) {
                  if (typeof event.preventDefault === 'function') event.preventDefault();
                  if (typeof event.stopPropagation === 'function') event.stopPropagation();
                }
                if (viewer) viewer.open(url, { alt: t('image.alt') });
              },
              onError: function (event) {
                var el = event && event.currentTarget;
                if (el && el.style) el.style.display = 'none';
              }
            })
          );
        }

        /* 一行概况：对话轮数 · token 用量 · 模型短名。
           三项合并成一行，既省高度，也让「聊了多少、烧了多少、用哪个模型」一次读完。 */
        function UsageLine(props) {
          var activity = props.activity;
          var settings = props.settings;
          var row = props.row;
          var t = props.t;
          if (!settings.showUsage) return null;
          var parts = [];
          var turns = turnCount(activity);
          if (turns > 0) parts.push(turns + ' ' + t('usage.turns'));
          var usage = tokenUsageOf(row);
          if (usage !== null) parts.push(formatTokens(usage.total));
          var model = activity && activity.model;
          var label = settings.showModel ? shortModel(modelLabel(model)) : '';
          if (label !== '') parts.push(label);
          if (parts.length === 0) return null;
          var effort =
            model && typeof model.reasoningEffort === 'string' ? model.reasoningEffort : '';
          var head =
            usage === null
              ? t('usage.title')
              : t('usage.title') +
                ' · ' +
                t('usage.input') +
                ' ' +
                formatTokens(usage.input) +
                ' · ' +
                t('usage.output') +
                ' ' +
                formatTokens(usage.output);
          var title = effort !== '' ? head + ' · ' + effort : head;
          return h(
            'div',
            { className: 'dsl-row dsl-usage', title: title },
            h('span', { className: 'dsl-label' }, t('usage.label')),
            h('span', { className: 'dsl-name' }, parts.join(' · '))
          );
        }

        /* ---------------- 插槽组件工厂 ---------------- */

        function createHoverPanel(options) {
          var getRow = options.getRow;
          var store = options.store;
          var t = options.t;
          /* 一个面板一个遮罩实例；悬停卡片同一时刻只显示一个，够用。 */
          var viewer = createImageViewer({ translate: t });

          return function HoverLiveActivity(props) {
            var settings = useSettings(store);
            var sessionId = props && props.sessionId;
            var row = getRow(sessionId);
            var activity = row && row.projectionValues ? row.projectionValues[PROJECTION_KEY] : undefined;
            var state = deriveState(activity, row, Date.now());
            var live = state.kind === 'tool' || state.kind === 'thinking';
            useTick(live && settings.showTiming);

            var content = useMemo(
              function () {
                return hasContent(activity, settings, row);
              },
              [activity, settings, row]
            );
            if (!content) return null;
            return h(
              'div',
              {
                className: settings.dense ? 'dsl-panel dsl-dense' : 'dsl-panel',
                'data-plugin': PLUGIN_ID,
                'data-session': String(sessionId || '')
              },
              h(ImageThumb, { activity: activity, t: t, viewer: viewer }),
              h(ActivityLine, { activity: activity, state: state, settings: settings, t: t }),
              h(UsageLine, { activity: activity, settings: settings, row: row, t: t }),
              h(RecentStrip, { activity: activity, settings: settings, t: t }),
              h(PreviewLines, { activity: activity, settings: settings, t: t }),
              h(NoticeLines, { activity: activity, state: state, settings: settings, t: t })
            );
          };
        }

        function createSettingsPage(options) {
          var store = options.store;
          var t = options.t;

          return function LiveActivitySettingsPage() {
            var settings = useSettings(store);
            var busyPair = useState(false);
            var busy = busyPair[0];
            var setBusy = busyPair[1];
            var statusPair = useState('');
            var status = statusPair[0];
            var setStatus = statusPair[1];

            useEffect(
              function () {
                store.load();
              },
              [store]
            );

            function flash(text) {
              setStatus(text);
              setTimeout(function () {
                setStatus('');
              }, 2200);
            }

            function update(key, value) {
              setBusy(true);
              store.patch(key, value).then(function (result) {
                setBusy(false);
                flash(result && result.ok ? t('settings.saved') : t('settings.saveFailed'));
              });
            }

            function reset() {
              setBusy(true);
              store.save(defaultSettings()).then(function () {
                setBusy(false);
                flash(t('settings.resetDone'));
              });
            }

            var rows = SETTINGS_SPEC.map(function (spec) {
              var value = settings[spec.key];
              var label = t('opt.' + spec.key);
              var help = t('opt.' + spec.key + '.help');
              var text = h(
                'span',
                { className: 'dsl-setting-text' },
                h('span', { className: 'dsl-setting-label' }, label),
                help ? h('span', { className: 'dsl-setting-help' }, help) : null
              );
              if (spec.kind === 'boolean') {
                return h(
                  'label',
                  { className: 'dsl-setting-row', key: spec.key },
                  text,
                  h('input', {
                    type: 'checkbox',
                    className: 'dsl-switch',
                    checked: value === true,
                    disabled: busy,
                    onChange: function (event) {
                      update(spec.key, event.target.checked === true);
                    }
                  })
                );
              }
              var min = typeof spec.min === 'number' ? spec.min : 0;
              var max = typeof spec.max === 'number' ? spec.max : 100;
              var step = typeof spec.step === 'number' ? spec.step : 1;
              return h(
                'label',
                { className: 'dsl-setting-row', key: spec.key },
                text,
                h(
                  'span',
                  { className: 'dsl-setting-control' },
                  h('input', {
                    type: 'range',
                    className: 'dsl-range',
                    min: min,
                    max: max,
                    step: step,
                    value: typeof value === 'number' ? value : spec.default,
                    disabled: busy,
                    onChange: function (event) {
                      update(spec.key, Number(event.target.value));
                    }
                  }),
                  h('span', { className: 'dsl-range-value' }, String(value))
                )
              );
            });

            return h(
              'div',
              { className: 'dsl-settings', 'data-plugin': PLUGIN_ID },
              h(
                'div',
                { className: 'dsl-settings-head' },
                h('div', { className: 'dsl-settings-title' }, t('settings.title')),
                h('div', { className: 'dsl-settings-sub' }, t('settings.subtitle'))
              ),
              h.apply(null, ['div', { className: 'dsl-settings-body' }].concat(rows)),
              h(
                'div',
                { className: 'dsl-settings-foot' },
                h(
                  'button',
                  { type: 'button', className: 'dsl-btn', onClick: reset, disabled: busy },
                  t('settings.reset')
                ),
                h('span', { className: 'dsl-settings-meta' }, t('settings.transport') + ': ' + store.transport()),
                h('span', { className: 'dsl-settings-meta' }, 'v' + VERSION),
                status !== '' ? h('span', { className: 'dsl-settings-status' }, status) : null
              )
            );
          };
        }

        /* ---------------- 会话列表读取 ---------------- */

        function createRowReader(sessions) {
          return function getRow(sessionId) {
            if (!sessions || typeof sessions !== 'object') return undefined;
            try {
              var list = sessions.list;
              if (!list || typeof list.getSnapshot !== 'function') return undefined;
              return rowOfSnapshot(list.getSnapshot(), sessionId);
            } catch (_error) {
              return undefined;
            }
          };
        }

        function createRowSubscription(sessions) {
          return function subscribeRows(listener) {
            if (!sessions || typeof sessions !== 'object') return function () {};
            try {
              var list = sessions.list;
              if (!list || typeof list.subscribe !== 'function') return function () {};
              var dispose = list.subscribe(listener);
              return typeof dispose === 'function' ? dispose : function () {};
            } catch (_error) {
              return function () {};
            }
          };
        }

        /* ---------------- 服务读取（不依赖 inject 声明） ---------------- */

        /*
         * cordis 的 Context 是个 proxy：读取「未 inject 且未提供」的服务会直接抛
         * `cannot get property "X" without inject`。更隐蔽的是时序——即使该服务稍后
         * 会被提供，apply 抢跑那一刻读到它就是崩。
         *
         * `ctx.get(name, false)` 是 cordis 反射层的公开逃生口（strict=false 表示不要求
         * 提供者 fiber 处于 active），未提供时返回 undefined 而不抛。
         * 旧版 cordis 没有它，回退到 try/catch 裸读。
         *
         * 两条路径都失败时返回 undefined，让调用方降级，绝不让插件进 failed。
         */
        function readService(ctx, name) {
          if (!ctx) return undefined;
          try {
            if (typeof ctx.get === 'function') {
              var viaGet = ctx.get(name, false);
              if (viaGet !== undefined) return viaGet;
            }
          } catch (_error) {
            /* 旧版 cordis 无 ctx.get，走下面的兜底 */
          }
          try {
            return ctx[name];
          } catch (_error) {
            return undefined;
          }
        }

        /* ---------------- 插件本体 ---------------- */

        /*
         * 只声明 apply 里立刻要用的两个服务：slots（注册插槽）与 locale（注册文案）。
         * `sessions` 刻意不写进 inject——它由 readService 在运行时按需读取，
         * 这样即便某个宿主版本没有它，插件也只是降级，而不是卡在 pending。
         */
        /*
         * 声明 apply 里立刻要用的服务。
         *
         * `sessions` 必须声明：cordis 只等待 inject 里列出的服务，没列出时
         * apply 可能在该服务挂上之前就跑，readService 读到 undefined ——
         * 那不是崩溃，而是更隐蔽的「面板永远读不到行数据」。
         * 官方参考实现 dsh-better-sidebar 的客户端 inject 同样声明了 sessions。
         *
         * 运行时仍走 readService 二次兜底：宿主版本漂移导致某个服务缺失时，
         * 插件降级而不是卡在 pending。
         */
        var inject = ['slots', 'locale', 'sessions'];

        function apply(ctx) {
          ensureStyle();

          var sessions = readService(ctx, 'sessions');
          var store = createSettingsStore(ctx);

          function t(key) {
            try {
              if (typeof ctx.t === 'function') {
                var bound = ctx.t(NS);
                if (typeof bound === 'function') {
                  var text = bound(key);
                  if (typeof text === 'string' && text !== '' && text !== key) return text;
                }
              }
            } catch (_error) {
              /* 未绑定语言时走本地表 */
            }
            return zh[key] || en[key] || key;
          }

          // locale 虽然写进了 inject，仍走 readService——宿主版本漂移时 inject 里的服务
          // 可能永不到齐，那时 apply 根本不会被调用；这里再兜一层，保证任何情况下不抛。
          var locale = readService(ctx, 'locale');
          if (locale && typeof locale.register === 'function') {
            try {
              ctx.effect(function () {
                return locale.register(NS, { zh: zh, en: en });
              });
            } catch (_error) {
              /* 文案注册失败时 t() 仍回落到本地表 */
            }
          }

          var getRow = createRowReader(sessions);
          var subscribeRows = createRowSubscription(sessions);

          var rowCache = {};
          function readRow(sessionId) {
            var key = String(sessionId);
            if (Object.prototype.hasOwnProperty.call(rowCache, key)) return rowCache[key];
            var row = getRow(sessionId);
            if (row !== undefined) rowCache[key] = row;
            return row;
          }

          try {
            ctx.effect(function () {
              return subscribeRows(function () {
                rowCache = {};
              });
            });
          } catch (_error) {
            /* 订阅不上就退化为「打开卡片那一次读」，功能仍在 */
          }

          var HoverPanel = createHoverPanel({ getRow: readRow, store: store, t: t });
          var SettingsPage = createSettingsPage({ store: store, t: t });

          function registerAt(slot, id, order, Component, label) {
            try {
              ctx.slots.inject(slot, function () {
                var desc = { name: slot, id: id, order: order, locale: NS };
                // `settings.section` 的导航标题由宿主读 `label` 渲染：缺了就是空行，
                // 用户根本点不到，等于设置页不存在。官方各节一律给 `label`。
                if (typeof label === 'function') desc.label = label;
                return ctx.slots.register(desc, Component);
              });
              return true;
            } catch (_error) {
              return false;
            }
          }

          registerAt(HOVER_SLOT, HOVER_SLOT_ID, HOVER_SLOT_ORDER, HoverPanel);
          registerAt(SETTINGS_SLOT, SETTINGS_SLOT_ID, SETTINGS_SLOT_ORDER, SettingsPage, function () {
            return t('settings.nav');
          });

          store.load();
        }

        exports.name = PLUGIN_ID;
        exports.inject = inject;
        exports.apply = apply;
        exports.__test = {
          PLUGIN_ID: PLUGIN_ID,
          NS: NS,
          PROJECTION_KEY: PROJECTION_KEY,
          HOVER_SLOT: HOVER_SLOT,
          HOVER_SLOT_ID: HOVER_SLOT_ID,
          HOVER_SLOT_ORDER: HOVER_SLOT_ORDER,
          SETTINGS_SLOT: SETTINGS_SLOT,
          SETTINGS_SLOT_ID: SETTINGS_SLOT_ID,
          SETTINGS_SLOT_ORDER: SETTINGS_SLOT_ORDER,
          SETTINGS_SPEC: SETTINGS_SPEC,
          defaultSettings: defaultSettings,
          normalizeSettings: normalizeSettings,
          formatDuration: formatDuration,
          elapsedSince: elapsedSince,
          deriveState: deriveState,
          findRow: findRow,
          rowOfSnapshot: rowOfSnapshot,
          hasContent: hasContent,
          validImage: validImage,
          validModel: validModel,
          modelLabel: modelLabel,
          shortModel: shortModel,
          formatTokens: formatTokens,
          turnCount: turnCount,
          tokenUsageOf: tokenUsageOf,
          imageUrl: imageUrl,
          glyphOf: glyphOf,
          routeUrl: routeUrl,
          createRowReader: createRowReader,
          createRowSubscription: createRowSubscription,
          createSettingsStore: createSettingsStore,
          createHoverPanel: createHoverPanel,
          createImageViewer: createImageViewer,
          createSettingsPage: createSettingsPage,
          zh: zh,
          en: en,
          CSS_TEXT: CSS_TEXT,
          STYLE_TAG_ID: STYLE_TAG_ID,
          VERSION: VERSION
        };

        return module.exports;
      }
    });
  } catch (error) {
    console.warn('[dsh-session-live] client bundle 注册失败：', error);
  }
})();
