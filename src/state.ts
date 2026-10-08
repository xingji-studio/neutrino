export interface AppState {
  selectedProvider: string;
  selectedModelName: string;
  selectedModelUrl: string;
  selectedModelApiKey: string;
  selectedModelStreaming: boolean;
  selectedIntensity: string;
  isThinking: boolean;
  /** Blink phase for the "thinking" indicator in the top status bar. */
  blinkOn: boolean;
  /** Blink phase for the text cursors (true = lit, false = hidden). */
  cursorOn: boolean;
}

export function defaultState(): AppState {
  return {
    selectedProvider: "DeepSeek",
    selectedModelName: "deepseek-chat",
    selectedModelUrl: "https://api.deepseek.com/v1",
    selectedModelApiKey: "",
    selectedModelStreaming: true,
    selectedIntensity: "High",
    isThinking: false,
    blinkOn: false,
    cursorOn: true,
  };
}
