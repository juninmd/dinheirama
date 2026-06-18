# Dinheirama Core

API Hono/Bun para análise de ações B3 e Bitcoin.

## Endpoints

- `GET /health`
- `GET /api/quote/:ticker` - aceita `PETR4`, `PETR4.SA`, `BTC`
- `GET /api/history/:ticker`
- `POST /api/analyze` - body `{ "ticker": "PETR4" }`
- `GET /api/portfolio` - radar padrão B3 + Bitcoin

## IA

Ordem de uso:

1. LiteLLM (`LITELLM_API_BASE`, `LITELLM_API_KEY`, `LITELLM_MODEL`)
2. Ollama (`OLLAMA_HOST`, `OLLAMA_MODEL`)
3. Modelo local v0

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.14. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
