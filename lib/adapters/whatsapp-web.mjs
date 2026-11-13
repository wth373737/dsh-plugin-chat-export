// WhatsApp Web 的浏览器侧适配：持久 profile + puppeteer-core（从宿主 profile 解析，不重复安装）。
// 这个模块只做「打开页面 / 侦察 DOM / 抓取」，不 import 任何 Telegram 代码。
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

function baseCandidates() {
  const bases = []
  const push = (v) => { if (typeof v === "string" && v.length > 0 && !bases.includes(v)) bases.push(v) }
  push(process.env.DSH_PROFILE_DIR)
  const home = process.env.DSH_HOME
  if (typeof home === "string" && home.length > 0) {
    const profiles = path.join(home, "profiles")
    try {
      for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) push(path.join(profiles, entry.name))
      }
    } catch {}
  }
  return bases
}

async function loadPuppeteer() {
  try {
    const direct = await import("puppeteer-core")
    return direct.default ?? direct
  } catch {}
  for (const base of baseCandidates()) {
    try {
      const require = createRequire(path.join(base, "package.json"))
      const entry = require.resolve("puppeteer-core")
      const loaded = await import(pathToFileURL(entry).href)
      return loaded.default ?? loaded
    } catch {}
  }
  throw new Error("找不到 puppeteer-core：插件目录与宿主 profile 都解析不到")
}

let session = { browser: null, page: null }

export function sessionState() {
  return { open: Boolean(session.page), url: session.page ? session.page.url() : null }
}

export async function openSession(options) {
  if (session.page) return session
  const puppeteer = await loadPuppeteer()
  const port = options.port || 9222

  // 先尝试附着到上次启动、现在仍在运行的实例：插件重载后不必重新扫码，
  // 也不会因为同一 profile 被占用而启动失败。
  try {
    const attached = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 240000 })
    const pages = await attached.pages()
    let page = pages.find((p) => p.url().includes("web.whatsapp.com")) || pages[0]
    if (!page) page = await attached.newPage()
    if (!page.url().includes("web.whatsapp.com")) {
      await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded", timeout: 90000 })
    }
    session = { browser: attached, page }
    return session
  } catch {}

  const browser = await puppeteer.launch({
    executablePath: options.chromePath,
    headless: false,
    userDataDir: options.profileDir,
    defaultViewport: null,
    protocolTimeout: 240000,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      `--remote-debugging-port=${port}`,
    ],
  })
  const pages = await browser.pages()
  const page = pages.length > 0 ? pages[0] : await browser.newPage()
  await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded", timeout: 90000 })
  session = { browser, page }
  return session
}

export async function closeSession() {
  if (!session.browser) return false
  try { await session.browser.close() } catch {}
  session = { browser: null, page: null }
  return true
}

/** 登录态判定：有 #pane-side 视为已进入主界面；有二维码画布视为待扫码。 */
const readState = () =>
  session.page.evaluate(() => ({
    hasPane: Boolean(document.querySelector("#pane-side")),
    hasQr: Boolean(document.querySelector("canvas[aria-label], div[data-ref]")),
    title: document.title,
    text: (document.body.innerText || "").slice(0, 200),
  }))

/** 等主界面出现（或超时）；刚打开时 SPA 还没 hydrate，立即读会误判未登录。 */
export async function sessionStatus(waitMs = 0) {
  if (!session.page) return { open: false }
  const deadline = Date.now() + Math.max(0, waitMs)
  let info = await readState()
  while (!info.hasPane && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      info = await readState()
    } catch {
      break
    }
  }
  return { open: true, url: session.page.url(), ...info, loggedIn: info.hasPane }
}

/** 侦察：报告左栏与消息区的关键节点（标签/属性/计数），不涉及消息正文。 */
export async function probeDom() {
  if (!session.page) throw new Error("浏览器还没打开，先调用 wa_open")
  return session.page.evaluate(() => {
    const describe = (node) =>
      node
        ? {
            tag: node.tagName,
            id: node.id || "",
            cls: (node.className || "").toString().slice(0, 80),
            attrs: Array.from(node.attributes).map((a) => a.name).slice(0, 12),
            placeholder: node.getAttribute("placeholder") || "",
            contenteditable: node.getAttribute("contenteditable") || "",
          }
        : null
    const sels = [
      "#side",
      "#pane-side",
      "#main",
      "[contenteditable]",
      "input",
      "#side [contenteditable]",
      "#side input",
      "div[role=row]",
      "[data-pre-plain-text]",
    ]
    const out = {}
    for (const sel of sels) {
      let nodes = []
      try {
        nodes = Array.from(document.querySelectorAll(sel))
      } catch {
        nodes = []
      }
      out[sel] = { count: nodes.length, first: describe(nodes[0]) }
    }
    return out
  })
}export async function openChatByName(name) {
  if (!session.page) throw new Error("浏览器还没打开，先调用 wa_open")
  const page = session.page

  // 一次性写入搜索值并派发 input：逐字符输入会让 WhatsApp 在几千个会话里重复搜索，
  // 渲染线程被长任务占满，evaluate 会因此超时。
  const ok = await page.evaluate((value) => {
    const input = document.querySelector("#side input")
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.focus()
    return true
  }, name)
  if (!ok) throw new Error("找不到左侧搜索框（#side input）")

  await new Promise((resolve) => setTimeout(resolve, 1800))
  await page.keyboard.press("Enter")
  try {
    await page.waitForSelector("#main", { timeout: 20000 })
    return true
  } catch {
    return false
  }
}/** 侦察已打开会话的消息节点结构（只报标签与属性名，不回消息正文）。 */
export async function probeMessages() {
  if (!session.page) throw new Error("浏览器还没打开，先调用 wa_open")
  return session.page.evaluate(() => {
    const sels = ["#main div[data-id]", "#main div[data-pre-plain-text]", "#main div.message-in", "#main div.message-out", "#main span.selectable-text", "#main [role=row]"]
    const out = {}
    for (const sel of sels) {
      let nodes = []
      try { nodes = Array.from(document.querySelectorAll(sel)) } catch { nodes = [] }
      const first = nodes[0]
      out[sel] = {
        count: nodes.length,
        attrs: first ? Array.from(first.attributes).map((a) => a.name) : [],
        prePlain: first ? (first.getAttribute("data-pre-plain-text") || "").slice(0, 100) : "",
        dataId: first ? (first.getAttribute("data-id") || "").slice(0, 100) : "",
        textLen: first ? (first.innerText || "").length : 0,
      }
    }
    const hist = {}
    for (const node of document.querySelectorAll("#main [data-testid]")) {
      const key = node.getAttribute("data-testid")
      hist[key] = (hist[key] || 0) + 1
    }
    const dataIds = Array.from(document.querySelectorAll("#main [data-id]"))
      .slice(0, 5)
      .map((node) => (node.getAttribute("data-id") || "").slice(0, 60))
    const header = document.querySelector("#main header")
    const title = header ? (header.innerText || "").split("\\n")[0] : ""
    return { title, out, hist, dataIds }
  })
}

/** 截当前页面到文件，便于人工核对（也用于排查抓取失败）。 */
export async function screenshot(file) {
  if (!session.page) throw new Error("浏览器还没打开，先调用 wa_open")
  await session.page.screenshot({ path: file, fullPage: false })
  return file
}

/** 等消息渲染出来：刚打开会话时面板还在转圈，立即读只能看到一条系统提示。 */
export async function waitForMessages(minCount = 3, timeoutMs = 30000) {
  if (!session.page) throw new Error("浏览器还没打开，先调用 wa_open")
  const page = session.page
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  let count = 0
  while (Date.now() < deadline) {
    try {
      count = await page.evaluate(() => document.querySelectorAll("#main [data-id]").length)
    } catch {
      count = 0
    }
    if (count >= minCount) return count
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return count
}

/** 读出当前面板里的消息行（id / data-pre-plain-text / 正文）。 */
export async function scrapeRows() {
  if (!session.page) throw new Error("浏览器还没打开，先调用 wa_open")
  return session.page.evaluate(() => {
    // 时间与发送者挂在 data-pre-plain-text 上；它可能就在行节点本身，也可能在子节点里，
    // 所以从持有者反找最近的 role=row，而不是从行往下找。
    const holders = Array.from(document.querySelectorAll("#main [data-pre-plain-text]"))
    return holders.map((holder) => {
      const row = holder.closest("[role=row]") || holder
      const textNode = row.querySelector("span.selectable-text")
      const withId = row.hasAttribute("data-id") ? row : row.querySelector("[data-id]")
      return {
        id: withId ? (withId.getAttribute("data-id") || "") : "",
        testid: row.getAttribute("data-testid") || "",
        pre: holder.getAttribute("data-pre-plain-text") || "",
        text: textNode ? (textNode.innerText || "") : "",
      }
    })
  })
}
/**
 * 小步向上滚动并确认是否真的加载了更早的消息。
 * 大跳跃（scrollTop = 0）不会触发懒加载，还会把渲染线程顶住导致 CDP 超时。
 */
export async function scrollStep(stepPx = 500, waitMs = 700) {
  if (!session.page) throw new Error("浏览器还没打开，先调用 wa_open")
  const page = session.page
  const read = () =>
    page.evaluate(() => {
      const panel = document.querySelector("[data-testid=conversation-panel-messages]")
      return {
        rows: document.querySelectorAll("#main [role=row]").length,
        top: panel ? panel.scrollTop : -1,
      }
    })
  const before = await read()
  await page.evaluate((step) => {
    const panel = document.querySelector("[data-testid=conversation-panel-messages]")
    if (!panel) return
    panel.scrollTop = Math.max(0, panel.scrollTop - step)
    // 有些版本只监听 scroll 事件，改 scrollTop 不派发事件就不会触发加载
    panel.dispatchEvent(new Event("scroll", { bubbles: true }))
  }, stepPx)
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  const after = await read()
  return {
    before,
    after,
    loaded: after.rows > before.rows || (before.top > 0 && after.top < before.top),
    atTop: after.top <= 0,
  }
}