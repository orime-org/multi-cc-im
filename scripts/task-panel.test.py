"""Behavior checks for the local Codex terminal plan viewer."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("task-panel.py")
SPEC = importlib.util.spec_from_file_location("task_panel", SCRIPT)
PANEL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PANEL)


class PlanViewerTests(unittest.TestCase):
    """Show each task and connection state without exposing cache paths."""

    def test_each_task_and_connection_state_are_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session-a.json"
            path.write_text(json.dumps({
                "title": "project tasks", "note": "Disconnected | saved checklist",
                "plan": [{"step": "Done", "status": "completed"},
                         {"step": "Working", "status": "in_progress"},
                         {"step": "Later", "status": "pending"}],
            }))
            output = subprocess.check_output([
                sys.executable, str(SCRIPT), "--session", "session-a",
                "--state-dir", directory, "--once",
            ], text=True)
            for expected in ("project tasks  1/3", "Disconnected", "[x] Done", "[>] Working", "[ ] Later"):
                self.assertIn(expected, output)

    def test_waiting_view_does_not_look_like_a_file_selector(self):
        path = Path("/not-created/session-a.json")
        self.assertNotIn(str(path), "\n".join(PANEL.read_lines(path)))
        self.assertIn("Waiting", "\n".join(PANEL.read_lines(path)))

    def test_clipping_keeps_chinese_characters_and_removes_terminal_controls(self):
        self.assertEqual(PANEL.clip("中文a", 4), "中文")
        self.assertNotIn("\x1b", PANEL.clip("\x1bhello", 20))

    def test_invalid_session_id_cannot_select_another_cache(self):
        with self.assertRaises(ValueError):
            PANEL.state_path(Path("/tmp"), "../outside")


if __name__ == "__main__":
    unittest.main()
