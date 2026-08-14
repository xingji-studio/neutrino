import os

from textual.app import App
from textual.reactive import reactive

from src.models.config import load_config, save_config
from src.screens.start_menu import StartMenu
from src.screens.model_select import ModelSelectScreen
from src.screens.chat_screen import ChatScreen
from src.screens.history_screen import HistoryScreen
from src.screens.settings_screen import SettingsScreen


CSS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "neutrino.tcss")


class NeutrinoApp(App):
    CSS_PATH = CSS_DIR

    SCREENS = {
        "start": StartMenu,
        "model_select": ModelSelectScreen,
        "history": HistoryScreen,
        "settings": SettingsScreen,
    }

    BINDINGS = [
        ("ctrl+m", "open_model_config", "Model Config"),
        ("ctrl+q", "quit", "Quit"),
    ]

    is_thinking = reactive(False)
    selected_provider = reactive("DeepSeek")
    selected_model_name = reactive("deepseek-chat")
    selected_intensity = reactive("High")

    def __init__(self):
        super().__init__()
        self.selected_model_url = "https://api.deepseek.com/v1"
        self.selected_model_api_key = ""
        self.selected_model_streaming = True
        self._restore_selection()

    def _restore_selection(self) -> None:
        config = load_config()
        self.selected_provider = config.get("selected_provider", "DeepSeek")
        self.selected_model_name = config.get("selected_model", "deepseek-chat")
        self.selected_intensity = config.get("selected_intensity", "High")
        self.selected_model_url = config.get("selected_model_url", "https://api.deepseek.com/v1")
        self.selected_model_api_key = config.get("selected_model_api_key", "")
        self.selected_model_streaming = config.get("selected_model_streaming", True)

    def on_mount(self) -> None:
        self.push_screen("start")

    def set_model_config(self, provider_name: str, model: dict, intensity: str) -> None:
        self.selected_provider = provider_name
        self.selected_model_name = model["name"]
        self.selected_model_url = model["url"]
        self.selected_model_api_key = model.get("api_key", "")
        self.selected_model_streaming = model.get("supports_streaming", True)
        self.selected_intensity = intensity

        config = load_config()
        config["selected_provider"] = provider_name
        config["selected_model"] = model["name"]
        config["selected_intensity"] = intensity
        config["selected_model_url"] = model["url"]
        config["selected_model_api_key"] = model.get("api_key", "")
        config["selected_model_streaming"] = model.get("supports_streaming", True)
        save_config(config)

    def start_new_chat(self, initial_message: str = "") -> None:
        screen = ChatScreen(initial_message=initial_message)
        self.push_screen(screen)

    def load_session(self, data: dict) -> None:
        screen = ChatScreen()
        screen._loaded_messages = data.get("messages", [])
        screen.session_id = data.get("id")
        if data.get("provider"):
            screen.model_config = {
                "provider": data.get("provider", "DeepSeek"),
                "name": data.get("model", "deepseek-chat"),
                "url": self.selected_model_url,
                "api_key": self.selected_model_api_key,
                "supports_streaming": True
            }
        if data.get("intensity"):
            screen.intensity = data.get("intensity", "High")
        if data.get("provider"):
            self.selected_provider = data.get("provider", "DeepSeek")
        if data.get("model"):
            self.selected_model_name = data.get("model", "deepseek-chat")
        if data.get("intensity"):
            self.selected_intensity = data.get("intensity", "High")
        self.push_screen(screen)

    def action_open_model_config(self) -> None:
        self.push_screen("model_select")

    def action_quit(self) -> None:
        self.exit()

    def action_back_to_start(self) -> None:
        self.pop_screen()


if __name__ == "__main__":
    app = NeutrinoApp()
    app.run()