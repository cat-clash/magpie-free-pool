# magpie-free-pool

把 **免注册、免 key、免实名、免绑卡** 的 OpenAI 兼容端点塞进 magpie 模型池，并带一个**每小时自动健康检测**：失效模型自动剔除，新上架的免费模型自动接入。

架构参考 [chengaopan/AutoMergePublicNodes](https://github.com/chengaopan/AutoMergePublicNodes) 的「多源抓取 → 归一化 → 去重 → 校验 → 定时产物 → CI 提交」流水线；区别在于判活标准是**真发一次 chat 看能不能回话**，而不是只看 TCP 通不通——`airforce`、`inference.net`、`chutes` 都是 `/models` 200 但 chat 401/402 的反例。

## 三个默认端点

| provider id | base URL | 模型规模 | 匿名限制 |
| --- | --- | --- | --- |
| `kilo-free` | `https://api.kilo.ai/api/gateway` | ~460 个，19 个标 `isFree` | ~200 请求/小时/IP |
| `llm7-free` | `https://api.llm7.io/v1` | ~74 个，`tier=turbo` 匿名可用 | 未公布 |
| `pollinations-free` | `https://text.pollinations.ai/openai` | 1 个（gpt-oss-20b） | 同 IP 1 并发、间隔 ≥45s、100 次/天 |

三个端点都不校验 `Authorization`，插件用占位 key `anonymous`。

### OVH 默认关闭

`ovh-free` 从 2026-11-27 起匿名调用返回 **403 authentication failed**，要求自备 OAuth token（`https://kepler.ai.cloud.ovh.net/v1/oauth/ovh/authorize`）。纯匿名已不可用，所以**默认不注册**，避免在 magpie 里点到就报错。

需要时打开：

```sh
magpie plugin options github:cat-clash/magpie-free-pool '{"enableOvh":true}'
echo anonymous | magpie plugin login ovh-free
```

## 安装

```sh
magpie plugin add github:cat-clash/magpie-free-pool
echo anonymous | magpie plugin login kilo-free
echo anonymous | magpie plugin login llm7-free
echo anonymous | magpie plugin login pollinations-free
magpie plugin list
```

模型 id 形如 `kilo-free/kilo-auto/free`。

## 每小时自动体检

`polling.mjs` 抓 `/models` → 对候选发 `max_tokens=8` 的真实 chat → 写 `free_pool_snapshot.json`；`index.mjs` 的 `config` hook 只读这份快照，所以 magpie 里**永远只出现当前可用的模型**。

判定规则：
- `alive`：200 且有回复 → 进池
- `suspect`：429 / 超时 / 5xx → 先留池，失败次数 +1（抗抖动）
- `dead`：401 / 402 / 403，或连续失败达阈值（默认 2 次）→ 出池
- 复活：上轮 dead 本轮 200 → 立刻回 alive，计数清零

探测优先级：**新模型最优先** → 已知存活模型按游标轮转 → 付费模型最后。快照里存游标，每小时覆盖不同的一批，几百个模型逐轮走完。

### 本机手动跑

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'   # 有代理就设，无则删掉
node polling.mjs --once --max-probes 24    # 跑一次
node polling.mjs --loop                    # 常驻，每小时
node polling.mjs --serve                   # GET /health, POST /refresh
```

### 代理坑（重要）

Node 原生 `fetch` 和 bun **都不读** `HTTPS_PROXY`。中国大陆直连这些海外端点会 `ECONNRESET`（约 5 秒断开），看起来像"全部端点挂了"。`health.mjs` 自带 `createProxyFetch()`：CONNECT 隧道 + TLS，自动读环境变量，也支持 `--proxy http://127.0.0.1:7897`。GitHub Actions 的 runner 在海外，直连无需代理。

## 质量感知与容错

每小时探测不只看"能不能连"，还记录三样东西，写进快照供排序使用：

| 字段 | 含义 |
| --- | --- |
| `quality` | 0–1 分。真回了话是及格线，`1000ms` 内接近 1，`10s` 接近 0，空回复固定 0.4 |
| `category` | 失败归类：`ok` / `rate_limit`(429) / `auth`(401,403) / `payment`(402) / `server`(5xx) / `network`(连不上) / `http` |
| `health.latencyMs` | 本轮实测延迟，用于观察端点是否在变慢 |

**候选排序**（`selectCandidates`）：新出现的免费模型 → 上轮质量高的模型按分数从高到低复检 → 付费模型。每小时额度先花在"没试过的"和"上轮最好的"上，而不是每次按字母序打同一批。

**代理回退**：`makeFetch` 会先探一下代理端口（`proxyAlive`，1.5s 超时）。代理挂了就自动退回直连，并在日志里打 `WARNING 代理端口不可达，已回退直连`——避免把"代理挂了"误判成"所有端点都死了"（这是本地实测踩过的坑）。

## 测试

```sh
node --test    # 26 个用例，全程 mock fetch，不访问外网
```

## 与 AutoMergePublicNodes 的对应

| 参考项目 | 本项目 |
| --- | --- |
| `sources.list` 多源 | `SPECS` 四个匿名端点 |
| 并发抓取 + 单源超时 | `poolRun` + `AbortController` |
| `Node.__hash__` 去重 | `dedupeModels` 按 provider-qualified id |
| 多格式归一化 | `normalizeCatalog` 三套 mapper |
| `fetch.yml` 每 3 小时 | `health.yml` 每小时 |
| 产物 `list.txt` | `free_pool_snapshot.json` |
| CI 自动 commit + jsDelivr purge | 同样 |

## 已知问题

装好后模型全部超时、`provider test` 报 `no answer in 10s`？先看 [docs/known-issues.md](./docs/known-issues.md) 的**陷阱 #7**（`settings.json` 的 `proxy` 字段）。其余端点状态与运维坑也记在那份文件里。

## 授权

MIT。端点由各自运营方提供，配额与条款随时可能变；本项目只做探测与汇总，不绕过任何鉴权。
