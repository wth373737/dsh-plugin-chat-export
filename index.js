/**
 * Chat Export —— 群聊导出插件（Host half）
 *
 * 不变量：磁盘上永远不存在未获许可的会话内容。
 * 门禁由插件自身完成，不依赖 Agent 自觉，也不依赖 tools/pre-execute 的判断。
 * guard 只负责堵住"绕过插件直调通道"与"读凭据/改策略库"这两类旁路。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { loadSchemastery } from './lib/schema.js'
import { chatNameFromFile, fingerprint, parseChatText, parseJsonExport, parsePrePlain, slugOfName } from './lib/adapters/whatsapp.mjs'
import { closeSession, openChatByName, openSession, probeDom, probeMessages, scrapeRows, screenshot, scrollStep, sessionState, sessionStatus, waitForMessages } from './lib/adapters/whatsapp-web.mjs'

export const inject = ['tools', 'commands', 'webServer', 'settings']

const execFileAsync = promisify(execFile)

const SCHEMA = await loadSchemastery()

function buildConfig(Schema) {
  return Schema.object({
    outputRoot: Schema.string()
      .default('')
      .description('导出根目录。留空则使用 <DSH_HOME>/plugin-data/chat-export/export。'),
    mirrorRoot: Schema.string()
      .default('')
      .description('可选的第二落点：产物同时镜像到此目录，方便知识库或笔记工具直接读取。留空不镜像。'),
    defaultDays: Schema.number().default(7).description('chat_fetch 未指定窗口时默认回溯的天数。'),
    mediaPolicy: Schema.union(['record-only', 'download'])
      .default('record-only')
      .description('record-only 只记录附件位置与 id，需要时再补下；download 导出时同时下载媒体文件。'),
    digestModel: Schema.string().default('qwen2.5:7b').description('生成摘要所用的本地 Ollama 模型 tag。'),
    ollamaUrl: Schema.string().default('http://127.0.0.1:11434').description('本地 Ollama 地址。'),
    waInbox: Schema.string().default('').description('WhatsApp 导出文件的收件箱目录。留空则用数据目录下的 wa-inbox，也可在设置页里改。'),
    waChrome: Schema.string().default('').description('用于 WhatsApp Web 的 Chrome 可执行文件路径。留空则用系统默认路径。'),
    waProfile: Schema.string().default('').description('持久 Chrome profile 目录（保存 WhatsApp Web 登录态）。留空则用数据目录下的 wa-profile。'),
    digestConcurrency: Schema.number()
      .default(2)
      .description('摘要并发的本地模型请求数。受本机资源预算约束，默认 2，不建议调高。'),
    requestDelay: Schema.number().default(1.5).description('两次请求之间的间隔秒数，用来避开平台限流。'),
    maxMessagesPerFetch: Schema.number().default(5000).description('单次拉取的消息上限；超出时按时间窗分批。'),
    pythonPath: Schema.string()
      .default('')
      .description('运行 Telegram bridge 的解释器。留空则自动探测 uv 隔离环境，再退回系统 Python。'),
    tgApiId: Schema.string()
      .role('secret')
      .description('Telegram api_id（my.telegram.org 获取）。在设置页填写，不要贴在会话里。'),
    tgApiHash: Schema.string()
      .role('secret')
      .description('Telegram api_hash。在设置页填写，不要贴在会话里。'),
    tgSessionPath: Schema.string()
      .default('')
      .description('复用自己的 Telethon 会话文件路径。留空则在插件数据目录自建会话。'),
  })
}

export const Config = SCHEMA ? buildConfig(SCHEMA) : undefined

/* ------------------------------------------------------------------ 路径 */

export function dshHome() {
  return process.env.DSH_HOME || process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh')
}

export function stateDir() {
  return join(dshHome(), 'plugin-data', 'chat-export')
}

export function policyPath() {
  return join(stateDir(), 'policy.json')
}

function overridesFile() {
  return join(stateDir(), 'settings.json')
}

export function readOverrides() {
  try {
    const file = overridesFile()
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch {
    // 覆盖文件坏了就当作没有覆盖。
  }
  return {}
}

function writeOverrides(patch) {
  const next = { ...readOverrides(), ...patch }
  const file = overridesFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * 导出根目录的优先级：Config 字段（设置层/配置文件） > 插件自有覆盖文件 > 默认目录。
 * 覆盖文件让页面可以即时保存，且不必为改一个路径而让整个插件重载。
 */
export function outputRootOf(cfg) {
  const configured = typeof cfg?.outputRoot === 'string' ? cfg.outputRoot.trim() : ''
  if (configured.length > 0) return configured
  const stored = String(readOverrides().outputRoot ?? '').trim()
  if (stored.length > 0) return stored
  return join(stateDir(), 'export')
}

/**
 * 凭据来源：优先 Config 里的 secret 字段（设置页/配置层），
 * 其次插件数据目录下的 credentials.json —— 后者让人可以在"设置页还没做"时
 * 直接建文件填入，密码不进会话、不进命令历史。
 */
export function credentialsOf(cfg) {
  const direct = { apiId: String(cfg?.tgApiId ?? '').trim(), apiHash: String(cfg?.tgApiHash ?? '').trim() }
  if (direct.apiId.length > 0 && direct.apiHash.length > 0) return direct
  try {
    const file = join(stateDir(), 'credentials.json')
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      const apiId = String(parsed?.api_id ?? '').trim()
      const apiHash = String(parsed?.api_hash ?? '').trim()
      if (apiId.length > 0 && apiHash.length > 0) return { apiId, apiHash }
    }
  } catch {
    // 文件坏了就当作没有凭据，别静默放行。
  }
  return direct
}
export function sessionFileOf(cfg) {
  const explicit = typeof cfg?.tgSessionPath === 'string' ? cfg.tgSessionPath.trim() : ''
  return explicit.length > 0 ? explicit : join(stateDir(), 'tg')
}
function bridgeScriptPath() {
  return fileURLToPath(new URL('./bridge/tg_bridge.py', import.meta.url))
}

function slugOf(text) {
  const cleaned = String(text ?? '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned.slice(0, 80) || 'chat'
}

export function pythonOf(cfg) {
  const configured = typeof cfg?.pythonPath === 'string' ? cfg.pythonPath.trim() : ''
  if (configured.length > 0) return configured

  const localAppData = process.env.LOCALAPPDATA
  const candidates = []
  if (localAppData) {
    candidates.push(join(localAppData, 'uv', 'tools', 'telegram-download-chat', 'Scripts', 'python.exe'))
  }
  try {
    candidates.push(fileURLToPath(new URL('../venv-tg/Scripts/python.exe', import.meta.url)))
  } catch {}
  candidates.push('C:\\Python314\\python.exe', 'C:\\Python313\\python.exe', 'C:\\Python312\\python.exe')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'python'
}

/* ------------------------------------------------------------------ 策略库 */

function emptyPolicy() {
  return { version: 1, chats: {}, audit: [] }
}

export function loadPolicy() {
  const file = policyPath()
  if (!existsSync(file)) return emptyPolicy()
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (!parsed || typeof parsed !== 'object') return emptyPolicy()
    return {
      version: 1,
      chats: parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {},
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
    }
  } catch {
    // 策略库损坏时按空库处理：宁可多问一次，也不能静默放行。
    return emptyPolicy()
  }
}

export function savePolicy(policy) {
  const file = policyPath()
  mkdirSync(dirname(file), { recursive: true })
  const text = `${JSON.stringify(policy, null, 2)}\n`
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, text, 'utf8')
  try {
    renameSync(temp, file)
  } catch {
    writeFileSync(file, text, 'utf8')
  }
}

function record(policy, entry) {
  policy.audit.push({ at: new Date().toISOString(), ...entry })
  if (policy.audit.length > 500) policy.audit.splice(0, policy.audit.length - 500)
}

function auditDenied(kind, detail) {
  try {
    const policy = loadPolicy()
    record(policy, { op: 'guard-deny', chat: detail, result: kind })
    savePolicy(policy)
  } catch {
    // 审计失败不能影响门禁本身。
  }
}

export function keyOf(platform, id) {
  return `${platform}:${id}`
}

export function splitKey(key) {
  const at = key.indexOf(':')
  return at < 0 ? ['telegram', key] : [key.slice(0, at), key.slice(at + 1)]
}

export function resolveChat(policy, query) {
  const q = String(query ?? '').trim()
  if (q.length === 0) return { error: '缺少 chat 参数' }
  const chats = policy.chats
  if (chats[q]) return { key: q, entry: chats[q] }

  const keys = Object.keys(chats)
  const byId = keys.filter((key) => String(chats[key].id ?? '') === q)
  if (byId.length === 1) return { key: byId[0], entry: chats[byId[0]] }

  const lower = q.toLowerCase()
  const byName = keys.filter((key) => String(chats[key].name ?? '').toLowerCase() === lower)
  if (byName.length === 1) return { key: byName[0], entry: chats[byName[0]] }

  const fuzzy = keys.filter((key) => String(chats[key].name ?? '').toLowerCase().includes(lower))
  if (fuzzy.length === 1) return { key: fuzzy[0], entry: chats[fuzzy[0]] }
  if (fuzzy.length > 1) {
    return {
      error: `「${q}」匹配到多个会话，请改用会话 key 精确指定`,
      candidates: fuzzy.map((key) => ({ key, name: chats[key].name ?? '' })),
    }
  }
  return { error: `名单里没有「${q}」` }
}

export function decide(policy, query, decision, source, displayName) {
  const found = resolveChat(policy, query)
  const at = new Date().toISOString()
  if (!found.error) {
    found.entry.decision = decision
    found.entry.decided_at = at
    found.entry.decided_by = source
    if (displayName && !found.entry.name) found.entry.name = displayName
    return { key: found.key, created: false }
  }
  if (found.candidates) {
    const list = found.candidates.map((item) => `${item.key} (${item.name})`).join('、')
    throw new Error(`chat_policy: ${found.error}：${list}`)
  }
  const raw = String(query).trim()
  const [platform, id] = [normalizePlatform(splitKey(raw)[0]), splitKey(raw)[1]]
  const key = keyOf(platform, id)
  policy.chats[key] = {
    platform,
    id,
    name: displayName ?? '',
    decision,
    decided_at: at,
    decided_by: source,
    cursor: { msg_id: 0, ts: null },
  }
  return { key, created: true }
}

/* ------------------------------------------------------------------ 询问 */

/* ------------------------------------------------------------------ bridge */

async function callBridge(cfg, argv, exec) {
  const script = bridgeScriptPath()
  if (!existsSync(script)) {
    throw new Error(
      `chat_export: bridge 尚未安装（缺少 ${script}）。真实读取要等 P2 的 tg_bridge.py；当前只能验证门禁。`,
    )
  }
  const python = pythonOf(cfg)
  // 全局选项必须排在子命令之前，否则 argparse 视为未知参数并以退出码 2 结束。
  const args = [script, '--json', '--delay', String(cfg.requestDelay ?? 1.5), ...argv]
  try {
    const { stdout } = await execFileAsync(python, args, {
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      signal: exec?.signal,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        TG_API_ID: credentialsOf(cfg).apiId,
        TG_API_HASH: credentialsOf(cfg).apiHash,
        TG_SESSION: sessionFileOf(cfg),
        CHAT_EXPORT_POLICY: policyPath(),
      },
    })
    const trimmed = String(stdout ?? '').trim()
    if (trimmed.length === 0) throw new Error('bridge 没有返回内容')
    return JSON.parse(trimmed)
  } catch (error) {
    const code = error?.code
    if (code === 2) {
      const usage = String(error?.stderr ?? error?.stdout ?? '').slice(0, 300)
      throw new Error(`chat_export: bridge 命令行参数被拒绝（argparse exit 2）。${usage}`)
    }
    if (code === 7) {
      const raw = String(error?.stdout ?? '').slice(0, 300)
      throw new Error(`chat_export: Telegram 未登录（exit 7）。${raw}`)
    }
    if (code === 3) throw new Error(`chat_export: bridge 配置错误。${String(error?.stdout ?? '').slice(0, 400)} ${String(error?.stderr ?? '').slice(0, 400)}`)
    const stderr = String(error?.stderr ?? error?.message ?? error)
    throw new Error(`chat_export: bridge 调用失败（${python}）。${stderr.slice(0, 600)}`)
  }
}

/* ------------------------------------------------------------------ 工具 */

function policySnapshot(policy, cfg) {
  const chats = Object.entries(policy.chats).map(([key, entry]) => ({
    key,
    platform: entry.platform ?? splitKey(key)[0],
    id: entry.id ?? splitKey(key)[1],
    name: entry.name ?? '',
    decision: entry.decision ?? 'pending',
    decided_at: entry.decided_at ?? null,
    decided_by: entry.decided_by ?? null,
    cursor_msg_id: entry.cursor?.msg_id ?? 0,
  }))
  return {
    output_root: outputRootOf(cfg),
    policy_file: policyPath(),
    counts: {
      allow: chats.filter((item) => item.decision === 'allow').length,
      deny: chats.filter((item) => item.decision === 'deny').length,
      pending: chats.filter((item) => item.decision === 'pending').length,
    },
    chats,
  }
}

function renderPolicy(value) {
  if (Array.isArray(value.audit)) {
    if (value.audit.length === 0) return '审计记录为空。'
    return value.audit
      .map((item) => `- ${item.at} · ${item.op ?? ''} · ${item.chat ?? ''} · ${item.result ?? ''}`)
      .join('\n')
  }
  if (value && value.status === 'ui-only') {
    return String(value.message ?? '该操作只能由你本人在插件页面完成。')
  }
  if (!value || typeof value.counts !== 'object') {
    value = { ...value, counts: { allow: 0, deny: 0, pending: 0 }, chats: [] }
  }
  const head = `名单：允许 ${value.counts.allow} · 拒绝 ${value.counts.deny} · 待定 ${value.counts.pending}\n导出根目录：${value.output_root}\n策略文件：${value.policy_file}`
  if (!Array.isArray(value.chats) || value.chats.length === 0) {
    return `${head}\n\n（名单为空。任何会话在被问到并批准之前都不会被读取。）`
  }
  const rows = value.chats.map(
    (item) => `| ${item.name || '(未命名)'} | \`${item.key}\` | ${item.decision} | ${item.decided_by ?? '-'} |`,
  )
  return [head, '', '| 会话 | key | 决定 | 来源 |', '|---|---|---|---|', ...rows].join('\n')
}

function policyTool(ctx, cfg) {
  return {
    name: 'chat_policy',
    description:
      '读取或修改群聊读取名单（白名单/黑名单），查看待定会话与审计记录。这是本插件唯一的策略入口，导出门禁依据同一份数据。未列入名单的会话属于灰区，只有在第一次尝试读取时才会向用户询问。',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['list', 'allow', 'deny', 'pending', 'reset', 'audit'],
          description: 'list=全部名单；allow=加入白名单；deny=加入黑名单；pending=待定会话；reset=从名单移除；audit=审计记录。',
        },
        chat: {
          type: 'string',
          description: '会话 key（platform:id，例如 tg:-1001234567890）或会话名。allow/deny/reset 需要。',
        },
        name: { type: 'string', description: '可选：新增会话时记录显示名，便于以后按名字指定。' },
        limit: { type: 'integer', description: 'audit 返回条数，默认 20。' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderPolicy(value) }],
    },
    async execute(args) {
      const op = String(args?.op ?? 'list')
      const policy = loadPolicy()

      if (op === 'list') return { ok: true, op, ...policySnapshot(policy, cfg) }

      if (op === 'allow') {
        return {
          ok: false,
          op,
          status: 'ui-only',
          chat: args?.chat ?? null,
          message: '批准只能在「群聊导出」页面完成。Agent 没有批准权限；请把会话留作待批准，由用户在页面上决定。',
        }
      }

      if (op === 'deny') {
        const raw = String(args?.chat ?? '').trim()
        if (raw.length === 0) throw new Error('chat_policy: deny 需要 chat（会话 key 或会话名）')
        const applied = decide(policy, raw, 'deny', 'user-tool', args?.name)
        record(policy, { op, chat: applied.key, result: 'deny' })
        savePolicy(policy)
        return { ok: true, op, chat: applied.key, decision: 'deny', created: applied.created, ...policySnapshot(policy, cfg) }
      }
      if (op === 'reset') {
        const raw = String(args?.chat ?? '').trim()
        if (raw.length === 0) throw new Error('chat_policy: reset 需要 chat')
        const found = resolveChat(policy, raw)
        if (found.error) throw new Error(`chat_policy: ${found.error}`)
        delete policy.chats[found.key]
        record(policy, { op, chat: found.key, result: 'removed' })
        savePolicy(policy)
        return { ok: true, op, chat: found.key, ...policySnapshot(policy, cfg) }
      }

      if (op === 'pending') {
        const all = policySnapshot(policy, cfg)
        return { ok: true, op, ...all, chats: all.chats.filter((item) => item.decision === 'pending') }
      }

      if (op === 'audit') {
        const limit = Math.max(1, Math.min(200, Number(args?.limit) || 20))
        return { ok: true, op, audit: policy.audit.slice(-limit), total: policy.audit.length }
      }

      throw new Error(`chat_policy: 未知 op ${JSON.stringify(op)}`)
    },
  }
}

function listTool(ctx, cfg) {
  return {
    name: 'chat_list',
    description:
      '列出 Telegram 里的会话（只返回名称与 id，永不返回消息内容），并标出每个会话当前的许可状态：allow / deny / ask（灰区）。这是发现新群、把灰区变成明确许可的入口。',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: '保留参数，恒为拉取最新列表。' },
        limit: { type: 'integer', description: '返回多少条（按最近活跃排序），默认 40，上限 500。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!Array.isArray(value.chats)) return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        const rows = value.chats.map((item) => `| ${item.name || '(未命名)'} | \`${item.id}\` | ${item.policy} |`)
        return [
          {
            type: 'text',
            text: [
              `会话共 ${value.total ?? value.chats.length} 个，显示最近 ${value.chats.length} 个（仅名称，不含任何消息内容）`,
              '',
              '| 会话 | id | 许可 |',
              '|---|---|---|',
              ...rows,
            ].join('\n'),
          },
        ]
      },
    },
    async execute(args, exec) {
      const dialogs = await callBridge(cfg, ['dialogs'], exec)
      const list = Array.isArray(dialogs?.chats) ? dialogs.chats : Array.isArray(dialogs) ? dialogs : []
      const policy = loadPolicy()
      const mapped = list.map((item) => {
        const key = keyOf('tg', String(item.id))
        const entry = policy.chats[key]
        return {
          id: String(item.id),
          name: String(item.name ?? ''),
          kind: String(item.kind ?? ''),
          last_ts: item.last_ts ?? null,
          policy: entry?.decision === 'allow' ? 'allow' : entry?.decision === 'deny' ? 'deny' : 'ask',
        }
      })
      mapped.sort((a, b) => String(b.last_ts ?? '').localeCompare(String(a.last_ts ?? '')))
      // 导入式平台的会话不来自通道，而来自策略库本身；否则批准过的 WhatsApp 群不会出现。
      for (const [key, entry] of Object.entries(policy.chats)) {
        if (normalizePlatform(entry?.platform ?? splitKey(key)[0]) === "tg") continue
        mapped.push({
          id: String(entry?.id ?? splitKey(key)[1]),
          name: String(entry?.name ?? ""),
          kind: "import",
          last_ts: entry?.cursor?.ts ?? null,
          policy: entry?.decision === "allow" ? "allow" : entry?.decision === "deny" ? "deny" : "ask",
        })
      }
      const limit = Math.max(1, Math.min(500, Number(args?.limit) || 40))
      const chats = mapped.slice(0, limit)
      return {
        ok: true,
        chats,
        total: mapped.length,
        hidden: Math.max(0, mapped.length - chats.length),
        counts: {
          total: mapped.length,
          shown: chats.length,
          ask: mapped.filter((c) => c.policy === 'ask').length,
          allow: mapped.filter((c) => c.policy === 'allow').length,
          deny: mapped.filter((c) => c.policy === 'deny').length,
        },
      }
    },
  }
}

function fetchTool(ctx, cfg) {
  return {
    name: 'chat_fetch',
    description:
      '按白名单读取某个群聊在给定时间窗内的消息，归一化后追加落盘为 messages.jsonl，返回统计。灰区会话只会登记为待批准，不会读取任何内容；批准动作仅在插件页面完成。黑名单会话不会发起任何请求。',
    parameters: {
      type: 'object',
      properties: {
        chat: {
          type: 'string',
          description: '会话 key（tg:<id>）或会话名。灰区会话也可以直接给名字，插件会先问用户再解析 id。',
        },
        days: { type: 'integer', description: '回溯天数，默认取设置里的 defaultDays。' },
        since: { type: 'string', description: '起始时间（ISO 或 YYYY-MM-DD），优先于 days。' },
        until: { type: 'string', description: '结束时间（ISO 或 YYYY-MM-DD）。' },
        max: { type: 'integer', description: '单次条数上限，默认取设置里的 maxMessagesPerFetch。' },
      },
      required: ['chat'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value?.status === 'denied') {
          return [{ type: 'text', text: `已拒绝：${value.name || value.chat} 在黑名单里，没有发起任何请求。` }]
        }
        if (value?.status === 'deferred') {
          return [{ type: 'text', text: `已跳过：${value.name || value.chat} 本次不读取（未获许可）。` }]
        }
        if (value?.status === 'pending-approval') {
          const hint = value.note ? `\n${value.note}` : '\n请到「群聊导出」页面批准后重试。'
          return [{ type: 'text', text: `待批准：${value.name || value.chat}${hint}` }]
        }
        if (value?.status === 'needs-decision') {
          return [
            {
              type: 'text',
              text: `需要用户决定：${value.name || value.chat} 尚未获得读取许可。${value.reason ? `（${value.reason}）` : ''}\n请用 ask_user_question 向用户确认后，调用 chat_policy 记录决定。`,
            },
          ]
        }
        const lines = [
          `会话：${value.name || value.chat}`,
          `本次新增：${value.added} 条 · 累计：${value.total} 条`,
          `时间范围：${value.first_ts ?? '-'} → ${value.last_ts ?? '-'}`,
          `落盘：${value.path}`,
        ]
        if (value.media_pending > 0) lines.push(`待补附件：${value.media_pending} 个（只记了位置）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const policy = loadPolicy()
      const raw = String(args?.chat ?? '').trim()
      if (raw.length === 0) throw new Error('chat_fetch: 需要 chat')

      const found = resolveChat(policy, raw)
      let key = found.error ? undefined : found.key
      let entry = found.error ? undefined : found.entry
      // 显式给了 tg:<id> 就不必再问通道解析名称：灰区卡片可以直接问。
      if (!key && /^[a-z]+:.+$/i.test(raw)) {
        const [prefix, rawId] = splitKey(raw)
        key = keyOf(normalizePlatform(prefix), rawId)
      }
      if (found.candidates) {
        const list = found.candidates.map((item) => `${item.key} (${item.name})`).join('、')
        throw new Error(`chat_fetch: ${found.error}：${list}`)
      }

      if (entry?.decision === 'deny') {
        record(policy, { op: 'fetch', chat: key, result: 'denied' })
        savePolicy(policy)
        return { ok: false, status: 'denied', chat: key, name: entry.name ?? raw }
      }

      if (entry?.decision !== 'allow') {
        // 同意只在插件自己的页面里发生：Agent 没有「批准」这个能力，只有「请求批准」。
        // 灰区会话在这里登记成 pending，页面把它列出来等用户点。
        if (!key) {
          return {
            ok: false,
            status: 'pending-approval',
            chat: raw,
            name: raw,
            note: '还不知道这个会话的 id。先 chat_list 拿到 id，再回来登记待批准。',
          }
        }
        const [prefix, pendingId] = splitKey(key)
        const pending = policy.chats[key] ?? {
          platform: normalizePlatform(prefix),
          id: pendingId,
          name: '',
          decision: 'pending',
          cursor: { msg_id: 0, ts: null },
        }
        pending.platform = normalizePlatform(pending.platform ?? prefix)
        pending.id = pending.id ?? pendingId
        pending.decision = 'pending'
        pending.seen_at = new Date().toISOString()
        policy.chats[key] = pending
        record(policy, { op: 'fetch', chat: key, result: 'pending-approval' })
        savePolicy(policy)
        return { ok: false, status: 'pending-approval', chat: key, name: pending.name || raw }
      }
      const [platform, id] = splitKey(key)
      if (normalizePlatform(platform) !== 'tg') throw new Error('chat_fetch: WhatsApp 会话是导入式的，不支持主动拉取。请用 chat_import 导入官方导出文件（.zip 或 .txt）。')

      const days = Math.max(1, Number(args?.days) || cfg.defaultDays || 7)
      const max = Math.max(1, Number(args?.max) || cfg.maxMessagesPerFetch || 5000)
      const sinceId = Number(entry?.cursor?.msg_id ?? 0)
      const argv = ['fetch', '--chat', id, '--max', String(max)]
      if (args?.since) argv.push('--since', String(args.since))
      if (args?.until) argv.push('--until', String(args.until))
      if (!args?.since) argv.push('--days', String(days))
      if (sinceId > 0) argv.push('--since-id', String(sinceId))

      const payload = await callBridge(cfg, argv, exec)
      const messages = Array.isArray(payload?.messages) ? payload.messages : []

      const chatName = String(entry?.name || payload?.name || id)
      const dir = join(outputRootOf(cfg), slugOf(chatName))
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'messages.jsonl')

      const seen = new Set()
      const lines = []
      let pending = 0
      for (const message of messages) {
        const msgId = Number(message?.id ?? message?.msg_id ?? 0)
        if (!Number.isFinite(msgId) || msgId <= 0 || seen.has(msgId) || msgId <= sinceId) continue
        seen.add(msgId)
        const attachments = Array.isArray(message?.attachments) ? message.attachments : []
        pending += attachments.length
        lines.push(
          JSON.stringify({
            platform: 'telegram',
            chat_id: id,
            chat_name: chatName,
            msg_id: msgId,
            ts: message?.ts ?? message?.date ?? null,
            sender_id: message?.sender_id ?? null,
            sender_name: message?.sender_name ?? message?.sender ?? null,
            kind: message?.kind ?? 'text',
            text: message?.text ?? '',
            reply_to: message?.reply_to ?? null,
            attachments,
            raw_ref: { source: 'telegram-bridge' },
          }),
        )
      }

      let total = 0
      if (existsSync(file)) {
        total = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0).length
      }
      if (lines.length > 0) {
        appendFileSync(file, `${lines.join('\n')}\n`, 'utf8')
        total += lines.length
        const mirror = String(cfg.mirrorRoot ?? '').trim()
        if (mirror.length > 0) {
          const mirrorDir = join(mirror, slugOf(chatName))
          mkdirSync(mirrorDir, { recursive: true })
          appendFileSync(join(mirrorDir, 'messages.jsonl'), `${lines.join('\n')}\n`, 'utf8')
        }
      }

      const highest = lines.length > 0 ? Math.max(...lines.map((line) => Number(JSON.parse(line).msg_id))) : sinceId
      if (key && policy.chats[key]) {
        policy.chats[key].cursor = { msg_id: highest, ts: new Date().toISOString() }
        // 拉到数据时顺手把真实群名回填：否则名单里一直是无名条目，
        // 按名字查找和摘要定位都会退回用 id。
        if (!policy.chats[key].name) policy.chats[key].name = chatName
      }
      record(policy, { op: 'fetch', chat: key, result: `added:${lines.length}` })
      savePolicy(policy)

      const ids = lines.map((line) => JSON.parse(line).msg_id)
      return {
        ok: true,
        status: 'fetched',
        chat: key,
        name: chatName,
        added: lines.length,
        total,
        first_ts: lines.length > 0 ? JSON.parse(lines[0]).ts : null,
        last_ts: lines.length > 0 ? JSON.parse(lines[lines.length - 1]).ts : null,
        path: file,
        media_pending: pending,
        cursor: highest,
        sample_ids: ids.slice(0, 5),
      }
    },
  }
}

/* ------------------------------------------------------------------ guard */

// 只保留“外部导出工具”这一条：我们自己的 bridge 由它自己执行策略
// （bridge 的 fetch 会读策略库，只放行 allow 的会话），
// 门禁跟着能力走，而不是跟着命令行里出现的字符串走。
const EXTERNAL_EXPORT_CLIS = ['telegram' + '-download-chat', 'telegram' + '_export', 'qq' + 'cli', 'qq' + '.exe']
const BYPASS_PATTERNS = EXTERNAL_EXPORT_CLIS.map((name) => new RegExp(name.replace(/[.]/g, '[.]'), 'i'))
const SECRET_PATTERNS = [/session\.session/i, /telegram-download-chat[\\/]config\.ya?ml/i]

SECRET_PATTERNS.push(/[\\/]tg[.]session/, /login[.]cmd/i, /credentials[.]json/i)

const EXECISH = /(bash|shell|pwsh|powershell|terminal|exec|run|command|spawn|script|shell)/i
const WRITEISH = /(write|edit|patch|apply|replace|create)/i

function pathArgsOf(exec) {
  const args = exec?.arguments ?? {}
  const out = []
  for (const key of ['file_path', 'path', 'target', 'paths', 'files', 'pattern']) {
    const value = args[key]
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') out.push(item)
  }
  return out.join('\n')
}

function commandOf(exec) {
  const args = exec?.arguments ?? {}
  for (const key of ['command', 'cmd', 'script', 'input']) {
    if (typeof args[key] === 'string') return args[key]
  }
  return ''
}

/**
 * 门禁的第三层：堵住绕过插件直调通道、读凭据、改策略库。
 *
 * 只检查"真正指向目标"的参数（路径参数 / 命令参数），不扫整个参数 JSON——
 * 否则写文档时提到路径也会被误拦。
 */
function makeGuard() {
  return (exec) => {
    const name = String(exec?.name ?? '')
    if (name.startsWith('chat_')) return undefined

    const command = commandOf(exec)
    if (EXECISH.test(name) && command.length > 0 && BYPASS_PATTERNS.some((pattern) => pattern.test(command))) {
      auditDenied('bypass-channel', `${name}:${command.slice(0, 120)}`)
      return '群聊导出：拒绝绕过门禁直接调用导出通道。请改用 chat_fetch——它会先向用户确认会话许可，并把决定记进策略库。'
    }

    const paths = pathArgsOf(exec)
    if (paths.length === 0) return undefined

    if (SECRET_PATTERNS.some((pattern) => pattern.test(paths))) {
      auditDenied('credential-path', `${name}:${paths.slice(0, 120)}`)
      return '群聊导出：拒绝访问凭据文件。api_id/api_hash 与登录会话只能由插件自身使用；请在设置页维护它们。'
    }

    if (WRITEISH.test(name) && /policy\.json/i.test(paths)) {
      auditDenied('edit-policy', `${name}:${paths.slice(0, 120)}`)
      return '群聊导出：拒绝直接改写策略库。请用 chat_policy 工具修改名单。'
    }

    return undefined
  }
}
/* ------------------------------------------------------------------ 用户命令 */

/**
 * 授予读取权限是**用户侧动作**：只有人能敲这些命令。
 * 同一段逻辑将来由插件页面通过 commands.execute 复用，不另写一套。
 */
function approveCommand(cfg) {
  return {
    name: 'chat-approve',
    description: '把某个群聊会话加入读取白名单。只有你本人能执行，Agent 无法调用。',
    input: { hint: '会话 key（tg:<id>）或会话名' },
    async handler(invocation) {
      const raw = String(invocation?.rawInput ?? '').trim()
      if (raw.length === 0) return { kind: 'error', text: '用法：/chat-approve tg:-1001234567890' }
      try {
        const policy = loadPolicy()
        const applied = decide(policy, raw, 'allow', 'user-command')
        record(policy, { op: 'approve', chat: applied.key, result: 'allow' })
        savePolicy(policy)
        const entry = policy.chats[applied.key] ?? {}
        return {
          kind: 'success',
          text: `已加入白名单：${entry.name || '(未命名)'} (${applied.key})。现在可以让 Agent 用 chat_fetch 读取它。`,
        }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  }
}

function denyCommand(cfg) {
  return {
    name: 'chat-deny',
    description: '把某个群聊会话加入黑名单，此后永不读取。只有你本人能执行。',
    input: { hint: '会话 key（tg:<id>）或会话名' },
    async handler(invocation) {
      const raw = String(invocation?.rawInput ?? '').trim()
      if (raw.length === 0) return { kind: 'error', text: '用法：/chat-deny tg:-1001234567890' }
      try {
        const policy = loadPolicy()
        const applied = decide(policy, raw, 'deny', 'user-command')
        record(policy, { op: 'deny', chat: applied.key, result: 'deny' })
        savePolicy(policy)
        return { kind: 'success', text: `已加入黑名单：${applied.key}。此后不会发起任何读取请求。` }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  }
}

function pendingCommand(cfg) {
  return {
    name: 'chat-pending',
    description: '列出等待你批准的灰区会话。',
    async handler() {
      const policy = loadPolicy()
      const rows = Object.entries(policy.chats).filter(([, entry]) => (entry?.decision ?? 'pending') === 'pending')
      if (rows.length === 0) return { kind: 'success', text: '没有待批准的会话。' }
      const lines = rows.map(([key, entry]) => `- ${entry?.name || '(未命名)'} · ${key}`)
      return {
        kind: 'success',
        text: ['待批准：', ...lines, '', '批准用 /chat-approve <key>，拒绝用 /chat-deny <key>。'].join('\n'),
      }
    },
  }
}
/* ------------------------------------------------------------------ 登录 */

function loginTool(ctx, cfg) {
  return {
    name: 'chat_login',
    description:
      '准备一次交互式 Telegram 登录：生成一个启动脚本（凭据写在脚本里，不出现在命令行或历史记录中），再由你在终端运行。插件自己不会、也不能代你登录。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute() {
      const creds = credentialsOf(cfg)
      const apiId = creds.apiId
      const apiHash = creds.apiHash
      if (apiId.length === 0 || apiHash.length === 0) {
        return {
          ok: false,
          status: 'no-credentials',
          text: '还缺凭据：要么在 设置 -> 群聊导出 填 tgApiId / tgApiHash，要么把凭据写进 credentialsPath 指向的 JSON 文件（{"api_id": 123, "api_hash": "…"}）。',
        }
      }
      const python = pythonOf(cfg)
      const script = bridgeScriptPath()
      const launcher = join(stateDir(), 'login.cmd')
      const body = [
        '@echo off',
        `set "TG_API_ID=${apiId}"`,
        `set "TG_API_HASH=${apiHash}"`,
        `set "TG_SESSION=${sessionFileOf(cfg)}"`,
        `set "CHAT_EXPORT_POLICY=${policyPath()}"`,
        'set "PYTHONIOENCODING=utf-8"',
        `"${python}" "${script}" login`,
        'echo.',
        'pause',
        '',
      ].join('\r\n')
      mkdirSync(dirname(launcher), { recursive: true })
      writeFileSync(launcher, body, 'utf8')
      return {
        ok: true,
        status: 'ready',
        launcher,
        python,
        text: [
          '登录脚本已生成（凭据写在脚本里，不进命令行历史）：',
          launcher,
          '',
          '请在终端运行它，按提示输入手机号、验证码（若有两步验证再输密码）。',
          '完成后回来让我跑 chat_list：成功会列出你的会话，失败会给出下一条该敲的命令。',
        ].join('\n'),
      }
    },
  }
}
/* ------------------------------------------------------------------ 页面接口 */

const UI_PATH = "/chat-export/api"
const UI_HEADER = "x-chat-export-ui"

function sendJson(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

function uiSnapshot(policy, cfg) {
  return {
    ok: true,
    output_root: outputRootOf(cfg),
    inbox: inboxDirOf(cfg),
    credentials: credentialsOf(cfg).apiId.length > 0,
    ...policySnapshot(policy, cfg),
  }
}

async function handleUiRequest(req, res, ctx, cfg) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "只接受 POST" })
  if (req.headers[UI_HEADER] !== "1") return sendJson(res, 403, { ok: false, error: "缺少页面请求头" })
  let payload = {}
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
  } catch {
    return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" })
  }
  const action = String(payload.action ?? "")
  try {
    const policy = loadPolicy()
    if (action === "status") {
      const missingName = Object.values(policy.chats).some((entry) => !entry || !entry.name)
      if (missingName) {
        try {
          const dialogs = await callBridge(cfg, ["dialogs"], { signal: undefined })
          const list = Array.isArray(dialogs?.chats) ? dialogs.chats : []
          let changed = false
          for (const entry of Object.values(policy.chats)) {
            if (!entry || entry.name) continue
            const hit = list.find((item) => String(item.id) === String(entry.id))
            if (hit && hit.name) {
              entry.name = String(hit.name)
              changed = true
            }
          }
          if (changed) savePolicy(policy)
        } catch {
          // 通道暂时不可用时页面仍要能打开，只是显示 key。
        }
      }
      return sendJson(res, 200, uiSnapshot(policy, cfg))
    }
    if (action === "approve" || action === "deny") {
      const chat = String(payload.chat ?? "").trim()
      if (chat.length === 0) return sendJson(res, 400, { ok: false, error: "缺少 chat" })
      const decision = action === "approve" ? "allow" : "deny"
      const applied = decide(policy, chat, decision, "user-ui", payload.name)
      record(policy, { op: action, chat: applied.key, result: decision })
      savePolicy(policy)
      return sendJson(res, 200, uiSnapshot(loadPolicy(), cfg))
    }
    if (action === "reset") {
      const found = resolveChat(policy, String(payload.chat ?? "").trim())
      if (found.error) return sendJson(res, 404, { ok: false, error: found.error })
      delete policy.chats[found.key]
      record(policy, { op: "reset", chat: found.key, result: "removed" })
      savePolicy(policy)
      return sendJson(res, 200, uiSnapshot(loadPolicy(), cfg))
    }
    if (action === "setWa") {
      const patch = {}
      if (typeof payload.profile === "string") patch.waProfile = payload.profile.trim()
      if (typeof payload.chrome === "string") patch.waChrome = payload.chrome.trim()
      writeOverrides(patch)
      return sendJson(res, 200, uiSnapshot(loadPolicy(), cfg))
    }

    if (action === "setInbox") {
      writeOverrides({ inboxDir: String(payload.value ?? "").trim() })
      return sendJson(res, 200, uiSnapshot(loadPolicy(), cfg))
    }

    if (action === "scanInbox") {
      const inbox = inboxDirOf(cfg)
      const files = listInboxFiles(inbox)
      const results = files.length === 0 ? [] : await importFiles(cfg, files)
      return sendJson(res, 200, { ...uiSnapshot(loadPolicy(), cfg), scanned: files.length, results })
    }

    if (action === "setRoot") {
      const value = String(payload.value ?? "").trim()
      writeOverrides({ outputRoot: value })
      return sendJson(res, 200, { ...uiSnapshot(loadPolicy(), cfg), output_root: outputRootOf(cfg) })
      return sendJson(res, 200, { ...uiSnapshot(loadPolicy(), cfg), output_root: value })
    }
    return sendJson(res, 400, { ok: false, error: "未知 action" })
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
  }
}
/* ------------------------------------------------------------------ 摘要 */

const NL = String.fromCharCode(10)
const URL_RE = /https?:\/\/[^\s)>\]]+/g

function normText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase()
}

function ollamaBase(cfg) {
  const raw = String(cfg.ollamaUrl ?? "").trim() || "http://127.0.0.1:11434"
  return raw.replace(/\/+$/, "")
}

async function ollamaGenerate(cfg, prompt, system, signal) {
  const res = await fetch(`${ollamaBase(cfg)}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.digestModel, prompt, system, stream: false, options: { temperature: 0.2 } }),
    signal,
  })
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`)
  const data = await res.json()
  return String(data.response ?? "").trim()
}

function chatFileOf(cfg, entry) {
  return join(outputRootOf(cfg), slugOf(entry.name || entry.id), "messages.jsonl")
}

function readWindow(cfg, entry, hours) {
  const file = chatFileOf(cfg, entry)
  if (!existsSync(file)) return { file, messages: [] }
  const cutoff = Date.now() - hours * 3600 * 1000
  const messages = []
  for (const line of readFileSync(file, "utf8").split(NL)) {
    if (line.trim().length === 0) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const ts = Date.parse(String(row.ts ?? ""))
    if (Number.isFinite(ts) && ts < cutoff) continue
    messages.push(row)
  }
  return { file, messages }
}

function chunkLines(messages) {
  return messages.map((m) => {
    const kind = m.kind && m.kind !== "text" ? `[${m.kind}]` : ""
    return `#${m.msg_id} [${String(m.ts ?? "").slice(0, 16)}] ${m.sender_name ?? "?"}${kind}: ${String(m.text ?? "").replace(/\s+/g, " ").slice(0, 500)}`
  })
}

function chunkMessages(lines, limit) {
  const chunks = []
  let current = ""
  for (const line of lines) {
    if (current.length > 0 && current.length + line.length + 1 > limit) {
      chunks.push(current)
      current = line.slice(0, limit)
    } else {
      current = current.length > 0 ? `${current}${NL}${line}` : line
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** 在换行处对半切，供失败块重试用。 */
function splitChunk(chunk) {
  const mid = Math.floor(chunk.length / 2)
  const at = chunk.indexOf(NL, mid)
  if (at < 0) return [chunk.slice(0, mid), chunk.slice(mid)]
  return [chunk.slice(0, at), chunk.slice(at + 1)]
}
const DIGEST_SYSTEM = "你是严谨的课程群纪要助手。只依据给定内容，不臆测、不补充原文没有的信息。"

const ALERT_RULE = "alerts 是重要通知的原句（考试时间、上课形式或地点变动、作业与论文截止或提交方式、报名、取消延期、资料发布）。必须逐字照抄原文中的那一句，不改写、不翻译、不拼接；没有就空数组。"

const chunkPrompt = (chunk) => `以下是群聊片段，每行以 #消息号 开头。${ALERT_RULE} points 是事实要点，todos 是待办。questions 只放这段内容里没有被回答的提问，每条必须给出该消息的 #消息号：{"id":543,"text":"问题原文"}。同一个问题只出现一次；提问不算 points；不要编造。只输出 JSON，不要解释：{"alerts":["原句"],"points":["..."],"todos":["..."],"questions":[{"id":543,"text":"..."}]}${NL}原文：${NL}${chunk}`

const mergePrompt = (merged) => `把下面的提取结果合并成 200-400 字中文摘要，分两节：要点、待办；没有内容的节写 无。不要编造；不要重复通知原句与链接；不要输出尚待确认（那部分由代码单独列出）。${NL}${JSON.stringify(merged, null, 1)}`

function parseExtract(text) {
  const cleaned = String(text ?? "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    const pick = (key) => (Array.isArray(parsed[key]) ? parsed[key].filter((x) => String(x).trim().length > 0) : [])
    const questions = pick("questions").map((q) => (typeof q === "string" ? { id: null, text: q } : { id: Number(q?.id) || null, text: String(q?.text ?? "") })).filter((q) => q.text.length > 0)
    return { alerts: pick("alerts"), points: pick("points"), todos: pick("todos"), questions }
  } catch {
    return null
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function refLabel(item) {
  const when = item && item.ts ? ` · ${String(item.ts).slice(0, 16)}` : ""
  return `[${item.ref}${when}]`
}

function quoteLines(value) {
  return String(value ?? "").split(NL).join(NL + "  ")
}
function refOf(message) {
  if (message && message.msg_id !== null && message.msg_id !== undefined) return `msg ${message.msg_id}`
  return `uid ${String(message?.uid ?? "").slice(0, 8) || "?"}`
}

function verifyAlerts(messages, extracts) {
  const alerts = []
  let rejected = 0
  for (const item of extracts) {
    if (!item) continue
    for (const raw of item.alerts) {
      const needle = normText(raw)
      if (needle.length < 6) {
        rejected += 1
        continue
      }
      const hit = messages.find((m) => normText(m.text).includes(needle))
      if (!hit) {
        rejected += 1
        continue
      }
      if (alerts.some((a) => a.msg_id === hit.msg_id)) continue
      alerts.push({ msg_id: hit.msg_id, ref: refOf(hit), ts: hit.ts, sender: hit.sender_name, text: String(hit.text ?? "").trim() })
    }
  }
  alerts.sort((a, b) => (a.msg_id > b.msg_id ? 1 : -1))
  return { alerts, rejected }
}

function extractLinks(messages) {
  const links = []
  for (const m of messages) {
    const found = String(m.text ?? "").match(URL_RE) ?? []
    for (const url of found) links.push({ msg_id: m.msg_id, ref: refOf(m), url })
  }
  return links
}

function verifyQuestions(messages, extracts) {
  const out = []
  let rejected = 0
  for (const item of extracts) {
    if (!item) continue
    for (const question of item.questions) {
      if (!question.id) {
        rejected += 1
        continue
      }
      const hit = messages.find((m) => Number(m.msg_id) === Number(question.id))
      if (!hit) {
        rejected += 1
        continue
      }
      if (out.some((q) => q.msg_id === hit.msg_id)) continue
      out.push({ msg_id: hit.msg_id, ref: refOf(hit), ts: hit.ts, sender: hit.sender_name, text: String(hit.text ?? "").trim() })
    }
  }
  out.sort((a, b) => (a.msg_id > b.msg_id ? 1 : -1))
  return { questions: out, rejected }
}
async function digestOne(cfg, entry, hours, signal) {
  const { file, messages } = readWindow(cfg, entry, hours)
  const chatName = entry.name || entry.id
  if (messages.length === 0) {
    return { chat: chatName, path: null, source: file, messages: 0, chunks: 0, ok_chunks: 0, failed_chunks: 0, alerts: 0, links: 0, rejected_alerts: 0, text: "窗口内没有消息，未生成摘要。" }
  }
  // 块越小，7B 越不容易产出畸形 JSON；宁可多几块，也不要整块丢失。
  const chunks = chunkMessages(chunkLines(messages), 3000)
  const concurrency = Math.max(1, Math.min(4, Number(cfg.digestConcurrency) || 2))
  const extractChunk = async (chunk, depth) => {
    try {
      const parsed = parseExtract(await ollamaGenerate(cfg, chunkPrompt(chunk), DIGEST_SYSTEM, signal))
      if (parsed) return [parsed]
    } catch {
      // 落到重试
    }
    if (depth > 0 && chunk.length > 1200) {
      const [left, right] = splitChunk(chunk)
      const a = await extractChunk(left, depth - 1)
      const b = await extractChunk(right, depth - 1)
      return [...a, ...b]
    }
    return []
  }
  const groups = await mapLimit(chunks, concurrency, (chunk) => extractChunk(chunk, 1))
  const extracts = groups.flat()
  const ok = extracts
  const failed = groups.filter((group) => group.length === 0).length
  const verified = verifyAlerts(messages, extracts)
  const links = extractLinks(messages)
  const collect = (key) => ok.flatMap((item) => item[key]).slice(0, 40)
  const verifiedQuestions = verifyQuestions(messages, extracts)
  const merged = { points: collect("points"), todos: collect("todos") }
  let summary = ""
  try {
    summary = await ollamaGenerate(cfg, mergePrompt(merged), DIGEST_SYSTEM, signal)
  } catch (error) {
    summary = `（归并失败：${String(error?.message ?? error)}）`
  }
  const stamp = new Date().toISOString()
  const withTs = messages.filter((m) => m && m.ts).length
  const timeMode = withTs === 0 ? "snapshot" : "window"
  const scopeLine =
    timeMode === "snapshot"
      ? `无时间戳（导出未含时间）：覆盖该会话已导入的全部 ${messages.length} 条，按导入顺序`
      : `窗口 ${hours}h · 覆盖 ${messages.length} 条`
  const body = [`# ${chatName} · 摘要`, "", `> 由 ${cfg.digestModel} 生成 · 输入 ${messages.length} 条 / ${chunks.length} 块 · 确定性校验通过 ${chunks.length - failed}/${chunks.length}`, `> ${scopeLine} · 生成时间 ${stamp}`, `> 来源 ${file}`, ""]
  body.push(`## 重要通知（原句照抄，未改写）${verified.alerts.length === 0 ? "（无）" : ""}`)
  for (const alert of verified.alerts) body.push(`- ${refLabel(alert)} ${alert.sender ?? "?"}: ${quoteLines(alert.text)}`)
  body.push("")
  body.push(`## 链接（代码提取）${links.length === 0 ? "（无）" : ""}`)
  for (const link of links) body.push(`- [${link.ref}] ${link.url}`)
  body.push("")
  body.push("## 概要（模型生成，请结合上方原文核对）")
  body.push("")
  body.push(summary)
  body.push("")
  body.push(`## 可能有待确认（未逐条核实；附原文出处）${verifiedQuestions.questions.length === 0 ? "（无）" : ""}`)
  for (const q of verifiedQuestions.questions) body.push(`- ${refLabel(q)} ${q.sender ?? "?"}: ${quoteLines(q.text)}`)
  body.push("")
  if (failed > 0 || verified.rejected > 0 || verifiedQuestions.rejected > 0) {
    body.push("## 校验记录")
    if (failed > 0) body.push(`- 未产出合法 JSON 的块：${failed} / ${chunks.length}`)
    if (verified.rejected > 0) body.push(`- 通知句未能在原文中逐字匹配、已丢弃：${verified.rejected} 条`)
    if (verifiedQuestions.rejected > 0) body.push(`- 提问未能对上消息号、已丢弃：${verifiedQuestions.rejected} 条`)
    body.push("")
  }
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const outPath = join(dir, `digest-${stamp.slice(0, 10)}.md`)
  writeFileSync(outPath, body.join(NL), "utf8")
  return {
    chat: chatName, path: outPath, messages: messages.length, chunks: chunks.length,
    ok_chunks: chunks.length - failed, failed_chunks: failed, alerts: verified.alerts.length,
    rejected_alerts: verified.rejected, links: links.length, questions: verifiedQuestions.questions.length, time_mode: timeMode, chars: summary.length,
    alert_preview: verified.alerts.slice(0, 3).map((a) => `[${a.ref}] ${a.text}`.slice(0, 160)),
    preview: summary.slice(0, 400),
  }
}

function digestTool(ctx, cfg) {
  return {
    name: "chat_digest",
    description: "对白名单会话生成摘要：重要通知按原文照抄并带 msg_id，链接由代码提取（模型不参与），模型只写概要。产物写到该会话目录下的 digest-YYYY-MM-DD.md；原文不进上下文。",
    parameters: { type: "object", properties: { target: { type: "string", description: "会话 key/名称，或 all 表示全部白名单会话（默认）。" }, hours: { type: "integer", description: "回溯小时数，默认 24。" } }, additionalProperties: false },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => {
        if (!Array.isArray(value.digests)) return [{ type: "text", text: JSON.stringify(value, null, 2) }]
        const blocks = value.digests.map((item) => {
          const lines = [
            `【${item.chat}】${item.messages} 条 / ${item.chunks} 块 · 校验通过 ${item.ok_chunks}${item.failed_chunks > 0 ? ` · 失败 ${item.failed_chunks}` : ""}`,
            `重要通知 ${item.alerts} 条${item.rejected_alerts > 0 ? `（丢弃 ${item.rejected_alerts} 条未匹配原文）` : ""} · 链接 ${item.links} 条`,
            `产物：${item.path ?? "未生成（窗口内没有消息）"}`,
          ]
          if (item.messages === 0) lines.push("", item.text || "窗口内没有消息。")
          if (item.alert_preview && item.alert_preview.length > 0) {
            lines.push("", "原文通知：")
            for (const alert of item.alert_preview) lines.push(`- ${alert}`)
          }
          if (item.preview) lines.push("", item.preview)
          return lines.join(NL)
        })
        return [{ type: "text", text: blocks.join(NL + NL + "---" + NL + NL) }]
      },
    },
    async execute(args, exec) {
      const policy = loadPolicy()
      const target = String(args?.target ?? "all").trim() || "all"
      const hours = Math.max(1, Math.min(720, Number(args?.hours) || 24))
      let entries = []
      if (target === "all") {
        entries = Object.entries(policy.chats).filter(([, entry]) => entry?.decision === "allow").map(([key, entry]) => ({ key, name: entry.name || key, id: entry.id }))
      } else {
        const found = resolveChat(policy, target)
        if (found.error) throw new Error(`chat_digest: ${found.error}`)
        if (found.entry?.decision !== "allow") throw new Error(`chat_digest: ${target} 未获许可，不能摘要。`)
        entries = [{ key: found.key, name: found.entry.name || found.key, id: found.entry.id }]
      }
      if (entries.length === 0) throw new Error("chat_digest: 白名单为空，没有可摘要的会话。")
      const digests = []
      for (const entry of entries) digests.push(await digestOne(cfg, entry, hours, exec?.signal))
      return { ok: true, model: cfg.digestModel, hours, digests }
    },
  }
}
/* ------------------------------------------------------------------ WhatsApp 导入 */

function inboxDirOf(cfg) {
  const configured = String(cfg.waInbox ?? "").trim()
  if (configured.length > 0) return configured
  const stored = String(readOverrides().inboxDir ?? "").trim()
  if (stored.length > 0) return stored
  return join(stateDir(), "wa-inbox")
}

function listInboxFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(zip|txt|json)$/i.test(entry.name))
      .map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

async function readExportText(file) {
  if (/\.txt$/i.test(file)) return readFileSync(file, "utf8")
  const work = join(stateDir(), "wa-import", String(Date.now()))
  mkdirSync(work, { recursive: true })
  await execFileAsync("tar", ["-xf", file, "-C", work], { timeout: 120000, windowsHide: true })
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.txt$/i.test(entry.name)) found.push(full)
    }
  }
  walk(work)
  if (found.length === 0) throw new Error("压缩包里没有找到 txt 聊天文件")
  return readFileSync(found[0], "utf8")
}

/** 按 uid 指纹去重追加：同一句消息只存一次，多次导出累积成完整历史。 */
function appendEntries(file, records) {
  const seen = new Set()
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(NL)) {
      if (line.trim().length === 0) continue
      try {
        const row = JSON.parse(line)
        if (row && row.uid) seen.add(String(row.uid))
      } catch {
        continue
      }
    }
  }
  const fresh = []
  let dup = 0
  for (const record of records) {
    if (seen.has(record.uid)) {
      dup += 1
      continue
    }
    seen.add(record.uid)
    fresh.push(JSON.stringify(record))
  }
  if (fresh.length > 0) appendFileSync(file, fresh.join(NL) + NL, "utf8")
  return { added: fresh.length, dup }
}

/** 导入一批文件：工具与页面共用同一段逻辑，不写第二套。 */
/** 内容级合并键：同一句话在不同来源（无时间戳的导出 / 有时间的抓取）应当合并。 */
function contentKeyOf(record) {
  // 只用「会话 + 正文」：导出里的自己显示为 You，抓取拿到的是手机号，
  // 带上发送者会让同一句话配不上，反而产生重复。
  const text = String(record?.text ?? "").replace(/\s+/g, " ").trim().toLowerCase()
  return [record?.chat_id ?? "", text].join("\u0001")
}

/**
 * 按内容合并写入：
 * - 内容已存在且有 ts：跳过（计数为 duplicate）
 * - 内容已存在但没有 ts、而新行有 ts：补上 ts（计数为 upgraded）
 * - 内容不存在：追加
 */
/** 归并同一文件内的重复行：优先保留带 ts 的那条，其余合并进它。 */
function normalizeFile(file) {
  if (!existsSync(file)) return { before: 0, after: 0, merged: 0 }
  const lines = readFileSync(file, "utf8").split(NL).filter((line) => line.trim().length > 0)
  const order = []
  const rows = new Map()
  for (const line of lines) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const key = contentKeyOf(row)
    const prev = rows.get(key)
    if (!prev) {
      rows.set(key, row)
      order.push(key)
      continue
    }
    if (!prev.ts && row.ts) {
      prev.ts = row.ts
      prev.uid = row.uid || prev.uid
    }
    if ((!prev.sender_name || prev.sender_name === "You") && row.sender_name && row.sender_name !== "You") {
      prev.sender_name = row.sender_name
    }
  }
  const text = order.map((key) => JSON.stringify(rows.get(key))).join(NL) + NL
  writeFileSync(file, text, "utf8")
  return { before: lines.length, after: order.length, merged: lines.length - order.length }
}
function upsertMessages(file, records) {
  const rows = []
  const index = new Map()
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(NL)) {
      if (line.trim().length === 0) continue
      try {
        const row = JSON.parse(line)
        rows.push(row)
        index.set(contentKeyOf(row), rows.length - 1)
      } catch {
        continue
      }
    }
  }
  let added = 0
  let upgraded = 0
  let duplicate = 0
  let dirty = false
  const fresh = []
  for (const record of records) {
    const key = contentKeyOf(record)
    const at = index.get(key)
    if (at === undefined) {
      rows.push(record)
      index.set(key, rows.length - 1)
      fresh.push(JSON.stringify(record))
      added += 1
      continue
    }
    const existing = rows[at]
    if (!existing.ts && record.ts) {
      existing.ts = record.ts
      existing.uid = record.uid || existing.uid
      existing.raw_ref = record.raw_ref || existing.raw_ref
      dirty = true
      upgraded += 1
      continue
    }
    duplicate += 1
  }
  if (dirty) writeFileSync(file, rows.map((row) => JSON.stringify(row)).join(NL) + NL, "utf8")
  if (fresh.length > 0) appendFileSync(file, fresh.join(NL) + NL, "utf8")
  return { added, dup: duplicate, upgraded }
}
async function importFiles(cfg, files) {
  const policy = loadPolicy()
  const results = []
  for (const file of files) {
    try {
      const isJson = /\.json$/i.test(file)
      const rawText = isJson ? readFileSync(file, "utf8") : null
      let name = ""
      if (isJson) {
        try {
          name = parseJsonExport(rawText, { platform: "wa", chatKey: "" }).chatName
        } catch {
          name = ""
        }
      }
      if (name.length === 0) name = chatNameFromFile(basename(file))
      const slug = slugOfName(name)
      const chatKey = keyOf("wa", slug)
      const existing = policy.chats[chatKey]
      if (!existing || existing.decision !== "allow") {
        const denied = existing && existing.decision === "deny"
        policy.chats[chatKey] = {
          ...(existing || {}),
          platform: "wa",
          id: slug,
          name,
          decision: denied ? "deny" : "pending",
          seen_at: new Date().toISOString(),
        }
        record(policy, { op: "import", chat: chatKey, result: denied ? "denied" : "pending-approval" })
        savePolicy(policy)
        results.push({ file: basename(file), chat: name, status: denied ? "denied" : "pending-approval" })
        continue
      }
      const text = isJson ? rawText : await readExportText(file)
      const parsed = isJson ? parseJsonExport(text, { platform: "wa", chatKey }) : parseChatText(text, { platform: "wa", chatKey })
      const capturedAt = parsed.exportedAt || null
      const dir = join(outputRootOf(cfg), slug)
      mkdirSync(dir, { recursive: true })
      const outFile = join(dir, "messages.jsonl")
      const recordsToWrite = parsed.messages.map((m) => ({
        platform: "wa",
        chat_id: chatKey,
        chat_name: name,
        msg_id: null,
        uid: m.uid,
        ts: m.ts,
        sender_id: null,
        sender_name: m.sender,
        kind: m.kind,
        text: m.text,
        reply_to: null,
        attachments: [],
        captured_at: capturedAt,
        raw_ref: { source: isJson ? "wa-json" : "wa-export" },
      }))
      const { added, dup } = appendEntries(outFile, recordsToWrite)
      const processed = join(dirname(file), "processed")
      try {
        mkdirSync(processed, { recursive: true })
        renameSync(file, join(processed, basename(file)))
      } catch {
        // 归档失败不影响导入结果
      }
      record(policy, { op: "import", chat: chatKey, result: `added:${added}` })
      savePolicy(policy)
      results.push({ file: basename(file), chat: name, status: "imported", parsed: parsed.stats, added, duplicates: dup, warnings: parsed.warnings.length, path: outFile })
    } catch (error) {
      results.push({ file: basename(file), status: "failed", error: String(error?.message ?? error).slice(0, 240) })
    }
  }
  return results
}
function importTool(ctx, cfg) {
  return {
    name: "chat_import",
    description: "导入 WhatsApp 官方导出的聊天记录（.zip 或 .txt）。默认扫描收件箱；给了 path 就只导入那个文件。未获批准的会话只会登记为待批准而不导入。重复导入按内容指纹去重，不会产生重复消息。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "可选：指定要导入的导出文件绝对路径。" },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => {
        if (!Array.isArray(value.results)) return [{ type: "text", text: JSON.stringify(value, null, 2) }]
        if (value.results.length === 0) return [{ type: "text", text: `收件箱为空：${value.inbox}` }]
        const lines = value.results.map((item) => {
          if (item.status === "imported") return `- ${item.chat}｜导入 ${item.added} 条（重复 ${item.duplicates}）｜产物 ${item.path}`
          if (item.status === "failed") return `- ${item.file}｜失败：${item.error}`
          return `- ${item.chat}｜${item.status === "denied" ? "在黑名单里，已跳过" : "待批准，未导入"}｜${item.file}`
        })
        return [{ type: "text", text: [`收件箱：${value.inbox}`, "", ...lines].join(NL) }]
      },
    },
    async execute(args) {
      const policy = loadPolicy()
      const inbox = inboxDirOf(cfg)
      const files = args?.path ? [String(args.path)] : listInboxFiles(inbox)
      if (files.length === 0) return { ok: true, inbox, results: [] }
      return { ok: true, inbox, results: await importFiles(cfg, files) }
    },
  }
}
/* ------------------------------------------------------------------ WhatsApp Web */

function chromeOf(cfg) {
  const direct = String(cfg.waChrome ?? "").trim()
  if (direct.length > 0) return direct
  const stored = String(readOverrides().waChrome ?? "").trim()
  if (stored.length > 0) return stored
  return "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe"
}

function waProfileOf(cfg) {
  const direct = String(cfg.waProfile ?? "").trim()
  if (direct.length > 0) return direct
  const stored = String(readOverrides().waProfile ?? "").trim()
  if (stored.length > 0) return stored
  return join(stateDir(), "wa-profile")
}

function webTool(ctx, cfg, kind) {
  const base = { output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => [{ type: "text", text: typeof v?.text === "string" ? v.text : JSON.stringify(v, null, 2) }] } }
  if (kind === "open") {
    return {
      ...base,
      name: "wa_open",
      description: "启动一个独立的持久 Chrome（不影响日常浏览器）并打开 WhatsApp Web。已登录会直接进入主界面；未登录会停在扫码页，请在那个窗口里扫一次码。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const profileDir = waProfileOf(cfg)
        mkdirSync(profileDir, { recursive: true })
        await openSession({ chromePath: chromeOf(cfg), profileDir })
        const status = await sessionStatus(kind === "open" ? 45000 : 0)
        return { ok: true, ...status, profile: profileDir, text: status.loggedIn ? `已打开并登录：${status.url}` : `已打开 ${status.url}，请在窗口里扫码登录（首次）。扫码后调用 wa_probe 侦察页面结构。` }
      },
    }
  }
  if (kind === "sync") {
    return {
      ...base,
      name: "wa_sync",
      description:
        "在已登录的 WhatsApp Web 里打开会话，按时间水位向上加载并抓取消息（时间、发送者、正文），写入同一份归一化存储。默认覆盖到 24 小时前、最多滚动 10 次；没覆盖完会明确报不完整。只读，不发送任何消息。",
      parameters: {
        type: "object",
        properties: {
          chat: { type: "string", description: "会话名称，与左侧列表显示一致。" },
          hours: { type: "integer", description: "至少覆盖多少小时前，默认 24。" },
          scrolls: { type: "integer", description: "最多滚动次数，默认 10，上限 30。" },
        },
        required: ["chat"],
        additionalProperties: false,
      },
      async execute(args) {
        const status = await sessionStatus(0)
        if (!status.open) throw new Error("浏览器还没打开，先调用 wa_open")
        if (!status.loggedIn) throw new Error("还没登录：请先在打开的窗口里扫码")
        const chatName = String(args?.chat || "").trim()
        if (chatName.length === 0) throw new Error("需要 chat")

        const policy = loadPolicy()
        const slug = slugOfName(chatName)
        const chatKey = keyOf("wa", slug)
        const entry = policy.chats[chatKey]
        if (!entry || entry.decision !== "allow") {
          policy.chats[chatKey] = {
            ...(entry || {}),
            platform: "wa",
            id: slug,
            name: chatName,
            decision: entry?.decision === "deny" ? "deny" : "pending",
            seen_at: new Date().toISOString(),
          }
          savePolicy(policy)
          return { ok: false, chat: chatName, text: `${chatName} 未获批准，已登记为待批准；没有写入任何内容。` }
        }

        const opened = await openChatByName(chatName)
        if (!opened) throw new Error(`打不开会话：${chatName}`)
        await waitForMessages(3, 30000)

        const hours = Math.max(1, Math.min(720, Number(args?.hours) || 24))
        const maxScrolls = Math.max(0, Math.min(30, Number(args?.scrolls ?? 10)))
        const targetFrom = Date.now() - hours * 3600 * 1000

        const seen = new Map()
        let oldest = null
        const collect = async () => {
          const rows = await scrapeRows()
          for (const row of rows) {
            const parsed = parsePrePlain(row.pre)
            if (!parsed) continue
            const text = String(row.text || parsed.body || "").trim()
            if (text.length === 0) continue
            const key = row.id || `${parsed.iso}|${parsed.sender ?? ""}|${text.slice(0, 40)}`
            if (!seen.has(key)) seen.set(key, { iso: parsed.iso, sender: parsed.sender, text })
            const stamp = Date.parse(parsed.iso)
            if (Number.isFinite(stamp) && (oldest === null || stamp < oldest)) oldest = stamp
          }
          return rows.length
        }

        await collect()
        let rounds = 0
        let stopped = "covered"
        while (rounds < maxScrolls) {
          if (oldest !== null && oldest <= targetFrom) break
          rounds += 1
          const step = await scrollStep(500, 700)
          await collect()
          if (!step.loaded && step.atTop) {
            stopped = "reached-top"
            break
          }
        }
        const complete = oldest !== null && oldest <= targetFrom
        if (!complete) stopped = oldest === null ? "no-message" : rounds >= maxScrolls ? "max-scrolls" : stopped

        const records = []
        for (const item of seen.values()) {
          records.push({
            platform: "wa",
            chat_id: chatKey,
            chat_name: chatName,
            msg_id: null,
            uid: fingerprint("wa", chatKey, item.iso, item.sender || "", item.text),
            ts: item.iso,
            sender_id: null,
            sender_name: item.sender,
            kind: "text",
            text: item.text,
            reply_to: null,
            attachments: [],
            captured_at: new Date().toISOString(),
            raw_ref: { source: "wa-web" },
          })
        }

        const dir = join(outputRootOf(cfg), slug)
        mkdirSync(dir, { recursive: true })
        const outFile = join(dir, "messages.jsonl")
        const { added, dup, upgraded } = upsertMessages(outFile, records)
        const normalized = normalizeFile(outFile)
        const coveredFrom = oldest === null ? null : new Date(oldest).toISOString()
        const statePath = join(dir, "sync-state.json")
        writeFileSync(
          statePath,
          JSON.stringify(
            {
              ran_at: new Date().toISOString(),
              chat: chatName,
              target_from: new Date(targetFrom).toISOString(),
              covered_from: coveredFrom,
              complete,
              stopped,
              rounds,
              scraped: records.length,
            },
            null,
            2,
          ),
          "utf8",
        )
        record(policy, { op: "sync", chat: chatKey, result: `added:${added} complete:${complete}` })
        savePolicy(policy)
        return {
          ok: true,
          chat: chatName,
          complete,
          stopped,
          rounds,
          covered_from: coveredFrom,
          target_from: new Date(targetFrom).toISOString(),
          scraped: records.length,
          added,
          merged_duplicates: normalized.merged,
          upgraded,
          duplicates: dup,
          path: outFile,
        }
      },
    }
  }
  if (kind === "chatProbe") {
    return {
      ...base,
      name: "wa_chat_probe",
      description: "在已登录的 WhatsApp Web 里用搜索框打开指定会话，并侦察其消息节点结构（只报标签与属性名，不回正文）。",
      parameters: { type: "object", properties: { chat: { type: "string", description: "会话名称，与左侧列表显示一致。" } }, required: ["chat"], additionalProperties: false },
      async execute(args) {
        const status = await sessionStatus(0)
        if (!status.open) throw new Error("浏览器还没打开，先调用 wa_open")
        if (!status.loggedIn) throw new Error("还没登录：请先在打开的窗口里扫码")
        const opened = await openChatByName(String(args.chat || ""))
        if (!opened) return { ok: false, text: `没能打开会话「${args.chat}」：搜索后没有进入主界面，换个更精确的名字试试。` }
        const loaded = await waitForMessages(3, 30000)
        const info = await probeMessages()
        const dir = join(stateDir(), "wa-shots")
        mkdirSync(dir, { recursive: true })
        const shot = join(dir, `probe-${Date.now()}.png`)
        try {
          await screenshot(shot)
        } catch {
          // 截图失败不影响侦察结果
        }
        return { ok: true, chat: args.chat, loaded, title: info.title, hist: info.hist, dataIds: info.dataIds, probes: info.out, shot }
      },
    }
  }

  if (kind === "probe") {
    return {
      ...base,
      name: "wa_probe",
      description: "侦察 WhatsApp Web 当前页面的 DOM 结构（各候选选择器的命中数与样例），用于校准抓取器。只读，不发送任何消息。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const status = await sessionStatus(kind === "open" ? 45000 : 0)
        if (!status.open) throw new Error("浏览器还没打开，先调用 wa_open")
        if (!status.loggedIn) return { ok: false, ...status, text: "还没登录：请在打开的窗口里扫码，然后再调用 wa_probe。" }
        const probes = await probeDom()
        return { ok: true, loggedIn: status.loggedIn, url: status.url, probes }
      },
    }
  }
  return {
    ...base,
    name: "wa_close",
    description: "关闭由插件启动的那个 Chrome 实例（只关自己启动的，不动你日常浏览器）。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const closed = await closeSession()
      return { ok: true, closed, text: closed ? "已关闭插件启动的浏览器。" : "没有由插件启动的浏览器在运行。" }
    },
  }
}
/* ------------------------------------------------------------------ 装配 */

export function apply(ctx, config = {}) {
  const cfg = {
    outputRoot: config.outputRoot ?? '',
    mirrorRoot: config.mirrorRoot ?? '',
    defaultDays: config.defaultDays ?? 7,
    mediaPolicy: config.mediaPolicy ?? 'record-only',
    digestModel: config.digestModel ?? 'qwen2.5:7b',
    ollamaUrl: config.ollamaUrl ?? 'http://127.0.0.1:11434',
    waInbox: config.waInbox ?? '',
    waChrome: config.waChrome ?? '',
    waProfile: config.waProfile ?? '',
    digestConcurrency: config.digestConcurrency ?? 2,
    requestDelay: config.requestDelay ?? 1.5,
    maxMessagesPerFetch: config.maxMessagesPerFetch ?? 5000,
    pythonPath: config.pythonPath ?? '',
    tgApiId: config.tgApiId ?? '',
    tgApiHash: config.tgApiHash ?? '',
    tgSessionPath: config.tgSessionPath ?? '',
  }
  ctx.tools.register(policyTool(ctx, cfg))
  ctx.tools.register(listTool(ctx, cfg))
  ctx.tools.register(fetchTool(ctx, cfg))
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/chat-export/api',
      handler: (req, res) => handleUiRequest(req, res, ctx, cfg),
    }),
  )
  ctx.tools.register(loginTool(ctx, cfg))
  ctx.tools.register(digestTool(ctx, cfg))
  ctx.tools.register(importTool(ctx, cfg))
  ctx.tools.register(webTool(ctx, cfg, 'open'))
  ctx.tools.register(webTool(ctx, cfg, 'probe'))
  ctx.tools.register(webTool(ctx, cfg, 'chatProbe'))
  ctx.tools.register(webTool(ctx, cfg, 'sync'))
  ctx.tools.register(webTool(ctx, cfg, 'close'))
  ctx.tools.guard(makeGuard())
  // 设置页不会自己出现：必须显式登记页面策略（auto: true 表示按 Config schema 自动生成表单）。
  const settingsHost = ctx.settings
  if (settingsHost && typeof settingsHost.configure === 'function') {
    ctx.effect(() => settingsHost.configure({ auto: true }))
  }
  ctx.commands.register(approveCommand(cfg))
  ctx.commands.register(denyCommand(cfg))
  ctx.commands.register(pendingCommand(cfg))
}

/** 平台前缀归一：tg 与 telegram 视为同一平台，避免名单 key 与代码判断不一致。 */
export function normalizePlatform(value) {
  const p = String(value ?? '').toLowerCase()
  if (p === 'tg' || p === 'telegram') return 'tg'
  return p
}
