#!/usr/bin/env python3
"""
iTerm2 helper script invoked as an ephemeral subprocess per call.

Protocol (one JSON request on stdin, one JSON response on stdout):

  Request shape:
    {"action": "listSessions"}
    {"action": "sendText",      "sessionId": "<UUID>", "text": "..."}
    {"action": "sendKeystroke", "sessionId": "<UUID>", "key": "..."}

  Response shape:
    {"ok": true,  "result": <action-specific payload>}
    {"ok": false, "error": "<human-readable message>"}

Per [DD: iTerm2 adapter §6](../../../docs/superpowers/specs/2026-05-13-iterm2-adapter-dd.md#6-recommendation)
this script implements candidate C1: one short-lived Python process per
hook event, mirroring cli-cc's existing ephemeral-subprocess model. The
iTerm2 WebSocket is opened, the requested action runs, and the process
exits. No daemon, no persistent state, no lifecycle event subscription
(that's C2 territory and deferred to v2).

Stable identifier: only the UUID suffix of `ITERM_SESSION_ID` (e.g.
`"C3D91F33-3805-47E2-A3F6-B8AED6EC2209"`) is reliable. The `w<W>t<T>p<P>`
prefix shifts when other panes/tabs close, so we never echo it back as
the pane id — we always strip down to UUID before responding.

listSessions result payload (one entry per iTerm2 session):
  {"paneId": "<UUID-suffix>", "title": "<cleaned-tab-title>", "cwd": "<path-or-empty>"}

The Node-side adapter does final cleanup (cc emoji prefix strip, default
title coalesce); this helper passes raw values through with minimal
massaging.
"""

import asyncio
import json
import sys


def _err(message: str) -> int:
    sys.stdout.write(json.dumps({"ok": False, "error": message}) + "\n")
    sys.stdout.flush()
    return 1


def _ok(result) -> int:
    sys.stdout.write(json.dumps({"ok": True, "result": result}) + "\n")
    sys.stdout.flush()
    return 0


async def _list_sessions(connection):
    import iterm2

    app = await iterm2.async_get_app(connection)
    out = []
    if app is None:
        return out
    for window in app.windows:
        for tab in window.tabs:
            for session in tab.sessions:
                # session.session_id is "w<W>t<T>p<P>:UUID" — strip to UUID.
                full = session.session_id or ""
                uuid = full.split(":", 1)[1] if ":" in full else full

                # Tab-level user title (set via iTerm2's "Edit Session Name"
                # or by escape sequences). Falls back to autoName / name.
                title_var = await session.async_get_variable("session.autoName")
                title = (title_var or session.name or "").strip()

                # Working directory of the foreground process.
                cwd = await session.async_get_variable("session.path") or ""

                out.append(
                    {
                        "paneId": uuid,
                        "title": title,
                        "cwd": cwd,
                    }
                )
    return out


def _find_session_by_uuid(app, target_uuid: str):
    for window in app.windows:
        for tab in window.tabs:
            for session in tab.sessions:
                full = session.session_id or ""
                uuid = full.split(":", 1)[1] if ":" in full else full
                if uuid == target_uuid:
                    return session
    return None


async def _send_text(connection, session_id: str, text: str):
    import iterm2

    app = await iterm2.async_get_app(connection)
    if app is None:
        raise RuntimeError("iTerm2 reports no app object")
    session = _find_session_by_uuid(app, session_id)
    if session is None:
        raise RuntimeError(f"no iTerm2 session matches paneId {session_id!r}")
    await session.async_send_text(text)
    return {"sent": len(text)}


async def _send_keystroke(connection, session_id: str, key: str):
    # iTerm2 Python API has no separate "raw keystroke" verb. async_send_text
    # writes bytes directly to the pseudo-terminal; for control characters
    # like "\r" / "\x03" this delivers the keystroke verbatim to whatever
    # process is foregrounded in the session (which is what we want — cc
    # TUI receives the Enter / Ctrl-C as a real key event).
    return await _send_text(connection, session_id, key)


async def _dispatch(connection, request: dict):
    action = request.get("action")
    if action == "listSessions":
        return await _list_sessions(connection)
    if action == "sendText":
        return await _send_text(
            connection,
            request["sessionId"],
            request["text"],
        )
    if action == "sendKeystroke":
        return await _send_keystroke(
            connection,
            request["sessionId"],
            request["key"],
        )
    raise ValueError(f"unknown action {action!r}")


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        return _err("empty stdin — expected one JSON request")
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        return _err(f"stdin is not valid JSON: {exc}")

    try:
        import iterm2  # noqa: F401  — surfaces install issues with a clear message
    except ImportError:
        return _err(
            "iterm2 Python package not installed — "
            "run `python3 -m pip install --user iterm2`"
        )

    try:
        result_holder: dict = {}

        async def _run(connection):
            result_holder["value"] = await _dispatch(connection, request)

        # iterm2.run_until_complete blocks; opens WebSocket, runs callback,
        # closes WebSocket, returns. One-shot connection per invocation.
        iterm2.run_until_complete(_run)
        return _ok(result_holder.get("value"))
    except Exception as exc:  # noqa: BLE001 — surface every error to caller
        return _err(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    sys.exit(main())
