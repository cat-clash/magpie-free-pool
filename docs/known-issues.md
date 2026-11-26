# 已知问题与运维陷阱

本文件只收录**与 magpie-free-pool 直接相关**的坑。上游 workspace 的完整知识库在
`default-workspace/KNOWN_ISSUES.md`（含 OpenRouter 注册、magpie BUG #1–#4 等）。

---

## 陷阱 #7：`settings.json` 的 `proxy` 字段会被写回 `direct`，且它要的是完整 URL

### 现象

四个 provider 全部超时或 `ECONNRESET`，`magpie provider test <provider>` 报
`no answer in 10s`；任何 `magpie plugin` 命令的 stderr 都打一行
`plugin: host starts with no proxy`。

### 实测证据（2026-11-27，magpie 0.1.4684）

| 时间 (+08) | 观察 |
|---|---|
| 01:44 | `settings.json` 里 `"proxy": "direct"`（当天早先手工设过代理）→ host `no proxy` |
| 01:50 | 误把字段改成模式词 `"proxy"` → host 读成 `HTTP_PROXY=http://proxy` → `dial tcp proxy:80: getaddrinfo ENOTFOUND proxy` |
| 01:52 | 改成完整 URL `http://127.0.0.1:7897` → `✓ chat 2058 ms` |
| 06:44 | 又变回 `"direct"`（magpie 进程重启过）→ 再次 `no proxy` |
| 06:45 | 重写完整 URL + `start-magpie.cmd proxy` 重启 → `✓ chat 1798 ms`、`1469 ms` |

### 根因

1. 该字段由 magpie 托管，启动时探测代理不可达就落回 `direct` 并回写。
2. 值是**代理 URL**（会喂成 `HTTP_PROXY`/`HTTPS_PROXY`），不是 `direct`/`proxy` 模式词。
3. `start-magpie.ps1` 设的同名环境变量只在它拉起 magpie 时有效；magpie 自我重启不带。

### 修复

```powershell
$s='C:\Users\c\.config\magpie\settings.json'
Copy-Item $s "$s.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
$j=Get-Content $s -Raw | ConvertFrom-Json; $j.proxy='http://127.0.0.1:7897'
$j | ConvertTo-Json -Depth 30 | Set-Content $s -Encoding UTF8

Stop-Process -Name magpie -Force
& 'D:\magpie\start-magpie.cmd' proxy
```

### 复发检测

```powershell
((Get-Content 'C:\Users\c\.config\magpie\settings.json' -Raw | ConvertFrom-Json).proxy)
# 期望 http://127.0.0.1:7897；出现 direct / proxy 即为复发
& 'D:\magpie\magpie.com' provider test kilo-free 2>&1 | Select-String '✓|✗'
```

**`provider test` 出 `no answer in 10s` 时，先查这个字段，不要怀疑端点死了。**

---

## 陷阱 #4：Bun / Node 的 fetch 不看环境变量清理，死代理导致全局 ECONNREFUSED

进程启动时固化的代理地址，运行时清 `HTTPS_PROXY` 也清不掉；必须重启进程。
本插件的对策：`health.mjs` 的 `makeFetch()` 会先 `proxyAlive()` 探端口（1.5s），
代理挂了自动回退直连并打 `WARNING 代理端口不可达，已回退直连`。

---

## 陷阱 #6：`magpie plugin off/on` 会把 provider 置为 off=true，请求全 404

重装插件别只 `off` + `on`，要 `plugin rm` + `plugin add`。
登录态存在 `~/.config/magpie/plugin-auth.json`，按 provider id 索引，rm 后保留。

---

## 端点侧已知状态（2026-11-27 实测）

| provider | 状态 | 说明 |
|---|---|---|
| `kilo-free` | 可用 | 本地代理下 `✓ chat 1469–2058 ms`；免费额度 ~200 req/hr/IP，连续压测会 429 |
| `pollinations-free` | 可用 | `✓ chat 801 ms`；每 IP 1 并发、≥45s 间隔、≤100 回复/天 |
| `llm7-free` | 间歇 | 本地代理出口 IP 常 `ECONNRESET`；CI（海外 runner）能探到 alive |
| `ovh-free` | 需 token | 匿名 403，要求 OAuth token；CI 早期仍能命中 4 个 alive，按出口 IP 而定 |

这些都会随时间变化——这正是每小時健康检测存在的意义：不猜，实测。
