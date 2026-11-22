# AGENTS.md

Guide for agents and people who change this repository.

## Rule zero

This is a personal, educational quantitative research project for B3 stocks. **Nothing here is investment advice.** Keep this notice in the README, in the UI (fixed on every screen), in Telegram messages, and in any AI-generated text. Never write copy that promises returns, says "buy" or "sell", or treats a score as a forecast.

## Stack

| Layer | Technology |
|---|---|
| Backend (`core/`) | Bun + Hono + TypeScript. Data from Yahoo Finance, BCB and CVM, with brapi.dev as the quote fallback |
| Frontend (`web/`) | Vite + vanilla TypeScript + Tailwind CSS v4, no framework |
| Training (`core/training/`) | Python + XGBoost, optional |
| Deploy | Docker + ArgoCD (GitOps) on K3s. CI on GitHub Actions |

## Structure

- `core/index.ts`: Hono API (radar, analysis, Monte Carlo, alerts)
- `core/brapi.ts`: B3 quote fallback when Yahoo fails
- `core/quant/`: factors, backtest, portfolio, stress, IPS, journal, LLM guard
- `core/training/`: collection and training. `splits.py` is the time split with purging
- `web/src/main.ts`: shell (menu, top bar, hash routing). `views/`: one view per screen. `ui/`: components, SVG charts, icons, toast, dialog, search palette. `styles/`: `app.css` (entry), `theme.css` (tokens), and the rest
- `web/src/research-*.ts`: quant research tabs
- `docs/METODOLOGIA.md`: methodology, assumptions and limits

## Commands

```bash
cd core && bun install && bun test       # offline tests (synthetic data in quant/test-helpers.ts)
cd core && bun run start                 # API on :3000
cd web && bun install && bun run build   # frontend build (use `bun run dev` while developing)
cd core/training && python3 -m unittest test_splits
```

Run the tests of every package you touched before you commit.

## Quant layer rules

- No look-ahead: a signal is computed at `t` and executed at `t+1`
- Fundamentals are point-in-time in backtests (`availableAt <= data`)
- Factor weights are not fitted to the past
- Missing data never becomes zero. It lowers coverage or returns 503
- Every result shows costs, IR and caveats
- `quant/factors.ts` is shared by the backtest and the live score. Do not duplicate its logic
- A change to a strategy or factor needs a test that proves no look-ahead (model: `quant/backtest.test.ts`)
- The AI only explains numbers that were already computed. `quant/llm-guard.ts` drops any reply that has an invented number or a promise

## Frontend rules

- **CSS:** Tailwind v4. Layout and spacing are utilities in the markup. Only repeated patterns become classes in `styles/components.css`
- **Tokens:** colors, radii and shadows come from the theme (`bg-surface`, `text-fg-2`, `border-line`, and so on). No loose hex values. Light and dark themes are defined in `styles/theme.css`
- **Dynamic classes:** Tailwind only generates classes written out in full. Never build them from a template (`` `text-${tone}` ``). Use the `TEXT_TONE` and `BG_TONE` maps in `ui/format.ts`
- **Safe DOM:** API data enters through `h()` or `textContent`, never `innerHTML`
- **Color is never the only signal:** pair it with an icon, a sign (+/−) or text
- **Accessibility:** visible focus, keyboard navigation, minimum contrast 4.5:1, `prefers-reduced-motion` respected
- **Routes:** every screen has its own shareable hash URL (for example `#/analisar/PETR4.SA`)
- **Mobile first:** bottom bar up to 720px, icon rail up to 1100px, full menu above that

## Operations

- Infrastructure is declarative and GitOps with ArgoCD. Do not apply changes to the cluster by hand
- Do not commit `.env`. `.env.example` is the configuration contract. In production, inject secrets through Kubernetes Secrets or ArgoCD
- Do not leave marker or automation leftovers in the root (for example `.jules-verified*`)
- Small commits with imperative messages. Update the docs in the same change (README and `docs/METODOLOGIA.md`)

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