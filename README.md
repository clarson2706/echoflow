# EchoFlow

**Hold a key, speak, and clean text appears in any app.** EchoFlow also takes notes for you: start a
note, talk (or play a lecture or call), and finish with a structured note. Everything you say is kept
in a searchable history on your own computer.

- **Dictate anywhere.** Hold `Ctrl+Space` (configurable), speak, let go. Filler words and false starts
  are removed, self-corrections are applied ("Tuesday, no, Wednesday" becomes "Wednesday"), and the text
  is pasted where your cursor is.
- **Note mode.** Listens to your microphone, your computer's audio, or both, and ends with a note: title,
  summary, sections, key points and action items, with the raw transcript kept beside it.
- **History dashboard.** Search everything, view the original next to the cleaned text, re-clean as bullets,
  a to-do list, an email or a message, edit, export, delete.
- **Private by default.** Speech is transcribed on your machine with Whisper. Nothing is uploaded unless you
  add your own cleanup model key, and then only the words you spoke are sent.
- **Never loses a fact.** Model output is checked: every number, date and name you said must survive, or
  EchoFlow falls back to the offline cleanup.

## Install

Download **EchoFlow-Setup-x.y.z.exe** from the [latest release](https://github.com/clarson2706/echoflow/releases/latest)
and run it. It installs for your user account, with no admin rights, and starts EchoFlow when it finishes.
Windows may show a "SmartScreen" warning because the installer is not code-signed yet: choose **More info**, then **Run anyway**.

First launch sets itself up once: with an NVIDIA GPU it downloads the GPU libraries (about 1.2 GB) and the speech
model (about 1.6 GB); without one it uses a smaller model on the CPU (about 0.5 GB, slower). The dashboard shows progress.

### Updates

EchoFlow checks for new versions on launch and every few hours, downloads them quietly, and shows **Update ready** in
the sidebar and tray menu. Updates install when you restart (or next quit). Turn automatic updates off, or check
manually, in **Settings**.

### Run from source

You need Windows 10/11, [Node.js](https://nodejs.org) 20+ and [uv](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/clarson2706/echoflow && cd echoflow
npm install
cd engine && uv sync --extra gpu && cd ..    # drop "--extra gpu" if you have no NVIDIA GPU
npm start
```

Build the installer yourself with `npm run dist` (output in `dist-out/`).

## Use

| Do this | To get this |
|---|---|
| Hold `Ctrl+Space` in any app, speak, release | Cleaned text pasted at the cursor |
| `Ctrl+Shift+Space`, or **Start note** | Note mode on and off |
| Tray icon | Open the dashboard, start a note, pause the hotkey, quit |

Settings (hotkeys, writing style, cleanup model, note sources, privacy) live in the dashboard.

### Better cleanup with a model (optional)

Out of the box EchoFlow uses offline rules. For smarter rewording, pick **Google Gemini** (the free tier works) or
any **OpenAI-compatible** endpoint, including local servers like Ollama, in Settings, and paste a key. Keys are
encrypted with Windows DPAPI and are not stored in the history database. If the model is slow, down, or drops
a number or name, EchoFlow pastes the offline version instead and marks the entry so you can re-clean it later.

## Privacy

- Audio is never saved (unless you ask) and never leaves your computer.
- The history database is a single SQLite file in `%APPDATA%\echoflow\data`. Turn off **Keep history** to paste
  without saving anything.
- No accounts, no telemetry. The only network use is the one-time model download and, if you enable it, your
  chosen cleanup model.

## Known limits

- Windows only for now. English only.
- Pasting into windows running as administrator does not work (Windows blocks it); the text stays on the
  clipboard and you get a notice.
- `Ctrl+Space` is taken by input-method switching on some keyboard layouts; change it in Settings.
- Speaker names are not detected; computer audio and your voice are mixed into one transcript.
- The installer is not code-signed yet, so Windows shows a SmartScreen warning.

## Development

```sh
cd engine && uv run pytest              # unit and API tests, plus a real-Whisper test
node tests/e2e.js                       # drives the real app: hotkey, fake microphone, paste, notes, loopback, crash recovery
E2E_EXE=dist-out/win-unpacked/EchoFlow.exe node tests/e2e.js   # the same, against the packaged app
```

Layout: `app/` is the Electron shell (tray, hotkeys, overlay, capture, paste), `engine/` is the Python engine
(Whisper, cleanup, fact check, notes, SQLite), `ui/` is the dashboard. Design notes: `docs/superpowers/`.

The speech code is adapted from [Murmur](https://github.com/clarson2706/murmur) (MIT). Fonts: Cormorant Garamond
and Inter (SIL OFL), bundled in `ui/fonts`.

## License

MIT
