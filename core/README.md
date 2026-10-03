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

### Camada quantitativa (`quant/`)

- `GET /api/factors` ranking multifator (valor, qualidade, momentum, baixa vol), Graham, Piotroski
- `GET /api/backtest?years=8&topN=8&costs=1&tax=1` estratégias bruto vs líquido, vs Ibovespa/CDI, Sharpe deflacionado, robustez walk-forward, ressalvas
- `GET /api/portfolio/construct?method=hrp|erc|ivol|minvar|meanvar&maxWeight=0.15&maxSector=0.35&stress=1` carteira robusta, estresse e aderência ao IPS
- `GET /api/valuation/:ticker` DCF/DDM com cenários e sensibilidade
- `GET|PUT|DELETE /api/ips` perfil do investidor (IPS) e restrições derivadas
- `GET|POST /api/journal`, `DELETE /api/journal/:id`, `POST /api/journal/resolve`, `GET /api/journal/calibration` diário de decisões e calibração (Brier)
- `POST /api/fundamentals/cvm/sync` (`{from,to}`), `PUT|GET /api/fundamentals/pit` fundamentos ponto-no-tempo (CVM DFP+FCA ou CSV `ticker,asOf,availableAt,...`)
- `PUT|GET|DELETE /api/universe/history` pertencimento histórico ao universo (CSV `ticker,from,to`)
- `POST /api/tax/report`, `GET /api/tax/rules`, `GET /api/tax/proventos` calculadora de IR (swing, day trade, ETF, FII), JCP e dividendos

Metodologia, premissas e limitações: [`../docs/METODOLOGIA.md`](../docs/METODOLOGIA.md). Projeto pessoal e educacional; não é recomendação de investimento.

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
- `QUANT_DATA_DIR`, `DCF_RISK_FREE`, `DCF_EQUITY_RISK_PREMIUM`, `ALLOWED_ORIGINS`

## Testes

```bash
bun test
```
