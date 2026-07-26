# Swara

Swara is a voice-native personal context layer for the web. It combines three inputs — the current webpage's visible structure, a natural-language voice instruction from the user, and a persistent personal context vault — to produce structured browser actions against the fields on the current page. The goal is to let users complete any web form as naturally as speaking aloud, without repeatedly re-entering the same personal details.

Swara is deliberately **not** an autonomous browser agent. It does not navigate between pages, click through multi-site workflows, or submit forms on its own. It reads the page you are on, proposes actions, and executes them only after you confirm.

## Architecture

```
Chrome Extension (MV3)
  ├── Side Panel (React)      — voice capture, status display, vault viewer
  └── Content Script          — DOM inspection, field extraction, action execution
          ↕ (WebSocket / REST)
FastAPI + Pipecat Server
  ├── Sarvam AI               — speech-to-text, text-to-speech, OCR
  └── Gemini                  — reasoning, field-mapping, intent resolution
          ↕
Supabase
  └── Context Vault            — persistent user profile, preferences, past fills
```

## Repo Layout

```
swara/
├── extension/          # Chrome MV3 extension source
│   ├── src/
│   │   ├── background/ # service worker
│   │   ├── content/    # content script (DOM / field extractor)
│   │   ├── sidepanel/  # side-panel React UI
│   │   └── types/      # shared message types
│   ├── manifest.config.ts
│   └── package.json
├── server/             # FastAPI / Pipecat backend
│   ├── app.py
│   ├── requirements.txt
│   └── .env.example
└── demo/               # Self-contained HTML fixture forms for development
    ├── job-application.html
    └── event-registration.html
```

## Setup

### Extension

```bash
cd extension
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension/dist` directory.

### Server

```bash
cd server
pip install -r requirements.txt
uvicorn app:app --reload
```

The server starts on `http://localhost:8000` by default.

## Configuration

Copy `server/.env.example` to `server/.env` and fill in the values.

| Variable | Purpose |
|---|---|
| `SARVAM_API_KEY` | Sarvam AI — speech-to-text, text-to-speech, and OCR |
| `GOOGLE_API_KEY` | Google Gemini API — reasoning and field-mapping |
| `SUPABASE_URL` | Supabase project URL — context vault database |
| `SUPABASE_SERVICE_KEY` | Supabase service-role key — read/write vault access |
