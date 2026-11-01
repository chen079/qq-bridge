// ComfyUI 画图：纯函数 + 假 ComfyUI 服务上的完整链路（QQ 触发 → 出图回复；控制台工作流管理；
// AI 工具 qq_draw_image 的桥接接口与 MCP 按在线状态动态注入）。
// 离线：不连真实 ComfyUI、不发真 QQ 消息。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  aiDrawDenial, createComfyClient, fillCustomWorkflow, inspectWorkflow, matchDrawTrigger, probeComfyOnline, resolveComfyConfig, sanitizeWorkflowFile,
} from '../src/comfyui.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name} — ${error?.stack ?? error}`); }
}

// ── 假 ComfyUI ────────────────────────────────────────────────────────────
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d5d1d20000000049454e44ae426082', 'hex');
const submitted = [];
let failNext = null;
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/system_stats') return json({ system: { comfyui_version: '9.9.9' }, devices: [{ name: 'fake-gpu' }] });
  if (url.pathname === '/object_info/CheckpointLoaderSimple') return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: ['COMBO', { options: ['a.safetensors', 'b.safetensors'] }] } } } });
  if (url.pathname === '/object_info/KSampler') return json({ KSampler: { input: { required: { sampler_name: [['euler', 'euler_ancestral']], scheduler: [['normal', 'karras']] } } } });
  if (url.pathname === '/prompt' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      submitted.push(parsed.prompt);
      json({ prompt_id: `p${submitted.length}`, number: submitted.length });
    });
    return;
  }
  const hist = url.pathname.match(/^\/history\/(.+)$/);
  if (hist) {
    if (failNext) {
      const msg = failNext; failNext = null;
      return json({ [hist[1]]: { status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: msg }]] }, outputs: {} } });
    }
    return json({ [hist[1]]: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }, { filename: 'tmp.png', subfolder: '', type: 'temp' }] } } } });
  }
  if (url.pathname === '/view') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
  json({ error: 'not found' }, 404);
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${fake.address().port}`;

try {
  await test('触发词：前缀匹配、必须有分隔、长词优先', () => {
    const t = resolveComfyConfig({}).triggers;
    assert.equal(matchDrawTrigger('画图 一只猫', t), '一只猫');
    assert.equal(matchDrawTrigger('画图：一只猫', t), '一只猫');
    assert.equal(matchDrawTrigger('/画图 cat', t), 'cat');
    assert.equal(matchDrawTrigger('/draw', t), '');
    assert.equal(matchDrawTrigger('画图片好看吗', t), null);
    assert.equal(matchDrawTrigger('/drawing', t), null);
    assert.equal(matchDrawTrigger('帮我画图 猫', t), null);
  });

  await test('自定义工作流：占位符保留数字类型，未写 {{seed}} 时自动随机种子', () => {
    const wf = {
      1: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}' } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'best, {{prompt}}' } },
      3: { class_type: 'KSampler', inputs: { seed: 1, positive: ['2', 0] } },
    };
    const out = fillCustomWorkflow(wf, { prompt: 'cat', negative: '', seed: 42, width: 512, height: 768 });
    assert.equal(out[1].inputs.width, 512);
    assert.equal(out[2].inputs.text, 'best, cat');
    assert.equal(out[3].inputs.seed, 42);
    assert.equal(wf[2].inputs.text, 'best, {{prompt}}', '不改入参');
  });

  await test('自定义工作流：无占位符时替换 positive 所连文本节点', () => {
    const wf = {
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'old' } },
      7: { class_type: 'CLIPTextEncode', inputs: { text: 'neg' } },
      3: { class_type: 'KSampler', inputs: { positive: ['2', 0], negative: ['7', 0] } },
    };
    const out = fillCustomWorkflow(wf, { prompt: 'dog', seed: 1 });
    assert.equal(out[2].inputs.text, 'dog');
    assert.equal(out[7].inputs.text, 'neg');
  });

  await test('工作流校验与文件名清洗', () => {
    assert.equal(inspectWorkflow({ nodes: [], links: [] }).ok, false, 'UI 格式应拒绝');
    assert.equal(inspectWorkflow({ 1: { class_type: 'SaveImage', inputs: {} } }).ok, false, '没有提示词节点应拒绝');
    assert.equal(inspectWorkflow({ 1: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }).ok, true);
    assert.equal(sanitizeWorkflowFile('../config'), null);
    assert.equal(sanitizeWorkflowFile('a/b'), null);
    assert.equal(sanitizeWorkflowFile('..'), null);
    assert.equal(sanitizeWorkflowFile('动漫 v2'), '动漫 v2.json');
  });

  await test('客户端：内置工作流自动选模型、只取 output 图、执行错误透出', async () => {
    submitted.length = 0;
    const client = createComfyClient(() => ({ baseUrl, width: 640, stripMetadata: false }));
    const imgs = await client.generate('cat');
    assert.equal(imgs.length, 1, 'temp 预览图不应发送');
    assert.deepEqual(imgs[0].buffer, PNG);
    const wf = submitted[0];
    assert.equal(wf[4].inputs.ckpt_name, 'a.safetensors');
    assert.equal(wf[5].inputs.width, 640);
    assert.equal(wf[6].inputs.text, 'cat');
    failNext = 'CUDA out of memory';
    await assert.rejects(client.generate('cat'), /CUDA out of memory/);
  });

  await test('QQ：群友「@机器人 画图 xxx」→ 回执 + 引用原消息发图；冷却生效', async () => {
    const h = await bridgeHarness({ config: { comfyui: { baseUrl, ackMessage: '画画中', cooldownMs: 60000 } } });
    try {
      h.setMode('open');
      const event = (text, mid) => ({
        group_id: 456, user_id: 789, self_id: 10000, message_id: mid, sender: { nickname: '群友' },
        message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text } }],
      });
      await h.handleIncoming('group', '456', event(' 画图 a cute cat', 555), h.cfg);
      for (let i = 0; i < 50 && !h.calls.sent.some((s) => Array.isArray(s.text)); i++) await new Promise((r) => setTimeout(r, 100));
      const texts = h.calls.sent.map((s) => s.text);
      assert.ok(texts.includes('画画中'), `应先发回执：${JSON.stringify(texts)}`);
      const img = h.calls.sent.find((s) => Array.isArray(s.text));
      assert.ok(img, '应发出图片消息');
      assert.equal(JSON.stringify(img.text[0]), JSON.stringify({ type: 'reply', data: { id: '555' } }));
      assert.equal(img.text[1].type, 'image');
      assert.ok(img.text[1].data.file.startsWith('base64://'));
      assert.equal(submitted.at(-1)[6].inputs.text, 'a cute cat');

      h.calls.sent.length = 0;
      await h.handleIncoming('group', '456', event(' 画图 again', 556), h.cfg);
      await new Promise((r) => setTimeout(r, 400));
      assert.match(String(h.calls.sent[0]?.text ?? ''), /秒后再试/);
      assert.ok(!h.calls.sent.some((s) => Array.isArray(s.text)), '冷却期内不应出图');
    } finally { await h.close(); }
  });

  await test('自定义工作流：沿 LoRA 链找到 UNETLoader 主模型，并按工作流替换模型', async () => {
    const wf = {
      70: { class_type: 'CLIPLoader', inputs: { clip_name: 'clip.safetensors' } },
      71: { class_type: 'UNETLoader', inputs: { unet_name: 'orig.safetensors' } },
      72: { class_type: 'UpscaleModelLoader', inputs: { model_name: 'x4.pth' } },
      73: { class_type: 'LoraLoader', inputs: { model: ['71', 0], clip: ['70', 0] } },
      69: { class_type: 'CLIPTextEncode', inputs: { text: 'old', clip: ['73', 1] } },
      68: { class_type: 'KSampler', inputs: { seed: 1, model: ['73', 0], positive: ['69', 0] } },
      111: { class_type: 'SaveImage', inputs: { images: ['68', 0] } },
    };
    const info = inspectWorkflow(wf);
    assert.equal(info.modelLoader.node, '71');
    assert.equal(info.modelLoader.input, 'unet_name');
    assert.equal(info.modelLoader.current, 'orig.safetensors');

    const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'comfy-wf-'));
    try {
      fs.mkdirSync(path.join(dir, 'comfyui-workflows'));
      fs.writeFileSync(path.join(dir, 'comfyui-workflows', 'a.json'), JSON.stringify(wf));
      const wfPath = 'comfyui-workflows/a.json';
      submitted.length = 0;
      await createComfyClient(() => ({ baseUrl, workflowPath: wfPath, workflowModels: { [wfPath]: 'new.safetensors' } }), { root: dir }).generate('cat');
      assert.equal(submitted[0][71].inputs.unet_name, 'new.safetensors');
      assert.equal(submitted[0][69].inputs.text, 'cat');
      submitted.length = 0;
      await createComfyClient(() => ({ baseUrl, workflowPath: wfPath }), { root: dir }).generate('cat');
      assert.equal(submitted[0][71].inputs.unet_name, 'orig.safetensors', '没选模型时保持工作流原样');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('控制台：读状态、导入/选择/删除工作流、拒绝路径穿越与 agent token', async () => {
    const h = await bridgeHarness({ config: { comfyui: { baseUrl } } });
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((r) => server.once('listening', r));
      const port = server.address().port;
      const call = (p, method = 'GET', body, extra = {}) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...extra } }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });

      const info = await call('/api/comfyui');
      assert.equal(info.status, 200);
      assert.equal(info.body.comfy.online, true);
      assert.deepEqual(info.body.comfy.checkpoints, ['a.safetensors', 'b.safetensors']);
      assert.deepEqual(info.body.comfy.samplers, ['euler', 'euler_ancestral']);
      assert.deepEqual(info.body.workflows, []);

      assert.equal((await call('/api/comfyui', 'GET', undefined, { 'x-agent-token': 'x' })).status, 403, 'AI 不能改画图配置');

      const wf = { 3: { class_type: 'KSampler', inputs: { positive: ['6', 0] } }, 6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, 9: { class_type: 'SaveImage', inputs: {} } };
      assert.equal((await call('/api/comfyui/workflow', 'POST', { name: '../evil', content: wf })).status, 400);
      assert.equal((await call('/api/comfyui/workflow', 'POST', { name: 'ui', content: { nodes: [] } })).status, 400);
      const imp = await call('/api/comfyui/workflow', 'POST', { name: '我的流', content: JSON.stringify(wf) });
      assert.equal(imp.status, 200, JSON.stringify(imp.body));
      assert.equal((await call('/api/comfyui/workflow', 'POST', { name: '我的流', content: wf })).status, 409, '同名不覆盖');
      assert.ok(fs.existsSync(path.join(h.temp, 'comfyui-workflows', '我的流.json')));

      assert.equal((await call('/api/comfyui', 'POST', { workflowPath: '../config.json' })).status, 400);
      const saved = await call('/api/comfyui', 'POST', { workflowPath: 'comfyui-workflows/我的流.json', workflowModel: 'b.safetensors', checkpoint: 'b.safetensors', steps: '30', triggers: '画, 绘图' });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(h.cfg.comfyui.workflowModels['comfyui-workflows/我的流.json'], 'b.safetensors', '按工作流保存模型');
      assert.equal(h.cfg.comfyui.workflowPath, 'comfyui-workflows/我的流.json', '热更新');
      assert.equal(h.cfg.comfyui.steps, 30);
      assert.equal(JSON.stringify(h.cfg.comfyui.triggers), JSON.stringify(['绘图', '画']));
      const onDisk = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
      assert.equal(onDisk.comfyui.workflowPath, 'comfyui-workflows/我的流.json');
      assert.equal(onDisk.consoleToken, 'fixture-console-token', '其它配置保持不变');

      const listed = await call('/api/comfyui');
      assert.equal(listed.body.workflows[0].file, '我的流.json');
      assert.equal(listed.body.workflows[0].ok, true);

      const test = await call('/api/comfyui/test', 'POST', { prompt: 'hello' });
      assert.equal(test.status, 200, JSON.stringify(test.body));
      assert.ok(test.body.images[0].dataUrl.startsWith('data:image/png;base64,'));
      assert.equal(submitted.at(-1)[6].inputs.text, 'hello', '使用了选中的自定义工作流');

      assert.equal((await call('/api/comfyui/workflow/delete', 'POST', { file: '../config.json' })).status, 404);
      assert.equal((await call('/api/comfyui/workflow/delete', 'POST', { file: '我的流.json' })).status, 200);
      assert.equal(h.cfg.comfyui.workflowPath, '', '删掉在用的工作流后退回内置');
    } finally {
      await new Promise((r) => server.close(r));
      await h.close();
    }
  });

  // 一个确定没人监听的端口：探活/生成都应该连不上
  const deadUrl = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(`http://127.0.0.1:${port}`)); });
  });

  await test('AI 画图权限：管理员私聊始终可画；仅管理员/白名单规则下其它会话不让 AI 代画', async () => {
    const c = (raw) => resolveComfyConfig(raw);
    assert.equal(aiDrawDenial(c({}), 'group', 456, 123), '');
    assert.equal(aiDrawDenial(c({ groups: [{ id: '456', accessMode: 'blacklist', denyUsers: ['1'] }] }), 'group', 456, 123), '', '黑名单不影响 AI');
    assert.match(aiDrawDenial(c({ enabled: false }), 'private', 123, 123), /关闭/);
    assert.match(aiDrawDenial(c({ ownerOnly: true }), 'group', 456, 123), /仅管理员/);
    assert.equal(aiDrawDenial(c({ ownerOnly: true }), 'private', 123, 123), '');
    assert.match(aiDrawDenial(c({ ownerOnly: true }), 'private', 999, 123), /仅管理员/);
    assert.match(aiDrawDenial(c({ groups: [{ id: '456', accessMode: 'whitelist', allowUsers: ['1'] }] }), 'group', 456, 123), /白名单/);
    assert.match(aiDrawDenial(c({ privateAccess: { accessMode: 'whitelist' } }), 'private', 999, 123), /白名单/);
    assert.equal(await probeComfyOnline(baseUrl), true);
    assert.equal(await probeComfyOnline(deadUrl, 500), false);
  });

  await test('AI 画图接口：带令牌出图发到会话、按会话冷却、开关/权限/令牌校验、qq_get_prompt 只在在线时列出', async () => {
    const h = await bridgeHarness({ config: { comfyui: { baseUrl, cooldownMs: 60000 }, sendDelayMs: 0 } });
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((r) => server.once('listening', r));
      h.setMode('reserved2');
      const KEY = 'group:456';
      const token = h.getSocialV2State(KEY).agentToken;
      const port = server.address().port;
      const call = (p, body, agentToken = token) => new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port, path: p, method: body === undefined ? 'GET' : 'POST',
          headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', ...(agentToken ? { 'x-agent-token': agentToken } : {}) },
        }, (res) => {
          let data = '';
          res.on('data', (ch) => { data += ch; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }));
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });

      const prompt = await call(`/api/socialV2/prompt?key=${KEY}`);
      assert.equal(prompt.status, 200, JSON.stringify(prompt.body));
      assert.ok(JSON.stringify(prompt.body).includes('qq_draw_image'), 'ComfyUI 在线时 qq_get_prompt 列出画图工具');

      h.calls.sent.length = 0;
      const drawn = await call('/api/socialV2/draw', { key: KEY, prompt: 'a cute cat, sunset' });
      assert.equal(drawn.status, 200, JSON.stringify(drawn.body));
      assert.equal(drawn.body.sent, 1);
      assert.equal(submitted.at(-1)[6].inputs.text, 'a cute cat, sunset');
      const img = h.calls.sent.find((s) => Array.isArray(s.text));
      assert.ok(img, '应发出图片消息');
      assert.equal(img.kind, 'group');
      assert.equal(String(img.id), '456');
      assert.equal(img.text.length, 1, '不带引用时只有一张图，不带文字');
      assert.equal(img.text[0].type, 'image');
      assert.ok(img.text[0].data.file.startsWith('base64://'));
      assert.ok(h.getSocialV2State(KEY).recentMessages.at(-1).text.includes('AI画图'), 'AI 的会话记录里记下自己发了图');

      const again = await call('/api/socialV2/draw', { key: KEY, prompt: 'again' });
      assert.equal(again.status, 429);
      assert.match(again.body.error, /秒后再试/);

      h.cfg.comfyui = { baseUrl, cooldownMs: 0 };
      assert.equal((await call('/api/socialV2/draw', { key: KEY, prompt: 'x' }, '')).status, 403, '没带令牌');
      assert.equal((await call('/api/socialV2/draw', { key: KEY, prompt: 'x' }, 'not-a-token')).status, 403, '假令牌');
      assert.equal((await call('/api/socialV2/draw', { key: KEY, prompt: 'x', replyToMessageId: 'abc' })).status, 400);
      h.cfg.comfyui = { baseUrl, cooldownMs: 0, ownerOnly: true };
      assert.equal((await call('/api/socialV2/draw', { key: KEY, prompt: 'x' })).status, 403, '仅管理员时群里不能代画');
      h.cfg.comfyui = { baseUrl, cooldownMs: 0, groups: ['999'] };
      assert.equal((await call('/api/socialV2/draw', { key: KEY, prompt: 'x' })).status, 403, '不在画图群列表');
      h.cfg.comfyui = { baseUrl, cooldownMs: 0 };
      h.cfg.socialV2.tools.drawImage = false;
      const off = await call('/api/socialV2/draw', { key: KEY, prompt: 'x' });
      assert.equal(off.status, 403);
      assert.match(off.body.error, /工具未启用/);
      h.cfg.socialV2.tools.drawImage = true;

      h.cfg.comfyui = { baseUrl: deadUrl, cooldownMs: 0 };
      const offline = await call(`/api/socialV2/prompt?key=${KEY}`);
      assert.ok(!JSON.stringify(offline.body).includes('qq_draw_image'), 'ComfyUI 离线时不列出画图工具');
      const failed = await call('/api/socialV2/draw', { key: KEY, prompt: 'x' });
      assert.equal(failed.status, 502);
      assert.equal(failed.body.error, '画图失败：ComfyUI 连接不上（可能没开）');
      assert.ok(!failed.body.error.includes(deadUrl.split(':').pop()), '不把 ComfyUI 地址等原始错误给模型');
      assert.ok(!h.calls.sent.some((s, i) => i > 0 && Array.isArray(s.text)), '失败时不发图');
    } finally {
      await new Promise((r) => server.close(r));
      await h.close();
    }
  });

  await test('MCP：qq_draw_image 只在 ComfyUI 在线且开关打开时注入，状态变化时动态显隐', async () => {
    // MCP 按自身位置找 config.json，所以把相关源码复制到临时目录，node_modules 用目录联接指回仓库
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-draw-'));
    const writeConfig = (obj) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ consolePort: 1, ...obj }));
    let client;
    const live = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    await new Promise((r) => live.listen(0, '127.0.0.1', r));
    const liveUrl = `http://127.0.0.1:${live.address().port}`;
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      for (const f of ['mcp-snowluma-safe.js', 'sensitive.js', 'qq-model-view.js']) {
        fs.copyFileSync(path.join(ROOT, 'src', f), path.join(dir, 'src', f));
      }
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
      const start = async () => {
        client = new Client({ name: 'draw-probe-test', version: '0.0.0' });
        await client.connect(new StdioClientTransport({
          command: process.execPath, args: [path.join(dir, 'src', 'mcp-snowluma-safe.js')], cwd: dir, stderr: 'pipe',
          env: { ...process.env, QQ_BRIDGE_COMFY_PROBE_MS: '200' },
        }));
      };
      const hasDraw = async () => (await client.listTools()).tools.some((t) => t.name === 'qq_draw_image');
      const waitFor = async (want, label) => {
        for (let i = 0; i < 50; i++) {
          if (await hasDraw() === want) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.fail(label);
      };

      writeConfig({ comfyui: { baseUrl: deadUrl } });
      await start();
      assert.equal(await hasDraw(), false, 'ComfyUI 离线：启动时不注入');
      writeConfig({ comfyui: { baseUrl: liveUrl } });
      await waitFor(true, 'ComfyUI 上线后应注入');
      const tool = (await client.listTools()).tools.find((t) => t.name === 'qq_draw_image');
      assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['key', 'prompt', 'replyToMessageId', 'token']);
      writeConfig({ comfyui: { baseUrl: liveUrl }, socialV2: { tools: { drawImage: false } } });
      await waitFor(false, '控制台关掉开关后应立即隐藏');
      writeConfig({ comfyui: { baseUrl: liveUrl } });
      await waitFor(true, '重新打开开关后应再次注入');
      await new Promise((r) => live.close(r));
      await waitFor(false, 'ComfyUI 下线后应隐藏');
      await client.close();

      writeConfig({ comfyui: { baseUrl }, socialV2: { tools: { drawImage: false } } });
      await start();
      assert.equal(await hasDraw(), false, '开关关闭时启动就不注册');
    } finally {
      await client?.close().catch(() => {});
      if (live.listening) live.close();
      // 先摘掉目录联接本身，避免任何清理逻辑顺着它进到仓库的 node_modules
      try { fs.unlinkSync(path.join(dir, 'node_modules')); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
} finally {
  fake.close();
}

if (failed) {
  console.log(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('\nComfyUI 画图测试全部通过');
