# Dinheirama

Bancada pessoal de pesquisa quantitativa para ações da B3: fatores, backtest com custos e IR, carteira robusta a risco, perfil do investidor e diário de decisões calibrado.

> **Aviso importante**
> Projeto pessoal, feito para estudo. **Nada aqui é recomendação de investimento, de compra, de venda ou de alocação de patrimônio.** Sinais, rankings, carteiras e textos (inclusive os gerados por IA) vêm de modelos simplificados, com dados de terceiros que podem conter erros, e não consideram a sua situação pessoal. Desempenho passado, simulado ou em backtest não garante resultado futuro, e investir em ações pode causar perda de capital. O autor não é analista de valores mobiliários registrado na CVM.

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

## Stack

- **Frontend:** Vite, TypeScript e Tailwind CSS v4, com tema claro/escuro por variáveis CSS
- **Backend:** Bun, Hono, Yahoo Finance (preços e fundamentos), BCB (CDI) e CVM
- **IA:** LiteLLM (opcional, limitada pela guarda de fatos) e modelo XGBoost em Python
- **Deploy:** Docker e ArgoCD em K3s

## Rodando localmente

```bash
git clone https://github.com/juninmd/dinheirama.git
cd dinheirama/core && bun install && bun run start   # API em :3000
cd ../web && bun install && bun dev                  # frontend
```

Testes (offline, dados sintéticos): `cd core && bun test`. Treino em Python: `cd core/training && python3 -m unittest test_splits`.

## Interface

Menu lateral por objetivo (barra inferior no celular):

- **Descobrir:** Início, Analisar ativo, Radar B3
- **Aprofundar:** Monte Carlo, Pesquisa quant (fatores, backtest, carteira robusta, IPS, diário), Notícias & papers
- **Praticar:** Treino de decisão, Alertas & Telegram

`Ctrl/⌘ K` (ou `/`) abre a busca rápida: digite um ticker (`petr4` vira `PETR4.SA`) ou o nome de uma ferramenta. Toda tela tem URL própria (`#/analisar/PETR4.SA`, `#/quant/backtest`). O aviso de que o projeto é educacional fica fixo em todas as telas.

## API

Referência completa dos endpoints, cache e variáveis de ambiente em [`core/README.md`](core/README.md). Principais rotas da camada quant:

| Endpoint | Entrega |
|---|---|
| `GET /api/factors` | Ranking multifator, Graham, Piotroski, Fórmula Mágica |
| `GET /api/backtest` | Estratégias bruto vs líquido, vs Ibovespa e CDI, Sharpe deflacionado, ressalvas |
| `GET /api/portfolio/construct` | Pesos por HRP/ERC/mínima variância/Black-Litterman, estresse e aderência ao IPS |
| `GET /api/valuation/:ticker` | DCF com cenários e sensibilidade |
| `GET/PUT/DELETE /api/ips`, `GET/POST /api/journal` | Perfil do investidor e diário de decisões |

## Configuração

Copie `.env.example` para `.env`. Nunca versione `.env`; em produção injete via Secrets/ArgoCD. As variáveis cobrem LiteLLM, fontes de notícias e papers, Telegram, Monte Carlo, DCF e `QUANT_DATA_DIR`.

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

## Deploy

Implantado em K3s via ArgoCD: <https://dinheirama.antonio-code.duckdns.org>.

## Uso

Ferramenta educacional e pessoal. A decisão final é sua e precisa considerar carteira, liquidez, imposto, horizonte e risco pessoal.
