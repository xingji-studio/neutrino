from textual.app import ComposeResult
from textual.containers import Center, Vertical, Horizontal
from textual.screen import Screen
from textual.widgets import Button, Input, Label, Static, Select

from src.models.config import load_config, save_config, INTENSITY_LEVELS
from src.widgets import NeutrinoHeader


class SettingsScreen(Screen):
    BINDINGS = [
        ("escape", "go_back", "Back"),
    ]

    def compose(self) -> ComposeResult:
        yield NeutrinoHeader(id="app-header")
        yield Vertical(
            Center(Static("Settings", id="settings-title", classes="screen-title")),
            Horizontal(
                Label("Language:"),
                Select(
                    [("English", "en"), ("中文", "zh")],
                    id="lang-select",
                    value="en"
                ),
                classes="settings-row"
            ),
            Horizontal(
                Label("Default Intensity:"),
                Select(
                    [(l, l) for l in INTENSITY_LEVELS],
                    id="intensity-select",
                    value="High"
                ),
                classes="settings-row"
            ),
            Center(Button("Back", id="back-btn", classes="back-button")),
            id="settings-container"
        )

    def on_mount(self) -> None:
        config = load_config()
        lang = config.get("language", "en")
        intensity = config.get("default_intensity", "High")
        try:
            self.query_one("#lang-select", Select).value = lang
            self.query_one("#intensity-select", Select).value = intensity
        except Exception:
            pass

    def action_go_back(self) -> None:
        self._save()
        self.app.pop_screen()

    def _save(self) -> None:
        config = load_config()
        try:
            config["language"] = self.query_one("#lang-select", Select).value
            config["default_intensity"] = self.query_one("#intensity-select", Select).value
        except Exception:
            pass
        save_config(config)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back-btn":
            self._save()
            self.app.pop_screen()