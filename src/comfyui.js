// ComfyUI 文生图客户端：提交工作流 → 轮询 /history → 从 /view 取回图片字节。
//
// 只依赖 ComfyUI 的 HTTP API（/prompt、/history/<id>、/view、/object_info），不走 WebSocket，
// 这样桥接重启/ComfyUI 重启都不会留下悬挂连接。
//
// 工作流两种来源：
//   1. 内置的最小 txt2img 工作流（CheckpointLoaderSimple → KSampler → SaveImage）；
//   2. config.comfyui.workflowPath 指向的 **API 格式** 工作流 JSON（ComfyUI 菜单
//      「导出 (API)」/「Save (API Format)」得到）。文本里可以写占位符
//      {{prompt}} / {{negative}} / {{seed}} / {{width}} / {{height}} / {{checkpoint}}；没写 {{prompt}} 时，
//      自动把 KSampler 的 positive 输入所连的 CLIPTextEncode 文本替换成提示词。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COMFYUI_DEFAULTS = Object.freeze({
  enabled: true,
  baseUrl: 'http://127.0.0.1:8188',
  // 消息以这些词开头即触发画图，如「画图 一只橘猫」「/draw a cat」
  triggers: ['画图', '/画图', '/draw', '/画'],
  // true = 仅管理员可用
  ownerOnly: false,
  workflowPath: '',
  // 留空 = 自动取 ComfyUI 里的第一个 checkpoint
  checkpoint: '',
  promptPrefix: '',
  negativePrompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, blurry',
  width: 1024,
  height: 1024,
  steps: 25,
  cfg: 6,
  sampler: 'euler_ancestral',
  scheduler: 'normal',
  timeoutMs: 5 * 60 * 1000,
  // 同一个人两次画图的最小间隔（管理员不受限）
  cooldownMs: 30 * 1000,
  // 全局同时排队/生成中的任务上限
  maxQueue: 3,
  maxPromptChars: 800,
  ackMessage: '🎨 收到，正在画图…',
  // 发送前清除图片元数据（EXIF / PNG 文本块里的工作流与提示词）
  stripMetadata: true,
  // 画图群：每个群一条独立规则，群与群之间的黑白名单互不相通；也与聊天白名单（allow.groups）互相独立。
  // 非空时只有这些群能画图（不在聊天白名单里的群也能用）；留空 = 沿用聊天白名单的群、不限用户。
  // 规则：{ id: '群号', accessMode, allowUsers: [QQ], denyUsers: [QQ] }
  //   accessMode：off = 不限；whitelist = 只有 allowUsers 能画（空 = 只有管理员）；blacklist = denyUsers 不能画
  //   管理员始终不受限。手写 config 时也可以只写群号字符串，等同 off。
  groups: [],
  // 私聊的用户规则（同上，没有 id）；私聊能否使用仍按聊天白名单
  privateAccess: { accessMode: 'off', allowUsers: [], denyUsers: [] },
  // 拒绝时的回复；某项留空 = 不回复（静默忽略这条画图指令）
  denyMessages: {
    group: '本群未开放画图功能。', // 群不在画图群列表里
    ownerOnly: '画图功能目前仅管理员可用。', // 开启了「仅管理员可用」
    whitelist: '你没有使用画图功能的权限。', // 白名单模式下不在名单里
    blacklist: '你没有使用画图功能的权限。', // 黑名单模式下在名单里
  },
});

export const ACCESS_MODES = Object.freeze(['off', 'whitelist', 'blacklist']);
const OPEN_RULE = Object.freeze({ accessMode: 'off', allowUsers: [], denyUsers: [] });

/** 数组或逗号/空白分隔的字符串 → 去重后的纯数字 QQ/群号字符串数组。 */
function toIdList(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[\s,，;；]+/);
  return [...new Set(arr.map((x) => String(x ?? '').trim()).filter((x) => /^\d+$/.test(x)))];
}

function normalizeAccessRule(r) {
  const src = r && typeof r === 'object' ? r : {};
  return {
    accessMode: ACCESS_MODES.includes(src.accessMode) ? src.accessMode : 'off',
    allowUsers: toIdList(src.allowUsers),
    denyUsers: toIdList(src.denyUsers),
  };
}

/** 规范化画图群列表；纯群号条目套用 fallback 规则。群号非法或重复的条目丢弃（先出现的为准）。 */
function normalizeGroupRules(list, fallback) {
  const out = new Map();
  for (const item of Array.isArray(list) ? list : toIdList(list)) {
    const bare = typeof item === 'string' || typeof item === 'number';
    const id = String(bare ? item : item?.id ?? '').trim();
    if (!/^\d+$/.test(id) || out.has(id)) continue;
    out.set(id, { id, ...normalizeAccessRule(bare ? fallback : item) });
  }
  return [...out.values()];
}

/** 这条消息适用的用户规则：群聊取该群自己的规则（没配画图群时不限用户），私聊取 privateAccess。 */
export function drawAccessRule(c, kind, id) {
  if (kind !== 'group') return c.privateAccess ?? OPEN_RULE;
  return c.groups.find((g) => g.id === String(id)) ?? OPEN_RULE;
}

/** 用户能否画图：whitelist 只放行 allowUsers，blacklist 拒绝 denyUsers；管理员始终放行。 */
export function drawUserAllowed(rule, uid, isOwner) {
  if (isOwner) return true;
  if (rule.accessMode === 'whitelist') return rule.allowUsers.includes(String(uid));
  if (rule.accessMode === 'blacklist') return !rule.denyUsers.includes(String(uid));
  return true;
}

export function resolveComfyConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const c = { ...COMFYUI_DEFAULTS, ...src };
  c.baseUrl = String(c.baseUrl || COMFYUI_DEFAULTS.baseUrl).replace(/\/+$/, '');
  c.triggers = (Array.isArray(c.triggers) ? c.triggers : [c.triggers])
    .map((t) => String(t ?? '').trim()).filter(Boolean)
    // 长的优先匹配，避免「/画」抢在「/画图」前面
    .sort((a, b) => b.length - a.length);
  // 旧版是全局一条规则（顶层 accessMode/allowUsers/denyUsers）+ 纯群号数组：
  // 迁移成每个群、私聊各一份同样的规则，避免已配置的白名单被悄悄放开
  const legacy = ['accessMode', 'allowUsers', 'denyUsers'].some((k) => k in src) ? normalizeAccessRule(src) : null;
  delete c.accessMode; delete c.allowUsers; delete c.denyUsers;
  c.groups = normalizeGroupRules(c.groups, legacy);
  c.privateAccess = normalizeAccessRule(src.privateAccess ?? legacy);
  // 没配的项用默认文案；显式写成空串的保留为空（= 静默）
  const deny = src.denyMessages && typeof src.denyMessages === 'object' ? src.denyMessages : {};
  c.denyMessages = Object.fromEntries(Object.entries(COMFYUI_DEFAULTS.denyMessages)
    .map(([k, def]) => [k, typeof deny[k] === 'string' ? deny[k].trim() : def]));
  for (const k of ['width', 'height', 'steps', 'timeoutMs', 'cooldownMs', 'maxQueue', 'maxPromptChars']) {
    const n = Number(c[k]);
    c[k] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : COMFYUI_DEFAULTS[k];
  }
  const cfgScale = Number(c.cfg);
  c.cfg = Number.isFinite(cfgScale) && cfgScale > 0 ? cfgScale : COMFYUI_DEFAULTS.cfg;
  // 每个自定义工作流各自选的主模型：{ 'comfyui-workflows/x.json': 'model.safetensors' }
  c.workflowModels = Object.fromEntries(Object.entries(c.workflowModels && typeof c.workflowModels === 'object' ? c.workflowModels : {})
    .filter(([k, v]) => k && typeof v === 'string' && v.trim())
    .map(([k, v]) => [k, v.trim()]));
  c.enabled = c.enabled !== false;
  c.ownerOnly = c.ownerOnly === true;
  c.stripMetadata = c.stripMetadata !== false;
  return c;
}

/** 消息以触发词开头时返回提示词（可能为空串）；不是画图指令返回 null。 */
export function matchDrawTrigger(text, triggers) {
  const s = String(text ?? '').trim();
  for (const t of triggers ?? []) {
    if (!s.startsWith(t)) continue;
    const rest = s.slice(t.length);
    // 「画图片」「/drawing」之类不算：触发词后面必须是空白、标点或结尾
    if (rest && !/^[\s:：,，]/.test(rest)) continue;
    return rest.replace(/^[\s:：,，]+/, '').trim();
  }
  return null;
}

export function buildDefaultWorkflow({ checkpoint, prompt, negative, seed, width, height, steps, cfg, sampler, scheduler }) {
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    3: {
      class_type: 'KSampler',
      inputs: {
        seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'qq-bridge', images: ['8', 0] } },
  };
}

// 主模型加载节点：类名 → 模型文件名所在的输入
export const MODEL_LOADERS = Object.freeze({
  CheckpointLoaderSimple: 'ckpt_name',
  CheckpointLoader: 'ckpt_name',
  UNETLoader: 'unet_name',
  UnetLoaderGGUF: 'unet_name',
});

/** 找工作流的主模型加载节点：返回 { node, classType, input, current } 或 null。 */
export function findModelLoader(wf) {
  const entries = Object.entries(wf ?? {}).filter(([, n]) => n && typeof n === 'object' && typeof n.class_type === 'string');
  const describe = (id, n) => ({ node: id, classType: n.class_type, input: MODEL_LOADERS[n.class_type], current: String(n.inputs?.[MODEL_LOADERS[n.class_type]] ?? '') });
  // 从采样器的 model 输入往上游走（穿过 LoRA 等），找到真正加载主模型的节点；
  // 不能直接取第一个加载节点：工作流里可能还有放大、修脸用的其它模型。
  for (const [, n] of entries) {
    if (!n.inputs || !('positive' in n.inputs)) continue;
    let link = n.inputs.model;
    const seen = new Set();
    while (Array.isArray(link) && !seen.has(String(link[0]))) {
      const id = String(link[0]);
      seen.add(id);
      const up = wf[id];
      if (!up || typeof up !== 'object') break;
      if (MODEL_LOADERS[up.class_type]) return describe(id, up);
      link = up.inputs?.model;
    }
  }
  const first = entries.find(([, n]) => MODEL_LOADERS[n.class_type]);
  return first ? describe(first[0], first[1]) : null;
}

/** 往用户自定义的 API 格式工作流里填参数。返回新对象，不改入参。 */
export function fillCustomWorkflow(workflow, vars) {
  const placeholders = {
    prompt: vars.prompt, negative: vars.negative, seed: vars.seed, width: vars.width, height: vars.height,
    checkpoint: vars.checkpoint,
  };
  let usedPrompt = false;
  const walk = (v) => {
    if (typeof v === 'string') {
      // 整个字符串就是一个占位符时保留原类型（seed/width 需要是数字）
      const whole = v.match(/^\{\{(\w+)\}\}$/);
      if (whole && whole[1] in placeholders) {
        if (whole[1] === 'prompt') usedPrompt = true;
        return placeholders[whole[1]];
      }
      return v.replace(/\{\{(\w+)\}\}/g, (m, k) => {
        if (!(k in placeholders)) return m;
        if (k === 'prompt') usedPrompt = true;
        return String(placeholders[k]);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const wf = walk(workflow);
  const nodes = Object.values(wf).filter((n) => n && typeof n === 'object' && n.inputs);
  if (!usedPrompt) {
    // 没写占位符：顺着采样器的 positive 连线找到正向提示词节点
    for (const n of nodes) {
      const link = n.inputs.positive;
      if (!Array.isArray(link)) continue;
      const target = wf[String(link[0])];
      if (target?.inputs && typeof target.inputs.text === 'string') {
        target.inputs.text = vars.prompt;
        usedPrompt = true;
        break;
      }
    }
  }
  if (!usedPrompt) throw new Error('自定义工作流里找不到正向提示词节点：请在提示词文本里写 {{prompt}}');
  // 没有用 {{seed}} 的工作流也要每次换种子，否则同一提示词永远出同一张图
  if (!JSON.stringify(workflow).includes('{{seed}}')) {
    for (const n of nodes) {
      for (const k of ['seed', 'noise_seed']) {
        if (typeof n.inputs[k] === 'number') n.inputs[k] = vars.seed;
      }
    }
  }
  return wf;
}

export function createComfyClient(getConfig, { root = process.cwd(), log = () => {} } = {}) {
  const clientId = crypto.randomUUID();
  let cachedCheckpoint = null;

  async function request(c, pathname, init = {}, timeoutMs = 30000) {
    let res;
    try {
      res = await fetch(`${c.baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(`连接 ComfyUI 失败（${c.baseUrl}）：${error?.cause?.code || error?.message || error}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ComfyUI ${pathname} 返回 HTTP ${res.status}：${extractComfyError(body)}`);
    }
    return res;
  }

  async function pickCheckpoint(c) {
    if (c.checkpoint) return c.checkpoint;
    if (cachedCheckpoint) return cachedCheckpoint;
    const info = await (await request(c, '/object_info/CheckpointLoaderSimple')).json();
    const spec = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name;
    // 旧版：[[a, b, ...]]；新版：['COMBO', { options: [...] }]
    const list = Array.isArray(spec?.[0]) ? spec[0] : (spec?.[1]?.options ?? []);
    if (!list.length) throw new Error('ComfyUI 里没有可用的 checkpoint 模型');
    cachedCheckpoint = list[0];
    log(`[comfyui] 未配置 checkpoint，自动使用 ${cachedCheckpoint}`);
    return cachedCheckpoint;
  }

  async function buildWorkflow(c, prompt) {
    const vars = {
      prompt: c.promptPrefix ? `${c.promptPrefix}, ${prompt}` : prompt,
      negative: c.negativePrompt,
      seed: crypto.randomInt(0, 2 ** 47),
      width: c.width,
      height: c.height,
    };
    if (c.workflowPath) {
      const p = path.isAbsolute(c.workflowPath) ? c.workflowPath : path.join(root, c.workflowPath);
      let wf;
      try { wf = JSON.parse(fs.readFileSync(p, 'utf8')); }
      catch (error) { throw new Error(`读取工作流 ${p} 失败：${error?.message ?? error}`); }
      if (Array.isArray(wf?.nodes)) throw new Error('工作流是 UI 格式，请在 ComfyUI 里用「导出 (API)」重新导出');
      // 控制台为这个工作流选过模型就用它，否则保持工作流文件里的模型
      const chosen = c.workflowModels[c.workflowPath] || '';
      if (JSON.stringify(wf).includes('{{checkpoint}}')) vars.checkpoint = chosen || await pickCheckpoint(c);
      const filled = fillCustomWorkflow(wf, vars);
      const loader = findModelLoader(wf);
      if (chosen && loader) filled[loader.node].inputs[loader.input] = chosen;
      return filled;
    }
    return buildDefaultWorkflow({
      ...vars,
      checkpoint: await pickCheckpoint(c),
      steps: c.steps, cfg: c.cfg, sampler: c.sampler, scheduler: c.scheduler,
    });
  }

  /** 生成图片，返回 [{ buffer, filename, mimeType }] */
  async function generate(prompt) {
    const c = resolveComfyConfig(getConfig());
    const workflow = await buildWorkflow(c, prompt);
    const submit = await (await request(c, '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    })).json();
    const promptId = submit?.prompt_id;
    if (!promptId) throw new Error(`ComfyUI 未返回 prompt_id：${extractComfyError(JSON.stringify(submit))}`);
    log(`[comfyui] 已提交任务 ${promptId}`);

    const deadline = Date.now() + c.timeoutMs;
    let entry = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const hist = await (await request(c, `/history/${encodeURIComponent(promptId)}`)).json().catch(() => ({}));
      entry = hist?.[promptId];
      if (!entry) continue;
      const status = entry.status?.status_str;
      if (status === 'error') {
        const msg = (entry.status?.messages ?? []).find((m) => m?.[0] === 'execution_error')?.[1];
        throw new Error(`ComfyUI 执行出错：${msg?.exception_message?.trim() || msg?.node_type || '未知错误'}`);
      }
      if (entry.status?.completed || status === 'success') break;
      entry = null;
    }
    if (!entry) {
      // 超时就把任务从队列里撤掉，免得 ComfyUI 白白继续算
      request(c, '/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }).catch(() => {});
      request(c, '/interrupt', { method: 'POST' }).catch(() => {});
      throw new Error(`画图超时（${Math.round(c.timeoutMs / 1000)} 秒）`);
    }

    const files = [];
    for (const out of Object.values(entry.outputs ?? {})) {
      for (const img of out?.images ?? []) {
        if (img?.type !== 'output') continue; // 跳过预览节点的临时图
        files.push(img);
      }
    }
    if (!files.length) throw new Error('ComfyUI 没有输出图片（工作流里需要 SaveImage 节点）');
    const images = [];
    for (const f of files.slice(0, 4)) {
      const qs = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type });
      const res = await request(c, `/view?${qs}`, {}, 60000);
      const raw = Buffer.from(await res.arrayBuffer());
      images.push({
        // ComfyUI 会把完整工作流、提示词、模型名写进图片元数据；发出去之前剥掉
        buffer: c.stripMetadata ? stripImageMetadata(raw) : raw,
        filename: f.filename,
        mimeType: res.headers.get('content-type') || 'image/png',
      });
    }
    return images;
  }

  return { generate, resetCache() { cachedCheckpoint = null; } };
}

// ── 图片元数据清除 ──────────────────────────────────────────────────────────
// 只删元数据块、不重新编码，像素与画质完全不变。认不出的格式原样返回。

// PNG：tEXt/zTXt/iTXt（ComfyUI 的 prompt/workflow 就在这里）、eXIf、时间戳
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
// JPEG：APP1（EXIF/XMP）、APP13（Photoshop/IPTC）、COM 注释；保留 APP0/JFIF、APP2/ICC、APP14/Adobe（影响色彩）
const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);

export function stripImageMetadata(buf) {
  try {
    if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return stripPng(buf);
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) return stripJpeg(buf);
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return stripWebp(buf);
  } catch {
    // 结构异常时不冒险改写，原样返回
  }
  return buf;
}

function stripPng(buf) {
  const parts = [buf.subarray(0, 8)];
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const end = off + 12 + len;
    if (end > buf.length) throw new Error('truncated png');
    if (!PNG_DROP.has(type)) parts.push(buf.subarray(off, end));
    off = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  throw new Error('png without IEND');
}

function stripJpeg(buf) {
  const parts = [buf.subarray(0, 2)];
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) throw new Error('bad jpeg marker');
    const marker = buf[off + 1];
    // SOS 之后是熵编码数据，整段照搬
    if (marker === 0xda) { parts.push(buf.subarray(off)); return Buffer.concat(parts); }
    const end = off + 2 + buf.readUInt16BE(off + 2);
    if (end > buf.length) throw new Error('truncated jpeg');
    if (!JPEG_DROP.has(marker)) parts.push(buf.subarray(off, end));
    off = end;
  }
  throw new Error('jpeg without SOS');
}

function stripWebp(buf) {
  const parts = [];
  let off = 12;
  let vp8x = null;
  while (off + 8 <= buf.length) {
    const type = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    const end = off + 8 + len + (len & 1);
    if (off + 8 + len > buf.length) throw new Error('truncated webp');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = Buffer.from(buf.subarray(off, Math.min(end, buf.length)));
      if (type === 'VP8X') vp8x = chunk;
      parts.push(chunk);
    }
    off = end;
  }
  if (vp8x) vp8x[8] &= ~0x0c; // 清掉 EXIF / XMP 存在标志
  const body = Buffer.concat(parts);
  const header = Buffer.from(buf.subarray(0, 12));
  header.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([header, body]);
}

function extractComfyError(body) {
  try {
    const j = JSON.parse(body);
    const nodeErr = Object.values(j?.node_errors ?? {})[0]?.errors?.[0];
    if (nodeErr) return `${nodeErr.message}${nodeErr.details ? `（${nodeErr.details}）` : ''}`;
    if (j?.error?.message) return j.error.message;
  } catch {}
  return String(body ?? '').slice(0, 200);
}

// ── 控制台：工作流库与 ComfyUI 能力探测 ────────────────────────────────────

// 控制台里可选的工作流都放在仓库根下的这个目录（API 格式 JSON）
export const WORKFLOW_DIR_NAME = 'comfyui-workflows';

/** 只允许目录内的简单文件名，防止路径穿越。返回规范化文件名或 null。 */
export function sanitizeWorkflowFile(name) {
  const base = String(name ?? '').trim().replace(/\.json$/i, '');
  if (!base || base.length > 80 || !/^[\p{L}\p{N}_\- .()]+$/u.test(base) || /^\.+$/.test(base)) return null;
  return `${base.trim()}.json`;
}

/** 校验 API 格式工作流，返回 { ok, error?, nodeCount, hasPromptPlaceholder, hasSaveImage } */
export function inspectWorkflow(wf) {
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return { ok: false, error: '不是 JSON 对象' };
  if (Array.isArray(wf.nodes)) return { ok: false, error: '这是 UI 格式工作流，请在 ComfyUI 里用「导出 (API)」重新导出' };
  const nodes = Object.values(wf).filter((n) => n && typeof n === 'object' && typeof n.class_type === 'string');
  if (!nodes.length) return { ok: false, error: '没有找到任何 class_type 节点，不是 API 格式工作流' };
  const text = JSON.stringify(wf);
  const hasPromptPlaceholder = text.includes('{{prompt}}');
  const hasPositiveLink = nodes.some((n) => Array.isArray(n.inputs?.positive) && typeof wf[String(n.inputs.positive[0])]?.inputs?.text === 'string');
  const hasSaveImage = nodes.some((n) => n.class_type === 'SaveImage' || /save/i.test(n.class_type));
  const usesCheckpoint = text.includes('{{checkpoint}}');
  if (!hasPromptPlaceholder && !hasPositiveLink) {
    return { ok: false, error: '找不到正向提示词节点：请在提示词文本里写 {{prompt}}' };
  }
  return { ok: true, nodeCount: nodes.length, hasPromptPlaceholder, hasSaveImage, usesCheckpoint, modelLoader: findModelLoader(wf) };
}

export function listWorkflows(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)); } catch { return []; }
  return files.sort((a, b) => a.localeCompare(b, 'zh')).map((file) => {
    let info;
    try { info = inspectWorkflow(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))); }
    catch (error) { info = { ok: false, error: `JSON 解析失败：${error?.message ?? error}` }; }
    return { file, path: `${WORKFLOW_DIR_NAME}/${file}`, ...info };
  });
}

/**
 * 读 ComfyUI 版本、模型/采样器/调度器列表；离线时 online=false 并给出错误。
 * loaderClasses：还需要哪些加载节点的模型列表（来自各工作流的主模型节点），
 * 结果放在 modelOptions[类名]；没装对应自定义节点的返回空列表。
 */
export async function fetchComfyInfo(baseUrl, loaderClasses = [], timeoutMs = 5000) {
  const base = String(baseUrl || COMFYUI_DEFAULTS.baseUrl).replace(/\/+$/, '');
  const get = async (p) => {
    const res = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const options = (spec) => (Array.isArray(spec?.[0]) ? spec[0] : (spec?.[1]?.options ?? []));
  try {
    const [stats, ckpt, ks] = await Promise.all([
      get('/system_stats'),
      get('/object_info/CheckpointLoaderSimple'),
      get('/object_info/KSampler'),
    ]);
    const req = ks?.KSampler?.input?.required ?? {};
    const checkpoints = options(ckpt?.CheckpointLoaderSimple?.input?.required?.ckpt_name);
    const modelOptions = { CheckpointLoaderSimple: checkpoints };
    await Promise.all([...new Set(loaderClasses)].filter((cls) => MODEL_LOADERS[cls] && !(cls in modelOptions)).map(async (cls) => {
      try {
        const info = await get(`/object_info/${encodeURIComponent(cls)}`);
        modelOptions[cls] = options(info?.[cls]?.input?.required?.[MODEL_LOADERS[cls]]);
      } catch {
        modelOptions[cls] = [];
      }
    }));
    return {
      online: true,
      version: stats?.system?.comfyui_version ?? '',
      devices: (stats?.devices ?? []).map((d) => d?.name).filter(Boolean),
      checkpoints,
      modelOptions,
      samplers: options(req.sampler_name),
      schedulers: options(req.scheduler),
    };
  } catch (error) {
    return { online: false, error: error?.cause?.code || error?.message || String(error), checkpoints: [], modelOptions: {}, samplers: [], schedulers: [] };
  }
}
