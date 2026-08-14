import json
import httpx
from typing import AsyncGenerator

from src.models.config import INTENSITY_PARAMS


class LLMClient:
    def __init__(self, model_config: dict, intensity: str):
        self.model = model_config
        self.intensity = intensity
        params = INTENSITY_PARAMS.get(intensity, INTENSITY_PARAMS["High"])
        self.temperature = params["temperature"]
        self.top_p = params["top_p"]

    async def stream(self, messages: list) -> AsyncGenerator[str, None]:
        url = self.model["url"].rstrip("/") + "/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.model['api_key']}"
        }

        provider = self.model.get("provider", "")
        if provider == "Anthropic":
            async for chunk in self._stream_anthropic(messages):
                yield chunk
            return

        payload = {
            "model": self.model["name"],
            "messages": messages,
            "temperature": self.temperature,
            "top_p": self.top_p,
            "stream": True
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        line = line.strip()
                        if not line:
                            continue
                        if line.startswith("data: "):
                            data = line[6:]
                            if data == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data)
                                delta = chunk.get("choices", [{}])[0].get("delta", {})
                                content = delta.get("content", "")
                                if content:
                                    yield content
                            except json.JSONDecodeError:
                                continue
            except httpx.HTTPStatusError as e:
                yield f"\n[Error: HTTP {e.response.status_code} - {e.response.text}]"
            except httpx.RequestError as e:
                yield f"\n[Error: Connection failed - {e}]"

    async def _stream_anthropic(self, messages: list) -> AsyncGenerator[str, None]:
        url = self.model["url"].rstrip("/") + "/messages"
        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.model["api_key"],
            "anthropic-version": "2023-06-01"
        }

        system_msg = None
        chat_messages = []
        for m in messages:
            if m["role"] == "system":
                system_msg = m["content"]
            else:
                chat_messages.append({"role": m["role"], "content": m["content"]})

        payload = {
            "model": self.model["name"],
            "messages": chat_messages,
            "max_tokens": 4096,
            "temperature": self.temperature,
            "stream": True
        }
        if system_msg:
            payload["system"] = system_msg

        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        line = line.strip()
                        if not line or not line.startswith("data: "):
                            continue
                        data = line[6:]
                        try:
                            chunk = json.loads(data)
                            if chunk.get("type") == "content_block_delta":
                                delta = chunk.get("delta", {})
                                content = delta.get("text", "")
                                if content:
                                    yield content
                        except json.JSONDecodeError:
                            continue
            except httpx.HTTPStatusError as e:
                yield f"\n[Error: HTTP {e.response.status_code}]"
            except httpx.RequestError as e:
                yield f"\n[Error: Connection failed - {e}]"

    async def non_stream(self, messages: list) -> str:
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
            "stream": False
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            try:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                data = resp.json()
                return data["choices"][0]["message"]["content"]
            except httpx.HTTPStatusError as e:
                return f"[Error: HTTP {e.response.status_code} - {e.response.text}]"
            except httpx.RequestError as e:
                return f"[Error: Connection failed - {e}]"