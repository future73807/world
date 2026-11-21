# 09 · API 密钥与多 Provider 接入

> **一句话**：用户随便贴哪家的 Key——OpenAI、Claude、Gemini、DeepSeek、OpenRouter、本地 Ollama——都能用；上层只看见一个 `ai.chat()`，看不见四套协议。

---

## 前置

零件 03（服务端路由已存在）。

---

## 提示词正文
> **共同硬约束（独立执行本零件也必须遵守）**
> - 主游玩端是浏览器全屏 Three.js/WebGL；Blender 只负责从零生成、导出和离线检查，禁止把“打开 Blender”作为玩家步骤。
> - 恢复包中的任何文件均不得读取、参考或导入；所有 UI、模型、材质和动画从空白重新设计，禁止迁移、换皮或使用外部游戏/现成模型包资源。
> - 目标是**精致风格化低模**：大/中/小结构、合理拓扑与平面/分组平滑/加权法线、原创程序化材质和近景细节。低面数不等于简陋，禁止方块、体素、像素纹理和粗糙 primitives 通过。
> - 新模型先交剪影、灰模、材质完成图及近/中/远实机证据；美术不合格不能用低面数、帧率或“非 MC”豁免。
> - 新 UI 先交桌面/触屏线框和高保真 HUD/地图/暂停/创建/互动设计稿，使用原创图标、合法字体和统一 token；只参考开放世界游戏的信息层级，不复制具体素材。
> - 默认第三人称跟随。角色具有起步、移动、停止、转向、跳跃预备、上升、顶点、下落和落地；桌面 WASD/指针锁定/空格/Shift/E/M/J/Esc，触屏才显示虚拟控件；松鼠标不强制回正。
> - 禁止三栏/左右常驻面板/常驻日志。CLI 与性能工具默认隐藏，创建、设置、编辑只在高保真非驻留界面。
> - 本零件与上述约束冲突时，上述约束优先；若正文仍存在旧指令，停手报告，不擅自回退产品方向。

你是**多协议接线员**。市面上说"支持 OpenAI 格式"的接口其实分三大流派（OpenAI 形态 / Claude 形态 / Gemini 形态），其余各家都是 OpenAI 形态的变体。你要在**服务端**把它们全翻译成同一个调用，让零件 10 完全不用知道背后是谁。

### 步骤 1 · Provider 清单（必须支持）

| 标识 | 名称 | 认证方式 | 请求风格 | 默认地址 |
|---|---|---|---|---|
| `openai` | OpenAI / 兼容代理 | 头部 `Authorization: Bearer <key>` | 单一 `messages` 数组，`response_format` 可要 JSON | `https://api.openai.com/v1` |
| `anthropic` | Claude | 头部 `x-api-key: <key>` + `anthropic-version` | 顶层 `system` 与 `messages` 分离，`max_tokens` 必填 | `https://api.anthropic.com/v1` |
| `gemini` | Google Gemini | 查询参数 `key=<key>` 或头部 `x-goog-api-key` | `contents[]` + `parts[]`，system 走 `systemInstruction` | `https://generativelanguage.googleapis.com/v1beta` |
| `deepseek` | DeepSeek | 同 OpenAI | 同 OpenAI | `https://api.deepseek.com/v1` |
| `openrouter` | OpenRouter | 同 OpenAI（可带 `HTTP-Referer`/`X-Title`） | 同 OpenAI，`model` 形如 `vendor/model` | `https://openrouter.ai/api/v1` |
| `ollama` | 本地 Ollama | 无需 Key | 同 OpenAI，但无鉴权、默认 `http://localhost:11434/v1` | `http://localhost:11434/v1` |
| `custom` | 任意自建/中转 | 允许自定义鉴权头名 | 按 OpenAI 形态发，可用开关切到 Anthropic 形态 | 用户填 |

- `deepseek` / `openrouter` / `ollama` / 大多数中转站，**复用 `openai` 适配器**，只是默认 `base_url` 与 `model` 不同。不要为它们各写一套。
- 真正需要独立实现的只有三个：**openai 系、anthropic、gemini**。加上 `custom` 的两个开关即可覆盖全部。
- **"OpenAI 兼容"是一大片**：vLLM、LM Studio、Moonshot(Kimi)、智谱 GLM、通义千问 DashScope 兼容模式、SiliconFlow、以及各家中转站，都走 OpenAI 形态。它们的差别只在 `base_url` + `model`，用 `custom` 或 `openai` + 改地址即可，**不要**为每一家新增 provider。
- 版本不一致是常态：不要假设某个模型支持 JSON 模式、工具调用、图像输入。**能力探测先行**（步骤 5）。

### 步骤 2 · 配置存储

只存服务端 `runtime/secrets.json`（首次写入自动加入 `.gitignore`）：

- 顶层：`active_provider`（当前选中）、`updated_at`、`probe`（见步骤 5）。
- `providers` 对象：每个 provider 一个条目，含 `enabled`、`base_url`、`model`、`key`、`extra_headers`（可选，键值对）、`auth_mode`（`bearer` / `header-key` / `query-key` / `none`）、`api_style`（`openai` / `anthropic` / `gemini`）。
- 支持**多个 provider 同时配置**，用 `active_provider` 切换；这也是"离线兜底"的另一层保险。
- `ollama` 不存 Key（允许 `key` 为空）。
- **绝不**把 Key 下发浏览器；前端只拿 `has_key` 与打码尾四位。允许"仅本次会话"模式（不落盘）。

### 步骤 3 · 统一接口（内部契约，只需三个字段）

服务端暴露给零件 10 的语义只有：

**输入**：`system_prompt`（角色与硬约束）、`user_prompt`（愿望与上下文）、`want_json`（是否要求 JSON）、`max_tokens`、`temperature`、`provider_override`（可选）。
**输出**：`{ ok, text, usage, provider, model, latency_ms, error }`。失败时 `text` 为空、`error` 可读。

三个适配器的职责就是把上面三个输入翻译成各家请求体，再把各家响应里的文本捞出来：

| 适配器 | 文本所在位置（注意各家不同） |
|---|---|
| `openai` | `choices[0].message.content`；若为数组（部分新模型）要拼 `text` 片段 |
| `anthropic` | `content[]` 里 `type=text` 的块拼接；`stop_reason` 要检查是否被截断 |
| `gemini` | `candidates[0].content.parts[]` 拼接；`finishReason` 检查 `MAX_TOKENS` |

### 步骤 4 · 鉴权怎么放（最容易错的地方）

| provider | 放哪 | 注意 |
|---|---|---|
| openai / deepseek / openrouter | 请求头 `Authorization: Bearer KEY` | OpenRouter 建议加 `HTTP-Referer` 与 `X-Title`，缺失不报错 |
| anthropic | 请求头 `x-api-key: KEY` 与 `anthropic-version: 2023-06-01` | **不是** Bearer；用错就是 401 | 
| gemini | 优先请求头 `x-goog-api-key: KEY` | 查询串 `?key=` 也可，但会进代理日志；**首选头部** |
| custom | 按 `auth_mode` 决定 | 用户自定义头名时，明确提示"我会把它放进请求头" |

**禁止**把 Key 拼进 URL 记录日志（gemini 查询串方案要专门打码）。

### 步骤 5 · 能力探测（每个 provider 单独）

保存或切换 provider 后做一次极短请求（10~20 token），记录到 `secrets.json` 的 `probe`：

- `ok`、`model_echo`（服务端回显的模型名）、`latency_ms`、`at`、`supports_json`（试一次 JSON 模式）、`max_context_hint`（若响应头/字段有）。
- **不要**因为探测失败就清 Key；只标记，允许用户继续（很多中转站对探测请求返回奇怪结果）。
- 探测结果直接影响零件 10：`supports_json` 为假时，零件 10 走"文本里抠 JSON"的宽松解析。

### 步骤 6 · 非驻留设置界面（前端）

模型配置只放在从 Esc 暂停/设置进入的可关闭「模型」页，或首次创建世界时主动打开的设置步骤中。它不是左栏折叠区，不在默认 HUD 显示 Provider、Key 字段、状态列表或常驻徽章。

- **Provider 下拉**：七个选项，选中即把该 provider 的字段填进表单。
- 字段：Base URL（预填默认，可改）、模型名（给一行示例占位，例如 `gpt-4o-mini` / `claude-3-5-sonnet-latest` / `gemini-2.0-flash` / `llama3.1`）、Key（密码框，`ollama` 时禁用并写"本地无需 Key"）。
- 高级（默认折叠）：自定义鉴权头名、自定义 `model` 前缀、额外请求头（键值对）、`api_style` 切换。
- 按钮：保存、清除、测试连接。
- 测试连接结果一行：`✅ claude-3-5-sonnet · 812ms · JSON 支持` 或 `❌ 401 · 鉴权头不匹配`；完整错误与请求日志只能在开发工具查看。
- **多 provider 并存**时在该设置页显示一个小列表：每家一行，带状态点（已配置/探测失败/未配置），可一键切换 `active_provider`。
- 界面打开时进入 `settings`/`creating` 输入上下文，文本框、下拉、滑杆与按钮捕获键鼠事件；输入 Key、Base URL 或模型名时，WASD、空格、E、方向键不得驱动角色、相机或互动。
- 保存、取消与 Esc 关闭都回到打开前的游戏界面，恢复原玩家位置、相机姿态、视角模式和 HUD。关闭时清空持续按键；除非玩家明确确认创建/切换世界，不因保存 provider 而重置世界。
- 测试连接与自动降级在后台执行，不阻挡关闭；结果可在当前设置页简短显示，若已关闭则用自动消退通知告知，不自动重新弹出设置页。

### 步骤 7 · 统一代理与日志

- 一条服务端路由承接所有调用，前端永不直连第三方。
- 组装请求时按 provider 走对应适配器；超时默认 45 秒；仅对 429/5xx 重试 2 次（退避 1s / 3s）；`anthropic` 的 529（过载）也算可重试。
- 统一响应 `{ ok, data, error }`；`error` 里附 `provider`、HTTP 状态、简短原因（各家错误体结构不同，都要能捞出一句人话）。
- `runtime/logs/ai.log` 记：时间、用途、provider、model、估算 token、耗时、状态。**Key 一律 `***`**；gemini 的查询串形态要额外打码。

### 步骤 8 · 降级矩阵（一家不行怎么办）

| 情况 | 处理 |
|---|---|
| 当前 provider 探测失败 | 自动尝试其它**已配置**的 provider（按用户设的优先级），成功则以自动消退通知提示"已切到 X" |
| 全部失败 | 走零件 13 兜底（本地配方 → 预设），仅在创建界面状态行显示"离线配方"；游戏中最多发一次轻提示，不增加常驻徽章 |
| 模型不支持 JSON | 不报错，改"文本里抠 JSON"（零件 10） |
| 模型上下文太小（<4k） | 缩短 system prompt，去掉灵感例句，只留硬约束 |
| 中转站回显格式奇怪 | 适配器保留"最宽松路径"：找第一个含 `text`/`content` 的字段 |

### 步骤 9 · 安全

- Key 输入框 `autocomplete=off`，不参与前端持久化。
- 错误信息、日志、截图、`specs/*.json` 里**任何地方**都不得出现 Key。
- 代理路由做本地请求校验（同源 + 会话 cookie）。
- `secrets.json` 权限尽量收紧（Windows 上至少确保不在同步盘/公开目录）。
- 提供"一键清除全部 Key"，清 `secrets.json` 里的所有 `key` 字段并标记未配置。

### 步骤 10 · 自检（每家都要真跑一次）

对**至少四家**（openai 系一家、anthropic、gemini、deepseek 或 openrouter 或 ollama 任一）各做：

1. 填入 Key → 测试连接成功，显示模型名 + 延迟 + JSON 支持与否。
2. 用一个错误 Key → 失败文案可读（能看出是鉴权问题），无 Key 泄露。
3. 保存后刷新页面 → 仍是"已配置"，尾四位正确。
4. 清除 → 回"未配置"，创建界面的 AI 状态显示"离线配方"，默认 HUD 无新增徽章。
5. 全仓检索 Key 原文 → **零命中**（含 `runtime/logs/`、`specs/`、前端网络面板）。
6. 设置页聚焦 Key / Base URL 后按 WASD、空格、E，角色与相机不动；保存、取消及 Esc 关闭均回到原玩家位置、相机和 HUD，无粘键。
7. 默认游戏截图确认没有 Provider 表单或模型状态面板，只有显式打开设置后才出现。

截图存 `renders/app_step09_*.png`（至少：多 provider 列表、成功、失败、未配置、关闭设置后的原游戏画面）。

---

## 参数表

| 参数 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `ACTIVE_PROVIDER` | `openai` | 七选一 | |
| `AI_TIMEOUT_S` | 45 | 20~120 | |
| `AI_RETRY` | 2 | 0~4 | 仅 429/5xx/529 |
| `RETRY_BACKOFF` | 1s,3s | | |
| `MAX_OUTPUT_TOKENS` | 1600 | 512~4096 | 设定卡用 |
| `TEMP` | 0.9 | 0~1.5 | 想象力要热 |
| `ANTHROPIC_VERSION` | `2023-06-01` | | Claude 必填头 |
| `GEMINI_AUTH` | `header` | `header`/`query` | 优选 header |
| `PROBE_MAX_TOKENS` | 16 | 1~64 | |
| `LOG_KEY_MASK` | 强制 | | |
| `FALLBACK_ORDER` | 已配置者依次 | | 探测失败自动切 |

---

## 验收标准

1. 七个 provider 都能在非驻留设置页选中，默认地址与示例模型名正确。
2. 四家实测通过（各自鉴权方式正确，不出 401/403）。
3. 统一调用只暴露 `system / user / want_json / max_tokens / temperature`。
4. 三家响应文本都能正确捞出（含被截断标记）。
5. 多 provider 并存 + 自动降级生效（人为让主 provider 失败）。
6. Key 零泄露：日志、前端、specs 全检索。
7. 未配置时游戏与创建流程完全可用（离线配方），不强制停留在 provider 设置页。
8. 默认 HUD 无模型表单/徽章；设置输入不穿透，保存、取消与 Esc 关闭均恢复原玩家、相机和 HUD。
9. 五类截图已存，包括关闭设置后回到同一游戏画面的证据。

---

## 回退方案

- **某家接口改版**（例如 Gemini 换路径）：只改对应适配器，**不要**改动统一接口；在汇报里写明改了哪一段。
- **中转站连不上**（证书/自签）：不静默忽略，明确提示"证书校验失败"并给"允许本次不安全连接"的显式开关（默认关，需用户点）。
- **用户只有一条 Key 且不想选 provider**：加"自动识别"——按 Key 前缀猜（`sk-ant-` → anthropic、`AIza` → gemini、`sk-or-` → openrouter、`sk-` → openai/deepseek，其余走 custom），猜错允许手改。
- **Ollama 本地没起**：探测失败时提示"本地服务未启动"，不阻止其它 provider。
- **不想落盘**：仅本次会话模式，重启失效，UI 明确标注。
