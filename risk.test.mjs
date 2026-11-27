// risk.test.mjs — free-pool 风控层用例（纯内存 + 注入时钟/随机 + 临时落盘目录）
//
// 覆盖：节奏闸（间隔+抖动、per-端点独立轴）、熔断状态机、跨端点共因闸、
// shouldGate fail-fast、持久化、loader 接线（熔断合成 429 不发上游）。

import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const {
  createPacing,
  createBreaker,
  getBreaker,
  shouldGate,
  resetAllBreakers,
  bucketOf,
  _resetRiskForTests,
} = await import("./risk.mjs")
const { anonymousAuth, SPECS, riskGateResponse } = (await import("./index.mjs"))._internal

let riskDir
test.beforeEach(() => {
  riskDir = mkdtempSync(join(tmpdir(), "freepool-risk-test-"))
  process.env.FREEPOOL_RISK_DIR = riskDir
  _resetRiskForTests()
})
test.afterEach(() => {
  try { rmSync(riskDir, { recursive: true, force: true }) } catch { /* */ }
  for (const k of ["FREEPOOL_RISK_DIR", "FREEPOOL_RISK_THRESHOLD", "FREEPOOL_RISK_COOLDOWN_MS", "FREEPOOL_RISK_CONSENSUS", "FREEPOOL_RISK_WINDOW_MS", "FREEPOOL_PACE_MIN_MS", "FREEPOOL_PACE_JITTER_MS"]) delete process.env[k]
})

test("节奏闸：per-端点独立时间轴，minMs+抖动拉开节奏", async () => {
  let t = 1_000_000_000_000
  const sleeps = []
  const p = createPacing({ minMs: 800, jitterMs: 200, now: () => t, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); await Promise.resolve(); t += ms } })
  await p.paceWait("kilo-free")
  await p.paceWait("kilo-free")
  await p.paceWait("llm7-free")
  // kilo: 首 0+100=100；次槽位 = 上次槽位(T0+100)+800 = T0+900 → 再 +100 抖动 = 900。
  // llm7 是新轴：0+100。
  assert.deepEqual(sleeps, [100, 900, 100])
  assert.equal(p.paceStatus("kilo-free").activeKeys, 2)
})

test("熔断：连续失败达阈值即 open，半开成功关闭 / 失败重开退避翻倍", async () => {
  let t = 1_000_000_000_000
  const br = createBreaker({ threshold: 2, cooldownMs: 1000, now: () => t, random: () => 0, bucket: "e1" })
  br.record(false); br.record(false)
  assert.equal(br.open, true, "连续 2 次失败后熔断")
  assert.ok(br.retryAfterMs > 0)
  t += 1001
  assert.equal(br.open, false, "冷却到期半开放行探测")
  br.record(true)
  assert.equal(br.open, false)
  assert.equal(br.failures, 0)
  // 再熔断一次，半开失败重开 → 退避翻倍
  br.record(false); br.record(false)
  assert.equal(br.open, true)
  const c0 = br.retryAfterMs
  t += 1001
  br.record(false)
  assert.equal(br.open, true)
  assert.ok(br.retryAfterMs >= c0, "重开后冷却翻倍")
  assert.equal(br.consecutiveOpens, 1)
})

test("shouldGate：端点熔断 fail-fast，未熔断放行", async () => {
  process.env.FREEPOOL_RISK_THRESHOLD = "2"
  process.env.FREEPOOL_RISK_COOLDOWN_MS = "1000"
  getBreaker("pollinations", "Pollinations Free").record(false)
  getBreaker("pollinations", "Pollinations Free").record(false)
  const g = shouldGate("pollinations")
  assert.equal(g.gate, true)
  assert.equal(g.reason, "account")
  assert.equal(shouldGate("kilo-healthy").gate, false)
})

test("跨端点共因闸：两个不同端点先后熔断 → 全局桶打开、全池 fail-fast", async () => {
  process.env.FREEPOOL_RISK_CONSENSUS = "2"
  process.env.FREEPOOL_RISK_WINDOW_MS = "600000"
  process.env.FREEPOOL_RISK_COOLDOWN_MS = "60000"
  const now = () => Date.now()
  const a = getBreaker("src-a", "", { threshold: 1, cooldownMs: 60000, now, random: () => 0 })
  const b = getBreaker("src-b", "", { threshold: 1, cooldownMs: 60000, now, random: () => 0 })
  a.record(false); b.record(false)
  assert.equal(getBreaker("*").open, true, "共因闸打开全局桶")
  assert.equal(shouldGate("src-c").gate, true)
  assert.equal(shouldGate("src-c").reason, "cross-account")
})

test("持久化：落盘重启不丢冷却", async () => {
  const now = Date.now()
  const br = createBreaker({ threshold: 1, cooldownMs: 60000, now: () => now, random: () => 0, bucket: "persist" })
  br.record(false)
  assert.equal(br.open, true)
  _resetRiskForTests()
  const revived = getBreaker("persist", "", { now: () => Date.now() })
  assert.equal(revived.open, true, "重启后仍冷却（从落盘恢复）")
})

test("loader 接线：端点熔断时合成 429（risk-gated），不发上游", async () => {
  process.env.FREEPOOL_RISK_COOLDOWN_MS = "60000"
  const spec = SPECS[0] // kilo-free
  getBreaker(bucketOf(spec.id), spec.name).trip("test")
  const auth = anonymousAuth(spec, {})
  const loaded = await auth.loader()
  const upstream = []
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => { upstream.push(String(url)); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }) }
  try {
    const res = await loaded.fetch(`${spec.api}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "x", messages: [] }) })
    assert.equal(res.status, 429)
    const text = await res.text()
    assert.match(text, /risk-gated/)
    assert.match(text, /kilo-free/, "文案带端点名")
    assert.ok(Number(res.headers.get("retry-after")) > 0)
    assert.equal(upstream.length, 0, "熔断时不发上游")
  } finally { globalThis.fetch = previous }
})

test("loader 接线：未熔断时正常转发并记录 2xx（不误伤）", async () => {
  process.env.FREEPOOL_RISK_THRESHOLD = "2"
  const spec = SPECS[1] // llm7-free
  const auth = anonymousAuth(spec, {})
  const loaded = await auth.loader()
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
  try {
    const res = await loaded.fetch(`${spec.api}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "turbo", messages: [] }) })
    assert.equal(res.status, 200)
    assert.equal(shouldGate(bucketOf(spec.id)).gate, false, "一次 2xx 不清零也不熔断")
  } finally { globalThis.fetch = previous }
})

test("resetAllBreakers 解除所有端点冷却", async () => {
  process.env.FREEPOOL_RISK_COOLDOWN_MS = "60000"
  getBreaker("x").trip("t")
  assert.equal(getBreaker("x").open, true)
  const n = resetAllBreakers()
  assert.ok(n >= 1)
  assert.equal(getBreaker("x").open, false)
})

test("riskGateResponse 的 retry-after 与 body 结构", async () => {
  const res = riskGateResponse("pollinations-free", 90_000)
  assert.equal(res.status, 429)
  assert.equal(res.headers.get("retry-after"), "90")
  const parsed = JSON.parse(await res.text())
  assert.match(parsed.error.message, /risk-gated/)
  assert.equal(parsed.error.metadata.endpoint, "pollinations-free")
})
