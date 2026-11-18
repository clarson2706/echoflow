# EchoFlow: design

Date: 2026-11-17. Status: awaiting approval.

## Intent

EchoFlow is a voice tool for Windows. Hold Ctrl+Space, talk, release, and clean, structured text appears in whatever app has focus. Every session is saved to a searchable dashboard. A separate **note mode** listens through a whole meeting, lecture or brain-dump and ends with one finished, organized note.

The author mostly dictates notes, messages to Claude, and emails. The point is that the output is what they meant to say, not a word-for-word transcript. The cleanup step is the product; transcription only feeds it.

It is a standalone open-source project, published on GitHub for other people. Its inspiration is Wispr Flow, which is cloud-only, paid, and has little memory of past sessions. EchoFlow should be local-first, free, and strong where Wispr is weak: history, organization and note-taking.

## Goals

1. **Dictation anywhere.** A global hold-to-talk hotkey (default Ctrl+Space, configurable) inserts cleaned text into the focused app. Target: text appears about 1 s after release on a mid-range GPU.
2. **Cleanup that changes meaning for the better and never changes the facts.** Removes filler and false starts, resolves self-corrections ("Tuesday, no, Wednesday" becomes "Wednesday"), adds punctuation and paragraphs, handles spoken formatting ("new line", "bullet"), and applies the personal dictionary.
3. **Output styles.** Cleaned text, bullet list, to-do list, email, and message (short, casual). The style can be chosen manually and auto-suggested from the focused app.
4. **Note mode.** A toggle starts a long listening session. Speech is transcribed continuously. When it ends, the model produces a structured note (title, summary, headed sections, key points, action items), with the raw transcript kept beside it.
5. **Dashboard.** Every dictation and note is saved locally with raw text, cleaned text, timestamp, source app and duration. It supports full-text search, filtering, copy, re-clean in another style, edit, export (Markdown/txt), and delete.
6. **Local-first and private.** Transcription always runs on the user's machine. Nothing leaves the machine unless the user picks a cloud cleanup provider and supplies their own key.
7. **Works for people without the author's GPU.** NVIDIA GPU is the fast path; CPU is a supported path with a smaller default model.
8. **Installable like an app.** One installer, with no Python or CUDA setup for the user.

## Non-goals (first release)

- macOS and Linux (the design keeps the engine separate from the UI so they can be added).
- Mobile, browser extension, or cloud sync.
- Speaker identification in meetings (system audio is captured, but speakers are not labeled).
- Voice commands that control the computer ("open Chrome").
- Real-time streaming text that appears while the user is still talking (text is inserted on release).
- Accounts, telemetry, or any hosted service run by the project.

## Anti-goals (a failure even if it technically works)

- Cleanup that invents, drops or rewrites facts, names, numbers or dates.
- Pasting that clobbers the user's clipboard permanently or fails silently in common apps.
- Audio or text sent anywhere without the user explicitly choosing that.
- A setup that needs a developer to install.
- A hotkey that feels laggy or sticks on.

## Constraints

- Windows 11 first. The author's machine is an RTX 3060 Ti with 8 GB VRAM, and that is the performance reference.
- The author stays on the free tier of Google's Gemini API; the Gemini provider must work within those limits.
- Reuse Murmur (https://github.com/clarson2706/murmur, MIT, the author's own project) wherever it fits: model loading, GPU/CPU detection and fallback, batch-size selection, CUDA library registration, voice-activity detection, audio decoding. Murmur is file-based, so live capture and chunked streaming are new work.
- Open source license: MIT (matching Murmur).

## Approaches considered

- **A. Python tray app with a local web dashboard.** Fastest to build and reuses Murmur directly. The tray UI would feel rough, and a user-facing Python install is a poor fit for a public project.
- **B. Desktop shell (Tauri or Electron) around a Python engine. Chosen.** It looks and installs like a real product, and Murmur's engine carries over. The cost is bundling a Python runtime and packaging.
- **C. Single native app on whisper.cpp.** Easiest distribution and no Python, but Murmur's code mostly cannot be reused, and the GPU path is harder.

The author chose B.

## Design

### Architecture

Two processes that talk over a local-only channel (localhost HTTP/WebSocket on a random port with a per-launch token, or stdio):

1. **Shell (UI process).** Tray icon, global hotkey, recording overlay (small floating pill showing listening/processing), settings, dashboard, text insertion into the focused app, installer and auto-update.
2. **Engine (Python sidecar, bundled).** Audio capture, voice-activity detection, transcription (faster-whisper, adapted from Murmur), cleanup via a provider interface, note generation, and the SQLite store. The shell launches it, keeps it warm so the model stays loaded, and restarts it if it dies.

The engine exposes a small set of operations: start/stop dictation, start/stop note session, get/search/edit/delete history, re-clean, settings, and health/hardware info. The dashboard reads and writes through these operations only, so the engine can later run behind a different shell.

### Dictation flow

hotkey down → start capture and show the overlay → hotkey up → stop capture → voice-activity trim → transcribe → cleanup (style + dictionary + context) → insert → save to history.

- **Insertion** uses clipboard paste (save the clipboard, set the text, send Ctrl+V, restore the clipboard), with a typing-simulation fallback for apps that block paste. Recording the focused app's name and window title feeds both the history and style auto-suggest.
- **Hold-to-talk** is the default. A tap-to-toggle mode is available for hands-free use.
- Very short or silent captures are discarded without calling cleanup.
- The raw transcript is always kept so a bad cleanup is recoverable.

### Cleanup

A provider interface with one prompt contract: input is raw text, style, dictionary terms and app context; output is cleaned text only. The prompt forbids adding information and keeps names, numbers and dates exactly. Providers:

- **Local (default).** A small instruction-tuned model run on-device. The specific model and runtime are left to the builder, with the requirement that it works offline, runs acceptably on the reference GPU alongside Whisper in 8 GB, and has a CPU path.
- **Gemini** with the user's own key (works on the free tier, with rate-limit handling).
- **OpenAI-compatible endpoint** with the user's own key and base URL (covers OpenAI, OpenRouter, and local servers like Ollama or LM Studio).
- **Off.** Rule-based cleanup only (filler removal, capitalization, punctuation from Whisper), so the app still works with no model.

If the provider fails or times out, EchoFlow inserts the best rule-based cleanup rather than nothing, and flags the entry in history so it can be re-cleaned later.

### Note mode

A toggle (separate hotkey, default Ctrl+Shift+Space, and a button in the dashboard) starts a session. Audio comes from the microphone and, optionally, the computer's own audio (Windows WASAPI loopback), so online calls (Zoom, Teams, Meet) and recorded lectures can be noted. The two sources are captured as separate streams and merged by time, with a per-session choice of mic, system, or both. Audio is chunked at pauses and transcribed continuously, with no cleanup per chunk and nothing typed into other apps. The dashboard shows a live transcript and elapsed time. On stop, the full transcript goes to the note generator, which produces: title, short summary, sections with headings, key points, decisions, and action items. Very long sessions are summarized in stages so context limits are not hit. The audio itself is not kept by default (an option can keep it). The result is saved as a note linked to its raw transcript. The user can regenerate with a different template (meeting, lecture, brain-dump, journal) or edit by hand. If the app crashes mid-session, the transcript so far is recovered on next launch.

### Dashboard

- **History.** A single timeline of dictations and notes, newest first, with full-text search (SQLite FTS), filters (type, app, date, style), and tags.
- **Entry view.** Cleaned text on top, raw transcript behind a toggle, copy/edit/export/delete, and "re-clean as…" for another style or provider.
- **Notes view.** Rendered Markdown with the transcript beside it.
- **Dictionary.** Names and jargon, and replacement rules.
- **Settings.** Hotkeys, microphone, model size, hardware status, cleanup provider and key, styles, insertion method, history retention, launch at login.
- **Sketch (home):**

```
+--------------------------------------------------------------+
| EchoFlow          [ Search history...          ]  [● Note]    |
+-----------+--------------------------------------------------+
| History   | Today                                            |
| Notes     |  10:42  Gmail   Email    "Hi Sam, thanks for..." |
| Dictionary|  10:15  Claude  Message  "Can you check the..."  |
| Settings  |  09:30  Note    Marketing lecture  (42 min)      |
+-----------+--------------------------------------------------+
```

### Data and privacy

One SQLite file in the user's app-data folder holds entries, notes, dictionary and settings. API keys go in the Windows credential store, not the database. History retention is configurable, including "don't save text". There is no telemetry. The only network use is model downloads, update checks (can be disabled), and a cloud cleanup provider if the user turns one on, and the settings screen says plainly which of those are active.

### Hardware handling

On first run the engine detects the GPU and picks a Whisper model and compute type (large-v3-turbo on GPU, a small/base model on CPU, selectable). The model downloads once, with a progress screen. The settings screen shows what was detected and why.

### Packaging and publishing

A Windows installer that bundles the shell and the Python engine. CUDA libraries are fetched at first run or bundled, whichever keeps the installer reasonable (builder's call). The repository gets a README with a demo GIF, install steps, a privacy section, and contributing notes. Releases are published as GitHub Releases with auto-update. New repo `echoflow` under the author's GitHub account.

## Decisions made by the assistant (flag any you disagree with)

- MIT license.
- Hold-to-talk default with tap-toggle as an option.
- Clipboard-paste insertion with typing fallback.
- Local cleanup as the default provider, with Gemini and OpenAI-compatible as options.
- SQLite with full-text search for the dashboard.
- Python sidecar engine with a Tauri-or-Electron shell (see below).
- Audio not stored by default.

## Decisions from the author after the builder check

- **System audio is in scope for note mode from the first release**, alongside the microphone.
- **Quality versus speed:** the author delegated this to the assistant. The call: the 1 s target applies to rule-based and cloud cleanup; local-model cleanup may take 2 to 3 s. Before inserting, a fact check confirms that every number, date and capitalized name in the raw speech survives in the cleaned text, and if it fails the rule-based version is inserted instead. Accuracy wins over speed when both cannot be met. The builder should include a short model-selection spike and an eval set, with an acceptance bar of no fact loss on the eval set.

## Calls made after the builder check (assistant's, flag any you disagree with)

- **Languages:** English only in the first release. Whisper and the rules are kept language-agnostic where cheap, so more can be added.
- **Hardware:** NVIDIA GPU (fast path) and CPU (supported, smaller model) only. AMD and Intel GPUs run on the CPU path. First-run downloads of the speech model and cleanup model are acceptable, with a progress screen. The installer ships unsigned at first (SmartScreen warning documented in the README); code signing is a later task.
- **Elevated windows:** insertion into admin-level windows and apps that block synthetic input is out of scope. When insertion fails, EchoFlow copies the text to the clipboard and shows a toast saying so. "Common apps" means the manual checklist in the test strategy.
- **Hotkey:** Ctrl+Space is the default but configurable, because it conflicts with input-method switching on some keyboards.
- **Style and context:** the app-to-style mapping is a built-in table the user can edit, and it applies automatically (the user can override per dictation). The window title is never sent to a cloud provider; only the app name and chosen style are.
- **"Don't save text" retention:** history entries are not written. Note-mode crash recovery still keeps a temporary transcript for the active session only, and deletes it when the session ends. Re-clean is unavailable for entries that were not saved.
- **Gemini on the free tier:** best-effort only. Long notes are summarized in few, large calls with backoff on rate limits; if the limits are hit, the note falls back to the local provider.

## Left to the builder

- Tauri vs Electron. Weigh bundle size and hotkey/insertion APIs on Windows; pick one and state why.
- The local cleanup model and runtime.
- Exact IPC mechanism between shell and engine.
- Streaming and chunking details for note mode, including the VAD thresholds.
- UI framework and visual design (see the `impeccable` skill for design work).
- Test strategy: unit tests for cleanup contracts and database, an evaluation set of messy speech samples with expected cleaned output, and a manual checklist for insertion in common apps (browser, Word, VS Code, Slack/Discord, Notion).
- Build order. A sensible first slice is: engine + hotkey + paste with rule-based cleanup, then LLM cleanup and history, then note mode, then the polished dashboard and installer.
