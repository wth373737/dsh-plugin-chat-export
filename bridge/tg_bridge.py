#!/usr/bin/env python3
"""Telegram bridge for the DSH chat-export plugin.

Contract: ONE JSON object on stdout, diagnostics on stderr.
Exit codes: 0 ok | 2 needs login | 3 config/policy error | 4 rate limited
Credentials come from the environment (TG_API_ID / TG_API_HASH / TG_SESSION),
never from the command line.

This process enforces the allowlist itself: `fetch` refuses any chat the policy
file does not mark as `allow`. The gate follows the capability, not the caller.
"""
import argparse
from contextlib import asynccontextmanager
import asyncio
import datetime as dt
import json
import os
import sys

EXIT_OK, EXIT_LOGIN, EXIT_CONFIG, EXIT_FLOOD = 0, 7, 3, 4


def emit(payload, code=EXIT_OK):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(code)


def env(name):
    value = os.environ.get(name, "").strip()
    return value or None


def here():
    return os.path.dirname(os.path.abspath(__file__))


def credentials():
    api_id, api_hash = env("TG_API_ID"), env("TG_API_HASH")
    if not api_id or not api_hash:
        emit(
            {
                "ok": False,
                "error": "missing credentials",
                "hint": "在 设置 -> 群聊导出 填写 tgApiId / tgApiHash 后重试。",
            },
            EXIT_CONFIG,
        )
    try:
        return int(api_id), api_hash
    except ValueError:
        emit({"ok": False, "error": "api_id is not a number"}, EXIT_CONFIG)


def session_path():
    return env("TG_SESSION") or os.path.join(here(), "tg")


def policy_path():
    return env("CHAT_EXPORT_POLICY") or os.path.join(here(), "policy.json")


def allowlisted(chat_id):
    path = policy_path()
    if not os.path.exists(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as handle:
            chats = (json.load(handle) or {}).get("chats") or {}
    except Exception:  # noqa: BLE001
        return False
    for entry in chats.values():
        if str(entry.get("id")) == str(chat_id) and entry.get("decision") == "allow":
            return True
    return False


def new_client():
    from telethon import TelegramClient

    api_id, api_hash = credentials()
    return TelegramClient(session_path(), api_id, api_hash)


@asynccontextmanager
async def opened(client):
    """Open an authorized session without ever entering Telethon's interactive
    login flow: `async with client` calls start(), which prompts on stdin when
    the session is missing -- that would hang a Host-spawned child process."""
    try:
        await client.connect()
    except Exception as error:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error": "connect failed",
                "detail": f"{type(error).__name__}: {str(error)[:240]}",
                "session": session_path(),
            },
            EXIT_CONFIG,
        )
    if not await client.is_user_authorized():
        await client.disconnect()
        emit(
            {
                "ok": False,
                "error": "not logged in",
                "hint": "先运行 login 子命令完成一次交互式登录（chat_login 工具会生成启动脚本）。",
            },
            EXIT_LOGIN,
        )
    try:
        yield client
    finally:
        await client.disconnect()

def kind_of(message):
    if message.photo:
        return "image"
    if message.sticker:
        return "sticker"
    if message.voice or message.video_note:
        return "voice"
    if message.video:
        return "video"
    if message.document or message.audio:
        return "file"
    if message.media:
        return "file"
    text = message.message or ""
    if "http://" in text or "https://" in text:
        return "link"
    return "text"


def attachments_of(message):
    if not message.media:
        return []
    file = getattr(message, "file", None)
    return [
        {
            "kind": kind_of(message),
            "name": getattr(file, "name", None) if file else None,
            "size": getattr(file, "size", None) if file else None,
            "remote_id": str(message.id),
            "downloaded": False,
        }
    ]


def sender_name_of(message):
    sender = getattr(message, "sender", None)
    if sender is None:
        return None
    for attr in ("name", "username", "first_name", "title"):
        value = getattr(sender, attr, None)
        if value:
            return str(value)
    return None


async def find_dialog(client, wanted):
    wanted = str(wanted)
    async for dialog in client.iter_dialogs():
        if str(dialog.id) == wanted or str(getattr(dialog.entity, "id", "")) == wanted:
            return dialog
    return None


async def cmd_whoami(args):
    client = new_client()
    async with opened(client):
        me = await client.get_me()
        if me is None:
            emit({"ok": False, "error": "not logged in", "hint": "运行 login 子命令"}, EXIT_LOGIN)
        emit({"ok": True, "user": me.username or me.first_name or str(me.id), "user_id": me.id, "session": session_path()})


async def cmd_login(args):
    client = new_client()
    try:
        await client.connect()
    except Exception as error:  # noqa: BLE001
        emit(
            {
                "ok": False,
                "error": "connect failed",
                "detail": f"{type(error).__name__}: {str(error)[:240]}",
                "session": session_path(),
            },
            EXIT_CONFIG,
        )
    if await client.is_user_authorized():
        me = await client.get_me()
        emit({"ok": True, "already_authorized": True, "user": me.username or me.first_name or str(me.id)})
    phone = env("TG_PHONE") or input("phone (international, e.g. +8613800000000): ").strip()
    await client.send_code_request(phone)
    code = input("login code: ").strip()
    try:
        await client.sign_in(phone=phone, code=code)
    except Exception as error:  # noqa: BLE001
        if "password" in str(error).lower():
            await client.sign_in(password=input("two-step password: ").strip())
        else:
            raise
    me = await client.get_me()
    emit({"ok": True, "user": me.username or me.first_name or str(me.id), "user_id": me.id})


async def cmd_dialogs(args):
    client = new_client()
    async with opened(client):
        from telethon.tl.types import Channel, Chat, User

        chats = []
        async for dialog in client.iter_dialogs():
            entity = dialog.entity
            kind = "user" if isinstance(entity, User) else "channel" if isinstance(entity, Channel) else "group" if isinstance(entity, Chat) else "unknown"
            chats.append(
                {
                    "id": dialog.id,
                    "name": dialog.name or "",
                    "kind": kind,
                    "last_ts": dialog.date.isoformat() if dialog.date else None,
                    "unread": getattr(dialog, "unread_count", 0) or 0,
                }
            )
        emit({"ok": True, "chats": chats})


async def cmd_fetch(args):
    if not allowlisted(args.chat):
        emit(
            {
                "ok": False,
                "error": "not allowlisted",
                "hint": "该会话不在白名单里。批准动作只能在插件的用户命令或页面上完成。",
                "chat": str(args.chat),
            },
            EXIT_CONFIG,
        )
    client = new_client()
    async with opened(client):
        dialog = await find_dialog(client, args.chat)
        if dialog is None:
            emit({"ok": False, "error": f"chat not found: {args.chat}"}, EXIT_CONFIG)
        kwargs = {"limit": args.max, "reverse": True}
        if args.since_id:
            kwargs["min_id"] = int(args.since_id)
        elif args.days:
            kwargs["offset_date"] = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=int(args.days))
        until = dt.datetime.fromisoformat(args.until).replace(tzinfo=dt.timezone.utc) if args.until else None

        messages = []
        async for message in client.iter_messages(dialog.entity, **kwargs):
            if until is not None and message.date and message.date > until:
                break
            # Telethon already batches the API round-trips, so a per-message sleep
            # only wastes wall time (and would blow the caller's timeout). Keep a
            # light cadence check every 200 messages instead.
            if len(messages) % 200 == 199:
                await asyncio.sleep(max(0.0, float(args.delay)))
            messages.append(
                {
                    "id": message.id,
                    "ts": message.date.isoformat() if message.date else None,
                    "sender_id": message.sender_id,
                    "sender_name": sender_name_of(message),
                    "kind": kind_of(message),
                    "text": message.message or "",
                    "reply_to": message.reply_to_msg_id,
                    "attachments": attachments_of(message),
                }
            )
            if len(messages) >= args.max:
                break
        emit({"ok": True, "chat": args.chat, "name": dialog.name or "", "messages": messages})


def main():
    parser = argparse.ArgumentParser(description="Telegram bridge for chat-export")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--delay", type=float, default=1.5)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("whoami")
    sub.add_parser("login")
    sub.add_parser("dialogs")
    fetch = sub.add_parser("fetch")
    fetch.add_argument("--chat", required=True)
    fetch.add_argument("--max", type=int, default=2000)
    fetch.add_argument("--days", type=int)
    fetch.add_argument("--since-id", dest="since_id", type=int)
    fetch.add_argument("--until")
    args = parser.parse_args()

    handler = {"whoami": cmd_whoami, "login": cmd_login, "dialogs": cmd_dialogs, "fetch": cmd_fetch}[args.command]
    try:
        asyncio.run(handler(args))
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        seconds = getattr(error, "seconds", None)
        if seconds is not None:
            emit({"ok": False, "error": "flood wait", "retry_after": seconds}, EXIT_FLOOD)
        text = str(error)
        if "not authorized" in text.lower() or "authkey" in text.lower():
            emit({"ok": False, "error": "not logged in", "hint": "运行 login 子命令"}, EXIT_LOGIN)
        emit({"ok": False, "error": text[:800]}, EXIT_CONFIG)


if __name__ == "__main__":
    main()
