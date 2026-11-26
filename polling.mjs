// polling.mjs — 每小时动态健康检测调度器 + CLI
//
// 用法：
//   node polling.mjs --once                跑一次检测并写快照
//   node polling.mjs --once --dry-run      只看报告，不写盘
//   node polling.mjs --loop                常驻，每 --interval 分钟跑一次（默认 60）
//   node polling.mjs --serve               起本地 HTTP：GET /health、POST /refresh
//
// 代理：自动读 HTTPS_PROXY / HTTP_PROXY，用 health.mjs 的 CONNECT 隧道实现。
// Node 原生 fetch 和 bun 都不读系统代理，直连海外端点会被重置（ECONNRESET），必须走这里。

import { healthCheck, readSnapshot, writeSnapshot, makeFetch, DEFAULT_SNAPSHOT, DEFAULT_MAX_PROBES } from './health.mjs'
import { SPECS } from './index.mjs'

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000 // 1 小时

export async function runOnce(opts = {}) {
  const {
    snapshotPath = DEFAULT_SNAPSHOT,
    dryRun = false,
    maxProbes = DEFAULT_MAX_PROBES,
    deadThreshold = 2,
    proxy,
    logger = console.log,
    ...rest
  } = opts

  // 传输层：有代理走隧道，否则直连
  const { doFetch, transport } = makeFetch(proxy)
  const prev = dryRun ? null : await readSnapshot(snapshotPath)
  const report = await healthCheck(SPECS, { ...rest, prev, doFetch, maxProbes, deadThreshold })
  const s = report.summary
  logger(`[health] ${report.checkedAt} transport=${transport}`)
  logger(
    `[health] discovered=${s.discovered} probed=${s.probed} alive=${s.alive} suspect=${s.suspect} dead=${s.dead} removed=${s.removed} pool=${s.pool}`,
  )
  for (const [id, src] of Object.entries(report.sources)) {
    if (!src.ok) logger(`[health]   source ${id} FAILED: ${src.error}`)
  }
  if (!dryRun) {
    const path = await writeSnapshot(report, snapshotPath)
    logger(`[health] snapshot -> ${path}`)
  }
  return report
}

/** 常驻调度：立即跑一次，之后每 intervalMs 跑一次；返回 stop()。 */
export function startPolling(opts = {}) {
  const { intervalMs = DEFAULT_INTERVAL_MS, onError = console.error, ...rest } = opts
  let stopped = false
  let timer = null
  const tick = async () => {
    if (stopped) return
    try {
      await runOnce(rest)
    } catch (err) {
      onError(`[health] unexpected error: ${err?.stack || err}`)
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs)
    }
  }
  tick() // fire immediately
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

// ------------------------------------------------------------------ CLI ----

export async function main(argv = process.argv.slice(2)) {
  const has = (f) => argv.includes(f)
  const val = (f, d) => {
    const i = argv.indexOf(f)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d
  }
  const opts = {
    snapshotPath: val('--snapshot', DEFAULT_SNAPSHOT),
    maxProbes: Number(val('--max-probes', String(DEFAULT_MAX_PROBES))),
    deadThreshold: Number(val('--dead-threshold', '2')),
    dryRun: has('--dry-run'),
    proxy: val('--proxy', undefined),
    intervalMs: Number(val('--interval', '60')) * 60 * 1000,
  }

  if (has('--loop')) {
    console.log(`[health] polling every ${opts.intervalMs / 60000} min -> ${opts.snapshotPath}`)
    const stop = startPolling(opts)
    const shutdown = () => {
      stop()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return
  }

  if (has('--serve')) {
    const port = Number(val('--port', '8787'))
    const { createServer } = await import('node:http')
    const stop = startPolling(opts)
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (req.url === '/health' && req.method === 'GET') {
        const snap = await readSnapshot(opts.snapshotPath)
        res.end(JSON.stringify(snap ? { ok: true, checkedAt: snap.checkedAt, summary: snap.summary } : { ok: false, error: 'no snapshot yet' }))
        return
      }
      if (req.url === '/refresh' && req.method === 'POST') {
        const report = await runOnce({ ...opts, logger: () => {} })
        res.end(JSON.stringify({ ok: true, summary: report.summary }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    })
    server.listen(port, '127.0.0.1', () => console.log(`[health] serving http://127.0.0.1:${port} (GET /health, POST /refresh)`))
    const shutdown = () => {
      stop()
      server.close()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return
  }

  await runOnce(opts)
}

// 只有直接执行时才跑 CLI（被 import 时不跑）。pathToFileURL 处理 Windows 盘符。
const isEntry = async () => {
  if (!process.argv[1]) return false
  const { pathToFileURL } = await import('node:url')
  const { resolve } = await import('node:path')
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}
if (await isEntry()) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
