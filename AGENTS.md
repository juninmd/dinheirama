# AGENTS.md

Guia para agentes (e pessoas) que alteram este repositório.

## Regra zero

Projeto pessoal e educacional de pesquisa quantitativa para ações da B3. **Nada aqui é recomendação de investimento.** Mantenha esse aviso no README, na UI (fixo em todas as telas), no Telegram e em qualquer texto gerado por IA. Nunca escreva copy que prometa retorno, diga "compre/venda" ou trate score como previsão.

## Stack

| Camada | Tecnologia |
|---|---|
| Backend (`core/`) | Bun + Hono + TypeScript; dados do Yahoo Finance, BCB e CVM |
| Frontend (`web/`) | Vite + TypeScript vanilla + Tailwind CSS v4, sem framework |
| Treino (`core/training/`) | Python + XGBoost, opcional |
| Deploy | Docker + ArgoCD (GitOps) em K3s; CI no GitHub Actions |

## Mapa do repositório

```
core/
  index.ts          API Hono: radar, análise, Monte Carlo, alertas
  quant/            fatores, backtest, carteira, estresse, IPS, diário, guarda do LLM
  training/         coleta e treino (splits.py = divisão temporal com purga)
web/src/
  main.ts           shell: menu, barra superior, roteamento por hash
  views/            uma view por tela (home, analyze, radar, montecarlo, news, training, alerts, quant)
  ui/               componentes, gráficos SVG, ícones, toast, diálogo, paleta de busca
  styles/           app.css (entrada), theme.css (tokens), base, components, visuals, quant
  research-*.ts     abas da pesquisa quant
docs/METODOLOGIA.md metodologia, premissas e limitações
```

## Comandos

```bash
cd core && bun install && bun test       # testes offline (dados sintéticos em quant/test-helpers.ts)
cd core && bun run start                 # API em :3000
cd web && bun install && bun run build   # build do frontend (bun dev para desenvolver)
cd core/training && python3 -m unittest test_splits
```

Rode os testes do pacote que você tocou antes de commitar.

## Regras da camada quant

- Sem look-ahead: sinal em `t`, execução em `t+1`.
- Fundamentos só ponto-no-tempo em backtest (`availableAt <= data`).
- Pesos de fatores não são ajustados ao passado.
- Dado ausente nunca vira zero: reduz cobertura ou responde 503.
- Todo resultado mostra custos, IR e ressalvas.
- `quant/factors.ts` é compartilhado entre backtest e score ao vivo. Não duplique a lógica.
- Mudança em estratégia ou fator precisa de teste que prove ausência de look-ahead (modelo: `quant/backtest.test.ts`).
- A IA só explica números já calculados; `quant/llm-guard.ts` descarta resposta com número inventado ou promessa.

## Regras de frontend

- **CSS:** Tailwind v4. Layout e espaçamento em utilitários no markup; só o que se repete vira classe em `styles/components.css`.
- **Tokens:** cores, raios e sombras vêm do tema (`bg-surface`, `text-fg-2`, `border-line`…). Nada de hex solto. Tema claro e escuro definidos em `styles/theme.css`.
- **Classes dinâmicas:** o Tailwind só gera classes escritas por extenso. Proibido `` `text-${tone}` ``; use os mapas `TEXT_TONE` e `BG_TONE` de `ui/format.ts`.
- **DOM seguro:** dado vindo da API entra por `h()`/`textContent`, nunca por `innerHTML`.
- **Cor nunca é o único sinal:** acompanhe de ícone, sinal (+/−) ou texto.
- **Acessibilidade:** foco visível, navegação por teclado, contraste mínimo 4.5:1, `prefers-reduced-motion` respeitado.
- **Rotas:** cada tela tem URL de hash própria e compartilhável (`#/analisar/PETR4.SA`).
- **Mobile primeiro:** barra inferior até 720px, trilho de ícones até 1100px, menu completo acima disso.

## Operação

- Infraestrutura declarativa e GitOps com ArgoCD; não aplique mudanças à mão no cluster.
- Não versione `.env`. `.env.example` é o contrato de configuração; em produção injete segredos via Secrets/ArgoCD.
- Não deixe arquivos de marcação ou lixo de automação na raiz (por exemplo `.jules-verified*`).
- Commits pequenos, mensagem no imperativo, e documentação atualizada junto com a mudança (README e `docs/METODOLOGIA.md`).

<!-- base-actions-main-policy -->
## GitHub Actions — padrão obrigatório (@main)

- Referencie as actions internas sempre pelo branch, nunca por SHA:
  - `uses: juninmd/base-actions/<action>@main`
  - `uses: juninmd/base-actions/.github/workflows/<arquivo>.yml@main`
- Não fixe `@<sha>` em `juninmd/base-actions`: a atualização é centralizada no
  `main` e passa a valer no próximo run.
- PRs cujos checks não iniciam por billing/spending limit são mesclados pelo bot central
  `juninmd/base-actions/.github/workflows/auto-merge-billing-blocked.yml`.
  Para impedir o merge automático de um PR, aplique a label `do-not-merge`.