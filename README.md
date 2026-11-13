# dsh-plugin-chat-export

给 DeepSeek Harness 用的群聊导出插件：**按白名单读取即时消息**，归一化落盘，并用本地模型生成摘要。
目前支持 **Telegram**（向服务器拉取）和 **WhatsApp**（导入官方导出文件 / 从 WhatsApp Web 抓取）。

三条设计原则：

1. **同意由人做出，Agent 只能请求。** Agent 没有"批准"这个能力，只有"登记为待批准"。
2. **门禁跟着能力走。** Telegram 的读取通道（`bridge/tg_bridge.py`）自己读策略库，只放行 `allow` 的会话——绕过插件直接调用它也读不到未批准的内容。
3. **不确定就说不确定。** 摘要里哪些是原文、哪些是模型生成、覆盖是否完整，文件里都写明。

## 工具

| 工具 | 作用 |
|---|---|
| `chat_list` | 列出会话（只有名称与 id，永不含消息内容） |
| `chat_fetch` | Telegram：按时间窗拉取并归一化落盘（增量、按 `msg_id` 去重） |
| `chat_import` | WhatsApp：导入导出文件（`.json` / `.zip` / `.txt`），默认扫描收件箱 |
| `wa_open` / `wa_close` | 启动 / 关闭一个独立的持久 Chrome（WhatsApp Web） |
| `wa_probe` / `wa_chat_probe` | 侦察页面结构（只报标签与属性，不回正文），用于校准抓取器 |
| `wa_sync` | WhatsApp Web：按时间水位向上加载并抓取消息（含时间戳），写入同一份存储 |
| `chat_digest` | 生成摘要：重要通知**原文照抄** + 链接由代码提取 + 模型写概要 |
| `chat_policy` | 读名单 / 加黑名单 / 移除；**批准被禁用**（返回 `ui-only`） |
| `chat_login` | Telegram：生成一次性登录启动脚本 |

用户侧命令（只有人能执行）：`/chat-approve`、`/chat-deny`、`/chat-pending`。
设置页（`设置 → 群聊导出`）提供同样的操作，外加导出根目录与 WhatsApp 收件箱的即时修改。

## 门禁模型

```
未批准会话  → 登记 pending，返回「待批准」，不读任何内容
用户批准    → 策略库 allow（命令或页面，Agent 无从调用）
已批准会话  → 正常读取 → 归一化 → messages.jsonl
```

黑名单会话**不发起任何请求**；`policy.json` 里有 `audit` 记录每次放行/拒绝/待批准。
另有三条旁路拦截：直调导出通道、读凭据文件、直写策略库。

> 说明：字符串规则是**威慑与防手滑**，不是密码学边界；硬边界是"凭据不进模型可见面"与"数据在源头过滤"。

## Telegram

1. `my.telegram.org` 建应用，拿 `api_id` / `api_hash`。
2. 二选一：设置页填 secret 字段，或写入 `<插件数据目录>/credentials.json`（`{"api_id":123,"api_hash":"…"}`）。
3. 调 `chat_login` 生成 `login.cmd`，在终端运行完成扫码/验证码登录。
4. `chat_list` 验证，然后 `/chat-approve <key>` 批准要读的会话。

需要 Python + [Telethon](https://github.com/LonamiWebs/Telethon)（建议独立 venv）：

```powershell
uv venv E:\venv-tg --python C:\Python314\python.exe
uv pip install --python E:\venv-tg\Scripts\python.exe telethon
```

插件会自动探测与插件目录同级的 `venv-tg`，也可在设置里指定 `pythonPath`。

## WhatsApp

**桌面端没有导出功能**（只有手机端有），所以走两条路：

### A. 导入导出文件（简单、无风险）

浏览器扩展（例如 IS Chat Exporter）可以把 WhatsApp Web 的对话导出成 JSON。把文件放进收件箱，然后：

```
chat_import                     # 扫描收件箱
chat_import { path: "…json" }   # 只导入指定文件
```

支持 `.json`、`.zip`（`_chat.txt`）、`.txt`。重复导入按内容指纹去重；导出文件里常**没有时间戳**，此时摘要按"快照"处理。

### B. 从 WhatsApp Web 抓取（能拿到时间戳）

`wa_open` 启动一个独立 Chrome（独立 profile，不影响日常浏览器），首次扫码登录后登录态会保留。之后：

```
wa_sync { chat: "群名", hours: 24, scrolls: 10 }
```

它按**时间水位**滚动：一直加载更早的消息，直到最旧一条早于目标时间（默认 24 小时）或用完滚动预算，然后如实回报 `complete` / `stopped` / `covered_from`。不完整会在 `sync-state.json` 与返回值里明确标出。

WhatsApp 的重消息是：**只有文本气泡带 `data-pre-plain-text`**（时间与发送者），图片与系统提示拿不到时间，所以时间戳覆盖率取决于可见窗口里有多少文本气泡。

## 摘要产物

`<导出根目录>/<群名>/digest-YYYY-MM-DD.md`：

```markdown
## 重要通知（原句照抄，未改写）
- [msg 60 · 2026-11-12T07:37] G.C.Sodhy: ...Test 1 will now start at 4.30pm in Exam Hall 1.

## 链接（代码提取）
- [msg 548] https://example.com/meet/room

## 概要（模型生成，请结合上方原文核对）

## 可能有待确认（未逐条核实；附原文出处）
- [uid 5b7566e2] …: Does the course take tomorrow place?
```

三段内容的可信度不同，文件里写明：

- **重要通知**：模型挑句，但代码校验"该句必须原样存在于原文"，不匹配即丢弃并计数
- **链接**：正则提取，模型不参与
- **概要与提问**：本地模型生成；提问强制附出处，标为"未逐条核实"

时间模式有三种，头部会写明：`window`（都有时间戳）、`snapshot`（都没有，按导入顺序）、`mixed`（部分有，无法定时的行未按时间过滤）。

## 定时

用 task board 的定时卡片驱动（不自建守护进程）。每天固定时间按平台取数，最后统一出摘要：

- Telegram：`chat_list → chat_fetch(days=1)`（逐群，或按需扩成批量）
- WhatsApp：`chat_import`（扫收件箱）与/或 `wa_sync(hours=24)`，看用的是哪条通路
- 收尾：`chat_digest(hours=24)`，失败项照实报告，不要重试刷屏

WhatsApp 的 `wa_sync` 依赖那个持久 Chrome 处于登录态；Chrome 没开或掉登录时，卡片应当报错而不是静默产出空摘要。

## 目录结构

```
index.js                    工具定义、页面接口、命令、guard、装配
lib/schema.js               从宿主 profile 解析 schemastery（本地 bundle 必需）
lib/adapters/whatsapp.mjs   导出文件解析与归一化（纯函数，不依赖其它平台）
lib/adapters/whatsapp-web.mjs  持久 Chrome、打开会话、侦察、抓取
bridge/tg_bridge.py         Telegram 通道（Telethon），自带策略校验
client.js                   设置页（settings.section）
```

## 已知限制

- **滚动加载历史未验证**：用真实滚轮事件驱动 WhatsApp 虚拟列表时会触发 CDP 输入超时。时间水位逻辑本身正确，但"第一屏被垃圾消息占满"的场景还没有实证。
- WhatsApp 会话的身份就是**群名**（导出与抓取都没有稳定 id），群改名会变成新会话。
- 抓取只覆盖文本气泡；图片/系统提示没有时间戳。
- 摘要质量受本地模型限制；7B 常改写通知原句（会被校验丢弃），块过大时会吐畸形 JSON（已用较小分块 + 失败对半重试缓解）。
- v1 只做 Telegram 与 WhatsApp。QQ 的官方导出在 NT 版已移除；微信同理，都不在范围内。

## License

MIT
