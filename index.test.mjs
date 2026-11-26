import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FreePoolPlugin,
  KiloFreePlugin,
  Llm7FreePlugin,
  PollinationsFreePlugin,
  OvhFreePlugin,
  _internal,
} from './index.mjs'
import {
  healthCheck,
  normalizeCatalog,
  fetchModels,
  probeModel,
  dedupeModels,
  selectCandidates,
  qualityScore,
  makeFetch,
  aliveModelIds,
  writeSnapshot,
  readSnapshot,
  DEFAULT_SNAPSHOT,
} from './health.mjs'
import { runOnce } from './polling.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXPECTED = [
  { id: 'kilo-free', name: 'Kilo Free', api: 'https://api.kilo.ai/api/gateway', models: ['kilo-auto/free', 'nvidia/nemotron-3.5-lightning:free', 'openrouter/free'] },
  { id: 'llm7-free', name: 'LLM7 Free', api: 'https://api.llm7.io/v1', models: ['turbo'] },
  { id: 'pollinations-free', name: 'Pollinations Free', api: 'https://text.pollinations.ai/openai', models: ['openai-fast'] },
  { id: 'ovh-free', name: 'OVH Free', api: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', models: ['gpt-oss-120b', 'Qwen3.8-27B'] },
]

// ------------------------------------------------------------------ index ----

test('SPECS registers exactly four providers in config', async () => {
  const plugin = await FreePoolPlugin()
  assert.equal(typeof plugin.config, 'function')
  const cfg = {}
  await plugin.config(cfg)
  assert.deepEqual(Object.keys(cfg.provider).sort(), EXPECTED.map((e) => e.id).sort())
  for (const e of EXPECTED) {
    const p = cfg.provider[e.id]
    assert.equal(p.name, e.name)
    assert.equal(p.npm, '@ai-sdk/openai-compatible')
    assert.equal(p.api, e.api)
    assert.ok(Object.keys(p.models).length > 0, `${e.id} needs seed models`)
  }
})

test('config uses ??= and preserves a user-supplied provider', async () => {
  const plugin = await FreePoolPlugin()
  const custom = { name: 'Mine', npm: '@ai-sdk/openai-compatible', api: 'http://localhost:1/v1', models: {} }
  const cfg = { provider: { 'kilo-free': custom } }
  await plugin.config(cfg)
  assert.equal(cfg.provider['kilo-free'], custom)
  assert.ok(cfg.provider['llm7-free'])
  assert.ok(cfg.provider['pollinations-free'])
  assert.ok(cfg.provider['ovh-free'])
})

test('the four auth hooks expose one provider id each', async () => {
  const pairs = [
    [await KiloFreePlugin(), 'kilo-free'],
    [await Llm7FreePlugin(), 'llm7-free'],
    [await PollinationsFreePlugin(), 'pollinations-free'],
    [await OvhFreePlugin(), 'ovh-free'],
  ]
  for (const [plugin, id] of pairs) {
    const auth = plugin.auth
    assert.equal(auth.provider, id)
    assert.equal(auth.methods.length, 1)
    assert.equal(auth.methods[0].type, 'api')
    assert.equal(typeof auth.loader, 'function')
    assert.equal(typeof auth.usage, 'function')
  }
})

test('authorize completes without a real key and loader uses a passthrough fetch', async () => {
  const auth = (await KiloFreePlugin()).auth
  const result = await auth.methods[0].authorize()
  assert.equal(result.type, 'success')
  assert.equal(result.key, 'anonymous')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (u, i) => ({ ok: true, u, i })
  try {
    const loader = await auth.loader()
    assert.equal(loader.baseURL, 'https://api.kilo.ai/api/gateway')
    assert.equal(loader.apiKey, 'anonymous')
    const seen = await loader.fetch('http://example.invalid/x', { method: 'GET' })
    assert.equal(seen.ok, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('usage is static fair-use info with no fabricated values', async () => {
  for (const make of [KiloFreePlugin, Llm7FreePlugin, PollinationsFreePlugin, OvhFreePlugin]) {
    const usage = await (await make()).auth.usage()
    assert.ok(Array.isArray(usage.windows) && usage.windows.length > 0)
    for (const w of usage.windows) {
      assert.equal('used' in w, false)
      assert.equal('remaining' in w, false)
      assert.ok(w.display)
    }
  }
})

test('_internal exposes spec data for diagnostics', () => {
  assert.equal(_internal.SPECS.length, 4)
  assert.ok(_internal.ICON.startsWith('https://'))
})

// ------------------------------------------------------------- normalize ----

test('normalizeCatalog: openrouter style (kilo)', () => {
  const spec = { id: 'kilo-free', name: 'Kilo Free', modelFormat: 'openrouter' }
  const json = {
    data: [
      {
        id: 'kilo-auto/free',
        name: 'Auto Free',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['tools'],
        top_provider: { context_length: 128000, max_completion_tokens: 8192 },
      },
      {
        id: 'openai/gpt-6-luna',
        name: 'GPT-6 Luna',
        architecture: { output_modalities: ['text'] },
        pricing: { prompt: '0.000002', completion: '0.000008' },
        top_provider: { context_length: 1000000 },
      },
    ],
  }
  const out = normalizeCatalog(spec, json)
  assert.equal(out.length, 2)
  const free = out[0]
  assert.equal(free.id, 'kilo-free/kilo-auto/free')
  assert.equal(free.free, true)
  assert.equal(free.tool_call, true)
  assert.equal(free.provider, 'kilo-free')
  const paid = out[1]
  assert.equal(paid.id, 'kilo-free/openai/gpt-6-luna')
  assert.equal(paid.free, false)
})

test('normalizeCatalog: llm7 style with tier=turbo anonymous', () => {
  const spec = { id: 'llm7-free', name: 'LLM7 Free', modelFormat: 'llm7' }
  const json = {
    data: [
      {
        id: 'codestral-latest',
        context_window: { tokens: 512000 },
        capabilities: { tools: true, reasoning: true },
        modalities: { input: ['text'], output: ['text'] },
        tiers: ['turbo', 'pro'],
        pricing: { input: 0.5, output: 1.2 },
      },
      {
        id: 'gpt-oss:20b',
        context_window: { tokens: 128000 },
        capabilities: { tools: true },
        modalities: { input: ['text'], output: ['text'] },
        tiers: ['turbo'],
        pricing: { input: 0.5, output: 1.2 },
      },
    ],
  }
  const out = normalizeCatalog(spec, json)
  assert.equal(out.length, 2)
  assert.ok(out.every((m) => m.free === true), 'turbo tier should count as free candidate')
  assert.equal(out[0].id, 'llm7-free/codestral-latest')
})

test('normalizeCatalog: pollinations style array with aliases', () => {
  const spec = { id: 'pollinations-free', name: 'Pollinations Free', modelFormat: 'auto' }
  const json = [{ name: 'openai-fast', description: 'GPT-OSS 20B', tier: 'anonymous', tools: true, reasoning: true, aliases: ['openai', 'gpt-oss-20b'] }]
  const out = normalizeCatalog(spec, json)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'pollinations-free/openai-fast')
  assert.equal(out[0].free, true)
  assert.deepEqual(out[0].aliases, ['openai', 'gpt-oss-20b'])
})

// -------------------------------------------------------------- probe -------

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

test('probeModel: 200 with content = alive', async () => {
  const health = await probeModel(
    { id: 'kilo-free', baseUrl: 'https://api.kilo.ai/api/gateway' },
    { id: 'kilo-free/nvidia/nemotron-3.5-lightning:free' },
    async (url, init) => {
      assert.equal(String(url), 'https://api.kilo.ai/api/gateway/chat/completions')
      assert.equal(JSON.parse(init.body).model, 'nvidia/nemotron-3.5-lightning:free')
      return jsonResponse({ model: 'nvidia/nemotron-3.5-lightning:free', choices: [{ message: { content: 'hi' } }] })
    },
  )
  assert.equal(health.ok, true)
  assert.equal(health.hasContent, true)
  assert.equal(health.returnedModel, 'nvidia/nemotron-3.5-lightning:free')
})

test('probeModel: 429 is transient rate limit with retry-after', async () => {
  const health = await probeModel(
    { id: 'kilo-free', baseUrl: 'https://api.kilo.ai/api/gateway' },
    { id: 'kilo-free/x' },
    async () => jsonResponse({}, 429, { 'retry-after': '120' }),
  )
  assert.equal(health.ok, false)
  assert.equal(health.transient, true)
  assert.equal(health.status, 429)
  assert.equal(health.retryAfter, '120')
})

test('probeModel: 401 is non-transient auth failure', async () => {
  const health = await probeModel(
    { id: 'llm7-free', baseUrl: 'https://api.llm7.io/v1' },
    { id: 'llm7-free/gpt-oss:20b' },
    async () => jsonResponse({}, 401),
  )
  assert.equal(health.ok, false)
  assert.equal(health.transient, false)
  assert.equal(health.status, 401)
})

// ---------------------------------------------------------- healthCheck ----

const MOCK_SPECS = [
  {
    id: 'alpha',
    name: 'Alpha',
    baseUrl: 'https://alpha.example/v1',
    modelsUrl: 'https://alpha.example/v1/models',
    modelFormat: 'openrouter',
    seedModels: { 'fallback/1': { name: 'Fallback 1', limit: { context: 8000, output: 4096 } } },
  },
  {
    id: 'beta',
    name: 'Beta',
    baseUrl: 'https://beta.example/v1',
    modelsUrl: 'https://beta.example/v1/models',
    modelFormat: 'llm7',
    seedModels: {},
  },
]

function mockFetch(behavior) {
  return async (url, init) => {
    const u = String(url)
    if (u.endsWith('/models')) {
      const b = behavior.models[new URL(u).host]
      return b ? jsonResponse(b) : jsonResponse({}, 404)
    }
    if (u.endsWith('/chat/completions')) {
      const model = JSON.parse(init.body).model // probeModel 已剥掉 provider 前缀
      if (model === 'good') return jsonResponse({ model: 'good', choices: [{ message: { content: 'hi' } }] })
      if (model === 'flaky') return jsonResponse({}, 429)
      if (model === 'authfail') return jsonResponse({}, 401)
      return jsonResponse({ model, choices: [{ message: { content: 'ok' } }] })
    }
    return jsonResponse({}, 404)
  }
}

test('healthCheck: discovers, probes, classifies alive/dead/suspect, removes after threshold', async () => {
  const doFetch = mockFetch({
    models: {
      'alpha.example': { data: [
        { id: 'good', name: 'Good', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: 8000 } },
        { id: 'flaky', name: 'Flaky', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: 8000 } },
      ] },
      'beta.example': { data: [] },
    },
  })
  const prev = {
    models: {
      'alpha/seed': { status: 'alive', provider: 'alpha' },
      'alpha/authfail': { status: 'alive', failures: 1, provider: 'alpha' },
    },
  }
  const report = await healthCheck(MOCK_SPECS, { prev, doFetch, maxProbes: 20, deadThreshold: 2 })
  assert.equal(report.summary.sources, 2)
  assert.equal(report.summary.discovered >= 3, true) // alpha catalog 2 (good+flaky) + alpha seed 1; beta 空
  assert.equal(report.models['alpha/good'].status, 'alive')
  // seed fallback model appears
  assert.equal(report.models['alpha/fallback/1'].status, 'alive')
  // flaky: first transient failure -> suspect
  assert.equal(report.models['alpha/flaky'].status, 'suspect')
  assert.equal(report.models['alpha/flaky'].failures, 1)
})

test('healthCheck: a model that stayed dead past threshold is removed (failures>=2)', async () => {
  const doFetch = mockFetch({
    models: {
      'alpha.example': { data: [{ id: 'authfail', name: 'AuthFail', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: 8000 } }] },
      'beta.example': { data: [] },
    },
  })
  const prev = { models: { 'alpha/authfail': { status: 'suspect', failures: 1, provider: 'alpha' } } }
  const report = await healthCheck(MOCK_SPECS, { prev, doFetch, maxProbes: 20, deadThreshold: 2 })
  assert.equal(report.models['alpha/authfail'].status, 'dead')
  assert.equal(report.models['alpha/authfail'].failures, 2)
  assert.equal(report.summary.removed, 1)
})

// ------------------------------------------------------------ persistence ----

test('writeSnapshot / readSnapshot round-trip, and aliveModelIds filters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mgp-health-'))
  try {
    const path = join(dir, 'snap.json')
    const report = {
      checkedAt: '2026-11-26T00:00:00.000Z',
      models: {
        'a/ok': { status: 'alive', provider: 'a' },
        'a/sus': { status: 'suspect', provider: 'a' },
        'a/dead': { status: 'dead', provider: 'a' },
      },
    }
    await writeSnapshot(report, path)
    const read = await readSnapshot(path)
    assert.equal(read.checkedAt, report.checkedAt)
    assert.deepEqual(aliveModelIds(read).map(([id]) => id), ['a/ok', 'a/sus'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ polling ----

test('runOnce with mocked fetch writes a snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mgp-poll-'))
  try {
    const path = join(dir, 'snap.json')
    const doFetch = mockFetch({
      models: {
        'alpha.example': {
          data: [
            { id: 'good', name: 'Good', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: 8000 } },
            { id: 'flaky', name: 'Flaky', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: 8000 } },
          ],
        },
        'beta.example': { data: [] },
      },
    })
    const report = await runOnce({ snapshotPath: path, doFetch, maxProbes: 20, logger: () => {} })
    assert.equal(report.summary.alive >= 1, true)
    const snap = await readSnapshot(path)
    assert.equal(snap.summary.alive >= 1, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('DEFAULT_SNAPSHOT points inside the plugin dir', () => {
  assert.ok(DEFAULT_SNAPSHOT.endsWith('free_pool_snapshot.json'))
})
// ------------------------------------------------ 新增：质量分与错误分类 ----

test('qualityScore: faster answers score higher, capped to 0..1', () => {
  assert.equal(qualityScore(0) > qualityScore(500), true)
  assert.equal(qualityScore(500) > qualityScore(3000), true)
  assert.equal(qualityScore(3000) > qualityScore(20000), true)
  assert.equal(qualityScore(0) <= 1, true)
  assert.equal(qualityScore(20000) >= 0, true)
})

test('probeModel: classifies error categories for the four failure families', async () => {
  const spec = { id: 'k', baseUrl: 'https://k.example' }
  const model = { id: 'k/m' }

  const rate = await probeModel(spec, model, async () => jsonResponse({}, 429))
  assert.equal(rate.category, 'rate_limit')
  assert.equal(rate.transient, true)

  const auth = await probeModel(spec, model, async () => jsonResponse({}, 401))
  assert.equal(auth.category, 'auth')
  assert.equal(auth.transient, false)

  const pay = await probeModel(spec, model, async () => jsonResponse({}, 402))
  assert.equal(pay.category, 'payment')
  assert.equal(pay.transient, false)

  const net = await probeModel(spec, model, async () => { throw new Error('ECONNRESET') })
  assert.equal(net.category, 'network')
  assert.equal(net.transient, true)
})

test('probeModel: ok result carries a quality score', async () => {
  const h = await probeModel({ id: 'k', baseUrl: 'https://k.example' }, { id: 'k/m' }, async () =>
    jsonResponse({ model: 'm', choices: [{ message: { content: 'hello' } }] }),
  )
  assert.equal(h.category, 'ok')
  assert.equal(typeof h.quality, 'number')
  assert.ok(h.quality > 0.4, '正常回复应当高于空回复的 0.4')
})

test('probeModel: empty content is kept as alive but scored lower', async () => {
  const h = await probeModel({ id: 'k', baseUrl: 'https://k.example' }, { id: 'k/m' }, async () =>
    jsonResponse({ model: 'm', choices: [{ message: { content: '   ' } }] }),
  )
  assert.equal(h.ok, true)
  assert.equal(h.quality, 0.4)
})

// ------------------------------------------------ 新增：候选排序 ----

test('selectCandidates: new free models first, then recently checked, paid last', () => {
  const now = Date.now()
  const recent = new Date(now - 60_000).toISOString() // 1 分钟前刚探过
  const prev = {
    models: {
      'a/known-fast': { quality: 0.95, health: { checkedAt: recent } },
      'a/known-slow': { quality: 0.3, health: { checkedAt: recent } },
    },
  }
  const unique = [
    { id: 'a/paid', free: false },
    { id: 'a/known-slow' },
    { id: 'a/known-fast' },
    { id: 'a/new-one' },
  ]
  const picked = selectCandidates(unique, prev, 10, { now })
  assert.deepEqual(picked.map((m) => m.id), ['a/new-one', 'a/known-fast', 'a/known-slow', 'a/paid'])
})

test('selectCandidates: stale records jump the queue so old state gets refreshed', () => {
  const now = Date.now()
  const old = new Date(now - 8 * 60 * 60 * 1000).toISOString() // 8 小时前
  const recent = new Date(now - 60_000).toISOString()
  const prev = {
    models: {
      'a/stale': { quality: 0.9, health: { checkedAt: old } },
      'a/fresh': { quality: 0.1, health: { checkedAt: recent } },
    },
  }
  const unique = [{ id: 'a/stale' }, { id: 'a/fresh' }, { id: 'a/new-one' }]
  const picked = selectCandidates(unique, prev, 3, { now })
  assert.equal(picked[0].id, 'a/stale', '陈旧记录必须最先复探')
})

test('modelsFromSnapshot hides records that are stale', async () => {
  const now = Date.now()
  const snapshot = {
    models: {
      'kilo-free/fresh': { provider: 'kilo-free', status: 'alive', limit: { context: 8000 }, health: { checkedAt: new Date(now - 60_000).toISOString() } },
      'kilo-free/stale': { provider: 'kilo-free', status: 'alive', limit: { context: 8000 }, health: { checkedAt: new Date(now - 8 * 60 * 60 * 1000).toISOString() } },
    },
  }
  const cfg = {}
  await (await FreePoolPlugin({}, { snapshot })).config(cfg)
  const models = Object.keys(cfg.provider['kilo-free'].models)
  assert.equal(models.includes('fresh'), true)
  assert.equal(models.includes('stale'), false, '陈旧记录不应暴露给 magpie')
})

test('selectCandidates: respects maxProbes', () => {
  const unique = Array.from({ length: 20 }, (_, i) => ({ id: `a/m${String(i).padStart(2, '0')}` }))
  assert.equal(selectCandidates(unique, null, 5).length, 5)
})

test('healthCheck stores quality and category on each probed model', async () => {
  const doFetch = mockFetch({
    models: {
      'alpha.example': {
        data: [
          { id: 'good', name: 'Good', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: 8000 } },
        ],
      },
      'beta.example': { data: [] },
    },
  })
  const report = await healthCheck(MOCK_SPECS, { prev: null, doFetch, maxProbes: 10 })
  const entry = report.models['alpha/good']
  assert.equal(entry.status, 'alive')
  assert.equal(entry.category, 'ok')
  assert.equal(typeof entry.quality, 'number')
  assert.equal(typeof entry.health.latencyMs, 'number')
})

// ------------------------------------------------ 新增：代理回退 ----

test('makeFetch: falls back to direct when the proxy port is dead', async () => {
  const r = await makeFetch('http://127.0.0.1:1') // 1 号端口必然不可连
  assert.equal(r.proxyDown, true)
  assert.equal(r.doFetch, globalThis.fetch)
  assert.match(r.transport, /unreachable/)
})

test('makeFetch: no proxy configured stays direct', async () => {
  const env = { ...process.env }
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k]
  try {
    const r = await makeFetch()
    assert.equal(r.transport, 'direct')
    assert.equal(r.proxyDown, false)
  } finally {
    Object.assign(process.env, env)
  }
})

// ------------------------------------------------ 新增：源级探测配额 ----

test('healthCheck honours maxProbesPerRound per source', async () => {
  const capped = [
    {
      id: 'alpha', name: 'Alpha', baseUrl: 'https://alpha.example/v1',
      modelsUrl: 'https://alpha.example/v1/models', modelFormat: 'openrouter',
      maxProbesPerRound: 2, seedModels: {},
    },
  ]
  const catalog = { data: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    id, name: id, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: 8000 },
  })) }
  let probedIds = []
  const doFetch = async (url, init) => {
    if (String(url).endsWith('/models')) return jsonResponse(catalog)
    if (String(url).endsWith('/chat/completions')) {
      const model = JSON.parse(init.body).model
      probedIds.push(model)
      return jsonResponse({ model, choices: [{ message: { content: 'ok' } }] })
    }
    return jsonResponse({}, 404)
  }
  const report = await healthCheck(capped, { prev: null, doFetch, maxProbes: 10 })
  assert.equal(report.summary.probed, 2, '每轮只应探 2 个')
  assert.equal(probedIds.length, 2)
})
