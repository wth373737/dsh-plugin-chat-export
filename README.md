# dsh-plugin-chat-export

给 DeepSeek Harness 用的群聊导出插件：**按白名单读取即时消息**，归一化落盘，并用本地模型生成摘要。

强调两件事：

1. **同意由人做出，Agent 只能请求。** Agent 没有"批准"这个能力，只有"登记为待批准"。
2. **门禁跟着能力走。** 真正的读取通道（`bridge/tg_bridge.py`）自己去读策略库，只放行 `allow` 的会话——即使有人绕过插件直接调用它，也读不到未批准的内容。

## 能力

| 工具 | 作用 |
|---|---|
| `chat_list` | 列出会话（只有名称与 id，永远不含消息内容） |
| `chat_fetch` | 按时间窗拉取白名单会话，归一化后追加写入 `messages.jsonl`（增量、按 `msg_id` 去重） |
| `chat_digest` | 生成摘要：重要通知**原文照抄**并带 `msg_id`，链接由代码提取，概要与提问由本地模型生成 |
| `chat_policy` | 读名单 / 加入黑名单 / 移除；**批准被禁用**（返回 `ui-only`） |
| `chat_login` | 生成一次性登录启动脚本（凭据写在脚本里，不进命令行与历史） |

用户侧命令（只有人能执行）：

- `/chat-approve <key>` 加入白名单
- `/chat-deny <key>` 加入黑名单
- `/chat-pending` 列出待批准

设置页（`设置 → 群聊导出`）提供同样的操作，外加导出根目录的即时修改。

## 门禁模型

```
chat_fetch(未知会话)  → 登记 pending，返回「待批准」，不读任何内容
用户批准（命令或页面） → 策略库 allow
chat_fetch(已批准)     → bridge → 归一化 → messages.jsonl
```

- 黑名单会话：**不发起任何请求**（不是"拉了再丢弃"）
- 证据链：`policy.json` 里有 `audit`，记录每次放行/拒绝/待批准
- 三道旁路拦截：直调导出通道、读凭据文件、直写策略库

## 安装

```bash
git clone https://github.com/wth373737/dsh-plugin-chat-export.git
```

然后在 Harness 里用插件管理器安装这个目录（bundle 的 `cordis.patch.yml` 会插入入口），或：

```
plugin_manager(action: "install_bundle", target: "<绝对路径>/dsh-plugin-chat-export")
```

### Python 侧依赖

`bridge/tg_bridge.py` 只需要 [Telethon](https://github.com/LonamiWebs/Telethon)。建议装在独立 venv 里，避免污染系统 Python：

```powershell
uv venv E:\venv-tg --python C:\Python314\python.exe
uv pip install --python E:\venv-tg\Scripts\python.exe telethon
```

插件会自动探测 `../venv-tg/Scripts/python.exe`（即与插件目录同级的 `venv-tg`），也可以在设置里显式指定 `pythonPath`。

## 首次配置

1. 在 [my.telegram.org](https://my.telegram.org) 建一个应用，拿到 `api_id` 与 `api_hash`。
2. 二选一：
   - 设置页填 `tgApiId` / `tgApiHash`（secret 字段，界面上只显示"已设置/未设置"）；
   - 或写入 `<插件数据目录>/credentials.json`：`{"api_id": 123456, "api_hash": "..."}`
3. 调用 `chat_login`，它会在数据目录生成 `login.cmd`；在终端运行它，按提示输入手机号与验证码。
4. `chat_list` 验证：能列出会话就说明打通了。

插件数据目录默认是 `<DSH_HOME>/plugin-data/chat-export/`，里面有 `policy.json`、`settings.json`、会话文件与导出目录。

## 摘要产物

`<导出根目录>/<群名>/digest-YYYY-MM-DD.md`：

```markdown
## 重要通知（原句照抄，未改写）
- [msg 60 · 2026-11-12T07:37] G.C.Sodhy: ...Test 1 will now start at 4.30pm in Exam Hall 1.

## 链接（代码提取）
- [msg 548] https://example.com/meet/room

## 概要（模型生成，请结合上方原文核对）

## 可能有待确认（未逐条核实；附原文出处）
- [msg 543 · ...] Mohammad: Does the course take tomorrow place?
```

三段内容的可信度不同，插件在文件里就写明了：

- **重要通知**：模型挑句，但代码校验"该句必须原样存在于原文"，不匹配即丢弃并计数
- **链接**：正则提取，模型不参与
- **概要与提问**：本地模型生成；提问部分强制附 `msg_id`，标为"未逐条核实"

## 定时

用 task board 的定时卡片驱动（不用自建守护进程）：每天 09:00 触发一次
`chat_list → chat_fetch(days=1) → chat_digest(hours=24)`。

## 已知限制

- v1 只支持 Telegram。QQ 的官方导出在 NT 版已移除，WhatsApp 无法回溯历史，都不在范围内。
- 摘要在小样本上表现一般；7B 模型的问答配对能力有限（已用"未核实 + 附出处"规避，而不是假装准确）。
- 定时卡片里"逐个群拉取"是 Agent 循环调用工具；白名单变长后应改为一次性的批量同步。
- 门禁的字符串规则是**威慑与防手滑**，不是密码学边界；硬边界是"凭据不进模型可见面"与"数据在源头过滤"。

## License

MIT
