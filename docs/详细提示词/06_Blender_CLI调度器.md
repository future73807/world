# 06 · Blender CLI 调度器

> **一句话**：网页里的一次点击，变成后台一条 `blender -b`；它的每一行日志、退出码、产物，都要回到网页。

---

## 前置

零件 05（队列就绪）。

---

## 提示词正文

你是**发射台**。你不管世界长什么样，只管把命令正确发射出去、把回执完整带回来。

### 步骤 1 · 规格

调度器接收一个作业描述：`kind`、`script`（要喂给 Blender 的 .py 路径，必须在 `world/scripts/` 内）、`args`（数组，透传给脚本，用于 `--` 之后）、`out_blend`（产物路径）、`timeout_s`。

拼出的真实命令形态（按此语义，不要求逐字）：

`可执行 blender 后台模式 + 打开指定 .blend + 执行 python 脚本 + 脚本参数 + 环境变量 PYTHONUNBUFFERED`

**Windows 注意**：可执行名可能是 `blender.exe` 或 `blender`，先探一次缓存结果；路径一律用引号安全封装（不是字符串拼接，用参数数组）。

### 步骤 2 · 环境变量

给子进程注入：

- `MIST_SEED`（本环 seed）
- `MIST_RING`（环号）
- `MIST_SPEC`（设定卡绝对路径）
- `MIST_STATE`（状态文件绝对路径）
- `MIST_OUT`（产物 .blend 绝对路径）
- `PYTHONUNBUFFERED=1`

脚本只从这些环境变量读输入，避免命令行拼接的引号地狱。

### 步骤 3 · 日志落盘

子进程 stdout/stderr 同时写两处：内存环形缓冲（给网页实时看）与 `runtime/logs/{job_id}.log`（给排查）。日志每行前缀 `[out]` / `[err]`。

### 步骤 4 · 退出解读

| 退出码 | 含义 | 处理 |
|---|---|---|
| 0 | 成功 | 校验产物存在且大小 > 0 才标 `succeeded` |
| 1 | 脚本异常 | 标 `failed`，抓最后 20 行 + `Traceback` 行 |
| 2 | 参数错误 | `failed`，提示"脚本参数与环境变量不匹配" |
| 超时 | 卡死 | 先软中断，10 秒后强杀，标 `failed`，`error_tail` 写"超时" |
| 其他 | 崩溃 | `failed`，保留完整日志路径 |

**关键**：退出码 0 但产物不存在，也判 `failed`——Blender 有些错误会以 0 退出但什么都没写。

### 步骤 5 · 进度解析

读 stdout 行，认 `@@PROGRESS` 前缀（格式见契约 I），解析出 stage/percent/message，转成 `job.progress` 事件。解析失败不打断，只忽略。

### 步骤 6 · 一个"测试作业"

提供一个 `test` 作业：喂一个极小的 .py 给 Blender，它只打印 3 行 `@@PROGRESS` 和一行 `@@DONE`，不建任何东西，正常存一个空 .blend 到 `runtime/jobs/test_out.blend`。

点它，网页应看到：CLI 滚日志 → 进度条动 → 弹通知。

### 步骤 7 · 安全

- `script` 路径必须解析到 `world/scripts/` 之内（前缀校验）。
- 产物路径必须解析到项目根之内。
- 不把任何 API Key 注入子进程环境（世界生成不需要）。
- 子进程工作目录固定为项目根。

### 步骤 8 · 作为拓荒的执行臂

调度器不自己决定拓荒，但它必须**被拓荒状态机调用**。零件 30 的跨进程桥读到的请求，最终落到调度器这里：`kind=ringgen` + 环境变量。所以：

- 调度器开工前，先把 `runtime/world_state.json` 的 `fsm` 置 `generating`、`pending_ring` 置本次环号（改动由状态机做，调度器只读）。
- 调度器结束（成功或失败）时，确保对应的 `job.*` 事件已经写完，状态机据此写 `unlock_result.json`。

不要让调度器自己去轮询 request 文件——那会让它同时是"执行者"和"调度者"。

---

## 参数表

| 参数 | 默认 | 说明 |
|---|---|---|
| `BLENDER_BIN` | 自动探测 | 允许用户在网页设置里覆盖 |
| `DEFAULT_TIMEOUT_S` | 900 | |
| `SOFT_KILL_FIRST` | 是 | 先请求退出再强杀 |
| `LOG_TAIL_LINES` | 20 | 失败时保留 |
| `RING_BUFFER` | 3000 | 实时缓冲行数 |

---

## 验收标准

1. 点「测试作业」：页面看到分段滚动的日志（不是一次性），进度条到 100，弹成功通知。
2. `runtime/logs/{job_id}.log` 存在，`[out]` 行齐全。
3. 人为改脚本路径到 `world/scripts/../evil.py`，应被拒。
4. 人为让脚本抛异常：作业 `failed`，`error_tail` 含 Traceback。
5. 人为让脚本 exit 0 但不写产物：判 `failed`，文案"产物缺失"。
6. 截图 + 日志路径已记录。

---

## 回退方案

- **`blender` 不在 PATH**：网页设置里允许填绝对路径；同时尝试 `C:\Program Files\Blender Foundation\Blender *\blender.exe` 通配探测，只探测不改。
- **Windows 控制台编码乱码**：子进程输出按 UTF-8 解码，失败则回退系统编码；日志文件始终写 UTF-8。
- **杀不干净**：用进程组/任务树终止；仍残留则在日志里列 PID 清单。
