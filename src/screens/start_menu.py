from pathlib import Path

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Center, Grid, Vertical
from textual.screen import Screen
from textual.widgets import Button, Input, Static

from src.widgets import NeutrinoHeader

LOGO_PATH = Path(__file__).parent.parent.parent / "logo.txt"


def load_logo() -> str:
    try:
        return LOGO_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "NEUTRINO"


class StartMenu(Screen):
    BINDINGS = [
        Binding("left", "focus_prev", "", priority=True),
        Binding("right", "focus_next", "", priority=True),
        Binding("up", "focus_prev", "", priority=True),
        Binding("down", "focus_next", "", priority=True),
        Binding("ctrl+m", "open_model_config", "", priority=True),
        Binding("escape", "quit_app", "", priority=True),
    ]

    tab_ids = ["tab-model", "tab-history", "tab-settings"]

    def compose(self) -> ComposeResult:
        logo_text = load_logo()
        yield NeutrinoHeader(id="app-header")
        yield Vertical(
            Center(Static(logo_text, id="logo", classes="logo")),
            Center(Input(placeholder="Type a message to start a new chat...", id="start-input", classes="start-input")),
            Center(
                Grid(
                    Button("Model", id="tab-model", classes="tab-button"),
                    Button("History", id="tab-history", classes="tab-button"),
                    Button("Settings", id="tab-settings", classes="tab-button"),
                    id="tab-bar",
                    classes="tab-bar"
                ),
                id="tab-container"
            ),
            id="start-container"
        )

    def on_mount(self) -> None:
        self.query_one("#start-input", Input).focus()

    def _focusables(self) -> list:
        return [self.query_one("#start-input", Input)] + [
            self.query_one(f"#{tab_id}", Button) for tab_id in self.tab_ids
        ]

    def _move_focus(self, direction: int) -> None:
        focusables = self._focusables()
        focused = self.focused
        try:
            index = focusables.index(focused)
        except ValueError:
            index = 0
        index = (index + direction) % len(focusables)
        focusables[index].focus()

    def action_focus_prev(self) -> None:
        self._move_focus(-1)

    def action_focus_next(self) -> None:
        self._move_focus(1)

    def action_open_model_config(self) -> None:
        self.app.push_screen("model_select")

    def action_quit_app(self) -> None:
        self.app.exit()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        if text:
            self.app.start_new_chat(text)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "tab-model":
            self.app.push_screen("model_select")
        elif event.button.id == "tab-history":
            self.app.push_screen("history")
        elif event.button.id == "tab-settings":
            self.app.push_screen("settings")
