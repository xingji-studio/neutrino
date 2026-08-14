from textual.app import ComposeResult
from textual.containers import Center, Vertical, VerticalScroll
from textual.screen import Screen
from textual.widgets import Button, Label, Static

from src.models.config import list_sessions, load_session
from src.widgets import NeutrinoHeader


class HistoryScreen(Screen):
    BINDINGS = [
        ("escape", "go_back", "Back"),
        ("up", "move_up", ""),
        ("down", "move_down", ""),
        ("enter", "load_selected", ""),
        ("delete", "delete_selected", "Delete"),
    ]

    def __init__(self):
        super().__init__()
        self.sessions = []
        self.selected_idx = 0

    def compose(self) -> ComposeResult:
        yield NeutrinoHeader(id="app-header")
        yield Vertical(
            Center(Static("History", id="history-title", classes="screen-title")),
            Center(Label("Select a session to load", id="history-hint", classes="hint")),
            VerticalScroll(
                id="history-list",
                can_focus=False
            ),
            Center(Button("Back", id="back-btn", classes="back-button")),
            id="history-container"
        )

    def on_mount(self) -> None:
        self._refresh()

    def _refresh(self) -> None:
        self.sessions = list_sessions()
        self.selected_idx = 0
        self._render()

    def _render(self) -> None:
        container = self.query_one("#history-list", VerticalScroll)
        container.remove_children()

        if not self.sessions:
            container.mount(Static("[dim]No sessions yet[/dim]", classes="empty-msg"))
            return

        for i, session in enumerate(self.sessions):
            prefix = "▸ " if i == self.selected_idx else "  "
            created = session.get("created_at", "unknown")[:19]
            model = session.get("model", "?")
            provider = session.get("provider", "?")
            intensity = session.get("intensity", "?")
            count = session.get("message_count", 0)
            label = f"{prefix}[bold]{created}[/bold] | {provider}/{model} ({intensity}) | {count} messages"
            widget = Static(label, classes="session-item" if i != self.selected_idx else "session-item selected")
            container.mount(widget)

    def action_go_back(self) -> None:
        self.app.pop_screen()

    def action_move_up(self) -> None:
        if self.sessions:
            self.selected_idx = (self.selected_idx - 1) % len(self.sessions)
            self._render()

    def action_move_down(self) -> None:
        if self.sessions:
            self.selected_idx = (self.selected_idx + 1) % len(self.sessions)
            self._render()

    def action_load_selected(self) -> None:
        if not self.sessions:
            return
        session = self.sessions[self.selected_idx]
        data = load_session(session["id"])
        if data:
            self.app.pop_screen()
            self.app.load_session(data)

    def action_delete_selected(self) -> None:
        if not self.sessions:
            return
        session = self.sessions[self.selected_idx]
        import shutil
        from pathlib import Path
        from src.models.config import SESSION_DIR
        path = SESSION_DIR / f"{session['id']}.json"
        if path.exists():
            path.unlink()
        self._refresh()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back-btn":
            self.app.pop_screen()