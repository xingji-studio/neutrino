import time
from pathlib import Path
from typing import Optional

from textual.app import ComposeResult
from textual.containers import VerticalScroll, Horizontal
from textual.reactive import reactive
from textual.screen import Screen
from textual.widgets import Input, Static
from textual.worker import Worker, WorkerState

from src.llm.client import LLMClient
from src.models.config import save_session
from src.widgets import NeutrinoHeader

PROMPT_PATH = Path(__file__).parent.parent.parent / "prompt.txt"


def load_prompt() -> str:
    try:
        return PROMPT_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "You are Neutrino, a helpful AI coding assistant."


class ChatScreen(Screen):
    BINDINGS = [
        ("escape", "toggle_pause", "Pause/Resume"),
        ("ctrl+b", "back_to_menu", "Back"),
        ("ctrl+l", "clear_chat", "Clear"),
    ]

    is_streaming = reactive(False)
    is_paused = reactive(False)

    def __init__(self, initial_message: str = ""):
        super().__init__()
        self.initial_message = initial_message
        self.messages = []
        self._loaded_messages = []
        self.streaming_content = ""
        self.current_stream_worker: Optional[Worker] = None
        self.queued_message: Optional[str] = None
        self.last_esc_time = 0
        self._load_config()

    def _load_config(self) -> None:
        app = self.app
        self.model_config = {
            "provider": getattr(app, "selected_provider", "DeepSeek"),
            "name": getattr(app, "selected_model_name", "deepseek-chat"),
            "url": getattr(app, "selected_model_url", "https://api.deepseek.com/v1"),
            "api_key": getattr(app, "selected_model_api_key", ""),
            "supports_streaming": getattr(app, "selected_model_streaming", True)
        }
        self.intensity = getattr(app, "selected_intensity", "High")

    def compose(self) -> ComposeResult:
        yield NeutrinoHeader(id="app-header")
        yield VerticalScroll(id="chat-log", can_focus=False)
        yield Horizontal(
            Static("", id="pause-indicator", classes="pause-indicator"),
            id="pause-container"
        )
        yield Input(placeholder="Type a message...", id="chat-input")

    def on_mount(self) -> None:
        self._render_system_info()
        for msg in self._loaded_messages:
            self._append_message(msg["role"], msg["content"])
        if self.initial_message:
            self.query_one("#chat-input", Input).value = self.initial_message
            self._send_message(self.initial_message)

    def _render_system_info(self) -> None:
        model_name = self.model_config.get("name", "unknown")
        provider = self.model_config.get("provider", "unknown")
        self._append_message("system", f"Model: {provider}/{model_name} | Intensity: {self.intensity}")

    def _append_message(self, role: str, content: str) -> None:
        self.messages.append({"role": role, "content": content})
        chat_log = self.query_one("#chat-log", VerticalScroll)

        if role == "system":
            widget = Static(f"[dim]{content}[/dim]", classes="msg-system")
        elif role == "user":
            widget = Static(f"[bold]You:[/bold]\n{content}", classes="msg-user")
        elif role == "assistant":
            widget = Static(f"[bold]Neutrino:[/bold]\n{content}", classes="msg-assistant")
        else:
            widget = Static(content, classes="msg-other")

        chat_log.mount(widget)
        chat_log.scroll_end(animate=False)

    def _update_streaming(self, content: str) -> None:
        chat_log = self.query_one("#chat-log", VerticalScroll)
        children = list(chat_log.children)

        if children and "msg-streaming" in children[-1].classes:
            children[-1].update(f"[bold]Neutrino:[/bold]\n{content}")
        else:
            widget = Static(f"[bold]Neutrino:[/bold]\n{content}", classes="msg-assistant msg-streaming")
            chat_log.mount(widget)

        chat_log.scroll_end(animate=False)

    def _finalize_streaming(self, content: str) -> None:
        chat_log = self.query_one("#chat-log", VerticalScroll)
        children = list(chat_log.children)

        if children and "msg-streaming" in children[-1].classes:
            children[-1].update(f"[bold]Neutrino:[/bold]\n{content}")
            children[-1].classes = "msg-assistant"
        else:
            self._append_message("assistant", content)

    def _show_thinking(self, show: bool) -> None:
        self.app.is_thinking = show

    def _update_pause_indicator(self) -> None:
        indicator = self.query_one("#pause-indicator", Static)
        pause_container = self.query_one("#pause-container")
        if self.is_paused:
            indicator.update("[yellow]PAUSED - Press ESC to resume[/yellow]")
            pause_container.styles.display = "block"
        elif self.is_streaming:
            indicator.update("[dim]Streaming... Press ESC to pause[/dim]")
            pause_container.styles.display = "block"
        else:
            pause_container.styles.display = "none"

    def _update_input_state(self) -> None:
        inp = self.query_one("#chat-input", Input)
        if self.is_streaming or self.is_paused:
            inp.disabled = True
            inp.placeholder = "Input will be sent when paused or idle..."
        else:
            inp.disabled = False
            inp.placeholder = "Type a message..."

    def action_toggle_pause(self) -> None:
        now = time.time()
        if now - self.last_esc_time < 0.4:
            self.is_paused = not self.is_paused
            if not self.is_paused and self.queued_message:
                msg = self.queued_message
                self.queued_message = None
                self._send_message(msg)
            return

        self.last_esc_time = now

    def action_back_to_menu(self) -> None:
        self._save_session()
        self.app.pop_screen()

    def _save_session(self) -> None:
        if len(self.messages) > 1:
            try:
                save_session(
                    self.messages,
                    self.model_config.get("name", "unknown"),
                    self.model_config.get("provider", "unknown"),
                    self.intensity
                )
            except Exception:
                pass

    def _send_message(self, text: str) -> None:
        text = text.strip()
        if not text:
            return

        self._append_message("user", text)
        self.query_one("#chat-input", Input).value = ""

        if self.is_streaming or self.is_paused:
            self.queued_message = text
            return

        self.is_streaming = True
        self._show_thinking(True)
        self._update_input_state()
        self._update_pause_indicator()

        system_prompt = load_prompt()
        api_messages = [{"role": "system", "content": system_prompt}]
        for m in self.messages:
            if m["role"] in ("user", "assistant"):
                api_messages.append({"role": m["role"], "content": m["content"]})

        self.current_stream_worker = self.run_worker(
            self._stream_response(api_messages),
            name="stream-response"
        )

    async def _stream_response(self, messages: list) -> None:
        client = LLMClient(self.model_config, self.intensity)
        self.streaming_content = ""
        try:
            async for token in client.stream(messages):
                if self.is_paused:
                    break
                self.streaming_content += token
                self._update_streaming(self.streaming_content)

            if not self.is_paused:
                self._finalize_streaming(self.streaming_content)
                self.messages.append({"role": "assistant", "content": self.streaming_content})
                self._on_stream_done()
        except Exception as e:
            error_msg = f"\n[Error: {e}]"
            self._finalize_streaming(self.streaming_content + error_msg)
            self.messages.append({"role": "assistant", "content": self.streaming_content + error_msg})
            self._on_stream_done()

    def _on_stream_done(self) -> None:
        self.is_streaming = False
        self._show_thinking(False)
        self._update_input_state()
        self._update_pause_indicator()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        if text:
            self._send_message(text)

    def watch_is_streaming(self, streaming: bool) -> None:
        self._update_input_state()
        self._update_pause_indicator()

    def watch_is_paused(self, paused: bool) -> None:
        self._update_pause_indicator()
        self._update_input_state()

    def action_clear_chat(self) -> None:
        chat_log = self.query_one("#chat-log", VerticalScroll)
        chat_log.remove_children()
        self.messages.clear()
        self._render_system_info()

    def on_screen_resume(self) -> None:
        self._update_input_state()
        self._update_pause_indicator()

    def on_worker_state_changed(self, event: Worker.StateChanged) -> None:
        if event.state == WorkerState.ERROR:
            self._on_stream_done()