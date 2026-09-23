'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../server/server');
const { capabilities, complete, messagesFor, parseReply, checkedChat } = require('../server/ai-conversation');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');
const reply = { answer: '可以慢慢聊。', action: null };
function minimaxEnvelope(args = JSON.stringify(reply), finish = 'tool_calls') {
  return { base_resp: { status_code: 0 }, choices: [{ finish_reason: finish, message: { role: 'assistant', content: '',
    tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'unseen_reply', arguments: args } }] } }] };
}
const allCaps = () => ({ text: true, vision: true, asr: true });
async function fixture(t, adapter = {}, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-chat-'));
  const app = await createApp({ ...options, dataDir: dir, setupCode: 'test-chat', conversation: { capabilities: allCaps, complete: async () => reply, ...adapter } });
  t.after(async () => { app.server.closeAllConnections(); if (app.server.listening) await new Promise(resolve => app.server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const owner = await app.api('create', { setupCode: 'test-chat' });
  const invite = await app.api('invite', { role: 'family' }, owner.token);
  const family = await app.api('join', { invite: invite.invite, nickname: '家人' });
  async function photo(id = 'photo') { const file = await app.api('upload', { base64: png.toString('base64') }, owner.token); return (await app.api('send', { id, image: file.id, text: '家人提供的文字' }, owner.token)).id; }
  return { ...app, dir, owner, family, photo };
}
test('capability check is configuration-only: hy3 is never a vision fallback', () => {
  const app = { ai() {} };
  assert.equal(capabilities(app, { AI_MODEL: 'hy3' }).text, true);
  assert.equal(capabilities(app, { AI_MODEL: 'hy3' }).vision, false);
  assert.equal(capabilities(app, { AI_VISION_MODEL: 'hy3' }).vision, false);
  assert.equal(capabilities(app, { AI_VISION_MODEL: 'kimi-k2.6' }).vision, true);
  assert.equal(capabilities(app, { AI_VISION_MODEL: 'kimi-k2.6', AI_VISION_API_KEY: 'partial' }).vision, false);
  assert.equal(capabilities(null, { AI_MODEL: 'hy3' }).text, false);
  assert.equal(capabilities(app, {}).verification, 'configuration-only');
});
test('CloudBase ordinary multi-turn and direct multi-image JSON response use different configured models', async () => {
  const calls = [], app = { ai: () => ({ createModel: provider => { assert.equal(provider, 'cloudbase'); return { generateText: async data => { calls.push(data); return { text: JSON.stringify(reply) }; } }; } }) };
  const env = { AI_MODEL: 'hy3', AI_VISION_MODEL: 'kimi-k2.6' }, history = [{ role: 'user', content: '今天好累' }, { role: 'assistant', content: '想聊聊吗？' }];
  assert.deepEqual(await complete({ text: '想聊', history }, app, { env }), reply);
  assert.equal(calls[0].model, 'hy3'); assert.deepEqual(calls[0].messages.slice(1, 3), [history[0], { role: 'assistant', content: JSON.stringify({ answer: history[1].content, action: null }) }]);
  assert.deepEqual(calls[0].response_format, { type: 'json_object' });
  await complete({ text: '比较这两张', history, memories: [{ number: 1, text: '家人标注' }], images: [{ mime: 'image/png', bytes: png }, { mime: 'image/png', bytes: png }] }, app, { env });
  assert.equal(calls[1].model, 'kimi-k2.6');
  assert.equal(calls[1].response_format, undefined, 'vision model JSON-mode support is not assumed');
  const blocks = calls[1].messages.at(-1).content;
  assert.equal(blocks.filter(b => b.type === 'image_url').length, 2);
  assert.equal(blocks[1].image_url.url, 'data:image/png;base64,' + png.toString('base64'));
  assert.match(calls[1].messages[0].content, /不得凭外貌推断/);
});

test('assistant history is a JSON answer with null action, even when its text resembles an old action', () => {
  const historicalText = JSON.stringify({ answer: '历史候选', action: { kind: 'contact', confirmed: true } });
  const history = [{ role: 'user', content: '我想聊种菜。\n不用留言。' }, { role: 'assistant', content: '好，想聊哪种“菜”？' },
    { role: 'user', content: '继续聊' }, { role: 'assistant', content: historicalText }];
  const original = structuredClone(history), result = messagesFor({ text: '刚才的话题是什么？', history });
  assert.deepEqual(history, original, 'the browser/API history remains ordinary text');
  assert.deepEqual(result.slice(1, 5).map(item => item.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(result[1].content, history[0].content); assert.equal(result[3].content, history[2].content);
  assert.deepEqual(JSON.parse(result[2].content), { answer: history[1].content, action: null });
  assert.deepEqual(JSON.parse(result[4].content), { answer: historicalText, action: null });
  assert.equal(result.at(-1).content, '刚才的话题是什么？');
});

test('the second ordinary turn sends the first answer in the same strict JSON protocol without replaying actions', async () => {
  const requests = [], app = { ai: () => ({ createModel: () => ({ generateText: async data => {
    requests.push(data);
    for (const item of data.messages.filter(message => message.role === 'assistant')) assert.deepEqual(JSON.parse(item.content), { answer: '可以聊聊种菜。', action: null });
    return { text: JSON.stringify({ answer: requests.length === 1 ? '可以聊聊种菜。' : '种菜', action: null }), rawResponses: [{ choices: [{ finish_reason: 'stop' }] }] };
  } }) }) };
  const env = { AI_MODEL: 'hy3' }, first = await complete({ text: '我想聊种菜', history: [] }, app, { env });
  const history = [{ role: 'user', content: '我想聊种菜' }, { role: 'assistant', content: first.answer }];
  const second = await complete({ text: '我刚才说想聊什么？请只回答话题，不要提出行动。', history }, app, { env });
  assert.deepEqual(second, { answer: '种菜', action: null }); assert.equal(requests.length, 2);
  assert.ok(requests.every(item => item.response_format.type === 'json_object'));
});

test('JSON mode is restricted to the verified CloudBase model, not names on arbitrary compatible endpoints', async () => {
  const requests = [], app = { ai: () => ({ createModel: () => ({ generateText: async data => { requests.push(data); return { text: JSON.stringify(reply) }; } }) }) };
  for (const model of ['hy3-preview', 'other-model']) {
    await complete({ text: 'hi', history: [] }, app, { env: { AI_MODEL: model } });
    assert.equal(requests.at(-1).response_format, undefined);
  }
  const env = { AI_MODEL: 'hy3', AI_BASE_URL: 'https://example.test/v1', AI_API_KEY: 'fixture-only' };
  await complete({ text: 'hi', history: [] }, null, { env, fetcher: async (url, opts) => {
    assert.equal(JSON.parse(opts.body).response_format, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }] }));
  } });
});

test('format diagnostics contain only fixed categories, character counts and known finish reasons', async () => {
  const events = [], cases = [
    { text: 'PRIVATE_REPLY', reason: 'stop', category: 'invalid_json', finish: 'stop' },
    { text: JSON.stringify({ answer: 'PRIVATE_REPLY', action: { confirmed: true } }), reason: 'PRIVATE_FINISH', category: 'invalid_action', finish: 'unknown' },
    { text: JSON.stringify(reply), reason: 'length', category: 'truncated', finish: 'length' },
    { text: undefined, reason: 'stop', category: 'missing_text', finish: 'stop' }
  ];
  for (const item of cases) {
    const app = { ai: () => ({ createModel: () => ({ generateText: async () => ({ text: item.text, rawResponses: [{ choices: [{ finish_reason: item.reason, message: { content: 'PRIVATE_RAW' } }] }] }) }) }) };
    await assert.rejects(complete({ text: 'PRIVATE_PROMPT', history: [] }, app, { env: { AI_MODEL: 'hy3' }, diagnostic: event => events.push(event) }), { code: 'AI_RESPONSE', status: 503 });
    assert.deepEqual(events.at(-1), { category: item.category, characters: item.text?.length || 0, finish_reason: item.finish });
  }
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  for (const output of ['种菜', '说明文字' + JSON.stringify(reply), JSON.stringify(reply) + '已经发送', JSON.stringify({ ...reply, executed: true })]) assert.throws(() => parseReply(output), { code: 'AI_RESPONSE' });
  const env = { AI_MODEL: 'custom', AI_BASE_URL: 'https://example.test/v1', AI_API_KEY: 'PRIVATE_KEY' };
  await assert.rejects(complete({ text: 'PRIVATE_PROMPT', history: [] }, null, { env,
    diagnostic: event => events.push(event), fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'PRIVATE_RESPONSE' }, finish_reason: 'stop' }] })) }), { code: 'AI_RESPONSE' });
  assert.deepEqual(events.at(-1), { category: 'invalid_json', characters: 16, finish_reason: 'stop' });
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});
test('compatible provider bounds, parses and sanitizes output without leaking errors', async () => {
  const env = { AI_BASE_URL: 'https://example.test/v1', AI_API_KEY: 'test', AI_MODEL: 'model' };
  assert.deepEqual(await complete({ text: 'hello', history: [] }, null, { env, fetcher: async (url, opts) => { assert.equal(url, 'https://example.test/v1/chat/completions'); assert.equal(opts.redirect, 'error'); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] })); } }), reply);
  for (const [status, code] of [[401, 'AI_PERMISSION'], [429, 'AI_QUOTA'], [404, 'AI_SERVICE']]) await assert.rejects(complete({ text: 'x', history: [] }, null, { env, fetcher: async () => new Response('SECRET', { status }) }), e => e.code === code && !e.message.includes('SECRET'));
  await assert.rejects(complete({ text: 'x', history: [] }, null, { env, fetcher: async () => new Response('x'.repeat(128001)) }), { code: 'AI_RESPONSE' });
});
test('official MiniMax M3 sends single/multiple image bytes and JSON history without thinking in the answer', async () => {
  const history = [{ role: 'user', content: '刚才聊这张照片' }, { role: 'assistant', content: '可以聊聊看得见的内容。' }];
  for (const [base, imageCount] of [['https://api.minimax.cn/v1/', 1], ['https://api.minimax.io/v1', 4]]) {
    const images = Array.from({ length: imageCount }, () => ({ mime: 'image/png', bytes: png }));
    const env = { AI_MODEL: 'hy3', AI_VISION_BASE_URL: base, AI_VISION_API_KEY: 'fixture-only', AI_VISION_MODEL: 'MiniMax-M3' };
    const output = await complete({ text: '只说照片的可见内容', history, images }, null, { env, fetcher: async (url, options) => {
      assert.equal(url, base.replace(/\/$/, '') + '/chat/completions');
      assert.equal(options.redirect, 'error'); assert.equal(options.signal.aborted, false);
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'MiniMax-M3'); assert.equal(body.max_completion_tokens, 1200); assert.equal(body.max_tokens, undefined);
      assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.reasoning_split, true);
      assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'unseen_reply' } });
      assert.equal(body.tools.length, 1); assert.equal(body.tools[0].function.name, 'unseen_reply');
      const schema = body.tools[0].function.parameters;
      assert.deepEqual(schema.required, ['answer', 'action']); assert.equal(schema.additionalProperties, false);
      assert.match(schema.properties.action.description, /当前用户明确要求给家人留言或联系家人/);
      assert.match(schema.properties.action.description, /普通聊天、看图、描述或比较照片必须返回action:null/);
      assert.match(schema.properties.action.description, /message对象代替null/);
      assert.ok(body.messages[0].content.includes(schema.properties.action.description), 'system and action schema share the same intent constraint');
      assert.deepEqual(schema.properties.action.anyOf[0], { type: 'null' });
      assert.deepEqual(schema.properties.action.anyOf[1].required, ['kind', 'targetHint', 'text', 'usePhotos', 'useVoice']);
      assert.equal(schema.properties.action.anyOf[1].additionalProperties, false);
      assert.ok(body.messages[0].content.startsWith(messagesFor({ text: '只说照片的可见内容', history, images })[0].content), 'the base product policy is preserved');
      assert.match(body.messages[0].content, /必须调用 unseen_reply 一次/);
      assert.equal(body.response_format, undefined, 'the official schema has no verified JSON mode');
      assert.equal(body.service_tier, undefined, 'no priority tier is requested');
      assert.deepEqual(JSON.parse(body.messages.find(message => message.role === 'assistant').content), { answer: history[1].content, action: null });
      const blocks = body.messages.at(-1).content;
      assert.equal(blocks[0].text, '只说照片的可见内容'); assert.equal(blocks.length, imageCount + 1);
      assert.ok(blocks.slice(1).every(block => block.type === 'image_url' && block.image_url.url === 'data:image/png;base64,' + png.toString('base64')));
      const envelope = minimaxEnvelope();
      envelope.choices[0].message.reasoning_content = 'PRIVATE_REASONING';
      envelope.choices[0].message.reasoning_details = [{ text: 'PRIVATE_REASONING' }];
      return new Response(JSON.stringify(envelope));
    } });
    assert.deepEqual(output, reply, 'only the strict answer is returned, never reasoning');
  }
});

test('MiniMax M3 parameters require an exact documented endpoint and model, leaving other providers unchanged', async () => {
  for (const [base, model] of [
    ['https://api.minimax.cn/v1', 'MiniMax-M2.7'], ['https://api.minimax.io/v1', 'MiniMax-M3-preview'],
    ['https://api.minimaxi.com/v1', 'MiniMax-M3'], ['https://proxy.example.test/v1', 'MiniMax-M3'],
    ['https://api.minimax.cn.example.test/v1', 'MiniMax-M3'], ['https://api.minimax.cn:8443/v1', 'MiniMax-M3'],
    ['https://api.minimax.cn/other/v1', 'MiniMax-M3']
  ]) {
    await complete({ text: 'hi', history: [] }, null, { env: { AI_BASE_URL: base, AI_API_KEY: 'fixture-only', AI_MODEL: model }, fetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.max_tokens, 1200); assert.equal(body.max_completion_tokens, undefined);
      assert.equal(body.thinking, undefined); assert.equal(body.reasoning_split, undefined); assert.equal(body.response_format, undefined);
      assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    } });
  }
  const app = { ai: () => ({ createModel: () => ({ generateText: async body => {
    assert.equal(body.max_tokens, 1200); assert.equal(body.thinking, undefined); assert.equal(body.reasoning_split, undefined);
    assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined);
    return { text: JSON.stringify(reply) };
  } }) }) };
  await complete({ text: 'hi', history: [] }, app, { env: { AI_MODEL: 'MiniMax-M3' } });
});

test('MiniMax thinking, malformed actions, truncation and provider-declared errors remain failures', async () => {
  const env = { AI_BASE_URL: 'https://api.minimax.cn/v1', AI_API_KEY: 'PRIVATE_KEY', AI_MODEL: 'MiniMax-M3' }, diagnostics = [];
  for (const [content, finish_reason] of [
    ['<think>PRIVATE_REASONING</think>' + JSON.stringify(reply), 'stop'],
    [JSON.stringify({ ...reply, action: { kind: 'message', confirmed: true } }), 'stop'],
    [JSON.stringify(reply), 'length']
  ]) await assert.rejects(complete({ text: 'PRIVATE_PROMPT', history: [] }, null, { env, diagnostic: value => diagnostics.push(value),
    fetcher: async () => new Response(JSON.stringify(minimaxEnvelope(content, finish_reason))) }), { code: 'AI_RESPONSE' });
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE/);
  await assert.rejects(complete({ text: 'hi', history: [] }, null, { env, fetcher: async () => new Response(JSON.stringify({
    base_resp: { status_code: 1000, status_msg: 'PRIVATE_VENDOR_DETAIL' }, choices: [{ message: { content: JSON.stringify(reply) } }]
  })) }), { code: 'AI_UPSTREAM', message: 'AI 服务暂不可用，请稍后重试' });
});

test('MiniMax accepts exactly one named reply envelope, allowing only empty optional content', async () => {
  const env = { AI_BASE_URL: 'https://api.minimax.cn/v1', AI_API_KEY: 'fixture-only', AI_MODEL: 'MiniMax-M3' };
  for (const content of [undefined, null, '', ' \n']) {
    const envelope = minimaxEnvelope(JSON.stringify(reply), content === null ? 'stop' : 'tool_calls');
    envelope.choices[0].message.content = content;
    assert.deepEqual(await complete({ text: 'hi', history: [] }, null, { env, fetcher: async () => new Response(JSON.stringify(envelope)) }), reply);
  }
});

test('MiniMax refuses prose, unknown/multiple tools and ambiguous envelopes without retry or content fallback', async () => {
  const env = { AI_BASE_URL: 'https://api.minimax.cn/v1', AI_API_KEY: 'PRIVATE_KEY', AI_MODEL: 'MiniMax-M3' };
  const mutations = [
    response => { response.choices = []; },
    response => { response.choices.push(structuredClone(response.choices[0])); },
    response => { response.choices[0].finish_reason = 'content_filter'; },
    response => { delete response.choices[0].finish_reason; },
    response => { response.choices[0].message.role = 'user'; },
    response => { response.choices[0].message.content = '**第一张图片：**红圆蓝方。'; delete response.choices[0].message.tool_calls; },
    response => { response.choices[0].message.content = JSON.stringify(reply); delete response.choices[0].message.tool_calls; },
    response => { response.choices[0].message.content = 'PRIVATE_UNTRUSTED_CONTENT'; },
    response => { response.choices[0].message.content = { answer: 'PRIVATE_UNTRUSTED_CONTENT' }; },
    response => { response.choices[0].message.tool_calls = []; },
    response => { response.choices[0].message.tool_calls.push(structuredClone(response.choices[0].message.tool_calls[0])); },
    response => { response.choices[0].message.tool_calls[0].type = 'custom'; },
    response => { response.choices[0].message.tool_calls[0].function.name = 'send'; },
    response => { delete response.choices[0].message.tool_calls[0].function.arguments; },
    response => { response.choices[0].message.tool_calls[0].function.arguments = reply; }
  ];
  for (const change of mutations) {
    const envelope = minimaxEnvelope(), events = []; let requests = 0;
    change(envelope);
    await assert.rejects(complete({ text: 'PRIVATE_PROMPT', history: [] }, null, { env, diagnostic: event => events.push(event),
      fetcher: async () => { requests++; return new Response(JSON.stringify(envelope)); } }), { code: 'AI_RESPONSE' });
    assert.equal(requests, 1); assert.equal(events[0].category, 'invalid_tool_reply');
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  }
});

test('MiniMax reply arguments must be a complete JSON object with the existing answer and action limits', async () => {
  const action = { kind: 'message', targetHint: '妈妈', text: '明天见', usePhotos: false, useVoice: false };
  const env = { AI_BASE_URL: 'https://api.minimax.cn/v1', AI_API_KEY: 'fixture-only', AI_MODEL: 'MiniMax-M3' };
  for (const args of ['```json\n' + JSON.stringify(reply) + '\n```', '说明' + JSON.stringify(reply), JSON.stringify(reply) + '已发送',
    '{"answer":', JSON.stringify(JSON.stringify(reply)), JSON.stringify({ answer: '   ', action: null }),
    JSON.stringify({ ...reply, answer: 'a'.repeat(4001) }), JSON.stringify({ ...reply, confirmed: true }),
    JSON.stringify({ ...reply, action: { ...action, confirmed: true } }), JSON.stringify({ ...reply, action: { ...action, targetId: 'a_fake' } }),
    JSON.stringify({ ...reply, action: { ...action, text: 'a'.repeat(2001) } }), JSON.stringify({ ...reply, action: { ...action, usePhotos: 'true' } }),
    'x'.repeat(12001)]) {
    await assert.rejects(complete({ text: 'hi', history: [] }, null, { env, diagnostic() {},
      fetcher: async () => new Response(JSON.stringify(minimaxEnvelope(args))) }), { code: 'AI_RESPONSE' });
  }
});

test('MiniMax single reply tool is data only: actual conversation returns a photo action candidate without sending', async t => {
  const action = { kind: 'message', targetHint: '家人', text: '看看这两张照片', usePhotos: true, useVoice: false };
  const env = { AI_VISION_BASE_URL: 'https://api.minimax.cn/v1', AI_VISION_API_KEY: 'fixture-only', AI_VISION_MODEL: 'MiniMax-M3' };
  let requests = 0;
  const f = await fixture(t, { complete: input => complete(input, null, { env, fetcher: async (url, options) => {
    requests++;
    const body = JSON.parse(options.body);
    assert.equal(body.messages.at(-1).content.filter(block => block.type === 'image_url').length, 2);
    return new Response(JSON.stringify(minimaxEnvelope(JSON.stringify({ answer: '请选择家人并确认', action }))));
  } }) });
  const first = await f.photo('minimax-one'), second = await f.photo('minimax-two');
  const before = await f.store.list('message', f.owner.room);
  const result = await f.api('aiChat', { text: '把这两张照片给家人留言：看看这两张照片', messageIds: [first, second], readPhoto: true }, f.owner.token);
  assert.deepEqual(result.action, action); assert.equal(result.confirmed, false); assert.equal(result.imageCount, 2);
  assert.deepEqual(await f.store.list('message', f.owner.room), before, 'no model call can publish a message');
  assert.equal(requests, 1, 'there is no tool executor or follow-up completion');
});

test('MiniMax action guidance preserves model data and incomplete explicit requests without silently rewriting to null', async () => {
  const empty = { kind: 'message', targetHint: '', text: '', usePhotos: false, useVoice: false };
  const env = { AI_VISION_BASE_URL: 'https://api.minimax.cn/v1', AI_VISION_API_KEY: 'fixture-only', AI_VISION_MODEL: 'MiniMax-M3' };
  for (const [text, action] of [
    ['请分别描述第一张、第二张图片中的形状及对应颜色，并指出不同。不要猜测图片之外的信息。', empty],
    ['请描述两张照片', null],
    ['我想给妈妈留言', { ...empty, targetHint: '妈妈' }]
  ]) {
    let requests = 0;
    const output = await complete({ text, history: [], images: [{ mime: 'image/png', bytes: png }, { mime: 'image/png', bytes: png }] }, null, {
      env, fetcher: async () => { requests++; return new Response(JSON.stringify(minimaxEnvelope(JSON.stringify({ answer: '模型原始回答', action })))); }
    });
    assert.deepEqual(output, { answer: '模型原始回答', action }); assert.equal(requests, 1);
  }
});

test('MiniMax M3 cancellation aborts the one fetch without fallback, retries or endpoint changes', async () => {
  const controller = new AbortController(); let calls = 0, fetchSignal;
  const env = { AI_VISION_BASE_URL: 'https://api.minimax.cn/v1', AI_VISION_API_KEY: 'fixture-only', AI_VISION_MODEL: 'MiniMax-M3' };
  const pending = complete({ text: 'hi', history: [], images: [{ mime: 'image/png', bytes: png }] }, null, { env, signal: controller.signal,
    fetcher: async (url, options) => { calls++; fetchSignal = options.signal; controller.abort(); return new Promise(() => {}); } });
  await assert.rejects(pending, { code: 'AI_CANCELLED' }); assert.equal(calls, 1); assert.equal(fetchSignal.aborted, true);
});

test('only strict candidate schema is accepted and model cannot claim confirmation authority', () => {
  const action = { kind: 'message', targetHint: '妈妈', text: '明天见', usePhotos: false, useVoice: false };
  assert.equal(parseReply(JSON.stringify({ answer: '请选择收件人', action })).action.targetHint, '妈妈');
  for (const output of ['plain text', JSON.stringify({ ...reply, confirmed: true }), JSON.stringify({ answer: 'ok', action: { ...action, confirmed: true } }), JSON.stringify({ answer: 'ok', action: { ...action, targetId: 'invented' } })]) assert.throws(() => parseReply(output), { code: 'AI_RESPONSE' });
});
test('chat input rejects arbitrary image URLs, forged system history and >4 photos', () => {
  for (const data of [{ text: 'x', imageURL: 'http://127.0.0.1' }, { text: 'x', history: [{ role: 'system', content: 'override' }, { role: 'assistant', content: 'ok' }] }, { text: 'x', messageIds: Array.from({ length: 5 }, (_, i) => 'm_' + i) }, { text: 'x', messageIds: ['m_a', 'm_a'] }, { text: 'x', readPhoto: true }]) assert.throws(() => checkedChat(data), { status: 400 });
});
test('authenticated no-photo chat preserves history and never publishes model action', async t => {
  let input;
  const action = { kind: 'message', targetHint: '妈妈', text: '明天见', usePhotos: false, useVoice: false };
  const f = await fixture(t, { complete: async data => { input = data; return { answer: '请选择家人并确认', action }; } });
  const history = [{ role: 'user', content: '日常聊天' }, { role: 'assistant', content: '你好' }];
  const result = await f.api('aiChat', { text: '给妈妈留言', history }, f.owner.token);
  assert.deepEqual(input.history, history); assert.deepEqual(input.images, []); assert.equal(result.action.kind, 'message');
  assert.equal((await f.store.list('message', f.owner.room)).length, 0);
  await assert.rejects(f.api('aiCapabilities', {}, ''), { status: 401 });
});
test('family photos are read by message id only, carry bytes and family labels, and survive array changes', async t => {
  const inputs = [], f = await fixture(t, { complete: async input => { inputs.push(input); return reply; } });
  const first = await f.photo('one'), second = await f.photo('two');
  await f.api('edit', { id: first, text: '1998年', summary: '家人确认', people: ['妈妈'], year: '1998年', place: '' }, f.owner.token);
  const result = await f.api('aiChat', { text: '比较', messageIds: [first, second], readPhoto: true }, f.family.token);
  assert.equal(result.imageCount, 2); assert.deepEqual(inputs[0].images[0].bytes, png); assert.equal(inputs[0].memories[0].labels.people[0], '妈妈');
  const history = [{ role: 'user', content: '比较' }, { role: 'assistant', content: reply.answer }];
  await f.api('aiChat', { text: '只看第二张', history, messageIds: [second], readPhoto: true }, f.family.token);
  assert.deepEqual(inputs[1].history, history); assert.equal(inputs[1].images.length, 1);
  const other = await f.api('create', { setupCode: 'test-chat' });
  await assert.rejects(f.api('aiChat', { text: '越权', messageIds: [first], readPhoto: true }, other.token), { status: 404 });
  assert.equal(inputs.length, 2);
});
test('unconfigured vision and digest mismatch fail before model call; no text fallback', async t => {
  let calls = 0, vision = false;
  const f = await fixture(t, { capabilities: () => ({ text: true, vision, asr: false }), complete: async () => { calls++; return reply; } });
  const id = await f.photo();
  await assert.rejects(f.api('aiChat', { text: '看图', messageIds: [id], readPhoto: true }, f.owner.token), { code: 'AI_CONFIG' });
  vision = true;
  const m = await f.store.get(id); await f.store.mutate('f_' + m.image, old => ({ ...old, digest: 'changed' }));
  await assert.rejects(f.api('aiChat', { text: '看图', messageIds: [id], readPhoto: true }, f.owner.token), { code: 'AI_IMAGE' });
  assert.equal(calls, 0);
});
test('logout and memory deletion during model request suppress final response', async t => {
  let finish, began; let started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { complete: () => { began(); return new Promise(resolve => { finish = resolve; }); } });
  const request = f.api('aiChat', { text: '等待' }, f.family.token); await started;
  await f.api('logout', {}, f.family.token); finish(reply); await assert.rejects(request, { status: 401 });
  const id = await f.photo(); started = new Promise(resolve => { began = resolve; });
  const photoRequest = f.api('aiChat', { text: '等待', messageIds: [id], readPhoto: true }, f.owner.token); await started;
  await f.api('remove', { id }, f.owner.token); finish(reply); await assert.rejects(photoRequest, { status: 404 });
});
test('cancellation propagates to model and settles without leaking late result', async t => {
  let began, providerSignal; const started = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { complete: (input, app, { signal }) => { providerSignal = signal; began(); return new Promise(() => {}); } });
  const control = new AbortController(), request = f.api('aiChat', { text: '等待' }, f.owner.token, control.signal);
  await started; control.abort(); await assert.rejects(request, { code: 'AI_CANCELLED' }); assert.equal(providerSignal.aborted, true);
});
test('persistent family budget is shared across sessions and app restarts', async t => {
  const f = await fixture(t);
  const usage = { _id: 'ai_usage_' + f.owner.room, kind: 'ai-usage', room: f.owner.room, day: Math.floor(Date.now() / 86400000), daily: 60, minute: 0, recent: 0 };
  await f.store.put(usage);
  await assert.rejects(f.api('aiChat', { text: '超额' }, f.family.token), { status: 429 });
  const restarted = await createApp({ dataDir: f.dir, setupCode: 'test-chat', conversation: { capabilities: allCaps, complete: async () => reply } });
  await assert.rejects(restarted.api('aiChat', { text: '超额' }, f.owner.token), { status: 429 });
});
test('invalid audio is rejected before ASR; transient speech does not upload a family file', async t => {
  let calls = 0;
  const f = await fixture(t, { transcribe: async () => { calls++; return '真实接口替身文本'; } });
  await assert.rejects(f.api('aiTranscribe', { base64: 'bm90IHdhdg==' }, f.owner.token), { code: 'AI_AUDIO_FORMAT' });
  const b = Buffer.alloc(3244); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(3200, 40);
  assert.equal((await f.api('aiTranscribe', { base64: b.toString('base64') }, f.owner.token)).text, '真实接口替身文本');
  assert.equal(calls, 1); assert.equal((await f.store.list('file', f.owner.room)).length, 0);
});
test('HTTP action integration binds confirmation and allows frame shared message only through confirmed action', async t => {
  const f = await fixture(t); await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${f.server.address().port}`;
  async function call(action, data, token, status = 200) { const r = await fetch(address + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action, data }) }); const body = await r.json(); assert.equal(r.status, status, JSON.stringify(body)); return body; }
  const invite = await f.api('invite', { role: 'frame' }, f.owner.token), frame = await f.api('join', { invite: invite.invite });
  const members = (await call('contactState', {}, frame.token)).members, targetId = members[0].id;
  await call('send', { id: 'bypass', text: '不可越过确认', confirmedAction: true }, frame.token, 400);
  const preview = await call('aiActionPrepare', { kind: 'message', targetId, text: '明天见' }, frame.token);
  assert.equal(preview.visibility, 'family'); assert.equal((await f.store.list('message', f.owner.room)).length, 0);
  const result = await call('aiActionConfirm', { actionId: preview.actionId, version: preview.version }, frame.token);
  assert.equal(result.status, 'completed');
  await call('aiActionConfirm', { actionId: preview.actionId, version: preview.version }, frame.token);
  const shared = await f.store.list('message', f.owner.room); assert.equal(shared.length, 1); assert.match(shared[0].text, /家庭共享/); assert.equal(shared[0].type, 'photo');
  const contact = await call('aiActionPrepare', { kind: 'contact', mode: 'request-only', targetId }, frame.token);
  await call('aiActionConfirm', { actionId: contact.actionId, version: contact.version }, frame.token);
  assert.equal((await call('contactState', {}, frame.token)).requests.length, 1);
});

test('real-call routes stay disabled without controlled relay configuration and never fall back to a reminder', async t => {
  const f = await fixture(t, {}, { call: { env: {} } });
  assert.equal((await f.api('callCapabilities', {}, f.owner.token)).audioCall, false);
  const targetId = (await f.api('contactState', {}, f.owner.token)).members[0].id;
  await assert.rejects(f.api('aiActionPrepare', { kind: 'contact', mode: 'audio-call', targetId }, f.owner.token), { status: 503 });
  await assert.rejects(f.api('callStart', { targetId, requestId: 'no-relay-call' }, f.owner.token), { status: 503 });
  assert.equal((await f.api('contactState', {}, f.owner.token)).requests.length, 0);
});

test('HTTP confirmed audio call binds both participants and exchanges only peer signaling after acceptance', async t => {
  const env = { MEMORY_CALL_ENABLED: '1', MEMORY_CALL_ICE_SERVERS_JSON: JSON.stringify([{ urls: ['turns:relay.example.test:5349?transport=tcp'] }]), MEMORY_CALL_TURN_SECRET: 'test-only-nonsecret-relay-fixture-32-bytes' };
  const f = await fixture(t, {}, { call: { env } }); await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${f.server.address().port}`;
  async function call(action, data, token, status = 200) { const r = await fetch(address + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action, data }) }); const body = await r.json(); assert.equal(r.status, status, JSON.stringify(body)); return body; }
  const targetId = (await call('contactState', {}, f.owner.token)).members[0].id;
  const candidate = await call('aiActionPrepare', { kind: 'contact', mode: 'audio-call', targetId }, f.owner.token);
  assert.equal(candidate.audioCall, true); assert.equal((await call('callState', {}, f.family.token)).calls.length, 0);
  const confirmed = await call('aiActionConfirm', { actionId: candidate.actionId, version: candidate.version }, f.owner.token);
  const callId = confirmed.results[0].callId;
  assert.equal(confirmed.results[0].mode, 'audio-call');
  assert.equal((await call('callState', { id: callId }, f.family.token)).call.status, 'ringing');
  await call('callIce', { id: callId }, f.owner.token, 409);
  await call('callAccept', { id: callId }, f.family.token);
  const ice = await call('callIce', { id: callId }, f.owner.token);
  assert.equal(ice.iceTransportPolicy, 'relay'); assert.ok(ice.iceServers[0].credential); assert.notEqual(ice.iceServers[0].credential, env.MEMORY_CALL_TURN_SECRET);
  const offer = { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n' };
  await call('callSignal', { id: callId, description: offer }, f.owner.token);
  const incoming = await call('callState', { id: callId }, f.family.token);
  assert.deepEqual(incoming.call.peer.description, offer); assert.equal(incoming.call.status, 'connecting');
  assert.equal((await call('callState', {}, f.family.token)).calls[0].peer, undefined);
  const other = await f.api('create', { setupCode: 'test-chat' }); await call('callState', { id: callId }, other.token, 404);
  await call('callEnd', { id: callId }, f.owner.token);
  assert.equal((await call('callState', { id: callId }, f.family.token)).call.status, 'ended');
  await call('callIce', { id: callId }, f.family.token, 409);
  assert.equal((await call('contactState', {}, f.family.token)).requests.length, 0);
  const pending = await call('callStart', { targetId, requestId: 'lost-response-call' }, f.owner.token);
  const cancelled = await call('callCancelStart', { requestId: 'lost-response-call' }, f.owner.token);
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.callId, pending.callId);
  assert.equal((await call('callState', { id: pending.callId }, f.family.token)).call.status, 'ended');
  await call('callCancelStart', { requestId: 'cancel-before-write' }, f.owner.token);
  await call('callStart', { targetId, requestId: 'cancel-before-write' }, f.owner.token, 409);
});
