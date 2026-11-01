// ComfyUI 画图：纯函数 + 假 ComfyUI 服务上的完整链路（QQ 触发 → 出图回复；控制台工作流管理）。
// 离线：不连真实 ComfyUI、不发真 QQ 消息。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  createComfyClient, fillCustomWorkflow, inspectWorkflow, matchDrawTrigger, resolveComfyConfig, sanitizeWorkflowFile,
} from '../src/comfyui.js';

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
} finally {
  fake.close();
}

if (failed) {
  console.log(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log('\nComfyUI 画图测试全部通过');
