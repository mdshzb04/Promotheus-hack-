# Feynman Gap Finder

Hackathon-ready AI learning tool based on the [Feynman Technique](https://en.wikipedia.org/wiki/Feynman_technique). Explain a topic → get surgical "but why?" questions → interactive gap map → micro-lessons → prove-it challenge.

## Quick start (~30 sec demo)

```bash
cp .env.example .env   # add OPENAI_API_KEY or ANTHROPIC_API_KEY
npm install && npm start
```

Open **http://localhost:3000** — demo pre-loaded → **Start gap hunt**.

## Standout features

| Feature | What it does |
|---------|----------------|
| **Mastery Score** | 0–100 grade + animated ring after session |
| **Knowledge Graph** | Interactive SVG — topic hub + color-coded sub-concepts |
| **Voice Explain** | Web Speech API — speak your explanation (Chrome/Edge) |
| **Gap Chips** | Live gap detection tags on every AI question |
| **Expert Snapshot** | One-line gold-standard contrast vs your explanation |
| **Prove-It Challenge** | Re-explain weakest gap — AI grades if you closed it |
| **Shareable Report** | Copy full markdown report to clipboard |
| **Typewriter AI** | Questions stream in character-by-character |

## Flow

1. Topic + 2–4 sentence explanation (type or voice)
2. 3 rounds of pinpoint "but why?" with gap classification
3. Mastery report + knowledge graph + gap map + micro-lessons
4. Optional prove-it round to boost your score

## API

| Method | Path | Body |
|--------|------|------|
| GET | `/api/health` | — |
| GET | `/api/session/:id` | — |
| GET | `/api/session/:id/report` | — |
| POST | `/api/start` | `{ topic, explanation }` |
| POST | `/api/answer` | `{ sessionId, answer }` |
| POST | `/api/prove-it` | `{ sessionId, explanation }` |

## Config

| Env | Default |
|-----|---------|
| `PORT` | `3000` |
| `MAX_ROUNDS` | `3` |
| `OPENAI_MODEL` | `gpt-4o-mini` |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` |
# Promotheus-hack-
