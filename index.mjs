// magpie-free-pool v2 — 动态免费 API 池（参考 AutoMergePublicNodes 架构）
//
// 变化（相对 v1）：
//   - kilo 网关本身是 OpenRouter 风格聚合器，/models 返回 19 个免费模型（含 gpt/kimi/claude 降级档）
//   - 新增 health.mjs：每小时抓取 /models → 匿名 chat 探测 → 剔除死项 → 发现新模型 → 原子写快照
//   - config hook 优先读快照里的 alive 模型；快照未生成时用 seedModels 兜底
//   - 每导出函数仍是独立 plugin（magpie 的 provider id = auth.provider）
//
// 四个公共匿名端点：
//   kilo-free         -> https://api.kilo.ai/api/gateway       （主动态源，19 免费模型）
//   llm7-free         -> https://api.llm7.io/v1                （86 模型，tier=turbo 匿名可用）
//   pollinations-free -> https://text.pollinations.ai/openai   （匿名，gpt-oss-20b， daily 限流）
//   ovh-free          -> https://oai.endpoints.kepler.ai.cloud.ovh.net/v1 （匿名额度按 IP/年）

import { aliveModelIds, readSnapshot, DEFAULT_SNAPSHOT } from './health.mjs'

const ICON = 'https://cdn.simpleicons.org/openai'

// 源定义（health.mjs 用）。seedModels 是快照缺失时的兜底。
export const SPECS = [
  {
    id: 'kilo-free',
    name: 'Kilo Free',
    api: 'https://api.kilo.ai/api/gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    modelsUrl: 'https://api.kilo.ai/api/gateway/v1/models',
    modelFormat: 'openrouter',
    note: 'Kilo Code 公共网关；19 个免费模型，含 openrouter/free 路由。公平使用 ~200 req/hr/IP。',
    seedModels: {
      'kilo-auto/free': { name: 'Kilo Auto (free)', limit: { context: 128000, output: 8192 }, tool_call: true },
      'nvidia/nemotron-3.5-lightning:free': { name: 'Nemotron 3.5 Lightning (free)', limit: { context: 128000, output: 8192 }, tool_call: true },
      'openrouter/free': { name: 'OpenRouter Free Router', limit: { context: 200000, output: 8192 }, tool_call: true },
    },
    windows: [{ name: 'fair-use', limit: 200, unit: 'requests', span: 3600, display: 'Public fair use: ~200 requests/hour/IP.' }],
  },
  {
    id: 'llm7-free',
    name: 'LLM7 Free',
    api: 'https://api.llm7.io/v1',
    baseUrl: 'https://api.llm7.io/v1',
    modelsUrl: 'https://api.llm7.io/v1/models',
    modelFormat: 'llm7',
    note: 'LLM7.io OpenAI-compatible；匿名可用，按 pricing=0 过滤免费模型。',
    seedModels: {
      turbo: { name: 'LLM7 Turbo', limit: { context: 32768, output: 8192 }, tool_call: true },
    },
    windows: [{ name: 'fair-use', display: 'Anonymous; no published quota.' }],
  },
  {
    id: 'pollinations-free',
    name: 'Pollinations Free',
    api: 'https://text.pollinations.ai/openai',
    baseUrl: 'https://text.pollinations.ai/openai',
    modelsUrl: 'https://text.pollinations.ai/openai/models',
    modelFormat: 'openrouter',
    note: 'Pollinations 匿名端点；每 IP 间隔≥45s、≤100 回复/天（UTC 重置），超限 402+Retry-After。',
    seedModels: {
      'openai-fast': { name: 'OpenAI Fast (gpt-oss-20b)', limit: { context: 16000, output: 800 }, tool_call: true, reasoning: true },
    },
    windows: [{ name: 'daily', limit: 100, unit: 'replies', span: 86400, display: 'Anonymous: ≤100 replies/day, ≥45s interval per IP (UTC reset).' }],
  },
  {
    id: 'ovh-free',
    name: 'OVH Free',
    // 2026-11-27 起匿名调用返回 403 "authentication failed, generate a new token at
    // https://kepler.ai.cloud.ovh.net/v1/oauth/ovh/authorize"——纯匿名已不可用。
    // 默认不注册，避免用户在 magpie 里点到就报错；需要时把 options.enableOvh 设为 true。
    defaultDisabled: true,
    api: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    modelsUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models',
    modelFormat: 'openrouter',
    note: 'OVHcloud Kepler 匿名端点；~2 RPM/IP/model，年度匿名额度易耗尽。额度耗尽返回 429，需 OAuth token 的模型返回 403。',
    // 限流按"每请求递增"计（实测第 1 个 200、第 2 个起 429）。但配额太小会让僵尸记录
    // 永远轮不到探测（旧快照里的 dead/suspect 会被永久保留），所以每轮要能覆盖全部种子。
    maxProbesPerRound: 4,
    // 种子必须写实测能过的模型：gpt-oss-120b / Qwen3.8-27B 在 2026-11-27 已是 429 额度耗尽，
    // 写它们会导致快照缺失时 magpie 里全是"点了就报错"的模型。以下是实测 200 的。
    seedModels: {
      'Olala-v1.0-mini-7A1B': { name: 'Olala Mini 7A1B', limit: { context: 32768, output: 8192 }, tool_call: true },
      'Olala-v1.0-summarise': { name: 'Olala Summarise', limit: { context: 32768, output: 4096 }, tool_call: false },
      'nemotron3-nano-30b': { name: 'Nemotron 3 Nano 30B', limit: { context: 131072, output: 8192 }, tool_call: true, reasoning: true },
      'gemma-4-26b-a4b': { name: 'Gemma 4 26B A4B', limit: { context: 131072, output: 8192 }, tool_call: true },
    },
    windows: [{ name: 'fair-use', limit: 2, unit: 'requests/model', span: 60, display: 'Anonymous: ~2 RPM/IP/model.' }],
  },
]

function specById(id) {
  return SPECS.find((s) => s.id === id)
}

// 从快照构造某 provider 的 models 表；过滤掉带 provider 前缀以外的项
// 快照里超过这么久没被复检的模型不再暴露。免费端点的可用性按小时变，
// 一条 8 小时前的 alive 记录很可能已经 429/403——与其让用户点了报错，不如先藏起来。
export const STALE_MS = 6 * 60 * 60 * 1000

function modelsFromSnapshot(snapshot, spec, { now = Date.now(), staleMs = STALE_MS } = {}) {
  const out = {}
  for (const [fullId, m] of aliveModelIds(snapshot)) {
    if (m.provider !== spec.id) continue
    // 陈旧记录不暴露：checkedAt 太老的模型不再进模型表
    const checked = Date.parse(m.health?.checkedAt ?? '')
    if (Number.isFinite(checked) && now - checked > staleMs) continue
    const prefix = `${spec.id}/`
    const shortId = fullId.startsWith(prefix) ? fullId.slice(prefix.length) : fullId
    out[shortId] = {
      name: m.name,
      limit: m.limit,
      ...(m.tool_call ? { tool_call: true } : {}),
      ...(m.reasoning ? { reasoning: true } : {}),
      ...(m.modalities ? { modalities: m.modalities } : {}),
    }
  }
  return out
}

// 该源在快照里被探过、但全部判死 → 说明现在真的不能用，不要再用 seed 顶替
function hasOnlyDead(snapshot, spec) {
  const entries = Object.entries(snapshot?.models ?? {}).filter(([, m]) => m.provider === spec.id)
  if (entries.length === 0) return false // 从没探过：允许 seed 兜底
  return entries.every(([, m]) => m.status === 'dead')
}

function seedModels(spec) {  return Object.fromEntries(
    Object.entries(spec.seedModels).map(([id, def]) => [id, { ...def }]),
  )
}

function anonymousAuth(spec, options = {}) {
  const key = options.anonymousKey || 'anonymous'
  return {
    provider: spec.id,
    icon: ICON,
    maxConcurrency: 4,
    methods: [
      {
        type: 'api',
        label: 'No key needed (anonymous)',
        placeholder: 'unused',
        async authorize() {
          return { type: 'success', key, metadata: { provider: spec.id, note: spec.note } }
        },
      },
    ],
    async loader() {
      return {
        baseURL: spec.api,
        apiKey: key,
        async fetch(input, init) {
          return fetch(input, init)
        },
      }
    },
    async usage() {
      return { plan: 'Anonymous / fair use', windows: spec.windows.map((w) => ({ ...w })) }
    },
  }
}

/** config hook：注册 provider，models 来自快照（动态）或 seed（兜底）。 */
export const FreePoolPlugin = async ({ client } = {}, options = {}) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    const snapshot = options.snapshot ?? (await readSnapshot(options.snapshotPath ?? DEFAULT_SNAPSHOT))
    for (const spec of SPECS) {
      // 用户自定义优先，绝不覆盖
      if (cfg.provider[spec.id]) continue
      // 默认关闭的源（如 OVH：匿名已 403 需 OAuth）不注册，除非显式打开
      if (spec.defaultDisabled && options.enableOvh !== true) continue
      const dynamic = snapshot ? modelsFromSnapshot(snapshot, spec) : {}
      const models = Object.keys(dynamic).length ? dynamic : seedModels(spec)
      // 快照里有该源但全被判死（且不是缺少快照的情况）→ 不再用 seed 顶替，避免"点了就报错"
      if (snapshot && !Object.keys(dynamic).length && hasOnlyDead(snapshot, spec)) continue
      cfg.provider[spec.id] = {
        name: spec.name,
        npm: '@ai-sdk/openai-compatible',
        api: spec.api,
        models,
        options: {},
      }
    }
  },
})

/** provider hook：可选的动态 models 刷新（magpie 支持 provider.models 钩子时生效） */
export const FreePoolModelsPlugin = async ({ client } = {}, options = {}) => ({
  provider: {
    id: 'kilo-free',
    async models(provider) {
      const snapshot = options.snapshot ?? (await readSnapshot(options.snapshotPath ?? DEFAULT_SNAPSHOT))
      if (!snapshot) return provider.models
      const dynamic = modelsFromSnapshot(snapshot, specById('kilo-free'))
      return Object.keys(dynamic).length ? dynamic : provider.models
    },
  },
})

export const KiloFreePlugin = async ({ client } = {}, options = {}) => ({ auth: anonymousAuth(SPECS[0], options) })
export const Llm7FreePlugin = async ({ client } = {}, options = {}) => ({ auth: anonymousAuth(SPECS[1], options) })
export const PollinationsFreePlugin = async ({ client } = {}, options = {}) => ({ auth: anonymousAuth(SPECS[2], options) })
export const OvhFreePlugin = async ({ client } = {}, options = {}) => ({ auth: anonymousAuth(SPECS[3], options) })

export const _internal = { SPECS, ICON, modelsFromSnapshot, seedModels, anonymousAuth, specById }
