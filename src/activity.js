/**
 * 会话活动折叠：把一段提交过的事件序列折成「这个会话此刻在干什么」。
 *
 * 纯同步、纯函数式增量 fold，不依赖宿主、不读时钟（除显式传入的 now），
 * 因此可以被单元测试直接驱动，也可以被宿主半边和任何折叠单元复用。
 *
 * 状态必须是纯 JSON（宿主投影单元的持久化前提）。
 */

/** 归一化：折叠状态的最大长度上限，防止长会话把投影撑爆。 */
export const RECENT_MAX = 12;
/** 一个工具参数摘要的最大字符数。 */
export const DETAIL_MAX_CHARS = 120;
/** 一条文本预览的最大字符数。 */
export const PREVIEW_MAX_CHARS = 110;

/** 空状态。 */
export function initActivity() {
  return {
    /** 单调序号：本状态下最后一次折叠事件的 seq。 */
    seq: -1,
    /** 当前轮次，0 表示还没开始。 */
    turn: 0,
    /** 当前步。 */
    step: 0,
    /** 'turn' | 'step' | 'idle' */
    phase: 'idle',
    /** 本轮开始时间（ms），0 表示未知。 */
    turnStart: 0,
    /** 本轮结束时间（ms）。 */
    turnEnd: 0,
    /** 当前步开始时间，0 表示无开放步。 */
    stepStart: 0,
    /** 最后一次工具活动。 */
    tool: null,
    /** 最近若干次工具调用（新→旧）。 */
    recent: [],
    /** 最近一条用户提示预览。 */
    prompt: '',
    /** 最近一条助手回复预览（已落盘的）。 */
    reply: '',
    /** 最近一次错误（工具失败、轮次异常终止等）。 */
    error: null,
    /** 最近一次压缩标记。 */
    compaction: 0,
    /** 累计工具调用次数。 */
    toolCalls: 0,
    /** 最近一次模型选择（model/selection 事件）：{provider, model, reasoningEffort?}。 */
    model: null,
    /** 最近一张用户图片：{attachmentId, mediaType, width, height}，null 表示无。 */
    image: null,
  };
}

/** 把任意输入压成单行短文本。 */
export function clip(value, max) {
  const limit = typeof max === 'number' && max > 0 ? max : DETAIL_MAX_CHARS;
  if (typeof value !== 'string') {
    if (value === null || value === undefined) return '';
    try {
      value = String(value);
    } catch (_error) {
      return '';
    }
  }
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

/** 从任意消息体里抽出一段可读文本。 */
export function textOf(message) {
  if (message === null || message === undefined) return '';
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    const parts = [];
    for (const item of message) {
      const text = textOf(item);
      if (text !== '') parts.push(text);
    }
    return parts.join(' ');
  }
  if (typeof message === 'object') {
    if (typeof message.text === 'string') return message.text;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return textOf(message.content);
    if (Array.isArray(message.parts)) return textOf(message.parts);
  }
  return '';
}

/** 工具参数摘要的候选键，按优先级取第一个非空。 */
export const DETAIL_KEYS = [
  'title',
  'description',
  'objective',
  'task',
  'task_name',
  'question',
  'questions',
  'prompt',
  'message',
  'command',
  'cmd',
  'queries',
  'query',
  'pattern',
  'url',
  'uri',
  'file_path',
  'path',
  'target',
  'action',
  'status',
];

/** 工具名 → 活动类别。与宿主自己的活动分类保持同一套词。 */
export function activityOf(name) {
  const tool = typeof name === 'string' ? name : '';
  if (tool === 'read' || tool === 'read_image' || tool === 'read_original_image') return 'read';
  if (tool === 'grep' || tool === 'glob' || /_inspect$/.test(tool)) return 'search';
  if (tool === 'write') return 'write';
  if (tool === 'edit' || tool === 'apply_patch') return 'edit';
  if (
    tool === 'bash' ||
    tool === 'pwsh' ||
    tool === 'exec_command' ||
    tool === 'write_stdin' ||
    tool.indexOf('terminal_') === 0
  ) {
    return 'commands';
  }
  if (tool === 'run_code') return 'code';
  if (tool === 'web_search') return 'webSearch';
  if (tool === 'web_fetch' || tool === 'read_page') return 'webFetch';
  if (tool === 'subagent' || tool === 'subagent_fork' || tool.indexOf('subagent_') === 0) return 'subagents';
  if (
    tool === 'todo_write' ||
    tool === 'create_goal' ||
    tool === 'update_goal' ||
    tool === 'get_goal'
  ) {
    return 'plan';
  }
  if (tool === 'ask_user_question' || tool === 'request_user_input') return 'questions';
  return 'tools';
}

/**
 * 从原始参数 JSON 串里抽一句话摘要。
 * 参数永远是模型产出的未解析 JSON 字符串，可能坏掉，因此任何异常都退化为空。
 */
export function summarizeArguments(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    return clip(raw, DETAIL_MAX_CHARS);
  }
  if (parsed === null || typeof parsed !== 'object') return clip(String(parsed), DETAIL_MAX_CHARS);
  for (const key of DETAIL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
    const value = parsed[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      const joined = value
        .map((item) => (typeof item === 'string' ? item : textOf(item)))
        .filter((item) => item !== '')
        .join(' · ');
      if (joined !== '') return clip(joined, DETAIL_MAX_CHARS);
      continue;
    }
    if (typeof value === 'object') {
      const nested = textOf(value);
      if (nested !== '') return clip(nested, DETAIL_MAX_CHARS);
      continue;
    }
    const text = String(value).trim();
    if (text !== '') return clip(text, DETAIL_MAX_CHARS);
  }
  // 没有已知键时退化为「第一个标量字段」，比空串有用。
  for (const key of Object.keys(parsed)) {
    const value = parsed[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    if (text !== '') return clip(text, DETAIL_MAX_CHARS);
  }
  return '';
}

function pushRecent(state, entry) {
  const next = [entry].concat(state.recent || []);
  if (next.length > RECENT_MAX) next.length = RECENT_MAX;
  return next;
}

/* ------------------------------------------------------------------ *
 * 图片与模型提取。
 *
 * user/message 事件体（data 或 data.message）形如：
 *   { text, content: [ {type:'text', text}, {type:'image', attachment: ref}, ... ] }
 * ref = {attachmentId:'sha256:<64hex>', mediaType, bytes, width, height}
 * （见 dsh-attachment-local ensureReference/readImageFile，宿主侧形状权威。）
 *
 * 只认 ID_PATTERN 合法的 attachmentId —— 白名单即防穿越，落进状态的
 * ref 会被客户端拼进图片路由 URL，绝不放任意字符串进来。
 * ------------------------------------------------------------------ */
const ATTACHMENT_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** 归一化一条模型选择记录；不可用时返回 null。 */
function normalizeModel(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const provider = typeof data.provider === 'string' ? data.provider : '';
  const model = typeof data.model === 'string' ? data.model : '';
  if (provider === '' && model === '') return null;
  const out = { provider, model };
  if (typeof data.reasoningEffort === 'string' && data.reasoningEffort !== '') {
    out.reasoningEffort = data.reasoningEffort;
  }
  return out;
}

/** 从 attachment ref 里抽合法记录；非法返回 null。 */
function normalizeImageRef(ref) {
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return null;
  if (typeof ref.attachmentId !== 'string' || !ATTACHMENT_ID_PATTERN.test(ref.attachmentId)) return null;
  return {
    attachmentId: ref.attachmentId,
    mediaType: stringOr(ref.mediaType, 'image/png'),
    width: finiteOr(ref.width, 0),
    height: finiteOr(ref.height, 0),
  };
}

/** 遍历 content 数组取**最后一张**合法图片；没有返回 null。 */
function latestImageOf(source) {
  if (source === null || typeof source !== 'object') return null;
  const blocks = Array.isArray(source.content) ? source.content : Array.isArray(source) ? source : null;
  if (blocks === null) return null;
  let found = null;
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type !== 'image') continue;
    const ref = normalizeImageRef(block.attachment);
    if (ref !== null) found = ref;
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * 问答文本「直白化」
 *
 * 会话日志里 user/message 常常不是人话：宿主把运行时上下文、系统提醒、
 * 压缩摘要、技能目录都塞在用户位置上，真人那句话往往只占其中一行。
 * 折叠时先剥壳再压成单行，让面板里的「问」显示他真正说的那句。
 *
 * 只影响预览文本，不影响任何计数与判空逻辑。
 * ------------------------------------------------------------------ */

/** 自动注入内容的首行特征（剥壳后仍在，说明整条都是机器写的）。 */
const INJECTION_HEADS = [
  'current runtime context.',
  'this snapshot supersedes earlier runtime-context snapshots.',
  'time sampled while preparing turn',
  'current working directory:',
  // 宿主在 user 位置上插的系统标记（2026-10-19 于真实会话实测）
  '[model changed:',
  '[schedule reminder',
];

/**
 * 后台任务回执：`background job <tool>-<hash> (…)`，宿主插在 user 位置的
 * 完成通知。用结构判定而非裸前缀 —— 避免把真人以 "background job" 开头的
 * 那句话误判成注入。
 */
const BACKGROUND_JOB_NOTE = /^background jobs?\s+[\w.:-]+-\w+/i;

/** 整条即压缩产物：要在剥壳**之前**判定（标记行会被 META_LINE 先删掉）。 */
const RAW_ONLY_HEADS = ['[compressed conversation section]'];

/**
 * 宿主包装出来的英文元数据行（附件说明、折叠图片标记、压缩段标记）：
 * 整行丢弃 —— 它们在面板里既不直白，也不承载用户意图。
 */
const META_LINE =
  /^\s*(?:Image\s+"|Normalized copy\b|Source dimensions\b|Copy to a writable path\b|\[folded images?:|\[Compressed conversation section\]|\[model changed:|\[schedule reminder|background jobs?\s+[\w.:-]+-\w+)/i;

/** 成对包裹的注入块：整块连内容一起丢掉。 */
const INJECTION_BLOCKS =
  /<(system-reminder|untrusted-memory|available_skills|project_instructions|skill_content|ethics_reminder|ip_reminder|cyber_warning|behavior_instructions)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** 剩下的裸标签（自闭合、落单、无内容）也丢掉。 */
const LOOSE_TAGS = /<\/?[a-z][a-z0-9_-]*(?:\s[^<>]*)?\/?>/gi;

/**
 * 把一段消息文本压成「人话」：剥注入块 → 去标签 → 去 markdown 记号
 * → 折叠空白。可能返回空串（这段文本没有可读内容）。
 */
export function plainText(value) {
  if (typeof value !== 'string' || value === '') return '';
  let text = value.replace(INJECTION_BLOCKS, ' ').replace(LOOSE_TAGS, ' ');
  text = text
    .split('\n')
    .filter((line) => !META_LINE.test(line))
    .join('\n')
    .replace(/^\s*```.*$/gm, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^[\s>#*+\-]+/gm, ' ')
    .replace(/^\d+[.)]\s+/gm, ' ')
    .replace(/[*_`~]/g, '');
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 这段用户文本是否**整条**都是机器注入（不含真人内容）。
 * 判据：剥壳后为空，或以运行时上下文特征开头。
 */
export function isInjectedText(value) {
  if (typeof value !== 'string') return true;
  const raw = value.trim().toLowerCase();
  if (raw === '') return true;
  for (const marker of RAW_ONLY_HEADS) {
    if (raw.startsWith(marker)) return true;
  }
  const text = plainText(value);
  if (text === '') return true;
  const head = text.slice(0, 80).toLowerCase();
  for (const marker of INJECTION_HEADS) {
    if (head.startsWith(marker)) return true;
  }
  if (BACKGROUND_JOB_NOTE.test(text)) return true;
  return false;
}

/**
 * 折一个事件。与状态无关的事件必须返回**同一个引用**，
 * 让下游按 Object.is 直接跳过（宿主投影的发布抑制就靠这个）。
 */
export function applyActivity(state, event) {
  // 状态不完整时归一化补全；完整时**必须原样保留引用** ——
  // 宿主靠 Object.is 抑制发布，无条件重建会让每条事件都推一次全量。
  if (!isCompleteState(state)) state = normalizeState(state);
  if (event === null || typeof event !== 'object') return state;
  const type = event.type;
  const data = event.data;
  if (typeof type !== 'string' || data === null || typeof data !== 'object') return state;
  const seq = typeof event.seq === 'number' ? event.seq : state.seq;
  const time = typeof event.time === 'number' ? event.time : 0;

  switch (type) {
    case 'turn/start':
      return {
        ...state,
        seq,
        turn: typeof data.turn === 'number' ? data.turn : state.turn,
        step: 0,
        phase: 'turn',
        turnStart: time,
        turnEnd: 0,
        stepStart: 0,
        tool: null,
        prompt: '',
        reply: '',
        error: null,
      };

    case 'step/start':
      return {
        ...state,
        seq,
        turn: typeof data.turn === 'number' ? data.turn : state.turn,
        step: typeof data.step === 'number' ? data.step : state.step,
        phase: 'step',
        stepStart: time,
        tool: null,
      };

    case 'step/end':
      return {
        ...state,
        seq,
        turn: typeof data.turn === 'number' ? data.turn : state.turn,
        step: typeof data.step === 'number' ? data.step : state.step,
        phase: 'turn',
        stepStart: 0,
        tool: state.tool === null ? null : { ...state.tool, running: false, endedAt: time },
      };

    case 'turn/end': {
      const reason = data.reason;
      const failed =
        reason !== undefined &&
        reason !== null &&
        reason !== 'completed' &&
        reason !== 'success' &&
        reason !== 'done';
      return {
        ...state,
        seq,
        phase: 'idle',
        turnEnd: time,
        stepStart: 0,
        tool: state.tool === null ? null : { ...state.tool, running: false, endedAt: time },
        error: failed
          ? { kind: 'turn', label: clip(typeof reason === 'string' ? reason : 'error', 48), at: time }
          : state.error,
      };
    }

    case 'user/message': {
      const source = data.message !== undefined ? data.message : data;
      const raw = textOf(source);
      const image = latestImageOf(source);
      const next = { ...state, seq };
      // 机器注入的消息不覆盖上一条真人提问：面板里的「问」要保持是他说的话。
      if (!isInjectedText(raw)) {
        const text = clip(plainText(raw), PREVIEW_MAX_CHARS);
        if (text !== '') next.prompt = text;
      }
      if (image !== null) next.image = image;
      return next;
    }

    case 'model/selection': {
      const model = normalizeModel(data);
      if (model === null) return state.seq === seq ? state : { ...state, seq };
      return { ...state, seq, model };
    }

    case 'assistant/message': {
      const text = clip(plainText(textOf(data.message)), PREVIEW_MAX_CHARS);
      const interrupted = data.interrupted === true;
      const next = { ...state, seq };
      if (text !== '') next.reply = text;
      if (interrupted) {
        next.error = { kind: 'interrupted', label: 'interrupted', at: time };
      }
      return next;
    }

    case 'tool/call': {
      const name = typeof data.name === 'string' ? data.name : 'tool';
      const tool = {
        callId: typeof data.callId === 'string' ? data.callId : '',
        name,
        category: activityOf(name),
        detail: summarizeArguments(data.arguments),
        startedAt: time,
        endedAt: 0,
        running: true,
        failed: false,
      };
      return {
        ...state,
        seq,
        tool,
        recent: pushRecent(state, tool).map((item, index) =>
          index === 0 ? item : item.running ? { ...item, running: false } : item,
        ),
        toolCalls: state.toolCalls + 1,
      };
    }

    case 'tool/result': {
      const callId = typeof data.callId === 'string' ? data.callId : '';
      const error = data.error;
      const failed = error !== undefined && error !== null;
      const current = state.tool;
      const tool =
        current === null
          ? null
          : {
              ...current,
              running: false,
              endedAt: time,
              failed,
              detail:
                failed && error && typeof error.reason === 'string' && error.reason !== ''
                  ? clip(error.reason, DETAIL_MAX_CHARS)
                  : current.detail,
            };
      const recent = (state.recent || []).map((item, index) =>
        index === 0 && current !== null && current.callId === callId ? tool || item : item,
      );
      const next = { ...state, seq, tool, recent };
      if (failed && error) {
        const label =
          typeof error.name === 'string' && error.name !== ''
            ? error.name
            : typeof error.code === 'string' && error.code !== ''
              ? error.code
              : 'tool-failed';
        next.error = { kind: 'tool', label: clip(label, 48), at: time };
      }
      return next;
    }

    // 压缩 / 归档等非核心事件：只推进 seq，保持引用变化可被下游看到。
    default: {
      if (typeof type === 'string' && type.indexOf('compaction/') === 0) {
        return { ...state, seq, compaction: time };
      }
      return state.seq === seq ? state : { ...state, seq };
    }
  }
}

/* ------------------------------------------------------------------ *
 * 状态归一化
 *
 * 折叠状态是被宿主持久化的开放输入，可能来自：
 *   - 本插件 apply 的产物（字段完整）
 *   - 磁盘 checkpoint（可能是旧版本插件写的）
 *   - 损坏或被改写的行
 *
 * 旧实现把 stateSchema 设成「是个对象就行」，于是 `{totally:'wrong'}` 被当成
 * 合法状态接受，viewActivity 随后产出 10 个 undefined 字段
 * （seq/turn/step/prompt/reply/error/compaction/toolCalls/turnStart/stepStart
 * 全塌）—— undefined 不是合法 JSON，会污染投影 wire 与落盘的 checkpoint 行。
 *
 * 防线分两层，位置不同是因为两侧的纪律不同：
 *   1. apply 入口：状态**不完整时**才归一化。完整时必须返回同一引用，
 *      否则宿主靠 Object.is 做的发布抑制会失效（每个事件都发布一轮）。
 *   2. view 入口：无条件归一化。视图是读侧产物，不参与抑制比较。
 * ------------------------------------------------------------------ */

/** 合法 phase 取值。 */
const PHASES = new Set(['turn', 'step', 'idle']);

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/** 归一化一条工具记录（tool 与 recent 项同形）；不可用时返回 null。 */
function normalizeTool(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    callId: stringOr(value.callId, ''),
    name: stringOr(value.name, 'tool'),
    category: stringOr(value.category, 'tools'),
    detail: stringOr(value.detail, ''),
    startedAt: finiteOr(value.startedAt, 0),
    endedAt: finiteOr(value.endedAt, 0),
    running: value.running === true,
    failed: value.failed === true,
  };
}

/** 归一化错误标记；不可用时返回 null。 */
function normalizeError(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    kind: stringOr(value.kind, 'error'),
    label: stringOr(value.label, 'error'),
    at: finiteOr(value.at, 0),
  };
}

/** 把任意输入折成字段完整的合法状态（纯 JSON，无 undefined）。 */
export function normalizeState(state) {
  const base = initActivity();
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return base;
  const recent = Array.isArray(state.recent) ? state.recent : [];
  return {
    seq: finiteOr(state.seq, base.seq),
    turn: finiteOr(state.turn, base.turn),
    step: finiteOr(state.step, base.step),
    phase: PHASES.has(state.phase) ? state.phase : base.phase,
    turnStart: finiteOr(state.turnStart, base.turnStart),
    turnEnd: finiteOr(state.turnEnd, base.turnEnd),
    stepStart: finiteOr(state.stepStart, base.stepStart),
    tool: normalizeTool(state.tool),
    recent: recent
      .map(normalizeTool)
      .filter((item) => item !== null)
      .slice(0, RECENT_MAX),
    prompt: stringOr(state.prompt, base.prompt),
    reply: stringOr(state.reply, base.reply),
    error: normalizeError(state.error),
    compaction: finiteOr(state.compaction, base.compaction),
    toolCalls: finiteOr(state.toolCalls, base.toolCalls),
    model: normalizeModel(state.model),
    image: normalizeImageRef(state.image),
  };
}

/**
 * 判断状态是否已完整合法（可直接用于折叠，无需重建）。
 *
 * 这个函数存在的唯一理由是**保住引用同一性**：apply 每个事件都被调用，
 * 无条件归一化会让它每次都返回新对象，宿主的 Object.is 发布抑制随即失效。
 * 因此这里只做判定，不重建——完整就原样返回。
 */
export function isCompleteState(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false;
  if (!Number.isFinite(state.seq)) return false;
  if (!Number.isFinite(state.turn)) return false;
  if (!Number.isFinite(state.step)) return false;
  if (!PHASES.has(state.phase)) return false;
  if (!Number.isFinite(state.turnStart)) return false;
  if (!Number.isFinite(state.turnEnd)) return false;
  if (!Number.isFinite(state.stepStart)) return false;
  if (state.tool !== null && (typeof state.tool !== 'object' || Array.isArray(state.tool))) return false;
  if (!Array.isArray(state.recent)) return false;
  if (typeof state.prompt !== 'string') return false;
  if (typeof state.reply !== 'string') return false;
  if (state.error !== null && (typeof state.error !== 'object' || Array.isArray(state.error))) return false;
  if (!Number.isFinite(state.compaction)) return false;
  if (!Number.isFinite(state.toolCalls)) return false;
  if (state.model !== null && (typeof state.model !== 'object' || Array.isArray(state.model) || typeof state.model.provider !== 'string' || typeof state.model.model !== 'string')) return false;
  if (state.image !== null && (typeof state.image !== 'object' || Array.isArray(state.image) || typeof state.image.attachmentId !== 'string' || !ATTACHMENT_ID_PATTERN.test(state.image.attachmentId))) return false;
  return true;
}

/**
 * 把折叠状态渲染成客户端直接可用的视图。
 * @param state 折叠状态
 * @param now 当前毫秒时间戳（由调用方提供，宿主也可用 Date.now()）
 * @param running 宿主列表给出的 running 位；缺省时按 phase 推断
 * @param reuse 上一次产出的视图：字段全等时直接返回它，
 *   让宿主的 Object.is 发布抑制生效（投影 view 每次读都会被调用）。
 */
export function viewActivity(state, now, running, reuse) {
  const value = normalizeState(state);
  const current = typeof now === 'number' ? now : Date.now();
  const live =
    typeof running === 'boolean'
      ? running
      : value.phase === 'turn' || value.phase === 'step';
  const next = buildView(value, current, live);
  if (reuse && sameView(reuse, next)) return reuse;
  return next;
}

/** 视图等值比较：所有字段都是标量或固定形状的对象/数组。 */
function sameView(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  return true;
}

/**
 * 视图层净化：v2 时期的折叠器把未清洗的注入文本写进了 checkpoint，
 * 而行结构没变，宿主不会重放旧行。这里在**只读路径**上再洗一遍，
 * 状态本身不动 —— 历史脏值立刻干净，Object.is 发布抑制也不受影响。
 */
function cleanPreview(value) {
  if (typeof value !== 'string' || value === '') return '';
  if (isInjectedText(value)) return '';
  return clip(plainText(value), PREVIEW_MAX_CHARS);
}

function buildView(value, current, live) {
  const tool = value.tool;
  const activeTool = tool && tool.running ? tool : null;
  const lastTool = tool;
  return {
    seq: value.seq,
    turn: value.turn,
    step: value.step,
    running: live,
    phase: live ? (activeTool === null ? 'thinking' : 'tool') : 'idle',
    state: live ? (activeTool === null ? 'running' : 'running') : 'idle',
    tool: activeTool
      ? {
          name: activeTool.name,
          category: activeTool.category,
          detail: activeTool.detail,
          elapsedMs: activeTool.startedAt > 0 ? Math.max(0, current - activeTool.startedAt) : 0,
        }
      : null,
    lastTool: lastTool
      ? {
          name: lastTool.name,
          category: lastTool.category,
          detail: lastTool.detail,
          failed: lastTool.failed === true,
          durationMs:
            lastTool.startedAt > 0 && lastTool.endedAt > 0
              ? Math.max(0, lastTool.endedAt - lastTool.startedAt)
              : 0,
        }
      : null,
    recent: (value.recent || []).slice(0, RECENT_MAX).map((item) => ({
      name: item.name,
      category: item.category,
      detail: item.detail,
      failed: item.failed === true,
    })),
    prompt: cleanPreview(value.prompt),
    reply: cleanPreview(value.reply),
    error: value.error,
    compaction: value.compaction,
    toolCalls: value.toolCalls,
    model: value.model,
    image: value.image,
    turnElapsedMs: live && value.turnStart > 0 ? Math.max(0, current - value.turnStart) : 0,
    stepElapsedMs: live && value.stepStart > 0 ? Math.max(0, current - value.stepStart) : 0,
    turnStart: value.turnStart,
    stepStart: value.stepStart,
    toolStart: tool && tool.running ? tool.startedAt : 0,
    errorAt: value.error ? value.error.at : 0,
    updatedAt: typeof value.seq === 'number' ? value.seq : -1,
  };
}
