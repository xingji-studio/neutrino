import asyncio
import os
import subprocess
from pathlib import Path

MAX_OUTPUT = 20000
MAX_FILE_SIZE = 200000


def get_tool_definitions() -> list:
    return [
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Execute a shell command in the current working directory and return its stdout/stderr.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The shell command to execute."
                        }
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read the content of a text file. Returns the file content or an error.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file to read (absolute or relative to cwd)."
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write content to a file, creating or overwriting it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file to write (absolute or relative to cwd)."
                        },
                        "content": {
                            "type": "string",
                            "description": "The full content to write to the file."
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "List files and directories in a directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Directory to list (defaults to current working directory)."
                        }
                    },
                    "required": []
                }
            }
        }
    ]


async def execute_tool(name: str, arguments: dict) -> str:
    return await asyncio.to_thread(_execute_tool_sync, name, arguments)


def _execute_tool_sync(name: str, arguments: dict) -> str:
    try:
        if name == "run_command":
            return _run_command(arguments.get("command", ""))
        elif name == "read_file":
            return _read_file(arguments.get("path", ""))
        elif name == "write_file":
            return _write_file(arguments.get("path", ""), arguments.get("content", ""))
        elif name == "list_files":
            return _list_files(arguments.get("path", ""))
        else:
            return f"[Error: unknown tool '{name}']"
    except Exception as e:
        return f"[Error: {e}]"


def _run_command(command: str) -> str:
    if not command.strip():
        return "[Error: empty command]"
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=os.getcwd(),
        )
        parts = []
        if result.stdout:
            parts.append(result.stdout)
        if result.stderr:
            parts.append("[stderr]\n" + result.stderr)
        if result.returncode != 0:
            parts.append(f"[exit code: {result.returncode}]")
        output = "\n".join(parts).strip()
        if not output:
            return "(no output)"
        return output[:MAX_OUTPUT]
    except subprocess.TimeoutExpired:
        return "[Error: command timed out]"
    except Exception as e:
        return f"[Error: {e}]"


def _read_file(path: str) -> str:
    p = Path(path)
    if not p.is_absolute():
        p = Path(os.getcwd()) / p
    if not p.exists():
        return f"[Error: file not found: {p}]"
    if p.is_dir():
        return f"[Error: {p} is a directory]"
    try:
        data = p.read_text(encoding="utf-8", errors="replace")
        if len(data) > MAX_FILE_SIZE:
            data = data[:MAX_FILE_SIZE] + "\n...[truncated]"
        return data
    except Exception as e:
        return f"[Error: {e}]"


def _write_file(path: str, content: str) -> str:
    p = Path(path)
    if not p.is_absolute():
        p = Path(os.getcwd()) / p
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return f"Wrote {len(content)} characters to {p}"
    except Exception as e:
        return f"[Error: {e}]"


def _list_files(path: str) -> str:
    p = Path(path) if path.strip() else Path(os.getcwd())
    if not p.is_absolute():
        p = Path(os.getcwd()) / p
    if not p.exists():
        return f"[Error: directory not found: {p}]"
    if not p.is_dir():
        return f"[Error: {p} is not a directory]"
    try:
        entries = sorted(p.iterdir(), key=lambda e: e.name.lower())
        lines = []
        for e in entries:
            suffix = "/" if e.is_dir() else ""
            lines.append(e.name + suffix)
        return "\n".join(lines) or "(empty directory)"
    except Exception as e:
        return f"[Error: {e}]"
