// risk.mjs — 匿名免费端点的风控熔断层（语义移植自 magpie-marvis 0.8.x 的 pacing/breaker）
//
// 背景（issue: free-pool 匿名端点「总是限流」）：
//   · 四个端点都是**匿名、按出口 IP 计费/限流**（kilo ~200/hr、pollinations ≥45s+≤100/day、
//     OVH ~2 RPM、llm7 无公布配额）。旧 loader 是裸 `fetch` —— 既不拉开节奏、也不在被打后
//     止损，于是一连串请求直接把 IP 干进冷却，界面刷出一片 429/402。
//   · 本模块两层配合（marvis 教训：节奏闸是预防，熔断是止损）：
//     ① pacing（预防）：出网前按端点拉开最小间隔并叠加随机抖动，把固定连发打散成接近人的
//        随机分布；pollinations/OVH 这种有明确 per-IP 间隔要求的端点用各自的 minMs。
//     ② breaker（止损）：端点连续遇到**非预期**失败时本地 fail-fast（合成 429 带 retry-after），
//        不再让 magpie 宿主对它连试 7 次；跨端点共因闸判定「多个端点同时被拦 = 出口 IP 被
//        限流」→ 整个池短暂暂停，而不是四个端点挨个撞墙。
//
// 环境变量（默认值）：
//   FREEPOOL_RISK_DIR           稳定目录（默认 ~/.magpie-free-pool）
//   FREEPOOL_PACE_MIN_MS        全局默认最小间隔（800）
//   FREEPOOL_PACE_JITTER_MS     全局默认抖动（400；0 = 关）
//   FREEPOOL_RISK_THRESHOLD     连续失败阈值（3）
//   FREEPOOL_RISK_COOLDOWN_MS   退避基准（60_000 = 1min；0 = 禁用熔断）
//   FREEPOOL_RISK_CONSENSUS     窗口内不同端点被拦达到几个判共因（2；0 = 关共因闸）
//   FREEPOOL_RISK_WINDOW_MS     共因判定窗口（600_000 = 10min）

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"

// ---------------- 节奏闸 ----------------

const DEFAULT_PACE_MIN_MS = 800
const DEFAULT_PACE_JITTER_MS = 400

function numEnv(name, fallback) {
  const raw = Number.parseFloat(String(process.env[name] ?? ""))
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

/**
 * createPacing({ minMs, jitterMs, now, random, sleep }) → { paceWait(bucket), paceStatus(bucket) }
 * paceWait 出网前 await：距该 bucket 上次放行不足 minMs 时等到槽位，并叠加抖动。
 * 并发安全：同步占位（JS 单线程原子），同 bucket 按同一时间轴排队，不同 bucket 互不阻塞。
 */
export function createPacing({
  minMs,
  jitterMs,
  now = Date.now,
  random = Math.random,
  sleep,
} = {}) {
  if (minMs === undefined) minMs = numEnv("FREEPOOL_PACE_MIN_MS", DEFAULT_PACE_MIN_MS)
  if (jitterMs === undefined) jitterMs = numEnv("FREEPOOL_PACE_JITTER_MS", DEFAULT_PACE_JITTER_MS)
  minMs = Math.max(0, minMs)
  jitterMs = Math.max(0, jitterMs)
  const doSleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const axes = new Map()
  const AXES_SOFT_LIMIT = 64
  const AXES_TTL_MS = 60 * 60 * 1000
  function pruneAxes(t) {
    if (axes.size <= AXES_SOFT_LIMIT) return
    for (const [key, last] of axes) if (t - Number(last) > AXES_TTL_MS) axes.delete(key)
  }
  async function paceWait(bucket) {
    const k = String(bucket ?? "") || "*"
    const t = now()
    pruneAxes(t)
    const last = axes.get(k) ?? null
    const remaining = minMs > 0 && last !== null ? Math.max(0, last + minMs - t) : 0
    const jitter = jitterMs > 0 ? random() * jitterMs : 0
    const waitMs = remaining + jitter
    axes.set(k, t + waitMs)
    if (waitMs > 0) await doSleep(waitMs)
    return waitMs
  }
  function paceStatus(bucket) {
    const k = String(bucket ?? "") || "*"
    const last = axes.get(k) ?? 0
    return { minMs, jitterMs, key: k, lastDispatchAt: last, nextFreeAt: minMs > 0 && last ? last + minMs : 0, activeKeys: axes.size }
  }
  return { paceWait, paceStatus, minMs, jitterMs }
}

// ---------------- 熔断器 ----------------

const DEFAULT_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 60_000
const MAX_COOLDOWN_MS = 8 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_EVENTS = 50
const JITTER_RATIO = 0.1
const DEFAULT_CONSENSUS = 2
const DEFAULT_CONSENSUS_WINDOW_MS = 10 * 60 * 1000
const GLOBAL_BUCKET = "*"

function intEnv(name, fallback, { allowZero = false } = {}) {
  const raw = Number.parseInt(String(process.env[name] ?? ""), 10)
  const ok = Number.isFinite(raw) && (allowZero ? raw >= 0 : raw > 0)
  return ok ? raw : fallback
}

function clampInt(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
}

export function resolveRiskDir() {
  const envDir = process.env.FREEPOOL_RISK_DIR
  if (envDir && envDir.trim()) return envDir
  return join(homedir(), ".magpie-free-pool")
}

function stateFilePath() {
  return join(resolveRiskDir(), "breaker-state.json")
}

export function breakerStatePath() {
  return stateFilePath()
}

export function riskScope() {
  const v = String(process.env.FREEPOOL_RISK_SCOPE ?? "").trim().toLowerCase()
  return v === "global" ? "global" : "account"
}

function consensusConfig() {
  return {
    n: intEnv("FREEPOOL_RISK_CONSENSUS", DEFAULT_CONSENSUS, { allowZero: true }),
    windowMs: intEnv("FREEPOOL_RISK_WINDOW_MS", DEFAULT_CONSENSUS_WINDOW_MS),
  }
}

export function bucketOf(id) {
  const raw = String(id ?? "").trim()
  if (!raw) return GLOBAL_BUCKET
  return createHash("sha256").update(raw).digest("hex").slice(0, 12)
}

function readState() {
  try {
    const data = JSON.parse(readFileSync(stateFilePath(), "utf8"))
    if (!data || typeof data !== "object") return {}
    if (data.version === 2 && data.accounts && typeof data.accounts === "object") {
      const out = {}
      for (const [k, v] of Object.entries(data.accounts)) {
        if (!v || typeof v !== "object") continue
        if (k === GLOBAL_BUCKET && !v.reason && Number(v.openedAt) > 0) {
          out[k] = { ...v, openedAt: 0, stale: true }
        } else {
          out[k] = v
        }
      }
      return out
    }
    if ("consecutiveOpens" in data || "openedAt" in data || "failures" in data) {
      const opened = Number(data.openedAt)
      return {
        [GLOBAL_BUCKET]: {
          consecutiveOpens: clampInt(data.consecutiveOpens),
          openedAt: Number.isFinite(opened) ? opened : 0,
          failures: clampInt(data.failures),
          v1: true,
        },
      }
    }
    return {}
  } catch {
    return {}
  }
}

function writeState(accounts) {
  try {
    mkdirSync(resolveRiskDir(), { recursive: true })
    writeFileSync(stateFilePath(), JSON.stringify({ version: 2, accounts }))
  } catch {
    /* 写盘失败不影响请求 */
  }
}

export function breakerBuckets(nowMs = Date.now()) {
  const all = readState()
  return Object.entries(all).map(([bucket, s]) => {
    const openedAt = clampInt(s.openedAt)
    const consecutiveOpens = clampInt(s.consecutiveOpens)
    const base = intEnv("FREEPOOL_RISK_COOLDOWN_MS", DEFAULT_COOLDOWN_MS, { allowZero: true })
    let retryAfterMs = 0
    if (openedAt > 0 && base > 0) {
      const capped = Math.min(base * 2 ** consecutiveOpens, MAX_COOLDOWN_MS)
      retryAfterMs = Math.max(0, capped - (nowMs - openedAt))
    }
    return { bucket, label: s.label ?? (bucket === GLOBAL_BUCKET ? "全局" : bucket), failures: clampInt(s.failures), consecutiveOpens, openedAt, retryAfterMs }
  })
}

export function createBreaker({
  threshold = DEFAULT_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now,
  random = Math.random,
  bucket = GLOBAL_BUCKET,
  label = "",
  onOpen,
} = {}) {
  threshold = intEnv("FREEPOOL_RISK_THRESHOLD", threshold)
  cooldownMs = intEnv("FREEPOOL_RISK_COOLDOWN_MS", cooldownMs, { allowZero: true })
  bucket = String(bucket || GLOBAL_BUCKET)
  let failures = 0
  let consecutiveOpens = 0
  let openedAt = 0
  let halfOpen = false
  let activeCooldown = 0
  let loaded = false
  let tripReason = ""
  const events = []
  function computeCooldown(consecutive) {
    const capped = Math.min(cooldownMs * 2 ** consecutive, MAX_COOLDOWN_MS)
    return Math.max(0, capped + (random() * 2 - 1) * capped * JITTER_RATIO)
  }
  function pushEvent(type, c) {
    events.push({ at: now(), type, cooldownMs: c })
    if (events.length > MAX_EVENTS) events.shift()
  }
  function loadState() {
    if (loaded) return
    loaded = true
    try {
      const data = readState()[bucket]
      if (!data || typeof data !== "object") return
      consecutiveOpens = clampInt(data.consecutiveOpens)
      failures = clampInt(data.failures)
      if (data.v1 || data.stale) return
      tripReason = typeof data.reason === "string" ? data.reason : ""
      const opened = Number(data.openedAt)
      if (Number.isFinite(opened) && opened > 0) {
        const age = now() - opened
        if (age < -CLOCK_SKEW_MS || age > MAX_COOLDOWN_MS) { openedAt = 0; return }
        openedAt = opened
      }
    } catch { /* 当无状态 */ }
  }
  function persist() {
    const all = readState()
    const entry = { consecutiveOpens, openedAt, failures }
    if (label) entry.label = label
    else if (all[bucket]?.label) entry.label = all[bucket].label
    if (tripReason) entry.reason = tripReason
    if (events.length) entry.events = events.slice(-20)
    all[bucket] = entry
    writeState(all)
  }
  function expireIfDue() {
    if (!openedAt || halfOpen) return
    if (!activeCooldown) activeCooldown = computeCooldown(consecutiveOpens)
    if (now() - openedAt >= activeCooldown) halfOpen = true
  }
  function openBreaker(fromProbe) {
    if (fromProbe) { consecutiveOpens += 1; pushEvent("probe-fail", 0) }
    openedAt = now()
    halfOpen = false
    activeCooldown = computeCooldown(consecutiveOpens)
    pushEvent(fromProbe ? "reopen" : "open", activeCooldown)
    persist()
    if (typeof onOpen === "function") { try { onOpen({ bucket, at: openedAt }) } catch { /* */ } }
  }
  function closeBreaker() {
    openedAt = 0; halfOpen = false; activeCooldown = 0; failures = 0; consecutiveOpens = 0; tripReason = ""
    pushEvent("close", 0); persist()
  }
  return {
    get open() { loadState(); if (cooldownMs <= 0) return false; expireIfDue(); return openedAt > 0 && !halfOpen },
    get retryAfterMs() {
      loadState(); if (cooldownMs <= 0) return 0; expireIfDue()
      if (!openedAt || halfOpen) return 0
      if (!activeCooldown) activeCooldown = computeCooldown(consecutiveOpens)
      return Math.max(0, activeCooldown - (now() - openedAt))
    },
    get failures() { loadState(); return failures },
    get consecutiveOpens() { loadState(); return consecutiveOpens },
    record(ok) {
      loadState(); expireIfDue()
      if (cooldownMs <= 0) {
        if (ok) { if (failures !== 0) { failures = 0; persist() } }
        else { failures += 1; persist() }
        return
      }
      if (ok) {
        if (openedAt || halfOpen) closeBreaker()
        else if (failures !== 0) { failures = 0; persist() }
        return
      }
      failures += 1
      if (halfOpen) { openBreaker(true); return }
      if (failures >= threshold && !openedAt) openBreaker(false)
      else persist()
    },
    reset() { loadState(); closeBreaker() },
    trip(reason = "external") {
      loadState(); expireIfDue()
      if (cooldownMs <= 0) return
      if (openedAt && !halfOpen) return
      openedAt = now(); halfOpen = false; activeCooldown = computeCooldown(consecutiveOpens)
      tripReason = String(reason) || "external"; pushEvent(tripReason, activeCooldown); persist()
    },
    events(limit = MAX_EVENTS) { loadState(); const n = Math.trunc(Math.min(limit, MAX_EVENTS)); if (n <= 0) return []; return events.slice(-n) },
  }
}

// ---------------- 进程级池 + 跨端点共因闸 ----------------

const pool = new Map()
const tripLog = []

function noteBucketTrip(bucketName) {
  if (bucketName === GLOBAL_BUCKET) return
  const { n, windowMs } = consensusConfig()
  if (n <= 0) return
  const t = Date.now()
  tripLog.push({ bucket: bucketName, at: t })
  while (tripLog.length && t - tripLog[0].at > windowMs) tripLog.shift()
  if (new Set(tripLog.map((e) => e.bucket)).size < n) return
  tripLog.length = 0
  getBreaker(GLOBAL_BUCKET, "跨端点共因").trip("cross-account")
}

export function getBreaker(bucket = GLOBAL_BUCKET, label = "", opts = {}) {
  const key = String(bucket || GLOBAL_BUCKET)
  let b = pool.get(key)
  if (!b) {
    b = createBreaker({ ...opts, bucket: key, label, onOpen: () => noteBucketTrip(key) })
    pool.set(key, b)
  }
  return b
}

export function resetAllBreakers() {
  const keys = new Set([...Object.keys(readState()), ...pool.keys()])
  for (const k of keys) getBreaker(k).reset()
  tripLog.length = 0
  return keys.size
}

export const riskBreaker = getBreaker(GLOBAL_BUCKET)

export function shouldGate(bucket, label = "") {
  const br = getBreaker(bucket, label)
  if (br.open) return { gate: true, breaker: br, bucket, retryAfterMs: br.retryAfterMs, label, reason: "account" }
  const global = getBreaker(GLOBAL_BUCKET)
  if (global.open) return { gate: true, breaker: br, bucket: GLOBAL_BUCKET, retryAfterMs: global.retryAfterMs, label: "全局(跨端点共因)", reason: "cross-account" }
  return { gate: false, breaker: br }
}

export function riskEvents(limit = MAX_EVENTS) {
  return riskBreaker.events(limit)
}

export function _resetRiskForTests() {
  pool.clear()
  tripLog.length = 0
}

export const _riskInternals = { GLOBAL_BUCKET, noteBucketTrip, DEFAULT_THRESHOLD, DEFAULT_COOLDOWN_MS, readState }
