from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.screen import Screen
from textual.widgets import Static

from src.models.config import INTENSITY_LEVELS, load_models
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
        yield Static("", id="model-title", classes="page-title")
        yield VerticalScroll(id="model-options", classes="model-options")

    def on_mount(self) -> None:
        self.level = 0
        self.selected_provider_idx = 0
        self.selected_model_idx = 0
        self.selected_intensity_idx = 2
        self._load_data()
        self._refresh_display()

    def _load_data(self) -> None:
        data = load_models()
        self.providers = data.get("providers", [])
        self.provider_names = [p["name"] for p in self.providers]
        if self.providers:
            self.models = self.providers[0].get("models", [])
            self.model_names = [m["name"] for m in self.models]

    def _current_title(self) -> str:
        if self.level == 0:
            return "Model Selection"
        elif self.level == 1:
            return self.provider_names[self.selected_provider_idx]
        elif self.level == 2:
            return "Intensity Selection"
        return ""

    def _current_options(self) -> list:
        if self.level == 0:
            return self.provider_names
        elif self.level == 1:
            return self.model_names
        elif self.level == 2:
            return INTENSITY_LEVELS
        return []

    def _current_selection(self) -> int:
        if self.level == 0:
            return self.selected_provider_idx
        elif self.level == 1:
            return self.selected_model_idx
        elif self.level == 2:
            return self.selected_intensity_idx
        return 0

    def _refresh_display(self) -> None:
        title = self.query_one("#model-title", Static)
        title.update(self._current_title())

        container = self.query_one("#model-options", VerticalScroll)
        container.remove_children()

        options = self._current_options()
        selection = self._current_selection()
        for i, option in enumerate(options):
            if i == selection:
                widget = Static(f"▸ {option}", classes="option selected")
            else:
                widget = Static(f"  {option}", classes="option")
            container.mount(widget)

    def action_go_back(self) -> None:
        if self.level > 0:
            self.level -= 1
            self._refresh_display()
        else:
            self.app.pop_screen()

    def action_move_up(self) -> None:
        options = self._current_options()
        if not options:
            return
        if self.level == 0:
            self.selected_provider_idx = (self.selected_provider_idx - 1) % len(options)
        elif self.level == 1:
            self.selected_model_idx = (self.selected_model_idx - 1) % len(options)
        elif self.level == 2:
            self.selected_intensity_idx = (self.selected_intensity_idx - 1) % len(options)
        self._refresh_display()

    def action_move_down(self) -> None:
        options = self._current_options()
        if not options:
            return
        if self.level == 0:
            self.selected_provider_idx = (self.selected_provider_idx + 1) % len(options)
            self.models = self.providers[self.selected_provider_idx].get("models", [])
            self.model_names = [m["name"] for m in self.models]
            self.selected_model_idx = 0
        elif self.level == 1:
            self.selected_model_idx = (self.selected_model_idx + 1) % len(options)
        elif self.level == 2:
            self.selected_intensity_idx = (self.selected_intensity_idx + 1) % len(options)
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
