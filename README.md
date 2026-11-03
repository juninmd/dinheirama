# Dinheirama

Bancada pessoal de pesquisa quantitativa para ações da B3: fatores, backtest com custos e IR, carteira robusta a risco, perfil do investidor e diário de decisões calibrado.

[![Validate](https://github.com/juninmd/dinheirama/actions/workflows/validate.yml/badge.svg)](https://github.com/juninmd/dinheirama/actions/workflows/validate.yml)
[![Security Scan](https://github.com/juninmd/dinheirama/actions/workflows/security.yml/badge.svg)](https://github.com/juninmd/dinheirama/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

> **Aviso importante**
> Projeto pessoal, feito para estudo. **Nada aqui é recomendação de investimento, de compra, de venda ou de alocação de patrimônio.** Sinais, rankings, carteiras e textos (inclusive os gerados por IA) vêm de modelos simplificados, com dados de terceiros que podem conter erros, e não consideram a sua situação pessoal. Desempenho passado, simulado ou em backtest não garante resultado futuro, e investir em ações pode causar perda de capital. O autor não é analista de valores mobiliários registrado na CVM.

## Índice

- [O que é](#o-que-é)
- [Funcionalidades](#funcionalidades)
- [Stack](#stack)
- [Rodando localmente](#rodando-localmente)
- [Configuração](#configuração)
- [Interface](#interface)
- [API](#api)
- [Testes e CI](#testes-e-ci)
- [Deploy](#deploy)
- [Limitações conhecidas](#limitações-conhecidas)
- [Segurança](#segurança)
- [Licença](#licença)

## O que é

O Dinheirama acompanha um universo fixo de ações líquidas da B3 e organiza a pesquisa em torno de ideias consolidadas da literatura, sempre com validação estatística explícita. O objetivo é **entender e testar hipóteses**, não prever o mercado nem executar ordens.

| Ideia (fonte) | Código |
|---|---|
| Margem de segurança, número de Graham, F-Score de Piotroski | `quant/fundamentals.ts`, `quant/valuation.ts` |
| Valor, qualidade, momentum 12-1 e baixa volatilidade; Fórmula Mágica | `quant/factors.ts` |
| DCF com cenários e sensibilidade | `quant/valuation.ts` |
| HRP, risk parity, Black-Litterman, covariância com encolhimento, Kelly fracionado | `quant/portfolio.ts`, `monte-carlo.ts` |
| Backtest sem look-ahead, walk-forward, PBO, Sharpe probabilístico e deflacionado | `quant/backtest.ts`, `quant/validation.ts`, `quant/metrics.ts` |
| Custos, impacto de mercado e IR (swing, day trade, ETF, FII, JCP) | `quant/costs.ts`, `quant/tax.ts` |
| Fundamentos ponto-no-tempo da CVM e universo histórico | `quant/cvm.ts`, `quant/universe.ts` |
| Estresse histórico e cauda gorda | `quant/stress.ts` |
| Perfil do investidor (IPS) e diário de decisões com Brier score | `quant/ips.ts`, `quant/journal.ts` |
| IA que só explica números calculados | `quant/llm-guard.ts` |

Metodologia, premissas e limitações: [`docs/METODOLOGIA.md`](docs/METODOLOGIA.md).

## Funcionalidades

- **Radar B3** — ranking multifator com score, risco, RSI e impacto de notícias/papers.
- **Pesquisa quant** — fatores, backtest com custos e IR, construção de carteira (HRP, ERC, mínima variância, Black-Litterman), estresse e valuation.
- **Monte Carlo** — simulação por ativo e por carteira, com VaR/CVaR, drawdown, Sharpe e Kelly fracionado.
- **IPS e diário** — perfil do investidor com restrições derivadas e registro de previsões com calibração (Brier score).
- **Alertas e Telegram** — alertas de preço, RSI ou sinal de ML, notificação diária e bot interativo.
- **Treino de decisão** — cenários de comprar/manter/vender com contexto e resposta esperada.
- **IA com guarda de fatos** — o LLM só explica números já calculados; respostas com números inventados ou promessas são descartadas.
- **Dashboard** — Vite + Tailwind, tema claro/escuro, busca rápida (`Ctrl/⌘ K`) e URL própria por tela.

## Stack

- **Frontend:** Vite, TypeScript e Tailwind CSS v4, com tema claro/escuro por variáveis CSS
- **Backend:** Bun, Hono, Yahoo Finance (preços e fundamentos), BCB (CDI) e CVM
- **IA:** LiteLLM (opcional, limitada pela guarda de fatos) e modelo XGBoost em Python
- **Deploy:** Docker e ArgoCD em K3s

## Rodando localmente

### Pré-requisitos

- [Bun](https://bun.sh/docs/installation) 1.4+
- Python 3.12 (opcional, só para treinar o modelo de ML)
- Docker (opcional, para a imagem de produção)

### Backend e frontend

```bash
git clone https://github.com/juninmd/dinheirama.git
cd dinheirama

# API em http://localhost:3000
cd core
bun install
cp ../.env.example .env   # opcional: ajuste o que for usar
bun run start

# frontend em http://localhost:5173 (proxy de /api para :3000)
cd ../web
bun install
bun dev
```

O `.env` é opcional. Sem ele o backend sobe com Yahoo Finance, BCB e arXiv; IA, Telegram e fast-news ficam desativados. `GET /api/integrations/status` mostra o que está configurado e o que falta para a operação completa, sem expor segredos.

### Imagem de produção

```bash
docker build -t dinheirama .
docker run --rm -p 3000:3000 --env-file .env dinheirama
```

A imagem final serve o dashboard compilado e a API na mesma porta (`3000`). Para o job de treino existe um estágio com Python/XGBoost:

```bash
docker build --target trainer -t dinheirama-trainer .
```

## Configuração

Copie `.env.example` para `.env`. Nunca versione o `.env` real; em produção injete os valores via Secrets/ArgoCD.

| Variável | Padrão | Uso |
|---|---|---|
| `LITELLM_BASE_URL` | `http://litellm.ai.svc.cluster.local:4000/v1` | Proxy LiteLLM (API compatível com OpenAI). |
| `LITELLM_API_KEY` | — | Virtual key do LiteLLM. Sem ela, a análise usa fallback local. |
| `LLM_MODEL` | `cloud/auto` | Alias do modelo no LiteLLM. |
| `FAST_NEWS_URL` | — | Base URL do fast-news (`/api/rag/search?q=...`). |
| `MARKET_NEWS_FEEDS` | — | Feeds RSS/Atom de mercado, separados por vírgula. |
| `PAPER_FEEDS` | — | Feeds de papers; vazio usa a busca padrão do arXiv. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Habilitam envio diário, alertas e bot. |
| `NOTIFY_UTC_HOUR` | `11` | Hora UTC do envio diário (11 UTC = 08h BRT). |
| `ALERT_CHECK_INTERVAL_MS` | `60000` | Intervalo de verificação dos alertas. |
| `ALERTS_DIR` | `../data` | Diretório de `alerts.json` e `alerts_history.json`. |
| `MC_LOOKBACK_DAYS` | `365` | Janela de histórico do Monte Carlo. |
| `MC_RISK_FREE_RATE` | `0.105` | Taxa livre de risco anual no Sharpe simulado e fallback do CDI. |
| `PORT` | `3000` | Porta da API. |
| `QUANT_DATA_DIR` | `ALERTS_DIR` ou `../data` | Dados persistentes da camada quant: `ips.json`, `journal.json`, `fundamentals_pit.csv`, `universe_history.csv`. |
| `DCF_RISK_FREE` | `0.115` | Taxa livre de risco do DCF. |
| `DCF_EQUITY_RISK_PREMIUM` | `0.055` | Prêmio de risco de mercado do DCF. |
| `ALLOWED_ORIGINS` | — | Origens extras aceitas nas rotas de escrita (separadas por vírgula). |
| `TRAINING_DATA_DIR` | `/data/training` | Dados de treino. |
| `MODEL_DIR` | `/data/models` | Modelo ONNX. |

## Interface

Menu lateral por objetivo (barra inferior no celular):

- **Descobrir:** Início, Analisar ativo, Radar B3
- **Aprofundar:** Monte Carlo, Pesquisa quant (fatores, backtest, carteira robusta, IPS, diário), Notícias & papers
- **Praticar:** Treino de decisão, Alertas & Telegram

`Ctrl/⌘ K` (ou `/`) abre a busca rápida: digite um ticker (`petr4` vira `PETR4.SA`) ou o nome de uma ferramenta. Toda tela tem URL própria (`#/analisar/PETR4.SA`, `#/quant/backtest`). O aviso de que o projeto é educacional fica fixo em todas as telas.

## API

Referência completa de endpoints, cache e comportamento em [`core/README.md`](core/README.md). Principais rotas:

| Método | Endpoint | Entrega |
|---|---|---|
| `GET` | `/health` | Health check e tamanho dos caches. |
| `GET` | `/api/integrations/status` | Integrações configuradas e pendências para operação 24h. |
| `GET` | `/api/quote/:ticker` | Cotação atual. |
| `GET` | `/api/history/:ticker` | Histórico de preços. |
| `POST` | `/api/analyze` | Análise pontual (`{ "ticker": "PETR4.SA" }`). |
| `GET` | `/api/portfolio` | Radar ranqueado com alocação sugerida. |
| `GET` | `/api/montecarlo/:ticker` | Simulação por ativo (`days`, `sims`, `engine=bootstrap` ou `gbm`). |
| `GET` | `/api/portfolio/montecarlo` | Simulação de carteira (`days`, `sims`). |
| `GET` | `/api/factors` | Ranking multifator, Graham, Piotroski, Fórmula Mágica. |
| `GET` | `/api/backtest` | Estratégias bruto vs líquido, vs Ibovespa e CDI, Sharpe deflacionado, ressalvas. |
| `GET` | `/api/portfolio/construct` | Pesos por HRP/ERC/ivol/minvar/meanvar/Black-Litterman, estresse e aderência ao IPS. |
| `GET` | `/api/valuation/:ticker` | DCF/DDM com cenários e sensibilidade. |
| `GET/PUT/DELETE` | `/api/ips` | Perfil do investidor e restrições derivadas. |
| `GET/POST` | `/api/journal` | Diário de decisões; resolução e calibração em `/api/journal/resolve` e `/api/journal/calibration`. |
| `POST` | `/api/fundamentals/cvm/sync` | Sincroniza DFP/FCA da CVM. |
| `PUT/GET` | `/api/fundamentals/pit` | Fundamentos ponto-no-tempo via CSV (`ticker,asOf,availableAt,...`). |
| `PUT/GET/DELETE` | `/api/universe/history` | Pertencimento histórico ao universo (`ticker,from,to`). |
| `POST` | `/api/tax/report` | Calculadora de IR (swing, day trade, ETF, FII, JCP). |
| `GET` | `/api/research/:ticker` | Notícias, papers e fast-news com impacto estimado. |
| `GET` | `/api/training` | Cenários de treino de decisão. |
| `GET` | `/api/predict` | Predição do modelo de ML (`?ticker=PETR4.SA`). |
| `GET/POST/PUT/DELETE` | `/api/alerts` | CRUD de alertas, histórico e teste do Telegram. |

Exemplos:

```bash
curl http://localhost:3000/api/portfolio
curl "http://localhost:3000/api/montecarlo/PETR4.SA?days=21&sims=5000&engine=bootstrap"
curl "http://localhost:3000/api/backtest?years=8&topN=8&costs=1&tax=1"

curl -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"ticker":"PETR4.SA"}'
```

As rotas de escrita (`/api/ips`, `/api/journal`, `/api/fundamentals`, `/api/universe`, `/api/tax`) rejeitam requisições de outra origem e limitam o tamanho do corpo. Não há autenticação: não exponha o serviço na internet sem um proxy autenticado se os dados de IPS/diário forem sensíveis.

## Testes e CI

```bash
cd core && bun test                                   # testes offline com dados sintéticos
cd core/training && python3 -m unittest test_splits   # split temporal com purga
cd web && bun run build                               # typecheck + build do frontend
```

Os testes usam dados sintéticos (`core/quant/test-helpers.ts`); os números reais devem ser conferidos rodando `/api/backtest` com acesso ao Yahoo/BCB. O CI em `.github/workflows` roda testes do core e build do web em push/pull request, além de um scan de segredos com [gitleaks](https://gitleaks.io/) a cada push para `main`/`master`.

## Deploy

Imagens Docker são publicadas no GHCR pelos workflows e implantadas em K3s via GitOps com ArgoCD:

- **Validate** — testes do core e build do web.
- **Security Scan** — gitleaks.
- **Deploy** — build/push da aplicação e do trainer.

Instância de referência: <https://dinheirama.antonio-code.duckdns.org>.

## Limitações conhecidas

Leia antes de confiar em qualquer número.

- **Viés de sobrevivência:** o universo padrão é a lista atual de ações. Empresas que saíram do mercado não entram no backtest, o que tende a embelezar resultados. Mitigue enviando o pertencimento histórico em `PUT /api/universe/history`.
- **Fundamentos do Yahoo são um retrato do presente**, não ponto-no-tempo. Por isso o backtest padrão testa só fatores de preço. Para valor/qualidade sem look-ahead, sincronize a CVM (`POST /api/fundamentals/cvm/sync`, formato ainda não validado contra download real) ou envie CSV com `availableAt`.
- **Dados de terceiros** podem estar errados, atrasados ou indisponíveis. A API responde 503 em vez de inventar números.
- **Backtest vale para os dados e parâmetros testados.** Sharpe deflacionado e PBO ajudam, mas não eliminam o ajuste ao passado.
- **IR e custos são modelos simplificados.** Confirme regras fiscais com um contador.
- **Sem autenticação.** Rotas de escrita bloqueiam outra origem, mas não exponha o serviço na internet sem proxy autenticado se IPS e diário forem sensíveis.
- **DCF é muito sensível às premissas.** Use o intervalo de cenários, não um valor único.
- **O score é um ranking relativo** dentro do universo. Quintil superior não significa "vai subir".

## Segurança

- Segredos nunca entram no repositório: `.env` está no `.gitignore` e o histórico é verificado com gitleaks no CI.
- `/api/integrations/status` reporta apenas presença/ausência de configuração, nunca valores.
- O bot do Telegram só responde ao `TELEGRAM_CHAT_ID` configurado.
- Alertas, IPS, diário e dados quant ficam em arquivos locais (`ALERTS_DIR`/`QUANT_DATA_DIR`); IPS, diário e CSVs usam gravação atômica.
- Para reportar uma vulnerabilidade, abra uma issue privada ou fale com o mantenedor pelo perfil do GitHub — evite publicar detalhes sensíveis.

## Licença

Distribuído sob a licença MIT. Veja [LICENSE](LICENSE).

## Uso

Ferramenta educacional e pessoal. A decisão final é sua e precisa considerar carteira, liquidez, imposto, horizonte e risco pessoal.
