// health.mjs — 动态健康检测引擎（参考 AutoMergePublicNodes 的抓取→校验→合并→产物架构）
//
// 职责：
//   1. discover()  —— 从每个源的 /models 拉取实时模型目录，归一化成 magpie model 对象
//   2. probe()     —— 对每个候选模型发一次最小匿名 chat 请求，判定 alive / dead
//   3. healcheck() —— 并发跑完整流程，按 key 去重、剔除死项、保留健康证据，原子写快照
//   4. loadSnapshot() —— 给 index.mjs 的 config hook 读回最新可用模型
//
// 设计要点（来自参考项目）：
//   - 多源并发 + 单源超时（FETCH_TIMEOUT），一个源挂掉不拖垮全局
//   - 归一化：不同端点的 /models 结构不同（openrouter 风格 / llm7 风格 / pollinations 风格）
//   - 去重合并：按 provider::model id 去重，保留首次 + 记录来源
//   - 产物落地：无 BOM、稳定排序、原子替换，避免 magpie 读到半成品
//   - 状态分层：alive 直接进池；dead 带 reason + 失败次数，连续 N 次才彻底移除（容错抖动）

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SNAPSHOT = resolve(HERE, 'free_pool_snapshot.json')

// 每个源最多探测多少模型（避免 463 个模型全打一遍触发限流）
export const DEFAULT_MAX_PROBES = 12
// 单次探测超时（毫秒）
export const DEFAULT_PROBE_TIMEOUT = 12000
// 单个 /models 抓取超时
export const DEFAULT_FETCH_TIMEOUT = 25000
// 连续失败达到该次数才把模型从池中移除（抗抖动）
export const DEFAULT_DEAD_THRESHOLD = 2
// 最小探测请求
export const PROBE_MESSAGES = [{ role: 'user', content: 'hi' }]
export const PROBE_MAX_TOKENS = 8

// ------------------------------------------------------------------ 代理 ----
// Node 原生 fetch 和 bun 都不读 HTTPS_PROXY；直连海外端点会 ECONNRESET。
// 这里自带 CONNECT 隧道：代理只负责打通 TCP，TLS 由本进程完成（不依赖 Node 版本特性）。

function headerObject(headers) {
  const out = {}
  if (!headers) return out
  if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
    headers.forEach((v, k) => (out[k] = v))
    return out
  }
  for (const [k, v] of Object.entries(headers)) out[k] = Array.isArray(v) ? v.join(', ') : String(v)
  return out
}

function makeResponse(status, headers, buffer) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    async text() {
      return buffer.toString('utf8')
    },
    async json() {
      return JSON.parse(buffer.toString('utf8'))
    },
  }
}

function rawRequest(options, body, signal) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...options, signal })
    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(makeResponse(res.statusCode, res.headers, Buffer.concat(chunks))))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// 返回与 fetch 兼容的函数：CONNECT 隧道 + 隧道上跑 https 请求
export function createProxyFetch(proxyUrl) {
  const proxy = new URL(proxyUrl)
  return async function proxyFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
    if (url.protocol !== 'https:') return fetch(input, init)
    const host = url.hostname
    const port = Number(url.port || 443)
    const socket = await new Promise((res, rej) => {
      const req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port || 80),
        method: 'CONNECT',
        path: `${host}:${port}`,
        headers: { host: `${host}:${port}` },
        timeout: 15000,
      })
      req.on('connect', (resp, sock) => {
        if (resp.statusCode !== 200) {
          sock.destroy()
          rej(new Error(`proxy CONNECT ${resp.statusCode}`))
          return
        }
        res(sock)
      })
      req.on('timeout', () => req.destroy(new Error('proxy CONNECT timeout')))
      req.on('error', rej)
      req.end()
    })
    const tlsSocket = await new Promise((res, rej) => {
      const s = tls.connect({ socket, servername: host }, () => res(s))
      s.on('error', rej)
    })
    const headers = { ...headerObject(init.headers) }
    const body = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : ''
    if (body) headers['content-length'] = String(Buffer.byteLength(body))
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) headers.accept = 'application/json'
    return rawRequest(
      { host, port, method: init.method || 'GET', path: `${url.pathname}${url.search}`, headers, agent: false, createConnection: () => tlsSocket },
      body,
      init.signal,
    )
  }
}

// 有代理就用隧道，否则用原生 fetch
// 代理端口存活探测。陷阱 #4：代理挂了以后 Node/bun 仍会去连死端口，
// 得到一串 ECONNREFUSED，看起来像"端点全挂"。这里先探活，死了就回退直连。
async function proxyAlive(proxyUrl, timeoutMs = 1500) {
  let host
  let port
  try {
    const u = new URL(proxyUrl)
    host = u.hostname
    port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  } catch {
    return false
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

// 有代理且代理活着 → 隧道；代理死了或没配 → 直连
export async function makeFetch(explicitProxy) {
  const chosen = explicitProxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (!chosen) return { doFetch: fetch, transport: 'direct', proxyDown: false }
  if (!(await proxyAlive(chosen))) {
    return { doFetch: fetch, transport: `direct (proxy ${chosen} unreachable)`, proxyDown: true }
  }
  return { doFetch: createProxyFetch(chosen), transport: `proxy ${chosen}`, proxyDown: false }
}

// ---------------------------------------------------------------- 归一化 ----

// openrouter 风格：{ data: [{ id, name, architecture, pricing, context_length ... }] }
function fromOpenRouter(entry) {
  const params = new Set(entry.supported_parameters ?? [])
  const inputs = entry.architecture?.input_modalities ?? ['text']
  const outputs = entry.architecture?.output_modalities ?? ['text']
  const price = (v) => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const p = price(entry.pricing?.prompt)
  const c = price(entry.pricing?.completion)
  // 网关自报 isFree 优先：反例 google/lyria-*、humansand/* 价格是 0 但实测 401
  const declared = typeof entry.isFree === 'boolean' ? entry.isFree : undefined
  const free = declared ?? (p === 0 && c === 0)
  const context = entry.top_provider?.context_length || entry.context_length || 32768
  const out = entry.top_provider?.max_completion_tokens || 8192
  return {
    id: entry.id,
    name: entry.name || entry.id,
    limit: { context, output: out },
    tool_call: params.has('tools'),
    reasoning: Boolean(entry.reasoning?.mandatory || entry.reasoning?.default_enabled),
    modalities: { input: inputs.filter((m) => m !== 'decisions'), output: outputs },
    free,
    _price: { prompt: p, completion: c },
  }
}

// llm7 风格：{ data: [{ id, model_type, tiers, pricing:{input,output,currency,unit}, ... }] }
// 注意：llm7 匿名可用的是 tier=turbo（如 codestral-latest、gpt-oss:20b），
// 它们 pricing 未必是 0，但不能按价格过滤掉——否则会把可用模型误杀。
function fromLlm7(entry) {
  const caps = entry.capabilities ?? {}
  const ctx = entry.context_window?.tokens || 32768
  const unit = String(entry.pricing?.unit || '').toLowerCase()
  const tiers = entry.tiers ?? entry.tier
  const tierList = Array.isArray(tiers) ? tiers : [tiers]
  const anonymous = tierList.some((t) => String(t).toLowerCase() === 'turbo' || String(t).toLowerCase() === 'anonymous')
  const free = Number(entry.pricing?.input) === 0 && Number(entry.pricing?.output) === 0
  return {
    id: entry.id,
    name: entry.id,
    limit: { context: ctx, output: 8192 },
    tool_call: Boolean(caps.tools),
    reasoning: Boolean(caps.reasoning),
    modalities: {
      input: entry.modalities?.input ?? ['text'],
      output: entry.modalities?.output ?? ['text'],
    },
    free: free || anonymous, // anonymous  tier 也当免费候选，优先探测
    _price: { prompt: Number(entry.pricing?.input), completion: Number(entry.pricing?.output), unit },
    _anonymous: anonymous,
  }
}

// pollinations 风格：[{ name, description, tier, aliases, tools, ... }]
function fromPollinations(entry) {
  return {
    id: entry.name,
    name: entry.description || entry.name,
    limit: { context: 131072, output: 8192 },
    tool_call: Boolean(entry.tools),
    reasoning: Boolean(entry.reasoning),
    modalities: {
      input: entry.input_modalities ?? ['text'],
      output: entry.output_modalities ?? ['text'],
    },
    free: true,
    aliases: entry.aliases ?? [],
    _price: { prompt: 0, completion: 0 },
  }
}

// 非 chat 模型不进池：OVH 的 nvr-tts-*、whisper-* 等 /chat/completions 直接 404，
// 探测它们是浪费每小时有限的额度。
const NON_CHAT = /(^|[-_/])(tts|whisper|embed|embedding|embeddings|rerank|moderation|transcribe|transcription|speech)([-_/]|$)/i
export function isChatModelId(id) {
  return !NON_CHAT.test(String(id))
}

// 自动识别 /models 结构并归一化；modelFormat 显式指定时优先
const MAPPERS = { openrouter: fromOpenRouter, llm7: fromLlm7, pollinations: fromPollinations }
export function normalizeCatalog(spec, json) {
  const out = []
  const fmt = spec.modelFormat || 'auto'
  let entries = []
  let mapper
  if (Array.isArray(json)) {
    entries = json
    mapper = MAPPERS[fmt] ?? spec.mapper ?? fromPollinations
  } else if (Array.isArray(json?.data)) {
    entries = json.data
    const looksLlm7 = entries.some((e) => e.model_type !== undefined || e.tiers !== undefined || e.tier !== undefined || e.context_window !== undefined)
    mapper = MAPPERS[fmt] ?? spec.mapper ?? (looksLlm7 ? fromLlm7 : fromOpenRouter)
  } else {
    return out
  }
  for (const raw of entries) {
    try {
      const m = mapper(raw)
      if (!m.id || !isChatModelId(m.id)) continue
      if (m.modalities?.output && !m.modalities.output.includes('text') && !m.modalities.output.includes('decisions')) continue
      m.id = `${spec.id}/${m.id}`
      m.name = `${spec.name} · ${m.name}`
      m.provider = spec.id
      delete m._price // 探测阶段内部用，落库前去掉
      delete m._anonymous
      out.push(m)
    } catch {
      // 单条脏数据不影响整批
    }
  }
  return out
}

// ---------------------------------------------------------------- 抓取 ----

async function withTimeout(ms, fn, label) {
  let timer
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([fn(), t])
  } finally {
    clearTimeout(timer)
  }
}

// 抓一个源的 /models；失败返回 { ok:false, error }，不抛
export async function fetchModels(spec, doFetch = fetch, timeout = DEFAULT_FETCH_TIMEOUT) {
  if (!spec.modelsUrl) return { ok: false, error: 'no modelsUrl', models: [] }
  try {
    const res = await withTimeout(timeout, async () => {
      const headers = { accept: 'application/json' }
      if (spec.authHeader) headers.authorization = spec.authHeader
      return doFetch(spec.modelsUrl, { headers })
    }, `fetch ${spec.id}`)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, models: [] }
    const json = await res.json()
    const models = normalizeCatalog(spec, json)
    return { ok: true, models, error: null }
  } catch (err) {
    return { ok: false, error: String(err?.message || err), models: [] }
  }
}

// ---------------------------------------------------------------- 探测 ----

// 把一个带 provider 前缀的 model id 拆回 (spec, 原始 id)
export function splitModelId(spec, fullId) {
  const prefix = `${spec.id}/`
  return fullId.startsWith(prefix) ? fullId.slice(prefix.length) : fullId
}

// 对单个模型发最小 chat 探测；返回健康证据
export async function probeModel(spec, model, doFetch = fetch, timeout = DEFAULT_PROBE_TIMEOUT) {
  const rawId = splitModelId(spec, model.id)
  const url = `${spec.baseUrl.replace(/\/$/, '')}/chat/completions`
  const headers = { 'content-type': 'application/json' }
  if (spec.authHeader) headers.authorization = spec.authHeader
  const body = JSON.stringify({
    model: rawId,
    messages: PROBE_MESSAGES,
    max_tokens: PROBE_MAX_TOKENS,
    stream: false,
  })
  const started = Date.now()
  try {
    const res = await withTimeout(timeout, () => doFetch(url, { method: 'POST', headers, body }), `probe ${model.id}`)
    const latency = Date.now() - started
    if (res.status === 429) {
      const ra = res.headers?.get?.('retry-after') ?? null
      return {
        ok: false,
        reason: `rate-limited (429)${ra ? ` retry-after=${ra}s` : ''}`,
        status: 429,
        latency,
        transient: true,
        retryAfter: ra,
        category: 'rate_limit',
      }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: `auth ${res.status}`, status: res.status, latency, transient: false, category: 'auth' }
    }
    if (res.status === 402) {
      return { ok: false, reason: 'payment required (402)', status: 402, latency, transient: false, category: 'payment' }
    }
    if (!res.ok) {
      const transient = res.status >= 500
      return {
        ok: false,
        reason: `HTTP ${res.status}`,
        status: res.status,
        latency,
        transient,
        category: transient ? 'server' : 'http',
      }
    }
    let returned = rawId
    let hasContent = false
    let hasReasoning = false
    try {
      const json = await res.json()
      returned = json?.model || rawId
      const content = json?.choices?.[0]?.message?.content
      const reasoning = json?.choices?.[0]?.message?.reasoning
      hasContent = typeof content === 'string' && content.trim().length > 0
      hasReasoning = typeof reasoning === 'string' && reasoning.trim().length > 0
    } catch {
      // 有些网关返回非标准 JSON，只要 200 就当结构可用
    }
    const answered = hasContent || hasReasoning
    return {
      ok: true,
      status: res.status,
      latency,
      returnedModel: returned,
      hasContent,
      hasReasoning,
      reason: answered ? 'ok' : 'ok (empty content)',
      category: 'ok',
      // 质量分：能真的回话是及格线，答得越快分越高。空回复打折但不判死。
      quality: answered ? qualityScore(latency) : 0.4,
    }
  } catch (err) {
    return {
      ok: false,
      reason: String(err?.message || err),
      status: 0,
      latency: Date.now() - started,
      transient: true,
      category: 'network',
    }
  }
}

// 质量分 0..1：500ms 内满分，10s 以上接近 0。只用于候选排序，不决定生死。
export function qualityScore(latencyMs) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return 0.5
  const t = Math.min(latencyMs, 10000)
  return Math.round((1 - t / 10000) * 1000) / 1000
}

// ---------------------------------------------------------------- 合并 ----

function sha6(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 6)
}

// 去重：按 model.id；保留首次，后续记入 dup
export function dedupeModels(models) {
  const seen = new Set()
  const out = []
  const dup = []
  for (const m of models) {
    if (seen.has(m.id)) { dup.push(m.id); continue }
    seen.add(m.id)
    out.push(m)
  }
  return { models: out, dup }
}

// 从快照恢复某个 model 的连续失败次数
function priorFailures(prev, id) {
  return prev?.models?.[id]?.failures ?? 0
}

// 从快照读上轮质量分（没有则按中性值处理）
function priorQuality(prev, id) {
  const q = prev?.models?.[id]?.quality
  return typeof q === 'number' ? q : 0.5
}

/**
 * 候选排序：新模型优先 → 已知高质量模型 → 已知低质量 → 付费。
 * 这样每小时有限额度先花在"没试过的"和"上轮最好的"上。
 */
export function selectCandidates(unique, prev, maxProbes) {
  const rank = (m) => {
    const known = Boolean(prev?.models?.[m.id])
    const paid = m.free === false
    if (!known && !paid) return 0 // 新免费模型
    if (known && !paid) return 1 // 复检，按质量排
    if (!known && paid) return 2
    return 3
  }
  return unique
    .slice()
    .sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      if (ra === 1) return priorQuality(prev, b.id) - priorQuality(prev, a.id) // 高质量先复检
      return String(a.id).localeCompare(String(b.id))
    })
    .slice(0, maxProbes)
}

/**
 * 跑一次完整健康检查。
 * @param specs  源定义数组（见 index.mjs 的 SPECS）
 * @param opts   { prev, maxProbes, fetchTimeout, probeTimeout, deadThreshold, doFetch, now }
 * @returns 快照对象（尚未写盘）
 */
export async function healthCheck(specs, opts = {}) {
  const {
    prev = null,
    maxProbes = DEFAULT_MAX_PROBES,
    fetchTimeout = DEFAULT_FETCH_TIMEOUT,
    probeTimeout = DEFAULT_PROBE_TIMEOUT,
    deadThreshold = DEFAULT_DEAD_THRESHOLD,
    doFetch = fetch,
    now = new Date().toISOString(),
  } = opts
  const report = {
    checkedAt: now,
    summary: { sources: specs.length, discovered: 0, duplicates: 0, probed: 0, alive: 0, suspect: 0, dead: 0, removed: 0, pool: 0 },
    sources: {},
    models: {},
  }

  // 阶段 1：并发抓所有源的 /models
  const catalogs = await Promise.all(
    specs.map(async (spec) => ({ spec, result: await fetchModels(spec, doFetch, fetchTimeout) })),
  )
  const allModels = []
  for (const { spec, result } of catalogs) {
    report.sources[spec.id] = {
      ok: result.ok,
      error: result.error,
      discovered: result.models.length,
      baseUrl: spec.baseUrl,
    }
    if (result.ok) allModels.push(...result.models)
  }

  // 阶段 2：先补种子模型（静态声明的，即使 /models 挂了也探测）
  for (const spec of specs) {
    for (const [id, def] of Object.entries(spec.seedModels || {})) {
      const fullId = `${spec.id}/${id}`
      if (!allModels.some((m) => m.id === fullId)) {
        allModels.push({ ...def, id: fullId, name: `${spec.name} · ${def.name || id}`, provider: spec.id, free: true })
      }
    }
  }

  // 阶段 3：去重 + 按质量/新鲜度挑候选
  const { models: unique, dup } = dedupeModels(allModels)
  report.summary.discovered = unique.length
  report.summary.duplicates = dup.length
  const candidates = selectCandidates(unique, prev, maxProbes)

  // 阶段 4：并发探测。声明 maxProbesPerRound 的源（如 OVH：限流是每请求递增的，
  // 一次探多个会互相踩踏）本轮只探前 N 个，其余留到下轮由轮转覆盖。
  const quota = new Map()
  const thisRound = []
  for (const m of candidates) {
    const spec = m.provider ? specs.find((s) => s.id === m.provider) : null
    const cap = spec?.maxProbesPerRound
    if (Number.isFinite(cap)) {
      const used = quota.get(spec.id) ?? 0
      if (used >= cap) continue
      quota.set(spec.id, used + 1)
    }
    thisRound.push(m)
  }

  const probed = await Promise.all(
    thisRound.map(async (m) => ({ m, health: await probeModel(m.provider ? specs.find((s) => s.id === m.provider) : null, m, doFetch, probeTimeout) })),
  )
  report.summary.probed = probed.length

  // 阶段 5：合并进快照（保留上轮仍 alive 且本轮没轮到探测的模型）
  const decided = new Set()
  for (const { m, health } of probed) {
    decided.add(m.id)
    const prevFailures = priorFailures(prev, m.id)
    let status = health.ok ? 'alive' : 'dead'
    let failures = health.ok ? 0 : prevFailures + 1
    // 连续失败未达阈值 → 标记为 suspect，仍留在池里
    if (!health.ok && health.transient && failures < deadThreshold) status = 'suspect'
    const model = { ...m }
    delete model.free // 内部标记不外泄
    // 质量分：本轮探测到就用本轮的，没探到（不该发生）沿用上轮的
    const quality = typeof health.quality === 'number' ? health.quality : priorQuality(prev, m.id)
    report.models[m.id] = {
      ...model,
      status,
      failures,
      quality,
      category: health.category ?? 'unknown',
      health: {
        ok: health.ok,
        reason: health.reason,
        status: health.status,
        latencyMs: health.latency,
        returnedModel: health.returnedModel,
        hasContent: health.hasContent,
        ...(health.retryAfter ? { retryAfter: health.retryAfter } : {}),
        checkedAt: now,
      },
    }
    if (status === 'alive') report.summary.alive++
    else if (status === 'suspect') report.summary.suspect++
    else report.summary.dead++
  }

  // 保留上轮 alive/suspect 但本轮未探测到的模型（限量导致轮空）
  if (prev?.models) {
    for (const [id, m] of Object.entries(prev.models)) {
      if (decided.has(id)) continue
      report.models[id] = { ...m }
    }
  }

  // 统计最终产物：removed 是达阈值的死项，pool 是 magpie 实际会暴露的模型数
  for (const m of Object.values(report.models)) {
    if (m.status === 'dead' && m.failures >= deadThreshold) report.summary.removed++
    if (m.status === 'alive' || m.status === 'suspect') report.summary.pool++
  }
  return report
}

// ---------------------------------------------------------------- 持久化 ----

export async function writeSnapshot(report, path = DEFAULT_SNAPSHOT) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
  await rename(tmp, path)
  return path
}

export async function readSnapshot(path = DEFAULT_SNAPSHOT) {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// 给 config hook 用：从快照取所有可用模型的 id 列表
export function aliveModelIds(snapshot) {
  if (!snapshot?.models) return []
  return Object.entries(snapshot.models)
    .filter(([, m]) => m.status === 'alive' || m.status === 'suspect')
    .map(([id, m]) => [id, m])
}

export const _internal = {
  fromOpenRouter,
  fromLlm7,
  fromPollinations,
  withTimeout,
  sha6,
}
