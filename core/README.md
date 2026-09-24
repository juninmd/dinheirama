# core

Backend Hono do Dinheirama.

## Rodar

```bash
bun install
bun run start
```

## Endpoints

- `GET /health`
- `GET /api/quote/:ticker` para ações B3 (`PETR4.SA`)
- `GET /api/history/:ticker` para ações B3
- `POST /api/analyze` com `{ "ticker": "PETR4.SA" }` ou `{ "ticker": "BTC-USD" }`
- `GET /api/portfolio` para radar ações + cripto
- `GET /api/montecarlo/:ticker?days=21&sims=5000&engine=bootstrap|gbm` para a distribuição simulada do ativo
- `GET /api/portfolio/montecarlo?days=21&sims=4000` para a alocação ótima por Monte Carlo (agressiva, Sharpe e defensiva)
- `GET /api/training` para cenários de treino baseados no radar
- `GET /api/research/:ticker` para notícias, fast-news e papers/arXiv com impacto estimado
- `GET /api/integrations/status` para conferir envs e pendências 24h sem expor segredos

## Env

- Veja `.env.example`.
- `LITELLM_BASE_URL`
- `LITELLM_API_KEY`
- `LLM_MODEL`
- `FAST_NEWS_URL`
- `MARKET_NEWS_FEEDS`
- `PAPER_FEEDS`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `NOTIFY_UTC_HOUR`
- `MC_LOOKBACK_DAYS`
- `MC_RISK_FREE_RATE`

## Testes

```bash
bun test
```
