// Chat Export — settings page for the chat-export plugin.
// Talks only to its own same-origin fenced route (custom header blocks CSRF).
window.__ModuleLoader__.load({
  id: "@local/chat-export",
  factory(require) {
    const React = require("react")
    const h = React.createElement
    const API = "/chat-export/api"
    const UI_HEADER = "x-chat-export-ui"

    const S = {
      wrap: { display: "flex", flexDirection: "column", gap: 14, fontSize: 13 },
      row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
      card: { border: "1px solid rgba(128,128,128,0.25)", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 8 },
      h2: { margin: 0, fontSize: 13, fontWeight: 600 },
      meta: { fontSize: 12, opacity: 0.65, wordBreak: "break-all" },
      input: { flex: 1, minWidth: 240, padding: "5px 8px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.35)", background: "transparent", color: "inherit" },
      btn: { padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.4)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12 },
      ok: { borderColor: "rgba(46,160,67,0.6)", color: "rgb(46,160,67)" },
      no: { borderColor: "rgba(215,58,73,0.6)", color: "rgb(215,58,73)" },
      item: { display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(128,128,128,0.15)" },
      err: { color: "rgb(215,58,73)", fontSize: 12, whiteSpace: "pre-wrap" },
      note: { color: "rgb(46,160,67)", fontSize: 12 },
      pill: { fontSize: 11, padding: "1px 6px", borderRadius: 999, border: "1px solid rgba(128,128,128,0.35)" },
    }

    function request(body) {
      const headers = { "content-type": "application/json" }
      headers[UI_HEADER] = "1"
      return fetch(API, { method: "POST", headers, body: JSON.stringify(body) }).then((res) =>
        res.json().then((data) => {
          if (!res.ok || data.ok === false) throw new Error(data.error || "HTTP " + res.status)
          return data
        }),
      )
    }

    function Row(props) {
      return h(
        "div",
        { style: S.item },
        h(
          "div",
          null,
          h("div", null, props.label || props.entry.name || props.entry.key),
          h("div", { style: S.meta }, props.entry.name ? props.entry.key : "（尚无群名，拉取一次后自动补全）"),
        ),
        h("div", { style: S.row }, props.children),
      )
    }

    function Body() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState("")
      const [error, setError] = React.useState("")
      const [note, setNote] = React.useState("")
      const [root, setRoot] = React.useState("")

      const apply = React.useCallback((data) => {
        setState(data)
        setRoot(data.output_root || "")
      }, [])

      React.useEffect(() => {
        request({ action: "status" }).then(apply).catch((err) => setError(String(err.message || err)))
      }, [apply])

      const run = React.useCallback(async (body, done) => {
        setBusy(body.action)
        setError("")
        setNote("")
        try {
          const data = await request(body)
          apply(data)
          setNote(done)
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy("")
        }
      }, [apply])

      if (error && !state) return h("div", { style: S.wrap }, h("div", { style: S.err }, "群聊导出页面无法连接 Host：" + error))
      if (!state) return h("div", { style: S.wrap }, h("div", { style: S.meta }, "正在读取…"))

      const pending = state.chats.filter((c) => c.decision === "pending")
      const allowed = state.chats.filter((c) => c.decision === "allow")
      const denied = state.chats.filter((c) => c.decision === "deny")

      return h(
        "div",
        { style: S.wrap },
        h(
          "div",
          { style: S.card },
          h("div", { style: S.h2 }, "群聊导出"),
          h(
            "div",
            { style: S.meta },
            (state.credentials ? "凭据：已配置" : "凭据：未配置") + " · " +
              "导出：" + state.output_root + " · " +
              "允许 " + state.counts.allow + " / 拒绝 " + state.counts.deny + " / 待批准 " + state.counts.pending,
          ),
          h(
            "div",
            { style: S.row },
            h("input", { style: S.input, value: root, placeholder: "导出根目录", onChange: (e) => setRoot(e.target.value) }),
            h("button", { style: S.btn, disabled: busy !== "", onClick: () => run({ action: "setRoot", value: root }, "导出根目录已更新") }, "保存目录"),
            h("button", { style: S.btn, disabled: busy !== "", onClick: () => run({ action: "status" }, "已刷新") }, "刷新"),
          ),
          h("div", { style: note ? S.note : S.meta }, note || "导出根目录决定 messages.jsonl 落在哪里；留空则用插件数据目录。"),
          error ? h("div", { style: S.err }, error) : null,
        ),
        h(
          "div",
          { style: S.card },
          h("div", { style: S.h2 }, "待批准（" + pending.length + "）"),
          pending.length === 0
            ? h("div", { style: S.meta }, "没有待批准的会话。Agent 想读新会话时会先登记到这里。")
            : pending.map((entry) =>
                h(
                  Row,
                  { key: entry.key, entry },
                  h("button", { style: { ...S.btn, ...S.ok }, disabled: busy !== "", onClick: () => run({ action: "approve", chat: entry.key, name: entry.name }, "已允许") }, "允许"),
                  h("button", { style: { ...S.btn, ...S.no }, disabled: busy !== "", onClick: () => run({ action: "deny", chat: entry.key }, "已拒绝") }, "拒绝"),
                ),
              ),
        ),
        h(
          "div",
          { style: S.card },
          h("div", { style: S.h2 }, "白名单（" + allowed.length + "）"),
          allowed.length === 0
            ? h("div", { style: S.meta }, "还没有允许任何会话。")
            : allowed.map((entry) =>
                h(
                  Row,
                  { key: entry.key, entry },
                  h("button", { style: { ...S.btn, ...S.no }, disabled: busy !== "", onClick: () => run({ action: "deny", chat: entry.key }, "已改为拒绝") }, "改为拒绝"),
                  h("button", { style: S.btn, disabled: busy !== "", onClick: () => run({ action: "reset", chat: entry.key }, "已移出名单") }, "移出名单"),
                ),
              ),
        ),
        h(
          "div",
          { style: S.card },
          h("div", { style: S.h2 }, "黑名单（" + denied.length + "）"),
          denied.length === 0
            ? h("div", { style: S.meta }, "黑名单为空。")
            : denied.map((entry) =>
                h(Row, { key: entry.key, entry },
                  h("button", { style: { ...S.btn, ...S.ok }, disabled: busy !== "", onClick: () => run({ action: "approve", chat: entry.key, name: entry.name }, "已改为允许") }, "改为允许"),
                ),
              ),
        ),
      )
    }

    class Guard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { message: "" }
      }
      static getDerivedStateFromError(error) {
        return { message: String((error && error.message) || error) }
      }
      render() {
        if (this.state.message) return h("div", { style: S.err }, "群聊导出页面出错：" + this.state.message)
        return this.props.children
      }
    }

    function Page(props) {
      return h(Guard, null, h(Body, props))
    }
    return {
      name: "chat-export-ui",
      inject: ["slots"],
      apply(ctx) {
        ctx.effect(() =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: "chat-export", order: 66, label: "群聊导出", registrant: "@local/chat-export" },
              Page,
            ),
          ),
        )
      },
    }
  },
})
