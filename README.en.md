# dsh-plugin-chat-export

**English** | [简体中文](README.md)

Group-chat export for DeepSeek Harness: read instant messages through an allowlist, normalise them to disk, and digest them with a local model. Telegram (fetched from the server) and WhatsApp (official export files, or WhatsApp Web) are supported.

Three rules the code follows:

1. **Consent is a human act.** The agent can only file a request; approval is a command or a settings-page action, never a tool the model can call.
2. **The gate travels with the capability.** The Telegram bridge (`bridge/tg_bridge.py`) reads the policy store itself and only serves `allow` chats, so calling it outside the plugin does not read an unapproved conversation.
3. **Say what is uncertain.** A digest marks which lines are verbatim, which are model-generated, and whether the covered window is complete.

## Install

**From GitHub (recommended)** — open **Plugins → + Add plugin** in DSH and enter:

```text
github:wth373737/dsh-plugin-chat-export
```

then **restart DSH once**; the host half and the settings page both load at startup.

**Extra requirements, per platform**

- Telegram needs Python + [Telethon](https://github.com/LonamiWebs/Telethon). A separate venv is recommended; the plugin probes `venv-tg` next to the plugin directory, and `pythonPath` can be set in Settings.
- WhatsApp Web starts its own persistent Chrome — scan the QR once. Without Chrome, use the export-file path.
- Digests use local Ollama; the model and endpoint are configured in Settings.

After installing, every chat is **unapproved**. Approve each one in **Settings → group-chat export** or with `/chat-approve`; the agent has no way to approve.

## Tools

| Tool | What it does |
|---|---|
| `chat_list` | List chats (names and ids only, never message content) |
| `chat_fetch` | Telegram: fetch one time window, normalised and de-duplicated by `msg_id` |
| `chat_import` | WhatsApp: import `.json` / `.zip` / `.txt` exports (inbox scan by default) |
| `wa_open` / `wa_close` | Start / stop the dedicated persistent Chrome |
| `wa_probe` / `wa_chat_probe` | Inspect page structure (tags and attributes only, no message text) |
| `wa_sync` | WhatsApp Web: scroll back by time watermark and store what it covered |
| `chat_digest` | Build a digest: verbatim notices, code-extracted links, model-written summary |
| `chat_policy` | Read the lists; approval is disabled here on purpose (`ui-only`) |
| `chat_login` | Telegram: generate a one-shot login script for you to run |

Human-only commands: `/chat-approve`, `/chat-deny`, `/chat-pending`.

## Gate model

```
unapproved chat → registered as pending, no content read
approved        → policy says allow → fetch → normalise → messages.jsonl
blacklisted     → no request is made at all
```

`policy.json` records every allow / deny / pending decision.

## Digests

`<export root>/<chat>/digest-YYYY-MM-DD.md` separates three things with different trust levels:

- **Important notices** — the model picks the sentence, but code verifies it exists verbatim in the source; a non-matching quote is dropped and counted.
- **Links** — extracted by regex; the model is not involved.
- **Summary and open questions** — model-generated, and each question carries its source id, marked as not individually verified.

The header states the time mode: `window` (every message has a timestamp), `snapshot` (none do) or `mixed`.

## Scheduling

Driven by a task-board card (no daemon of its own): `chat_list` → `chat_fetch` for Telegram and/or `chat_import` / `wa_sync` for WhatsApp, then one `chat_digest`.

## Known limits

- Scroll-back on WhatsApp Web is not verified with a real wheel: a real scroll event on the virtual list can trigger a CDP input timeout. The time-watermark logic itself is correct.
- A WhatsApp chat's identity is its **group name**; renaming the group creates a new chat.
- Only text bubbles carry timestamps, so image and system messages cannot be ordered in time.
- Digest quality follows the local model; a 7B model rewrites notice sentences (those get dropped by the verbatim check) and occasionally emits malformed JSON on large chunks (mitigated by smaller chunks and split retries).
- v1 covers Telegram and WhatsApp only.

## License

MIT