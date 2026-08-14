from textual.widgets import Static


class NeutrinoHeader(Static):
    def on_mount(self) -> None:
        self._refresh()
        self.watch(self.app, "is_thinking", self._on_state_changed, init=False)
        self.watch(self.app, "selected_provider", self._on_state_changed, init=False)
        self.watch(self.app, "selected_model_name", self._on_state_changed, init=False)
        self.watch(self.app, "selected_intensity", self._on_state_changed, init=False)

    def _on_state_changed(self, old: object, new: object) -> None:
        self._refresh()

    def _refresh(self) -> None:
        app = self.app
        if getattr(app, "is_thinking", False):
            self.update("thinking")
        else:
            provider = getattr(app, "selected_provider", "DeepSeek")
            model = getattr(app, "selected_model_name", "deepseek-chat")
            intensity = getattr(app, "selected_intensity", "High")
            self.update(f"{provider}/{model} | {intensity}")
