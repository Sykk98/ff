// Client dei modelli AI lato server.
// - provider "ollama": API nativa di Ollama (permette di impostare il contesto, vedi ollama.js)
// - provider "openai": qualsiasi endpoint compatibile con OpenAI /chat/completions
//   (OpenRouter, Mistral, LM Studio, llama.cpp server, vLLM, DeepSeek, ecc.)
import { streamOllamaChat } from './ollama.js';
import { streamWithModelFallback } from '../docs/core/openai.js';
import { saveSettings } from './store.js';

/** Stream di testo dal modello: async iterator di { text } e, alla fine, { finishReason }. */
export async function* streamChat(settings, messages, opts = {}) {
  if (settings.provider === 'ollama') {
    // Ollama ha URL e modello propri, così passare da un provider all'altro non perde la configurazione.
    yield* streamOllamaChat({ ...settings, baseUrl: settings.ollamaUrl, model: settings.ollamaModel }, messages, opts);
    return;
  }
  yield* streamWithModelFallback(settings, messages, opts, (model) => saveSettings({ model }));
}
