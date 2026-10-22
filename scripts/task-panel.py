#!/usr/bin/env python3
"""Display one local Codex plan snapshot in a terminal pane."""

import argparse
import curses
import json
import os
import re
import shutil
import sys
import unicodedata
from pathlib import Path


def state_path(directory, session_id):
    """Keep each session inside the private display-cache directory."""
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id):
        raise ValueError("invalid session_id")
    return directory / (session_id + ".json")


def clip(text, width):
    """Clip a single line by terminal cells, including wide CJK characters."""
    result = []
    used = 0
    for char in str(text):
        if unicodedata.category(char).startswith("C"):
            continue
        cells = 0 if unicodedata.combining(char) else (
            2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
        )
        if used + cells > width:
            break
        result.append(char)
        used += cells
    return "".join(result)


def read_lines(path):
    """Read task state and return display lines, preserving useful errors."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        steps = data["plan"]
        if not isinstance(steps, list):
            raise ValueError("plan must be a list")
        symbols = {"completed": "[x]", "in_progress": "[>]", "pending": "[ ]"}
        rows = []
        for item in steps:
            status = item["status"]
            if status not in symbols:
                raise ValueError("invalid task status: " + str(status))
            rows.append(symbols[status] + " " + item["step"])
        done = sum(item["status"] == "completed" for item in steps)
        return [
            f"{data['title']}  {done}/{len(steps)}",
            data.get("note", ""),
            *rows,
            "q: close panel | local plan events | refresh: 1s",
        ]
    except FileNotFoundError:
        return ["Codex tasks", "Waiting for the local plan observer"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        return ["Task panel: unable to read saved tasks", str(error)]


def show_panel(screen, path):
    """Refresh only this pane; allow resizing and closing with q."""
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    screen.timeout(1000)
    while True:
        screen.erase()
        height, width = screen.getmaxyx()
        lines = read_lines(path)
        if len(lines) > height and height > 0:
            hidden = len(lines) - height + 1
            lines = lines[:height - 1] + [f"... {hidden} more lines; enlarge this pane"]
        for row, line in enumerate(lines):
            try:
                screen.addstr(row, 0, clip(line, max(0, width - 1)))
            except curses.error:
                # A resize can invalidate dimensions between reading and drawing.
                break
        screen.refresh()
        if screen.getch() in (ord("q"), ord("Q")):
            return


def main():
    """Render once for inspection or run an interactive task panel."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", required=True, help="session id whose plan should be displayed")
    parser.add_argument("--state-dir", type=Path,
                        default=Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "task-panel",
                        help="private display cache (default: $CODEX_HOME/task-panel)")
    parser.add_argument("--once", action="store_true", help="print without a TUI")
    args = parser.parse_args()
    try:
        path = state_path(args.state_dir, args.session)
    except ValueError as error:
        parser.error(str(error))
    if args.once or not sys.stdout.isatty():
        width = shutil.get_terminal_size((100, 24)).columns
        print("\n".join(clip(line, width) for line in read_lines(path)))
        return 0
    try:
        curses.wrapper(show_panel, path)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
