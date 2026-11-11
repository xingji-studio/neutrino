#!/usr/bin/env python3
"""Start a local Neutrino conversation and handle its approval requests."""
import argparse
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser()
parser.add_argument("message")
parser.add_argument("--cwd", default=os.getcwd())
parser.add_argument("--provider", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--intensity", default="High")
parser.add_argument("--mode", choices=["standard", "ptc", "fast", "fast_dag"], default="standard")
args = parser.parse_args()

home = Path(os.environ.get("NEUTRINO_HOME", Path.home() / ".neutrino"))
connection = json.loads((home / "api.json").read_text(encoding="utf-8"))
base = connection["url"]
headers = {"Authorization": "Bearer " + connection["token"]}


def request(route, data=None):
    request_headers = dict(headers)
    payload = None
    if data is not None:
        payload = json.dumps(data).encode()
        request_headers["Content-Type"] = "application/json"
    try:
        with urlopen(Request(base + route, payload, request_headers), timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(error.read().decode()) from error


conversation = request("/conversations", {
    "cwd": os.path.abspath(args.cwd),
    "selection": {"provider": args.provider, "model": args.model, "intensity": args.intensity},
    "agent_mode": args.mode,
    "approval_mode": "request",
})
key = conversation["key"]
print(f"Conversation: {key}", file=sys.stderr)
# Subscribe before sending: events generated after this point are retained for
# reconnect, and the initial snapshot describes the newly-created conversation.
with urlopen(Request(f"{base}/live/{key}/events", headers=headers)) as stream:
    request(f"/live/{key}/message", {"text": args.message})
    previous_text = ""
    printed_messages = set()
    previous_status = None
    handled = set()
    event = "message"
    data = []
    for raw in stream:
        line = raw.decode("utf-8").rstrip("\r\n")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
        elif not line:
            if not data:
                continue
            value = json.loads("\n".join(data))
            data = []
            if event == "snapshot":
                for index, message in enumerate(value.get("messages", [])):
                    if message.get("role") != "assistant" or index in printed_messages:
                        continue
                    completed = message.get("content", "")
                    if previous_text and completed.startswith(previous_text):
                        print(completed[len(previous_text):], end="", flush=True)
                    else:
                        print("\n" + completed, end="", flush=True)
                    printed_messages.add(index)
                    previous_text = ""
                text = value.get("streamingContent") or ""
                if text.startswith(previous_text):
                    print(text[len(previous_text):], end="", flush=True)
                elif text:
                    print("\n" + text, end="", flush=True)
                previous_text = text
                status = (value.get("busy"), value.get("paused"), bool(value.get("reviewing")))
                if status != previous_status:
                    print(f"\n[busy={status[0]} paused={status[1]} reviewing={status[2]}]", file=sys.stderr)
                    previous_status = status
                approval = value.get("approval")
            elif event == "approval.requested":
                approval = value
            elif event == "gone":
                break
            else:
                approval = None
            if approval and approval.get("id") not in handled:
                approval_id = approval["id"]
                handled.add(approval_id)
                print("\nApproval requested:\n" + json.dumps(approval, indent=2, ensure_ascii=False), file=sys.stderr)
                answer = input("Approve? [y/N] ").strip().lower() == "y"
                try:
                    request(f"/live/{key}/approvals/{approval_id}", {"approved": answer})
                except RuntimeError as error:
                    print(f"Approval could not be applied: {error}", file=sys.stderr)
            event = "message"
