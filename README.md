# magpie-free-pool

把 4 个**免注册、免 key、免实名、免绑卡**的 OpenAI 兼容端点塞进 magpie 模型池，并带一个**每小时自动健康检测**：失效模型自动剔除，新上架的免费模型自动接入。

架构参考 [chengaopan/AutoMergePublicNodes](https://github.com/chengaopan/AutoMergePublicNodes) 的「多源抓取 → 归一化 → 去重 → 校验 → 定时产物 → CI 提交」流水线；区别在于判活标准是**真发一次 chat 看能不能回话**，而不是只看 TCP 通不通——`airforce`、`inference.net`、`chutes` 都是 `/models` 200 但 chat 401/402 的反例。

## 四个匿名端点

| provider id | base URL | 模型规模 | 匿名限制 |
| --- | --- | --- | --- |
| `kilo-free` | `https://api.kilo.ai/api/gateway` | ~460 个，19 个标 `isFree` | ~200 请求/小时/IP |
| `llm7-free` | `https://api.llm7.io/v1` | ~74 个，`tier=turbo` 匿名可用 | 未公布 |
| `pollinations-free` | `https://text.pollinations.ai/openai` | 1 个（gpt-oss-20b） | 同 IP 1 并发、间隔 ≥45s、100 次/天 |
| `ovh-free` | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | ~26 个（过滤 tts 后） | ~2 请求/分钟/IP/模型，年度额度易耗尽 |

四个端点都不校验 `Authorization`，插件用占位 key `anonymous`。

## 安装

```sh
magpie plugin add github:cat-clash/magpie-free-pool
echo anonymous | magpie plugin login kilo-free
echo anonymous | magpie plugin login llm7-free
echo anonymous | magpie plugin login pollinations-free
echo anonymous | magpie plugin login ovh-free
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

## 测试

```sh
node --test    # 17 个用例，全程 mock fetch
```

覆盖：三种 `/models` 结构归一化、`isFree` 优先级、`tier=turbo` 匿名判定、429/401/402/网络错误分类、连续失败阈值剔除、恢复、快照原子读写、代理传输选择。

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

## 授权

MIT。端点由各自运营方提供，配额与条款随时可能变；本项目只做探测与汇总，不绕过任何鉴权。
