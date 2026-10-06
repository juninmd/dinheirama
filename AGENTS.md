# AGENTS.md

Projeto pessoal e educacional de pesquisa quantitativa para ações da B3. **Nada aqui é recomendação de investimento** — mantenha esse aviso em README, textos de UI, Telegram e respostas de IA.

## Tech Stack
- **Backend:** Bun + Hono + TypeScript (`core/`), dados via Yahoo Finance e BCB
- **Frontend:** Vite + TypeScript vanilla (`web/`)
- **Treino (opcional):** Python/XGBoost (`core/training/`)
- **Deploy:** Docker + ArgoCD (GitOps) em K3s; CI/CD no GitHub Actions

## Project Structure
```
dinheirama/
  core/
    index.ts            # API Hono, radar, análise, Monte Carlo, alertas
    quant/              # camada quantitativa (fatores, backtest, carteira, estresse, IPS, diário, guarda do LLM)
    training/           # coleta de dados e treino (splits.py = divisão temporal com purga)
  web/                  # frontend (hash router; uma view por tela)
    src/main.ts         # shell: menu, barra superior, busca rápida (ui/palette.ts), roteamento
    src/views/          # telas: home, analyze, radar, montecarlo, news, training, alerts, quant (lazy)
    src/ui/             # componentes (components.ts), gráficos SVG (charts.ts), ícones, toast, diálogo
    src/styles/         # tokens.css (temas), base, shell, components, views; quant.css só carrega com a aba
    src/research-*.ts   # abas da pesquisa quant (DOM sempre via h()/textContent, nunca innerHTML com dado da API)
  docs/METODOLOGIA.md   # metodologia, premissas e limitações
  .github/              # workflows
```

## Commands
- `cd core && bun install && bun test` — testes (offline, dados sintéticos em `quant/test-helpers.ts`)
- `cd core && bun run start` — backend em :3000
- `cd web && bun install && bun run build` — build do frontend
- `cd core/training && python3 -m unittest test_splits` — testes do split temporal

## Conventions
- GitOps com ArgoCD; infraestrutura declarativa.
- Regras da camada quant: sem look-ahead (sinal em `t`, execução em `t+1`), fundamentos só ponto-no-tempo em backtest, pesos não ajustados ao passado, dado ausente nunca vira zero, resultados sempre com custos/IR e ressalvas.
- O motor de fatores (`quant/factors.ts`) é compartilhado entre backtest e score ao vivo; não duplique a lógica.
- Mudanças em estratégias/fatores precisam de teste que prove ausência de look-ahead (veja `quant/backtest.test.ts`).
- Não versione `.env`; use `.env.example` como contrato.
