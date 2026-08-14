from textual.app import ComposeResult
from textual.containers import Center, Vertical
from textual.screen import Screen
from textual.widgets import Button, Label, Static

from src.models.config import get_models_by_provider, INTENSITY_LEVELS, load_models, save_models
from src.widgets import NeutrinoHeader


class ModelSelectScreen(Screen):
    BINDINGS = [
        ("escape", "go_back", "Back"),
        ("up", "move_up", ""),
        ("down", "move_down", ""),
        ("enter", "confirm", ""),
    ]

    def __init__(self):
        super().__init__()
        self.level = 0
        self.providers = []
        self.models = []
        self.selected_provider_idx = 0
        self.selected_model_idx = 0
        self.selected_intensity_idx = 2
        self.provider_names = []
        self.model_names = []

    def compose(self) -> ComposeResult:
        yield NeutrinoHeader(id="app-header")
        yield Vertical(
            Center(Static("Model Selection", id="model-title", classes="screen-title")),
            Center(Label("Use UP/DOWN to navigate, ENTER to confirm", id="model-hint", classes="hint")),
            Center(Static("", id="model-content", classes="model-content")),
            id="model-container"
        )

    def on_mount(self) -> None:
        self._load_data()
        self._refresh_display()

    def _load_data(self) -> None:
        data = load_models()
        self.providers = data.get("providers", [])
        self.provider_names = [p["name"] for p in self.providers]
        if self.providers:
            self.models = self.providers[0].get("models", [])
            self.model_names = [m["name"] for m in self.models]

    def _refresh_display(self) -> None:
        content = self.query_one("#model-content", Static)
        lines = []

        if self.level == 0:
            lines.append("[bold]Select Provider:[/bold]\n")
            for i, name in enumerate(self.provider_names):
                prefix = "▸ " if i == self.selected_provider_idx else "  "
                lines.append(f"{prefix}{name}")
        elif self.level == 1:
            provider_name = self.provider_names[self.selected_provider_idx]
            lines.append(f"[bold]{provider_name} - Select Model:[/bold]\n")
            for i, model in enumerate(self.models):
                prefix = "▸ " if i == self.selected_model_idx else "  "
                lines.append(f"{prefix}{model['name']}")
        elif self.level == 2:
            model_name = self.model_names[self.selected_model_idx]
            lines.append(f"[bold]Model: {model_name} - Select Intensity:[/bold]\n")
            for i, level in enumerate(INTENSITY_LEVELS):
                prefix = "▸ " if i == self.selected_intensity_idx else "  "
                lines.append(f"{prefix}{level}")

        content.update("\n".join(lines))

    def action_go_back(self) -> None:
        if self.level > 0:
            self.level -= 1
            self._refresh_display()
        else:
            self.app.pop_screen()

    def action_move_up(self) -> None:
        if self.level == 0:
            self.selected_provider_idx = (self.selected_provider_idx - 1) % len(self.provider_names)
            self.models = self.providers[self.selected_provider_idx].get("models", [])
            self.model_names = [m["name"] for m in self.models]
            self.selected_model_idx = 0
        elif self.level == 1:
            self.selected_model_idx = (self.selected_model_idx - 1) % len(self.model_names)
        elif self.level == 2:
            self.selected_intensity_idx = (self.selected_intensity_idx - 1) % len(INTENSITY_LEVELS)
        self._refresh_display()

    def action_move_down(self) -> None:
        if self.level == 0:
            self.selected_provider_idx = (self.selected_provider_idx + 1) % len(self.provider_names)
            self.models = self.providers[self.selected_provider_idx].get("models", [])
            self.model_names = [m["name"] for m in self.models]
            self.selected_model_idx = 0
        elif self.level == 1:
            self.selected_model_idx = (self.selected_model_idx + 1) % len(self.model_names)
        elif self.level == 2:
            self.selected_intensity_idx = (self.selected_intensity_idx + 1) % len(INTENSITY_LEVELS)
        self._refresh_display()

    def action_confirm(self) -> None:
        if self.level == 0:
            if self.providers:
                self.level = 1
                self.models = self.providers[self.selected_provider_idx].get("models", [])
                self.model_names = [m["name"] for m in self.models]
                self.selected_model_idx = 0
                self._refresh_display()
        elif self.level == 1:
            if self.models:
                self.level = 2
                self.selected_intensity_idx = 2
                self._refresh_display()
        elif self.level == 2:
            provider_name = self.provider_names[self.selected_provider_idx]
            model = self.models[self.selected_model_idx]
            intensity = INTENSITY_LEVELS[self.selected_intensity_idx]
            self.app.set_model_config(provider_name, model, intensity)
            self.app.pop_screen()

    def on_key(self, event) -> None:
        if event.key in ("up", "down", "enter", "escape"):
            return
        event.stop()