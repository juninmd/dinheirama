# Dinheirama

> Bancada pessoal de pesquisa quantitativa para ações da B3: fatores, backtest honesto, carteira robusta a risco, perfil do investidor e diário de decisões calibrado.

[![Deployment Status](https://img.shields.io/badge/ArgoCD-Synced-success?style=for-the-badge&logo=argocd)](https://argocd.antonio-code.duckdns.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

> ## ⚠️ Aviso importante
>
> **Este é um projeto pessoal, feito para estudo. Nada aqui é recomendação de investimento, de compra, de venda ou de alocação de patrimônio.**
> Os sinais, rankings, carteiras e textos (inclusive os gerados por IA) são resultados de modelos simplificados, com dados de terceiros que podem conter erros, e **não consideram a sua situação pessoal**. Desempenho passado, simulado ou em backtest não garante resultado futuro, e investir em ações pode causar perda de capital. O autor não é analista de valores mobiliários registrado na CVM. Decida por conta própria e, se precisar, consulte um profissional habilitado.

## O que é

O **Dinheirama** monitora um universo fixo de ações líquidas da B3 e organiza a pesquisa em torno de ideias consolidadas da literatura de investimentos, com validação estatística explícita. O foco é **entender e testar** hipóteses, não prever o mercado nem executar ordens.

| Ideia (fonte) | Onde está |
|---|---|
| Margem de segurança, número de Graham, critérios defensivos (Graham, *O Investidor Inteligente*) | `quant/fundamentals.ts`, `quant/valuation.ts` |
| Qualidade e solidez: F-Score de Piotroski, ROIC, alavancagem (Piotroski 2000; Asness et al.) | `quant/fundamentals.ts`, `quant/factors.ts` |
| Fórmula Mágica: earnings yield + ROIC (Greenblatt) | `quant/factors.ts` |
| Fatores de valor, qualidade, momentum 12-1 e baixa volatilidade (Fama-French, Carhart, Jegadeesh-Titman, Antonacci) | `quant/factors.ts` |
| DCF com premissas explícitas, cenários e sensibilidade (Damodaran, Greenwald) | `quant/valuation.ts` |
| Covariância com encolhimento, HRP, risk parity, Black-Litterman, retornos encolhidos (Ledoit-Wolf, López de Prado, Maillard et al., Black & Litterman, Michaud) | `quant/portfolio.ts` |
| Kelly fracionado com teto de posição (Thorp) | `quant/portfolio.ts`, `monte-carlo.ts` |
| Backtest sem look-ahead, walk-forward, validação purgada, PBO por CSCV, Sharpe probabilístico e deflacionado (Bailey & López de Prado) | `quant/backtest.ts`, `quant/validation.ts`, `quant/metrics.ts` |
| Custos, impacto de mercado e IR de swing trade, day trade, ETF/FII, JCP (Bogle) | `quant/costs.ts`, `quant/tax.ts` |
| Fundamentos ponto-no-tempo da CVM (DFP + FCA) e universo histórico | `quant/cvm.ts`, `quant/universe.ts` |
| Cauda gorda e estresse histórico (Taleb, Howard Marks) | `quant/stress.ts` |
| Perfil do investidor / IPS e checagem de aderência (Graham, Bogle) | `quant/ips.ts` |
| Diário de decisões, Brier score e curva de confiabilidade (Tetlock, Kahneman) | `quant/journal.ts` |
| IA só explica números calculados; respostas com número inventado ou promessa são descartadas | `quant/llm-guard.ts` |

A metodologia completa, as premissas e as limitações estão em [`docs/METODOLOGIA.md`](docs/METODOLOGIA.md).

## Tech Stack

- **Frontend**: [Vite](https://vitejs.dev/) + TypeScript
- **Runtime**: [Bun](https://bun.sh/)
- **Backend**: [Hono](https://hono.dev/) + Yahoo Finance (preços e fundamentos) + BCB (CDI)
- **IA**: LiteLLM (opcional, limitada pela guarda de fatos) e modelo XGBoost de treino em Python
- **Deploy**: Docker + ArgoCD

## Como Rodar Localmente

```bash
git clone https://github.com/juninmd/dinheirama.git
cd dinheirama/core && bun install && bun run start   # backend em :3000
cd ../web && bun install && bun dev                  # frontend
```

Testes (offline, com dados sintéticos): `cd core && bun test`. Os testes do treino em Python: `cd core/training && python3 -m unittest test_splits`.

## Interface

Menu lateral por objetivo (no celular, barra inferior): **Início** (busca, watchlist com cotação e status das integrações), **Analisar ativo**, **Radar B3**, **Monte Carlo**, **Pesquisa quant** (fatores, backtest, carteira robusta, IPS e diário), **Notícias & papers**, **Treino de decisão** e **Alertas & Telegram**.

- `Ctrl/⌘ K` (ou `/`) abre a busca rápida: digite um ticker (`petr4` vira `PETR4.SA`) ou o nome de uma ferramenta.
- Cada tela tem URL própria e compartilhável (`#/analisar/PETR4.SA`, `#/noticias/VALE3.SA`, `#/quant/backtest`, `#/alertas?ticker=PETR4`); voltar/avançar do navegador funciona.
- Tema claro/escuro (segue o sistema até você escolher), navegação por teclado e leitores de tela.
- O aviso de que o projeto é educacional e não é recomendação de investimento fica fixo em todas as telas.

## Endpoints

| Endpoint | O que entrega |
|---|---|
| `GET /api/factors` | Ranking multifator (valor, qualidade, momentum, baixa vol), Graham, Piotroski, Fórmula Mágica |
| `GET /api/backtest?years=8&topN=8&costs=1&tax=1` | Estratégias lado a lado (bruto vs líquido de custos e IR), vs Ibovespa e CDI, Sharpe deflacionado, robustez walk-forward e ressalvas |
| `GET /api/portfolio/construct?method=hrp&stress=1` | Pesos por HRP/ERC/inverso da vol/mínima variância/média-variância encolhida/Black-Litterman, contribuição ao risco, estresse e aderência ao IPS |
| `GET /api/valuation/:ticker` | DCF (ou desconto de dividendos para financeiras), cenários e sensibilidade |
| `GET/PUT/DELETE /api/ips` | Perfil do investidor e restrições derivadas |
| `GET/POST /api/journal`, `POST /api/journal/resolve`, `GET /api/journal/calibration` | Diário de decisões e calibração (Brier) |
| `POST /api/fundamentals/cvm/sync`, `PUT /api/fundamentals/pit`, `GET /api/fundamentals/pit` | Fundamentos ponto-no-tempo para backtests de valor/qualidade sem look-ahead: sincroniza a CVM (DFP+FCA) ou envia CSV com `availableAt` |
| `PUT/GET/DELETE /api/universe/history` | Entradas/saídas do universo por data (CSV `ticker,from,to`) para mitigar o viés de sobrevivência |
| `POST /api/tax/report`, `GET /api/tax/rules`, `GET /api/tax/proventos` | Calculadora de IR de operações reais (swing, day trade, ETF, FII), JCP e dividendos — não é orientação fiscal |
| `GET /api/portfolio` | Radar com score multifator (fallback para o score legado sem dados) e Monte Carlo |
| `GET /api/montecarlo/:ticker`, `GET /api/portfolio/montecarlo` | Simulação Monte Carlo com médias encolhidas e Kelly fracionado |
| `POST /api/analyze`, `GET /api/research/:ticker`, `GET /api/training`, `GET /api/integrations/status` | Análise pontual, pesquisa de notícias/papers, treino e status das integrações |

Detalhes dos endpoints do backend em [`core/README.md`](core/README.md).

## Integrações

Veja `.env.example` (nunca versione `.env`; em produção injete via Secrets/ArgoCD).

- `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LLM_MODEL`: proxy LiteLLM (API OpenAI). Default do modelo: `cloud/auto`.
- `FAST_NEWS_URL`, `MARKET_NEWS_FEEDS`, `PAPER_FEEDS`: notícias e papers (informativos; **não entram no score**, pois não foram validados).
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `NOTIFY_UTC_HOUR`: alerta diário.
- `MC_LOOKBACK_DAYS`, `MC_RISK_FREE_RATE`: Monte Carlo e taxa livre de risco (usada também no backtest quando o CDI do BCB não está acessível).
- `QUANT_DATA_DIR`: pasta de dados persistentes (`ips.json`, `journal.json`, `fundamentals_pit.csv`).
- `DCF_RISK_FREE`, `DCF_EQUITY_RISK_PREMIUM`: premissas do DCF.
- `ALLOWED_ORIGINS`: origens extras aceitas nas rotas que gravam estado (por padrão só a mesma origem).

## Limitações conhecidas (leia antes de confiar em qualquer número)

- **Viés de sobrevivência**: o universo padrão é a lista atual de ações; empresas que saíram do mercado ou do índice não entram nos backtests, o que tende a embelezar os resultados. Para mitigar, envie o pertencimento histórico em `PUT /api/universe/history` (ativos deslistados são liquidados com perda assumida de 30%). `NTCO3.SA` foi trocado por `NATU3.SA` sem poder confirmar a negociação (sem rede); ativos sem dados aparecem em `missing`.
- **Fundamentos do Yahoo são um retrato do presente**, não ponto-no-tempo. Por isso o backtest padrão testa só fatores de preço (momentum, baixa vol). Para testar valor/qualidade sem look-ahead, sincronize a CVM (`POST /api/fundamentals/cvm/sync`; só DFP anual e **formato não validado contra download real**) ou envie um CSV próprio.
- **Dados de terceiros** (Yahoo, BCB) podem estar errados, atrasados ou indisponíveis; a API responde 503 em vez de inventar números.
- **Os resultados de backtest valem para os dados e parâmetros testados**; o Sharpe deflacionado e a probabilidade de overfit ajudam, mas não eliminam o risco de ajuste ao passado.
- **IR e custos são modelos simplificados**: o backtest só modela swing trade de ações e não deduz IR diferido nem tributa dividendos; a calculadora `/api/tax/report` cobre day trade, ETF, FII e JCP, mas as regras mudam — confirme com um contador.
- **Sem autenticação**: as rotas de escrita bloqueiam requisições de outra origem, mas não exponha o serviço na internet sem um proxy autenticado se o IPS/diário forem sensíveis.
- **Valuation por DCF é muito sensível às premissas**; use o intervalo de cenários, não um valor único.
- O score é um **ranking relativo** dentro do universo (quintil superior ≠ "vai subir").

## Deployment

Implantado automaticamente em um cluster **K3s** via **ArgoCD**.

- **URL de Produção**: [https://dinheirama.antonio-code.duckdns.org](https://dinheirama.antonio-code.duckdns.org)

## Limite de Uso

Ferramenta educacional e pessoal. Não é recomendação de investimento. A decisão final é sua e precisa considerar carteira, liquidez, imposto, horizonte e risco pessoal.
