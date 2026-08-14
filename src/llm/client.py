import json
import httpx
from typing import AsyncGenerator, Optional

from src.models.config import INTENSITY_PARAMS


class LLMClient:
    def __init__(self, model_config: dict, intensity: str):
        self.model = model_config
        self.intensity = intensity
        params = INTENSITY_PARAMS.get(intensity, INTENSITY_PARAMS["High"])
        self.temperature = params["temperature"]
        self.top_p = params["top_p"]
        self.tool_calls: list = []

    async def stream_turn(
        self,
        messages: list,
        tools: Optional[list] = None,
    ) -> AsyncGenerator[str, None]:
        """Stream a single assistant turn.

        Yields content text chunks for display. When the stream completes,
        `self.tool_calls` holds any tool calls the model requested, as a list
        of dicts: {"id", "name", "arguments"}.
        """
        self.tool_calls = []
        url = self.model["url"].rstrip("/") + "/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.model['api_key']}"
        }

        payload = {
            "model": self.model["name"],
            "messages": messages,
            "temperature": self.temperature,
            "top_p": self.top_p,
            "stream": True
        }
        if tools:
            payload["tools"] = tools

        tool_calls_by_index = {}

        async with httpx.AsyncClient(timeout=300.0) as client:
            try:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        line = line.strip()
                        if not line or not line.startswith("data: "):
                            continue
                        data = line[6:]
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        choice = chunk.get("choices", [{}])[0]
                        delta = choice.get("delta", {})

                        content = delta.get("content", "")
                        if content:
                            yield content

                        for tc in delta.get("tool_calls", []) or []:
                            idx = tc.get("index", 0)
                            entry = tool_calls_by_index.setdefault(
                                idx, {"id": "", "name": "", "arguments": ""}
                            )
                            if tc.get("id"):
                                entry["id"] = tc["id"]
                            fn = tc.get("function", {})
                            if fn.get("name"):
                                entry["name"] = fn["name"]
                            if fn.get("arguments"):
                                entry["arguments"] += fn["arguments"]
            except httpx.HTTPStatusError as e:
                yield f"\n[Error: HTTP {e.response.status_code}]"
            except httpx.RequestError as e:
                yield f"\n[Error: Connection failed - {e}]"

        self.tool_calls = [
            tool_calls_by_index[i] for i in sorted(tool_calls_by_index)
        ]

    async def stream(self, messages: list) -> AsyncGenerator[str, None]:
        """Legacy plain-text stream (no tools)."""
        async for chunk in self.stream_turn(messages, tools=None):
            yield chunk
