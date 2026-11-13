# Voice

The web app has two voice features. Dictation turns speech into text in the composer and never sends it by itself. The voice assistant holds a spoken conversation about a session: it passes your requests to the agent, answers permission requests when you say yes or no, and tells you what the agent did.

Both need a provider key on the hub. Add keys under Settings → Voice; they are saved on the hub, take effect without a restart, and never reach the browser in full. Environment variables set when the hub starts take priority over keys saved in Settings.

## Dictation

Choose Dictation under Settings → Voice, then a provider. Tap the microphone in the composer, speak, and tap it again; the text goes into the composer for you to edit and send.

| Provider | Environment variable |
|---|---|
| OpenAI | `OPENAI_API_KEY` |
| ElevenLabs | `ELEVENLABS_API_KEY` |
| Deepgram | `DEEPGRAM_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Any OpenAI-compatible server, such as a local Speaches | `TRANSCRIPTION_BASE_URL`, `TRANSCRIPTION_MODEL`, optional `TRANSCRIPTION_API_KEY` |

Realtime mode shows the transcript while you speak. Desktop browsers that support on-device speech recognition also offer Browser on-device, which needs no key and keeps the audio on your computer.

## Voice assistant

Choose Voice assistant under Settings → Voice. It runs on one of three backends:

| Backend | Environment variable |
|---|---|
| ElevenLabs Conversational AI | `ELEVENLABS_API_KEY` |
| Gemini Live | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| Qwen Realtime | `DASHSCOPE_API_KEY` or `QWEN_API_KEY` |

With more than one configured, the hub uses ElevenLabs unless `VOICE_BACKEND` says otherwise (`elevenlabs`, `gemini-live` or `qwen-realtime`), and each browser can pick its own in Settings.

Open a session and tap the microphone in the composer; with an empty composer the send button shows it. Then talk:

| You say | What happens |
|---|---|
| "Ask it to run the tests" | The request goes to the agent |
| "Refactor the auth module" | Coding requests go to the agent too |
| "Yes", "Allow", "Go ahead" | The pending permission request is approved |
| "No", "Deny" | It is denied |
| A question it can answer itself | It answers without bothering the agent |

The assistant stays quiet while the agent works and sums up when the turn ends. Settings → Voice also sets the language, the voice, how long its answers are, and whether it greets you or briefs you on recent activity when you connect.

ElevenLabs sessions stream audio between your browser and ElevenLabs directly; the hub only hands out short-lived tokens. On first use the hub creates an assistant agent in your ElevenLabs account; set `ELEVENLABS_AGENT_ID` to use one of your own. Gemini Live and Qwen Realtime sessions go through a proxy on the hub, which adds the key.

## Troubleshooting

If the hub says a key isn't configured, add it under Settings → Voice, or set the variable and restart the hub. If the browser never asks for the microphone, check its site permissions for the hub's address; browsers only allow the microphone over HTTPS or on `localhost`. On Xiaomi phones, apps that draw over other apps (wallet overlays, chat bubbles, screen recorders) can block the microphone prompt; turn them off and try again.
