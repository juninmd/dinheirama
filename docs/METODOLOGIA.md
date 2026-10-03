# Metodologia

> Projeto pessoal e educacional. Nada aqui é recomendação de investimento. Este documento descreve o que o código faz, por que, e onde ele **não** é confiável.

## Princípios

1. **O que foi validado é o que é publicado.** O mesmo motor de fatores (`quant/factors.ts`) roda no backtest e no score ao vivo.
2. **Sem look-ahead.** Sinal usa dados até `t`; execução ocorre em `t + 1` pregão (mínimo 1, mesmo que se peça 0). Fundamentos só entram se `availableAt <= data`.
3. **Pesos sem otimização no passado.** Os 4 fatores têm peso igual (1/N), a estratégia mais difícil de bater fora da amostra (DeMiguel, Garlappi, Uppal 2009).
4. **Custos e impostos antes de conclusões.** Todo resultado traz bruto e líquido de custos, impacto de mercado e IR de swing trade.
5. **Estatística contra a autoilusão.** Sharpe probabilístico (PSR), Sharpe deflacionado pelo número de variantes testadas (DSR) e seleção walk-forward medem se o "melhor" resultado é sorte.
6. **Dado ausente não vira zero.** Falta de dado reduz cobertura do score ou resulta em 503; nunca é inventado.

## Score multifator (`quant/factors.ts`)

Cross-sectional, no universo monitorado: winsorização (5%/95%), z-score por métrica, média por grupo, média ponderada dos grupos disponíveis (mín. 2), posto percentual 0–100.

| Grupo | Métricas | Fonte |
|---|---|---|
| Valor | earnings yield (EBIT/EV; 1/PL em financeiras), book-to-price, FCF yield, dividend yield | Fama-French, Greenblatt, Graham |
| Qualidade | ROE, ROIC aproximado, margem operacional, −dívida líquida/EBITDA, F-Score de Piotroski | Piotroski, Asness et al. |
| Momentum | retorno 12−1 meses (pula o último mês), proximidade da máxima de 52 semanas | Jegadeesh-Titman, George-Hwang |
| Baixa volatilidade | −volatilidade anualizada de 12 meses | Ang et al. |

Instituições financeiras não usam EV/EBIT, FCF, ROIC nem alavancagem operacional.

**Sinal educacional:** quintil superior com momentum absoluto positivo (retorno 12−1 > CDI do período, filtro de Antonacci) → `buy`; quintil inferior → `sell`; demais → `hold`. É um ranking relativo, não uma previsão. Notícias e papers não entram no score por não terem validação.

**Risco** é classificado por volatilidade anualizada e drawdown atual (e não mais por RSI).

O score antigo (RSI + variação de 30 dias, que dava +25 a RSI > 70) é mantido só como fallback sem dados e como estratégia de comparação no backtest.

## Backtest (`quant/backtest.ts`)

- Rebalanceamento mensal (primeiro pregão do mês), aquecimento de 253 pregões.
- Retorno total por fechamento ajustado (proventos e splits).
- Caixa rende CDI (série SGS 12 do BCB; se indisponível, taxa constante `MC_RISK_FREE_RATE`, avisado nas ressalvas).
- Custos: emolumentos/liquidação B3 (≈0,0325% por lado), corretagem configurável e impacto de raiz quadrada `k·√(ordem/ADV)` com piso de 0,05%.
- IR swing trade (ações, PF): 15% sobre o lucro mensal, isenção se vendas ≤ R$ 20 mil/mês, compensação de prejuízos; custo médio por ativo.
- Banda de rebalanceamento de 0,5% do patrimônio para reduzir giro.
- Universo elegível: preço atual, histórico mínimo e liquidez média mínima (R$ 1 mi/dia) e, se informado, pertencimento ao universo na data (`PUT /api/universe/history`).
- **Deslistagem:** ativo sem cotação por 20 pregões seguidos é liquidado ao último preço com perda assumida de 30% (premissa conservadora e configurável, sem dados de recuperação); a ressalva informa quantos casos ocorreram.
- **IR no backtest:** o imposto do mês é reservado antes das compras (o caixa nunca fica negativo). O patrimônio final não deduz IR diferido sobre ganhos não realizados, nem tributa dividendos/JCP.
- Estratégias comparadas: 1/N, score antigo, momentum 12−1 (com e sem momentum absoluto), baixa vol, multifator.
- Métricas: CAGR, volatilidade, Sharpe e Sortino sobre CDI, drawdown máximo, Calmar, assimetria/curtose, VaR/CVaR 95%, acerto mensal, alfa/beta/information ratio vs Ibovespa, giro anual, custos e IR totais.

**Significância (`quant/metrics.ts`, `quant/validation.ts`):**
- PSR: probabilidade de o Sharpe verdadeiro ser > 0, ajustada por assimetria, curtose e tamanho da amostra.
- DSR: corrige o PSR pelo número de variantes testadas; a API conta todas as variantes avaliadas (`trialsCounted`).
- `walkForwardSelect`: escolhe a melhor variante no treino (24 meses) e mede no teste (6 meses, embargo de 21 pregões); `probabilityOfOverfit` é a fração de folds em que o escolhido ficou abaixo da mediana fora da amostra (aproximação do PBO de Bailey et al.).
- **PBO por CSCV** (`probabilityOfBacktestOverfitting`): divide o período em 16 blocos e, em cada uma das 12.870 divisões treino/teste, mede o posto fora da amostra da melhor variante do treino. Roda sobre **todas** as variantes tentadas (em retornos excedentes ao CDI). O PBO é estimado numa única amostra e oscila muito (com ruído puro varia de ~25% a ~90%, média ≈ 50%); a degradação Sharpe dentro→fora e a probabilidade de perda fora da amostra complementam a leitura.
- `purgedKFold`: validação cruzada com purga e embargo (López de Prado) para rótulos que olham `h` pregões à frente. O treino do modelo XGBoost usa divisão temporal com purga (`core/training/splits.py`).

## Fundamentos e valuation

- `parseYahooFundamentals` é defensivo (campos ausentes → `null`). **Formato real da resposta do Yahoo não foi verificado neste ambiente de desenvolvimento (sem acesso à rede)**; os parsers foram escritos a partir dos tipos do `yahoo-finance2` e testados com fixtures.
- Fundamentos do Yahoo são um retrato atual: **não** são ponto-no-tempo. Há duas formas de obter dados PIT para testar valor/qualidade sem look-ahead:
  1. **CVM** (`POST /api/fundamentals/cvm/sync`, `quant/cvm.ts`): baixa DFP anual e FCA dos dados abertos, uma linha por documento recebido e por ticker, disponível só a partir de `DT_RECEB` (reapresentações geram linhas posteriores). Os múltiplos que dependem de preço (P/L, P/VP, valor de mercado, EV, dividend yield) são recalculados ao preço da data de cada sinal (`repriceFundamentals`). Só demonstrações anuais: os indicadores ficam defasados até a próxima DFP. Números por ação usam o total de ações (ON+PN) e valem para todas as classes. **O formato dos arquivos segue a documentação pública e é coberto por fixtures; não foi validado contra um download real neste ambiente.**
  2. **CSV próprio** (`PUT /api/fundamentals/pit`, `ticker,asOf,availableAt,...`): linhas sem datas válidas, com `availableAt < asOf` (divulgado antes do período) ou sem ticker são rejeitadas; o ticker é normalizado (`PETR4` → `PETR4.SA`). Uma fonte ativa por vez (a mais recente substitui a anterior).
- **Graham:** número de Graham `√(22,5·LPA·VPA)`, margem de segurança e critérios defensivos avaliáveis (critérios sem dado ficam fora da contagem).
- **DCF (`quant/valuation.ts`):** FCFE aproximado (caixa operacional − capex) descontado ao custo do capital próprio `rf + β·ERP`; crescimento inicial decai linearmente até o terminal (teto 4,5%); cenários pessimista/base/otimista e grade de sensibilidade. Financeiras usam desconto de dividendos (Gordon). Premissas explícitas e configuráveis.

## Carteira (`quant/portfolio.ts`)

- Covariância de Ledoit-Wolf (encolhimento para identidade escalada) — estável mesmo com poucas observações.
- Retornos esperados encolhidos (James-Stein) em vez de médias amostrais; o Monte Carlo também encolhe as médias (`driftShrinkage`).
- Métodos: HRP (padrão), ERC/risk parity, inverso da volatilidade, mínima variância, média-variância encolhida e **Black-Litterman**, todos long-only.
- **Black-Litterman** (`method=bl`): equilíbrio por otimização reversa a partir dos pesos de capitalização (`π = λΣw`; sem valor de mercado para todos, usa pesos iguais e avisa) e visões de fator via regra de Grinold-Kahn (`alfa anual = IC × σ × z`, IC = 0,03, confiança de Idzorek = 25%) sobre o z-score composto do ranking. Posterior de He-Litterman (média e covariância), otimizado com os mesmos tetos. Sem visões, a carteira ótima reproduz os pesos de mercado.
- Tetos por ativo e por setor com redistribuição; se os tetos pedidos forem inviáveis (ex.: 29 ativos com 3% cada), eles são relaxados até somar 100% e o resultado traz `capsRelaxed` e os tetos efetivos; diagnósticos: N efetivo, Herfindahl, razão de diversificação, contribuição ao risco.
- Kelly fracionado (¼, teto de 20%); o Kelly pleno é exibido só como informação.

## Risco de cauda e estresse (`quant/stress.ts`)

- Diagnóstico de cauda: assimetria, curtose, VaR/CVaR 95/99% histórico, normal e Cornish-Fisher, pior dia e pior semana.
- Replays históricos (2008, 2015, Joesley Day 2017, Covid 2020, estresse fiscal 2024) usam o preço real dos ativos; a **cobertura** informa quanto do peso existia na época. Janelas são aproximadas.
- Choques hipotéticos de mercado (−10/−20/−30%) propagados por beta; correlação em dias normais vs. nos 10% piores dias do mercado.

## IPS (`quant/ips.ts`)

Perfil → restrições e aderência:
- Inadequado para renda variável: dívida cara, reserva de emergência < 6 meses ou horizonte < 3 anos (fração em ações ≤ 10%). Cautela: horizonte de 3–5 anos (≤ 40%).
- Fração máxima em ações = `min(teto do objetivo, tolerância de queda ÷ pior cenário histórico)`.
- Objetivo escolhe o método: preservação → mínima variância; renda → ERC; equilíbrio/crescimento → HRP.
- Checagens: maior posição, maior setor, perda no pior cenário (já considerando a fração em ações) e adequação do perfil.

## Diário e calibração (`quant/journal.ts`)

Registre, **antes** do resultado, a probabilidade (0,01–0,99) de o ativo superar o benchmark (ou o CDI) no horizonte. Ao vencer, o diário resolve com preços ajustados e calcula Brier score, Brier skill vs. a taxa-base, log loss, curva de confiabilidade e retorno excedente médio por ação. Com menos de ~30 previsões resolvidas, os números são ruído e o relatório avisa.

## IA com limites (`quant/llm-guard.ts`)

O LLM recebe só uma ficha de fatos e regras restritivas. A resposta é validada: números fora da ficha (tolerância de arredondamento e conversão fração↔percentual) ou frases de certeza/promessa ("garantido", "vai subir", "sem risco") descartam a resposta, e entra um texto determinístico. O aviso de projeto pessoal é sempre anexado.

## Calculadora de IR (`quant/tax.ts`, `POST /api/tax/report`)

A partir de uma lista de operações reais: custo médio por ativo; swing trade de ações (15%, isenção de R$ 20 mil em vendas/mês, só para ganhos), ETFs (15%, sem isenção), FIIs (20%) e day trade (20%, mesma ação comprada e vendida no dia; excedente segue como swing). Compensação de prejuízos por cesta — ações+ETFs (compensam entre si no mês, antes do saldo acumulado), FIIs e day trade ficam separados —, IRRF "dedo-duro" (0,005% nas vendas, 1% sobre o resultado líquido positivo do dia no day trade) como crédito, e DARF mínima de R$ 10 acumulada. JCP (15% na fonte) e retenção sobre dividendos altos (`GET /api/tax/proventos`; premissa da Lei 15.270/2025 conforme meu conhecimento — **confirme a regra vigente**, é configurável). Não cobre venda a descoberto, opções, BDRs, bonificações, desdobramentos e outras regras. Não é orientação fiscal.

## Segurança das rotas que gravam estado

O CORS do app é aberto (`*`), então as rotas de escrita (`/api/ips`, `/api/journal`, `/api/fundamentals`, `/api/universe`, `/api/tax`) rejeitam requisições de outra origem (`Sec-Fetch-Site` diferente de `same-origin`/`none`, ou `Origin` diferente de `Host`; libere origens extras com `ALLOWED_ORIGINS`), limitam o tamanho do corpo e gravam arquivos de forma atômica. Clientes sem navegador (curl, bot do Telegram) passam. Não há autenticação: **não exponha este serviço na internet sem um proxy autenticado** se os dados do IPS/diário forem sensíveis.

## O que **não** está implementado

- ITR trimestral da CVM (só DFP anual) e demonstrações de instituições financeiras com plano de contas próprio testadas contra dados reais.
- Histórico de composição do Ibovespa/universo: o arquivo `PUT /api/universe/history` precisa ser fornecido por você (não há fonte automática); preços de ativos já deslistados dependem do que o Yahoo ainda retém.
- Recuperação real em deslistagens (usa perda assumida) e IR sobre dividendos/JCP no backtest.
- Venda a descoberto, opções, BDRs e eventos corporativos na calculadora de IR.
- Validação com dados reais de mercado neste repositório: os testes automatizados usam dados sintéticos; **os números reais devem ser conferidos rodando `/api/backtest` com acesso ao Yahoo/BCB**.

## Referências

Graham, *O Investidor Inteligente* e *Security Analysis* · Greenblatt, *A Fórmula Mágica de Joel Greenblatt para Bater o Mercado* · Piotroski (2000), *Value Investing: The Use of Historical Financial Statement Information* · Fama & French (1993, 2015) · Carhart (1997) · Jegadeesh & Titman (1993) · Antonacci, *Dual Momentum Investing* · George & Hwang (2004) · Asness, Frazzini & Pedersen (2019), *Quality Minus Junk* · Ang, Hodrick, Xing & Zhang (2006) · Damodaran, *Investment Valuation* · Greenwald et al., *Value Investing* · Ledoit & Wolf (2004) · López de Prado, *Advances in Financial Machine Learning* e (2016) *Building Diversified Portfolios that Outperform Out of Sample* · Maillard, Roncalli & Teïletche (2010) · Michaud (1989) · Merton (1980) · DeMiguel, Garlappi & Uppal (2009) · Thorp (2006), *The Kelly Criterion in Blackjack, Sports Betting and the Stock Market* · Bailey & López de Prado (2012, 2014), *The Sharpe Ratio Efficient Frontier* e *The Deflated Sharpe Ratio* · Taleb, *A Lógica do Cisne Negro* e *Antifrágil* · Marks, *O Mais Importante para o Investidor* · Tetlock & Gardner, *Superforecasting* · Kahneman, *Rápido e Devagar* · Bogle, *The Little Book of Common Sense Investing*.
