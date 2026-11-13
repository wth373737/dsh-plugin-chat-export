// WhatsApp 官方导出（_chat.txt / .zip）的解析与归一化。
// 这个模块不 import 任何 Telegram 相关代码：它只做「文本 → 归一化消息」。
// 持久化与策略判断由调用方注入，因此两个平台之间不存在代码耦合。
import { createHash } from "node:crypto"

const NL = String.fromCharCode(10)

/** 内容指纹：WhatsApp 导出没有稳定消息 id，用它做去重键。 */
export function fingerprint(platform, chatKey, iso, sender, text) {
  return createHash("sha1").update([platform, chatKey, iso, sender, text].join("\u0001")).digest("hex").slice(0, 24)
}

/** 解析 [13/11/2026, 09:12:33] Name: text 与 13/11/2026, 09:12 - Name: text 两种。 */
const BRACKET = /^\[(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*([APap][Mm]))?\]\s?(.*)$/
const DASH = /^(\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*([APap][Mm]))?\s+-\s+(.*)$/

export function parseTimestamp(datePart, timePart, meridiem) {
  const parts = datePart.split(/[\/.\-]/).map((x) => Number(x))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  let [a, b, c] = parts
  let year, month, day
  if (a > 31) {
    year = a; month = b; day = c
  } else if (c > 31) {
    year = c; month = b; day = a
    if (month > 12) { month = a; day = b }
  } else if (c < 100) {
    // 两位数年份（如 11/13/26）：年份放末段，日/月按合法性纠正
    year = c < 70 ? 2000 + c : 1900 + c
    month = b; day = a
    if (month > 12) { month = a; day = b }
  } else {
    return null
  }
  if (year < 100) year += 2000
  const tm = timePart.split(":").map((x) => Number(x))
  let hour = tm[0] || 0
  const minute = tm[1] || 0
  const second = tm[2] || 0
  if (meridiem) {
    const pm = meridiem.toLowerCase() === "pm"
    if (pm && hour < 12) hour += 12
    if (!pm && hour === 12) hour = 0
  }
  const stamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return Number.isNaN(stamp.getTime()) ? null : stamp.toISOString()
}

const SYSTEM_HINTS = [
  "messages and calls are end-to-end encrypted",
  "you changed the",
  "changed the subject",
  "changed this group",
  "joined using this group",
  "added you",
  "created group",
  "deleted this message",
  "this message was deleted",
]

function looksSystem(text) {
  const low = text.toLowerCase()
  return SYSTEM_HINTS.some((hint) => low.includes(hint))
}

const MEDIA_HINTS = [/<media omitted>/i, /image omitted/i, /video omitted/i, /audio omitted/i, /document omitted/i, /sticker omitted/i, /GIF omitted/i, /<attached:/i]

function mediaKind(text) {
  const low = text.toLowerCase()
  if (/image omitted|<attached:.*\.(jpe?g|png|webp)/i.test(low)) return "image"
  if (/video omitted|\.mp4/.test(low)) return "video"
  if (/audio omitted|\.opus|\.m4a|\.mp3/.test(low)) return "audio"
  if (/sticker omitted/.test(low)) return "sticker"
  if (/document omitted|\.pdf|\.docx?|\.zip/.test(low)) return "file"
  return "file"
}

/**
 * 把 _chat.txt 的全文解析成归一化消息。
 * 解析不了的行不丢弃：计入 warnings，方便导入报告里如实展示。
 */
export function parseChatText(text, options = {}) {
  const platform = options.platform || "wa"
  const chatKey = options.chatKey || ""
  const raw = String(text || "").replace(/\r\n/g, NL).replace(/\r/g, NL)
  const lines = raw.split(NL)
  const messages = []
  const warnings = []
  let current = null
  let parsed = 0
  let unparsed = 0

  const flush = () => {
    if (!current) return
    const body = current.parts.join(NL).trim()
    const isSystem = looksSystem(body)
    const isMedia = MEDIA_HINTS.some((re) => re.test(body))
    messages.push({
      platform,
      chat_key: chatKey,
      ts: current.iso,
      sender: current.sender,
      kind: isSystem ? "service" : isMedia ? mediaKind(body) : "text",
      text: body,
      uid: fingerprint(platform, chatKey, current.iso, current.sender || "", body),
    })
    current = null
  }

  for (const line of lines) {
    const bracket = BRACKET.exec(line)
    const dashed = bracket ? null : DASH.exec(line)
    const match = bracket || dashed
    if (match) {
      flush()
      const iso = parseTimestamp(match[1], match[2], match[3])
      const rest = match[4] || ""
      if (!iso) {
        // 解析不了就只记进报告，不产出伪消息（否则会污染按时间读窗口）。
        unparsed += 1
        warnings.push({ line: line.slice(0, 120), reason: "无法解析日期" })
        current = null
        continue
      }
      const sep = rest.indexOf(": ")
      const sender = sep > 0 ? rest.slice(0, sep).trim() : null
      const body = sep > 0 ? rest.slice(sep + 2) : rest
      current = { iso, sender, parts: [body] }
      parsed += 1
    } else if (current) {
      current.parts.push(line)
    } else if (line.trim().length > 0) {
      unparsed += 1
      warnings.push({ line: line.slice(0, 120), reason: "首行之前的内容" })
    }
  }
  flush()

  const service = messages.filter((m) => m.kind === "service").length
  const withTs = messages.filter((m) => m.kind !== "service")
  return {
    messages,
    stats: {
      total: messages.length,
      service,
      parsed,
      unparsed,
      first_ts: withTs.length > 0 ? withTs[0].ts : null,
      last_ts: withTs.length > 0 ? withTs[withTs.length - 1].ts : null,
    },
    warnings: warnings.slice(0, 20),
  }
}

/** 从导出文件名推断会话名：WhatsApp Chat with X.zip / WhatsApp Chat - X.zip */
export function chatNameFromFile(fileName) {
  const base = String(fileName || "").replace(/\.(zip|txt)$/i, "")
  const match = /WhatsApp (?:Chat with|Chat)\s*[-–]?\s*(.+)$/i.exec(base)
  return match ? match[1].trim() : base.trim()
}

export function slugOfName(name) {
  const cleaned = String(name || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "")
  return cleaned.slice(0, 80) || "whatsapp-chat"
}


/**
 * 解析 IS Chat Exporter 之类的扩展导出的 JSON：
 * { version, source, conversation: { name }, exported_at, message_count, messages: [{ id, sender, timestamp, type, content }] }
 * 注意：这类导出常常没有时间戳（timestamp 为 null），此时 ts 记为 null，由调用方按「快照」语义处理。
 */
const JSON_KIND = {
  text: "text",
  document: "file",
  image: "image",
  video: "video",
  audio: "audio",
  voice: "voice",
  sticker: "sticker",
  gif: "image",
}

export function parseJsonExport(text, options = {}) {
  const platform = options.platform || "wa"
  const chatKey = options.chatKey || ""
  let doc
  try {
    doc = JSON.parse(String(text || ""))
  } catch {
    throw new Error("不是合法的 JSON")
  }
  const rawMessages = Array.isArray(doc && doc.messages) ? doc.messages : []
  const chatName = String((doc && doc.conversation && doc.conversation.name) || "").trim()
  const exportedAtRaw = String((doc && doc.exported_at) || "").trim()
  const exportedAt = exportedAtRaw && !Number.isNaN(Date.parse(exportedAtRaw)) ? new Date(exportedAtRaw).toISOString() : null
  const messages = []
  let empty = 0
  let withTs = 0
  for (const raw of rawMessages) {
    const content = String((raw && raw.content) || "").replace(/\n{3,}/g, NL + NL).trim()
    if (content.length === 0) {
      empty += 1
      continue
    }
    const type = String((raw && raw.type) || "text").toLowerCase()
    const sender = String((raw && raw.sender) || "").trim() || null
    let ts = null
    if (raw && raw.timestamp && !Number.isNaN(Date.parse(raw.timestamp))) ts = new Date(raw.timestamp).toISOString()
    if (ts) withTs += 1
    messages.push({
      platform,
      chat_key: chatKey,
      ts,
      sender,
      kind: JSON_KIND[type] || (type === "text" ? "text" : "file"),
      text: content,
      uid: fingerprint(platform, chatKey, ts || "", sender || "", content),
    })
  }
  return {
    chatName,
    exportedAt,
    messages,
    stats: {
      total: messages.length,
      with_ts: withTs,
      without_ts: messages.length - withTs,
      empty,
      declared: Number(doc && doc.message_count) || rawMessages.length,
      first_ts: null,
      last_ts: null,
    },
    warnings: [],
  }
}


function clockParts(timePart, meridiem) {
  const tm = String(timePart || "0:0").split(":").map((x) => Number(x))
  let hour = tm[0] || 0
  const minute = tm[1] || 0
  const second = tm[2] || 0
  if (meridiem) {
    const pm = String(meridiem).toLowerCase() === "pm"
    if (pm && hour < 12) hour += 12
    if (!pm && hour === 12) hour = 0
  }
  return [hour, minute, second]
}

/**
 * 解析 WhatsApp Web 消息节点上的 data-pre-plain-text，
 * 形如 [16:29, 2026年10月30日] 某人:  或  [4:29 PM, 30/10/2026] Someone:
 * 日期可能跟界面语言走：中文用 年月日，英文用斜杠。
 */
export function parsePrePlain(text) {
  const raw = String(text || "").trim()
  const match = /^\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*([APap][Mm]))?,\s*([^\]]+)\]\s*([\s\S]*)$/.exec(raw)
  if (!match) return null
  const [, timePart, meridiem, datePartRaw, rest] = match
  const datePart = datePartRaw.trim()
  let iso = null
  const cn = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(datePart)
  if (cn) {
    const [hour, minute, second] = clockParts(timePart, meridiem)
    const stamp = new Date(Date.UTC(Number(cn[1]), Number(cn[2]) - 1, Number(cn[3]), hour, minute, second))
    if (!Number.isNaN(stamp.getTime())) iso = stamp.toISOString()
  } else {
    iso = parseTimestamp(datePart, timePart, meridiem)
  }
  if (!iso) return null
  const sep = rest.indexOf(": ")
  const sender = sep > 0 ? rest.slice(0, sep).trim() : null
  const body = sep > 0 ? rest.slice(sep + 2) : rest
  return { iso, sender, body }
}
