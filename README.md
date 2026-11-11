# Switchyard

一个 OpenAI 兼容的本地网关：把多个提供商模型编成一条**优先级列表**，并从中选出一个当前输出模型。当当前模型因免费额度耗尽、失效、限流或无权限而无法服务时，网关在用户无感知的情况下切换到列表中的下一个模型。

Switchyard 不绑定任何厂商。默认提供商是阿里云百炼（DashScope）的兼容模式，但任何遵循 OpenAI 协议的端点都可以接入；"免费额度用完即停"只是它识别的一类失败信号，而不是产品定位。

## 特性

- **透明故障转移**：非流式与 SSE 流式请求都支持，响应头 `x-switchyard-model` / `x-switchyard-failovers` 告知实际使用的模型与切换次数。
- **单条模型列表**：所有候选模型放在一个列表里，拖动调整优先级；在列表里选一个作为当前输出模型，额度耗尽时按顺序自动切到下一个。支持多选、全选与批量移出。
- **免费额度优先**：把免费模型排在列表前面，额度耗尽（403）标记失效后自动转付费模型；失效模型在 `chain.retryDeadAfterMinutes`（默认 1 天）后自动重新参与选路，额度刷新当天又会从免费模型开始试，无需手动重置。
- **按能力选路**：每个模型可声明 `chat` / `responses` / `completions` / `embeddings` 能力；`/v1/chat/completions` 只在 chat 模型中选，`/v1/responses` 只在 responses 模型中选，不做协议转译。
- **上下文保护**：模型列表共用一个上下文窗口（默认 256K），超出时默认在转发前返回 400，避免把注定失败的请求送到提供商。
- **调用方统计**：按请求携带的 Bearer Token 自动归类，分别统计各客户端的请求、失败、切换与真实 Token 消耗（输入不含缓存命中，并显示缓存命中率）。
- **健康状态机**：`unknown → alive / dead / invalid`，限流进入冷却而不污染健康状态；重启后状态持久化。
- **管理看板**：模型、用量、事件、设置四个页面，主题始终跟随系统深浅色，全部本地访问。
- **两条等价的配置路径**：有看板的部署可以把模型列表、提供商、随机参数全部在界面上配置；`ui.enabled=false` 时看板彻底关闭，所有配置只在 `config.json` 里，能力不缩水。
- **多提供商**：`providers` 可以配任意多个 OpenAI 兼容端点；每个模型绑定一个提供商（`提供商/模型名`），同名模型分属两个提供商时是两个独立模型，跨提供商的故障转移照常工作。
- **Key 不是启动前提**：没有 Key 也能启动进程、打开看板、列出 `/v1/models`，缺 Key 只影响真正转发到那个提供商的请求。
- **零运行时依赖**：Node 内置 `http` / `fetch` / `test`，TypeScript 直接运行，无构建步骤。
- **离线可用**：看板不引用任何 CDN，Geist / Geist Mono 的拉丁子集（约 91 KB，SIL OFL）随程序一起分发，UI 全部使用无衬线字体，中文走系统字体。
- **可审计**：JSONL 事件日志、文件日志、原子写入的状态与配置。

## 快速开始

要求 **Node.js >= 22.18**（原生 TypeScript 类型剥离）。

```bash
npm install
npm start                  # 零配置就能起，缺 Key 时 /v1 返回 503 switchyard.no_key
```

要真正转发请求，**做两件事：添加 provider（Base URL + API Key），再把模型加入列表**。先添加 provider，二选一：

```bash
cp .env.example .env       # 1. 填 DASHSCOPE_API_KEY=sk-...
                           # 2. 或在看板「设置 → 提供商」里填
```

保存 provider 后默认**不会自动拉取目录**：到看板「模型」页点「添加模型」，在面板里直接输入模型 code 手动添加，或点「刷新目录」后再挑选。把模型加入列表并选一个当前输出模型后，`model: "auto"` 立即可用。新模型出现在目录里也不会自动加入，需要手动挑选。

首次启动会在当前目录生成 `config.json`，然后：

- 网关地址：`http://127.0.0.1:8788/v1`
- 管理看板：`http://127.0.0.1:8788`

> `npm run dev` 使用 `--watch` 热重启；`npm run mock` 启动本地模拟提供商（端口 9911），用于离线试用。

### 控制台输出

`npm start` 只打印接入地址、看板地址和配置文件路径，然后输出启动警告：

```text
◈ Switchyard v0.1.0
  gateway  http://127.0.0.1:8788/v1
  admin    http://127.0.0.1:8788
  config   /path/to/config.json
```

- 每个 API 请求不再打到控制台。访问日志只写入 `switchyard.log`（JSON，含 `method` / `path` / `status` / `ms`）；想在终端看逐请求的一行日志，把 `SWITCHYARD_LOG_LEVEL=debug`（或 `log.level`）设为 `debug`。
- 失败请求仍会输出 WARN / ERROR 行，例如模型失效、全部候选不可用。
- 输出到终端时带颜色；重定向到文件或设置 `NO_COLOR=1` 时自动去掉 ANSI 序列。
- `.env` 由程序自动加载（存在才读），缺少时静默跳过，语法错误仍会报错。
- npm 自己会打印 `> switchyard@0.1.0 start` 两行；想只看应用输出可以用 `npm start --silent`，或直接 `node src/index.ts`。
- 配置迁移会自动处理：`config.json` 是严格 JSON 时，启动时直接原地重写为新格式并打一条 `INFO 配置已迁移为新格式`，下次启动完全安静。
- 如果文件里有注释或尾逗号（无法安全重写），迁移只在内存里生效并输出 WARN，不会改动文件；在看板保存一次即可落盘，或去掉注释后重启让它自动写回。

### 长期运行

网关是常驻服务，启动信息打印完就保持安静，不提示「按 Ctrl+C 退出」。停止交给信号和服务管理器：

- `SIGINT`（终端 Ctrl+C）、`SIGTERM`（systemd / docker stop）和 Windows 的 `SIGBREAK` 都会优雅关闭：停止接收新连接、落盘用量与事件、写完「已关闭」日志后以 `0` 退出。
- 关闭最多等 5 秒，长连接拖住时会强制退出（退出码 `1`）；再按一次 Ctrl+C 也会立即强制退出。
- 推荐托管方式：
  - Windows：用 [NSSM](https://nssm.cc/) 注册为服务，`nssm set switchyard AppExit Default Restart`，崩溃或重启机器后自动拉起；
  - Linux：systemd unit，设置 `Restart=always`、`Environment=SWITCHYARD_CONFIG=/etc/switchyard/config.json`；
  - 容器：`restart: unless-stopped`，`STOPSIGNAL SIGTERM`，数据目录挂载到卷。
- 探活：`GET /health` 返回 `status`、版本、uptime、当前模型、模型可用数、提供商/Key 数，可直接给负载均衡或监控使用：

  ```json
  {"status":"ok","version":"0.1.0","uptimeSeconds":3600,"bootedAt":"...","model":"qianwenai/deepseek-v4.1-flash-1017","models":{"total":1,"alive":1,"dead":0},"providers":{"total":2,"configured":2}}
  ```
- 日志按 JSON Lines 写入 `<数据目录>/switchyard.log`，内置轮转：默认单文件 2 MB、保留 3 份（`switchyard.log.1` … `.3`），总共不超过 8 MB；由 `log.maxBytes` / `log.maxFiles` 调整，设 `maxBytes: 0` 关闭轮转。轮转由程序完成，不需要 logrotate。
- 配置热加载：直接编辑 `config.json` 会自动生效（监听文件变化，250ms 防抖），日志里输出一条 `配置已重新加载（文件变更）`；POSIX 上也可以 `kill -HUP <pid>`。设置 `SWITCHYARD_CONFIG_WATCH=0` 可关闭监听。看板保存本身已经即时生效，不会触发多余的重新加载。
- 热加载时如果新配置校验失败（JSON 写坏、端口非法等），会记录错误并继续使用旧配置，进程不会退出。

### Key 从哪来

Key 不是启动的硬性条件：进程、看板、`/v1/models` 都不需要它，缺 Key 只有转发请求时才会失败。每个提供商按下面的顺序取：

1. `providers[].apiKeyEnv` 指向的环境变量（如 `DASHSCOPE_API_KEY`）
2. `config.json` 里的 `providers[].apiKey`

都没有时，路由到那个提供商的请求返回 `503 switchyard.no_key`，错误信息会点名是哪个提供商缺 Key。多个提供商互不影响——缺 Key 的提供商会让相关请求失败，其余提供商照常服务。

### 多提供商与模型绑定

`providers` 是一个数组，每个元素是一个 OpenAI 兼容端点。**每个模型绑定到一个提供商**，标识写成 `提供商/模型名`：

```jsonc
"providers": [
  { "id": "dashscope", "label": "阿里云百炼", "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "apiKeyEnv": "DASHSCOPE_API_KEY" },
  { "id": "openai",   "label": "OpenAI",     "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" }
],
"defaultProvider": "dashscope",
"chain": {
  "active": "dashscope/qwen3.8-27b",
  "models": ["dashscope/qwen3.8-27b", "openai/gpt-4o-mini"]
}
```

- code 的第一段必须是已配置的提供商 id；转发时只把后面的模型名发给上游，前缀不会被发出去。
- **同名模型挂在两个提供商下算两个模型**：`dashscope/qwen3.8-max` 和 `openai/qwen3.8-max` 各自有独立的用量、价格、健康状态和故障转移顺位。
- `defaultProvider` 只用于真正透传的请求（客户端点名了列表里没有的模型），以及目录刷新时的默认目标。
- 客户端可以继续写裸模型名：只有在模型列表里唯一匹配时才会命中对应模型，同名模型分属两个提供商时按透传处理（建议直接用完整 code）。
- 模型列表里可以混排不同提供商的模型，故障转移顺序不变，跨提供商切换照样生效。
- 响应头 `x-switchyard-provider` 会告诉你这次实际落在哪个提供商；`/v1/models` 的每个条目带 `provider` 与 `upstream`。
- 模型目录刷新按提供商分组执行，缺 Key 的提供商会被跳过而不是整体失败。

> 术语统一：配置键、响应头、`/v1/models`、看板全部用 **provider（提供商）**，和 Cline / OpenCode 这类客户端里的叫法一致。
> 早期版本用过 `upstream`（`upstreams` / `defaultUpstream` / `modelUpstreams` / `modelProviders`），加载时会自动迁移并给出提示：`modelProviders` 会被并入模型 code，不用手改。


### 两种配置路径

同一份 `config.json` 同时是看板表单的存储后端，两条路径能力一致，随时可以互换：

| 场景 | 怎么用 |
| --- | --- |
| 有图形界面 | 打开看板即可完成全部配置：模型列表的加入/移出/排序/设为当前、上下文窗口、API 能力、提供商地址与 Key、故障转移、监听地址与端口、CORS、请求体上限、日志级别。保存即落盘生效 |
| 无图形界面（服务器、容器、脚本） | 把 `ui.enabled` 设为 `false`，看板静态资源不再提供，`/api/*` 仅保留给自动化；直接编辑 `config.json` 并重启，或用 `PUT /api/config` 推送 |

`config.json` 支持 `//`、`/* */` 注释与对象/数组尾逗号，方便手写；看板保存时会按规范化结果重写为严格 JSON。


### 接入客户端

任何 OpenAI SDK 只需替换 `base_url` / `baseURL`：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8788/v1", api_key="任意值或网关令牌")
client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "你好"}])
```

客户端这里的 `api_key` 只是**调用方标签**，网关用它给调用方分账（看板「调用方」页），提供商用的是 `providers[].apiKey`；两者互不相干，填任意值即可。只有设置了 `gatewayToken` 时它才需要等于网关令牌。

`model` 的取值：

| 值 | 含义 |
| --- | --- |
| `auto` | 使用当前选中的输出模型，失败后按列表顺序回退 |
| 列表里的模型（如 `qwen3.8-27b`） | 只发给这个模型，不做故障转移 |
| 未登记的其他模型 | 原样透传，不做故障转移 |

网关同时提供 `/v1/chat/completions` 与 `/v1/responses`。端点与模型能力一一对应：

| 请求端点 | 需要的模型能力 |
| --- | --- |
| `POST /v1/chat/completions` | `chat` |
| `POST /v1/responses` | `responses` |
| `POST /v1/completions` | `completions` |
| `POST /v1/embeddings` | `embeddings` |

网关**不会**把 Chat Completions 请求改写成 Responses（或反向），只会跳过未声明该能力的模型。若列表里没有任何匹配模型，或指定的模型未声明该能力，直接返回 `400 switchyard.api_unsupported`，而不是把请求送到错误的提供商端点。未在 `modelApis` 中登记的模型按 `["chat"]` 处理。

客户端 `api_key` 里填写的值会作为**调用方标识**：例如在 opencode 里填 `sk-opencode`，看板「调用方」就会单独统计它的用量。

## 工作方式

### 选路

1. 解析 `model`：`auto` 从当前输出模型开始；点名列表里的模型则只发给它；其他模型原样透传。
2. `auto` 时按当前请求端点过滤：只保留在 `modelApis` 中声明了对应能力的模型。
3. 过滤掉 `invalid` 模型，以及尚未到重试时间的 `dead` 模型（失效时间超过 `chain.retryDeadAfterMinutes` 后重新参与选路）。
4. 对剩余模型排序：正常模型保持列表顺序；处于限流冷却的模型排到后面。
5. `auto` 从当前输出模型开始按序尝试，每次尝试最多 `failover.maxAttempts` 次；点名模型只尝试一次。

**怎么看当前实际在用哪个模型**：`chain.effective` 就是 `auto` 此刻会命中的模型——从 `chain.active` 起、按列表顺序找到的第一个可用模型（`invalid` 与未到重试时间的 `dead` 除外）。看板「模型」页的「当前输出」始终落在它上面；`chain.active` 暂时不可用时它会顺延，行内不再另加标记，只在标题处注明「X 暂不可用，恢复后自动切回」。事件流里的「切换」事件记录 `qwen3.8-flash（额度耗尽）→ qwen3.8-27b（切换 1 次）` 这样的明细。API 侧另有响应头 `x-switchyard-model` / `x-switchyard-provider` / `x-switchyard-failovers`。

### API 能力

能力声明集中在 `modelApis`，缺省为 `["chat"]`：

```jsonc
"modelApis": {
  "qwen3.8-max-0902": ["chat"],
  "kimi-k3.1-pro": ["chat", "responses"],
  "qwen3.8-deep-research": ["responses"]
}
```

- 看板「模型」中每个模型的「⋯」菜单可以编辑 `CHAT` / `RESPONSES` / `COMPLETIONS` / `EMBEDDINGS` 能力，保存后立即生效并写入 `config.json`。
- 具体模型被点名且不支持当前端点时返回 `400`；`auto` 路由则自动跳过不支持的模型，只从支持者中选。
- 未跟踪、直接透传的模型不受能力表约束——网关没有它的声明，只能原样转发。

> Chat Completions 与 Responses 之间的字段映射（`messages ↔ input`、`max_tokens ↔ max_output_tokens`、工具定义、流式事件结构）只覆盖各自协议的子集，`previous_response_id`、`store`、内置工具与推理条目等在两个协议间没有等价物。因此 Switchyard 不做隐式转译；确实需要时请在客户端显式选择对应端点。

### 失败分类

网关不猜测额度，而是依据提供商返回的错误语义决定动作：

| 提供商信号 | 判定 | 动作 |
| --- | --- | --- |
| `403 AllocationQuota.FreeTierOnly` / 免费额度耗尽 | `quota_exhausted` | 标记模型 `dead`，立即切换；`chain.retryDeadAfterMinutes` 后自动重试（默认 1 天） |
| `429 Throttling.*` / rate limit | `throttled` | 进入冷却，稍后仍可用，**不**标记失效 |
| `404 ModelNotFound` / 模型不存在 | `model_invalid` | 标记 `invalid`，不再尝试 |
| `401 InvalidApiKey` / 签名错误 | `auth` | 终止本次故障转移，返回 401 |
| 裸 `404` | `provider` | 视为 base URL 配置错误，不牵连模型 |
| 其他 `403` | `forbidden` | 跳过该模型，不标记失效 |
| `400` / `422` | `bad_request` | 换模型重试（参数可能被其他模型接受） |
| `5xx` / 超时 / 网络错误 | `provider` / `timeout` / `network` | 重试下一个 |
| 估算超出模型列表的上下文窗口 | `context` | 转发前直接返回 `400`，不调用提供商 |

### 上下文窗口

模型列表通过 `chain.context` 控制上下文窗口，默认 `256000`（256K）：

- `window`：窗口大小，范围 1000 到 10,000,000。
- `onOverflow`：`reject`（默认）在估算超出时直接返回 `400 switchyard.context_length_exceeded`；`passthrough` 交给提供商自行处理。

估算按 OpenAI tokenizer 的预切分规则做近似：英文常用词通常 1 token（长词约 5 字符/token），数字每 1–3 位 1 token，CJK 约 1 token/字，标点、空白与 emoji 按常见合并方式计数，并保留约 3% 余量。Chat Completions 会把 `messages`（每条 3 token 开销，另计 role）、工具定义与 `max_tokens` / `max_completion_tokens` 计入；Responses 会把 `instructions`、`input`、工具定义与 `max_output_tokens` 计入。只对 `chat/completions`、`completions` 与 `responses` 生效，`embeddings` 不做限制。`/v1/models` 会为 `auto` 与列表内模型返回 `context_length`。估算用于拒绝明显超限的请求，精确计数仍以提供商为准。

### 流式边界

故障转移只发生在**提供商吐出的第一个字节之前**。一旦 SSE 已经开始向客户端输出，后续错误会直接结束流，不做静默重试，避免向客户端交付拼接错乱的响应。

### 调用方统计

网关从 `Authorization: Bearer <token>` 中提取调用方标识，按标识累计请求数、失败数、故障转移次数与 Token 用量，并持久化到 `state.json`。输入 Token 会扣除提供商上报的缓存命中部分，并单独显示缓存命中率。

- `sk-opencode` → 标签 `opencode`；不带 Key 的请求记为「未提供 Key」。
- 长随机 Key 只显示掩码（如 `sk-abc…wxyz`），状态文件保存的是 SHA-256 短哈希与派生标签，不保存完整 Key。
- `gatewayToken` 为空时会接受任意 Bearer 值，这正是区分多个客户端的前提；设置后只有该令牌会被接受，所有流量会归到同一个调用方。
- Token 统计依赖提供商返回 `usage`；流式请求默认注入 `stream_options.include_usage`，提供商不返回 usage 时只计请求数。缓存明细支持 `prompt_tokens_details.cached_tokens`、`input_tokens_details.cached_tokens` 与 `prompt_cache_hit_tokens`；未上报缓存明细的历史请求无法回算，缓存命中率会显示为「—」。
- 用量按协议分开累计：`chat`（`/v1/chat/completions`）、`completions`（`/v1/completions`）、`responses`（`/v1/responses`）、`embeddings`（`/v1/embeddings`）。看板右上角实时显示最近一次请求走的协议，「用量」页显示各协议的请求数，调用方表格里的「协议」列是它最近一次请求的协议。
- **只有用户加入模型列表的模型才会写进 `state.json`**：目录里拉到的候选模型、以及列表外透传请求用到的模型，都不会生成模型记录（不占 `models`、不保存健康状态与校准样本）。透传请求的 Token 仍然计入全局统计与调用方统计。模型从列表移除时，它的记录与校准样本一并删除。
- 「设置 → 数据」可重置用量统计：清空请求、失败、切换与 Token 累计（含缓存命中数、协议计数）并删除调用方记录，模型健康状态、目录、事件和配置都会保留。重置后新请求按真实新增输入重新累计。

## 配置

`config.json` 首次启动自动生成。看板「设置」里既有逐项表单，也可以切到「原始 JSON」直接写 JSON；两种方式写的是同一个文件，保存后立即生效，只有 `host` / `port` 需要重启进程。

```jsonc
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 8788,
  "gatewayToken": "",
  "server": {
    "maxBodyBytes": 16777216,   // 请求体上限（字节）
    "cors": true                // 为 /v1/* 返回 CORS 头
  },
  "ui": {
    "enabled": true             // false = 无看板，只认配置文件
  },
  "log": {
    "level": "info",            // debug / info / warn / error
    "file": "",                 // 留空写入数据目录的 switchyard.log
    "maxBytes": 2097152,        // 单文件上限，0 = 不轮转
    "maxFiles": 3               // 保留 switchyard.log.1 … .3
  },
  "chain": {
    "active": "dashscope/qwen3.8-27b",       // 当前输出模型，必须在 models 里
    "models": [
      "dashscope/qwen3.8-27b",               // 顺序即优先级，auto 从 active 开始回退
      "dashscope/kimi-k3.1-pro",
      "dashscope/qwen3.8-max-0902"
    ],
    "context": { "window": 256000, "onOverflow": "reject" },
    "retryDeadAfterMinutes": 1440  // 失效模型多少分钟后自动重试；0 = 仅手动重置
  },
  "modelApis": {
    "dashscope/qwen3.8-max-0902": ["chat"],
    "dashscope/kimi-k3.1-pro": ["chat", "responses"],
    "dashscope/qwen3.8-27b": ["chat"]
  },
  "providers": [
    {
      "id": "dashscope",
      "label": "阿里云百炼",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKeyEnv": "DASHSCOPE_API_KEY",
      "apiKey": "",
      "requestTimeoutMs": 90000,
      "injectStreamUsage": true
    }
  ],
  "defaultProvider": "dashscope",
  "failover": {
    "maxAttempts": 8,
    "throttleCooldownMs": 60000
  },
  "pricing": {
    "currency": "CNY",            // 展示币种
    "unit": 1000000,              // 单价按每百万 token
    "models": {
      "qianwenai/deepseek-v4.1-flash-1017": {
        "tiers": [
          { "from": "22:00", "to": "08:00", "input": 1, "cachedInput": 0.1, "output": 4 },
          { "from": "08:00", "to": "22:00", "input": 2, "cachedInput": 0.2, "output": 8 }
        ]
      }
    }
  },
  "responsesChaining": {
    "enabled": false,             // 仅对 /v1/responses 生效
    "ttlMinutes": 120,
    "maxSessions": 500
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `host` / `port` | 监听地址与端口。默认仅本机 |
| `gatewayToken` | 非空时，`/v1/*` 必须携带 `Authorization: Bearer <token>` |
| `server.maxBodyBytes` | 请求体上限，1024 – 268435456 字节，默认 16 MB |
| `server.cors` | 是否为 `/v1/*` 返回 `Access-Control-Allow-*`，浏览器直连时需要 |
| `ui.enabled` | `false` 时不再提供看板静态资源，配置只能走 `config.json` 与 `/api/config` |
| `log.level` | `debug` / `info` / `warn` / `error`；`SWITCHYARD_LOG_LEVEL` 优先级更高 |
| `log.file` | 日志文件路径，留空为 `<数据目录>/switchyard.log` |
| `log.maxBytes` | 单个日志文件上限（字节），默认 `2097152`（2 MB）；`0` 表示不轮转 |
| `log.maxFiles` | 轮转后保留的旧文件数（`.1` … `.N`），默认 `3`；`0` 表示只保留当前文件 |
| `chain.active` | 当前输出模型（`提供商/模型名`）；`auto` 请求从这里开始。必须在 `chain.models` 里，否则回落到第一个模型 |
| `chain.models` | 候选模型列表，顺序即优先级；每项都绑定提供商，写成 `提供商/模型名` |
| `chain.context.window` | 模型列表共用的上下文窗口，默认 `256000` |
| `chain.context.onOverflow` | `reject`（默认，超限返回 400）或 `passthrough`（交给提供商） |
| `chain.retryDeadAfterMinutes` | `dead` 模型自动重新参与选路的间隔（分钟），默认 `1440`（1 天）；`0` 表示只能手动重置。`invalid` 模型不会自动重试 |
| `modelApis` | 每个模型（`提供商/模型名`）支持的 API：`chat` / `responses` / `completions` / `embeddings`；未登记的模型默认 `["chat"]` |
| `providers[]` | 提供商列表：`id`（小写字母数字）、`label`、`baseUrl`、`apiKeyEnv`、`apiKey`、`requestTimeoutMs`、`injectStreamUsage` |
| `defaultProvider` | 仅用于透传请求（客户端点名了列表里没有的模型）与目录刷新的默认目标 |
| `providers[].apiKeyEnv` | 读取 API Key 的环境变量名；优先级高于同项的 `apiKey` |
| `providers[].injectStreamUsage` | 流式聊天请求未显式设置时自动注入 `stream_options.include_usage` |
| `failover.maxAttempts` | 单次请求最多尝试的模型数 |
| `failover.throttleCooldownMs` | 限流冷却时长；冷却结束后模型自动回到候选序列 |
| `pricing.currency` | 成本展示币种：`CNY` / `USD` / `EUR` / `GBP` / `JPY` / `KRW`，其他值按代码前缀显示 |
| `pricing.unit` | 单价的 token 基数，默认 `1000000`（每百万 token） |
| `pricing.models.<code>.tiers[]` | 分时段价格：`from` / `to`（本地时间 `HH:MM`，`from == to` 表示全天）、`input`、`cachedInput`、`output`。时间段必须覆盖一整天；`"*"` 可作为所有模型的兜底 |
| `responsesChaining.enabled` | 开启后 `/v1/responses` 会复用提供商的会话状态，只发送新增内容；默认关闭 |
| `responsesChaining.ttlMinutes` | response id 的保留时间（分钟），默认 `120` |
| `responsesChaining.maxSessions` | 内存中最多保留多少个会话前缀，默认 `500` |

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `DASHSCOPE_API_KEY` | 默认的提供商 Key 变量（可用 `apiKeyEnv` 改名） |
| `SWITCHYARD_PORT` | 覆盖监听端口 |
| `SWITCHYARD_PROVIDER` | 覆盖**默认提供商**的 base URL（内存生效，不写回配置） |
| `SWITCHYARD_CONFIG` | 配置文件路径，默认 `./config.json` |
| `SWITCHYARD_DATA_DIR` | 数据目录，默认 `./data` |
| `SWITCHYARD_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |
| `SWITCHYARD_CONFIG_WATCH` | 设为 `0` 关闭 `config.json` 文件监听（默认开启） |

### 成本估算

配好 `pricing` 后，用量页、模型页和调用方明细会按每次请求发生的**本地时间**选择价格档并累计成本：

```
成本 = 新增输入 × input + 缓存命中 × cachedInput + 输出 × output
```

三项 token 都来自提供商的 `usage`，只有单价是本地配置。几个边界：

- 时间段按网关进程的本地时区解释，必须完整覆盖 24 小时，否则保存配置时报错；
- 只统计成功请求；提供商没返回 `usage` 的请求不计成本；
- 不包含缓存写入费、免费额度、折扣、税与汇率；高上下文分档计价也无法按请求回拆；
- 修改单价只影响之后的累计，不会重算已经记账的历史金额。历史数据可以用 `POST /api/usage/backfill-cost` 指定一个 `at` 时间（ISO 格式），按该时刻命中的价格档重算：模型与总计按各自 token 计算，调用方按最近使用的模型计价（单一模型或同价模型时准确）。

### Responses 会话续接

`responsesChaining.enabled = true` 时，网关会在 `/v1/responses` 上做「增量发送」：

1. 用调用方、提供商、模型和工具集划定作用域，对 `input` 逐项做前缀哈希；
2. 命中之前的响应时，去掉客户端重复发来的 assistant / function_call / reasoning 项，只保留新增的 user 或工具结果；
3. 补上 `previous_response_id` 和 `store: true` 后转发；
4. 上游 SSE 原样透传，只旁路抓取 `response.created` 里的 id 存入内存。

约束与回退：

- 需要客户端使用 Responses API，并让模型在 `modelApis` 里声明 `responses`；
- 会话内容会保存在提供商侧（`store: true`），保留期由提供商决定；
- 进程重启、条目过期、前缀不匹配、切换模型/提供商或工具集变化时，自动退回全量请求；
- 只有成功响应才记录 id；`previous_response_id` 失效（400/404）时会清掉缓存并全量重试一次；
- 缓存只存在内存里，不写入 `state.json`。

## 看板

看板由 `src/ui/` 下的静态 HTML/CSS/ES module 直接提供，无需构建；主题始终跟随操作系统的深浅色设置。

| 页面 | 内容 |
| --- | --- |
| 模型 | 当前输出与状态、请求/切换/Token 统计、路由轨道（拖动或 `Alt+↑/↓` 调整优先级）、设为当前输出、重置状态、编辑 API 能力、批量移出、添加模型面板（按提供商展示目录、搜索/筛选/刷新与手动填写模型名）、发送测试、链路策略摘要与最近事件 |
| 用量 | 按调用方 API Key 汇总请求、失败、切换、真实输入/输出 Token、缓存命中率与按配置单价估算的成本，可分别排序并展开明细 |
| 事件 | 切换、失效、限流、恢复、配置变更，可按类型过滤、关键词搜索、暂停实时刷新 |
| 设置 | 网关、提供商、故障转移、服务、日志、数据、原始 JSON 的完整表单；「数据」分组可重置用量统计；底部保存栏统一提交 |

旧地址会重定向到新页面：`#/overview`、`#/chain` → 模型，`#/callers` → 用量，`#/catalog` 打开「添加模型」面板。

## 管理 API

管理接口仅接受本机回环地址访问；`ui.enabled=false` 时它们照常可用，便于无界面部署自动化。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 存活检查：状态、版本、uptime、当前模型、模型与提供商统计 |
| `GET` | `/api/overview` | 看板所需的完整快照（含调用方统计） |
| `GET` | `/api/events` | 事件列表，支持 `?limit=` |
| `GET` | `/api/config` | 读取配置：`text`（脱敏 JSON 文本）、`config`（结构化对象，`apiKey` 置空）、`apiKeySet`、Key 状态与路径 |
| `PUT` | `/api/config` | 保存配置：`{"config":{...}}` 按对象合并保存，或 `{"text":"{...}"}` 走文本（接受注释）；`apiKey` 留空表示保持原值 |
| `PATCH` | `/api/chain` | 更新上下文：`{"context":{"window":256000,"onOverflow":"reject"}}` |
| `POST` | `/api/chain/active` | 切换当前输出模型：`{"model":"qwen3.8-27b"}` |
| `POST` | `/api/chain/order` | 重排模型列表：`{"models":[...]}` |
| `POST` | `/api/chain/models` | 添加模型：`{"code":"dashscope/qwen3.8-27b"}`，必须带提供商标识 |
| `DELETE` | `/api/chain/models/:code` | 从列表移出模型 |
| `POST` | `/api/chain/models/remove` | 批量移出：`{"models":["a","b"]}`，返回 `removed` 与实际条数；一次落盘 |
| `POST` | `/api/models/:code/revive` | 重置模型状态为待检测 |
| `POST` | `/api/models/:code/apis` | 设置 API 能力：`{"apis":["chat","responses"]}` |
| `POST` | `/api/catalog/refresh` | 拉取模型目录；不传参数刷新全部提供商，`{"provider":"openai"}` 只刷一个 |
| `POST` | `/api/test` | 真实测试请求：`{"prompt":"..."}`，走 `auto` |

网关接口的失败映射：`401` 认证失败、`400` 参数 / 上下文超限 / API 能力不匹配、`403` 无权限、`429` 限流（`Retry-After: 5`）、`502` 提供商异常 / 未知提供商（`switchyard.provider_unknown`）、`503` 所有候选模型不可用（`Retry-After: 30`）或网关未配置提供商 Key（`switchyard.no_key`，不是客户端的认证问题）。错误体兼容 OpenAI 格式，并附带 `attempts` 明细。

## 安全

- 管理 API 与看板默认只监听 `127.0.0.1`；`/api/*` 另有回环来源校验。
- `ui.enabled=false` 时不再提供任何静态资源（`/` 直接 404），但管理 API 仍只对本机开放。
- 设置 `gatewayToken` 后，`/v1/*` 使用常量时间比较校验 Bearer Token。
- 提供商 Key 只在服务端读取，看板仅显示掩码；`/api/config` 返回的文本会清空 `apiKey`。
- 响应带 CSP、`nosniff`、`no-referrer`、`SAMEORIGIN` 等头部；请求体上限 16 MB。

## 已知边界

- 提供商没有官方额度查询 API；"额度耗尽"依据错误码判定，未触发错误前网关无法预知剩余额度，也不做本地预算估算。
- 不在 `modelApis` 中的透传模型按 chat-only 处理；其真实能力由提供商决定，网关无法预先校验。
- Chat Completions 与 Responses 不做隐式转译；跨协议使用请由客户端选择正确端点，或在 `modelApis` 中为模型补全能力声明。
- 上下文窗口使用与 tokenizer 预切分对齐的近似估算（不是逐字符计数），用于拦截明显超限的请求；在窗口边界附近仍可能与提供商的精确 tokenizer 有偏差。`npm run calibrate` 会发送一组固定样本，对比估算值与提供商返回的 `usage.prompt_tokens`（默认访问 `http://127.0.0.1:8788/v1`，可用 `SWITCHYARD_CALIBRATION_URL` / `_MODEL` 覆盖）。该估算只影响超限拦截，不影响用量统计。
- 网关会用每次成功请求的 `usage.prompt_tokens` 反过来校准估算，按「模型 × 是否带 tools」分别维护系数并持久化到 `state.json`；样本按请求长度加权，长度不足 100 token 估算的请求不参与校准。校准只改变超限拦截的判断，不改变统计与计费。
- 调用方 Token 统计以提供商返回的 `usage` 为准；输入显示为扣除缓存命中后的新增部分，缓存命中率以提供商上报过缓存明细的请求为分母。提供商不返回 usage 时只统计请求次数，不估算 Token。
- SSE 开始输出后不可回滚；极端情况下提供商中途断流只会结束当前响应。
- 状态与事件是单机文件，不适用于多实例共享。
- 看板保存会把 `config.json` 重写为规范化严格 JSON，手写的注释与字段顺序会丢失；想保留注释就只改文件、不开看板保存。
- 列表里没有的模型原样透传，不参与故障转移；`auto` 只会在列表内切换。
- 模型 code 由「提供商 + 上游模型名」组成（`提供商/模型名`）；改名或移出模型不会同步客户端里的 `model` 值，请自行更新调用方配置。
- 提供商 `id` 是模型 code 的前缀，已在用的 id 保存后不可修改；非要改名时请同时改掉所有引用它的模型 code，否则这些模型会因为前缀失效而只能透传。
- 同名模型出现在多个提供商时，目录里会保留多条记录（各自带 `provider`），按 `提供商/模型名` 分别管理用量、价格和健康状态。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test，99 个用例
npm run mock        # 模拟提供商，端口 9911
```

用模拟提供商联调：

```bash
# 终端 1
npm run mock
# 终端 2
SWITCHYARD_PROVIDER=http://127.0.0.1:9911/v1 DASHSCOPE_API_KEY=test npm run dev
# 终端 3
curl -s http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```

模拟提供商内置行为：`qwen3.8-max-0902` 返回免费额度耗尽、`kimi-k3` 返回 429、`deepseek-v3.2` / `glm-5` 返回 404，其余模型正常（支持流式）。它还模拟了 API 能力差异：`kimi-k3.1-pro` / `qwen3.8-27b` / `qwen3.8-vl` / `qwen3.8-max-0902` 支持 Responses，`qwen3.8-deep-research` 仅支持 Responses，其余模型仅支持 Chat Completions。

## 目录结构

```
src/
  index.ts              启动、配置加载、日志、优雅退出
  runtime.ts            编排：选路、请求、配置、事件
  core/                 选路、失败分类、故障转移、事件、用量
  config/               配置 schema、校验与读写
  provider/             提供商客户端
  store/                状态持久化（原子写 + 防抖）
  http/                 HTTP 服务、OpenAI 与 管理路由、SSE 转发
  ui/                   零依赖看板（HTML/CSS/ES module）
test/                   单元测试与模拟提供商
```

数据目录默认包含 `state.json`（已加入模型的状态与统计）、`events.jsonl`（事件流）、`switchyard.log`（运行日志）。
