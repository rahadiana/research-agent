# Research Agent

Multi-platform AI research agent — bot riset otomatis dari berbagai sumber web. Menggunakan [OpenCode SDK](https://github.com/opencode-ai/sdk) untuk LLM-powered search tanpa perlu API key.

```
Research → LLM multi-round search → Scrape → Wayback/Google Cache fallback → Synthesis → Export
```

## Fitur

- **Multi-round search** — LLM cari URL dalam batch kecil (8/round), angle berbeda tiap round
- **Smart scraping** — Readability + Cheerio, cascade fallback: original → Wayback Machine → Google Cache
- **arXiv** — Query langsung API arXiv untuk paper akademik (STEM)
- **Dashboard realtime** — Glass morphism UI dengan Socket.IO update
- **Export** — Markdown, JSON, HTML
- **Docker + Cloudflare Tunnel** — Akses publik gratis via `*.trycloudflare.com`
- **Zero API key** — Cukup OpenCode server running
- **Vector DB** — Semantic search via LanceDB

## Quick Start

```bash
# 1. Clone & masuk
git clone https://github.com/rahadiana/research-agent.git
cd research-agent

# 2. Salin env
cp .env.example .env

# 3. Jalankan dengan Docker
docker compose up -d

# 4. Buka dashboard
open http://localhost:3000
```

Cloudflare Tunnel otomatis aktif — cek URL public di log:

```bash
docker compose logs cloudflared
# → https://xxxx.trycloudflare.com
```

## Cara Pakai

### Dashboard

Buka `http://localhost:3000` → isi topik → submit → lihat progress realtime.

### API

```bash
# Submit research
curl -X POST http://localhost:3000/research \
  -H 'Content-Type: application/json' \
  -d '{"topic":"quantum computing","maxSources":10,"depth":"medium"}'

# Cek status semua
curl http://localhost:3000/api/research

# Detail satu research
curl http://localhost:3000/api/research/<id>

# Export Markdown
curl http://localhost:3000/research/<id>/export/md
```

### CLI

```bash
# Langsung dari source
npm run cli -- research run "topik riset"

# Atau via binary
npm run build && node dist/cli/index.js research run "topik riset"
```

## Parameter Research

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `topic` | string | required | Topik riset |
| `maxSources` | number | 10 | Maksimal sumber yang dikumpulkan |
| `depth` | `"quick"` / `"medium"` / `"deep"` | `"medium"` | Jumlah round pencarian |
| `questions` | string[] | `[]` | Pertanyaan spesifik |

## Arsitektur

```
                    ┌─────────────────────┐
                    │    Dashboard (EJS)   │
                    │  Socket.IO realtime  │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Research Engine   │
                    │  (core/research-    │
                    │   engine.ts)        │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
  ┌───────────────┐   ┌───────────────┐   ┌────────────────┐
  │  SourceCollector│   │  LLMProvider  │   │ ResearchStorage│
  │  - opencode-   │   │  - opencode   │   │  - VectorDB    │
  │    search      │   │    provider   │   │  (LanceDB)     │
  │  - web-scraper │   └───────────────┘   └────────────────┘
  │  - pdf-reader  │
  └───────┬───────┘
          │
  ┌───────▼───────────────────────────────────────┐
  │  Cascade Scrape:                              │
  │  Original URL → Wayback Machine → Google Cache│
  └───────────────────────────────────────────────┘
```

### Source Collectors

- **opencode-search** — Multi-round LLM search + scrape + fallback
- **web-scraper** — Scrape langsung (tanpa LLM)
- **pdf-reader** — Ekstrak teks dari PDF

### Storage

Menggunakan [LanceDB](https://lancedb.github.io/lancedb/) untuk vector storage dengan semantic search. Data persist di `./data/`.

## Konfigurasi

```env
# Di .env
OPENAI_API_KEY=sk-...        # Opsional — untuk OpenAI LLM
OPENCODE_BASE_URL=...        # Opsional — kustom opencode server
DASHBOARD_PORT=3000          # Port dashboard
DASHBOARD_HOST=0.0.0.0       # Bind address
DATA_DIR=./data              # Directory penyimpanan
```

## Development

```bash
# Install dependencies
npm install

# Dev mode (watch)
npm run dev

# Build
npm run build

# Type check
npm run typecheck

# Test
npm test

# Lint
npm run lint
```

## Docker

```bash
# Build & jalankan
docker compose up -d

# Build ulang (setelah ada perubahan)
docker compose up -d --build

# Update kode tanpa rebuild (dev)
npm run build
docker cp dist/ research-agent:/app/dist/
docker compose restart research-agent

# Lihat log
docker compose logs -f research-agent

# Tunnel URL
docker compose logs cloudflared
```

## Cloudflare Tunnel

Dua opsi tunnel:

1. **Quick** (default) — URL random `*.trycloudflare.com`, tanpa akun
2. **Custom domain** — Butuh akun Cloudflare:
   ```bash
   # Setup tunnel
   cloudflared tunnel login
   cloudflared tunnel create agent
   echo "TUNNEL_TOKEN=<token>" >> .env

   # Jalankan dengan profile custom
   docker compose --profile custom up -d
   ```

## Tech Stack

- **Runtime:** Node.js 20, TypeScript (ESM)
- **LLM:** OpenCode SDK (multi-provider)
- **Web:** Express, EJS, Socket.IO
- **Scraping:** Axios, Cheerio, JSDOM, Readability
- **Storage:** LanceDB (vector DB)
- **Infra:** Docker, docker-compose, Cloudflare Tunnel

## Lisensi

MIT
