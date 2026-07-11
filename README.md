# Dinheirama

> Assistente 24h para ações da B3 com radar de oportunidades, IA local e sinais de notícias/papers.

[![Deployment Status](https://img.shields.io/badge/ArgoCD-Synced-success?style=for-the-badge&logo=argocd)](https://argocd.antonio-code.duckdns.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

## Descrição

O **Dinheirama** monitora um universo de ações brasileiras, calcula sinais técnicos simples, cruza notícias/papers configuráveis e gera uma tese objetiva de comprar, manter ou vender. O foco é apoiar decisão, treino de análise e leitura de impacto de notícias, não executar ordens automaticamente.

## Tech Stack

- **Frontend**: [Vite](https://vitejs.dev/) + TypeScript
- **Runtime**: [Bun](https://bun.sh/)
- **Backend**: [Hono](https://hono.dev/) + Yahoo Finance
- **IA local**: Ollama
- **Deploy**: Docker + ArgoCD

## Como Rodar Localmente

1. Clone o repositório:
   ```bash
   git clone https://github.com/juninmd/dinheirama.git
   ```
2. Entre na pasta do frontend:
   ```bash
   cd dinheirama/web
   ```
3. Instale as dependências:
   ```bash
   bun install
   ```
4. Inicie o backend em outro terminal:
   ```bash
   cd ../core
   bun install
   bun run start
   ```
5. Inicie o frontend:
   ```bash
   bun dev
   ```

## Integrações

- `OLLAMA_HOST`: host do Ollama. Default: `http://127.0.0.1:11434`.
- `FAST_NEWS_URL`: base URL do fast-news. O Dinheirama consulta `/api/rag/search?q=...`.
- `MARKET_NEWS_FEEDS`: lista separada por vírgula de feeds RSS/Atom.
- `PAPER_FEEDS`: lista separada por vírgula de feeds de papers. Sem env, o backend tenta arXiv para finanças.
- `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`: habilitam envio diário.
- `NOTIFY_UTC_HOUR`: hora UTC do alerta diário. Default: `11`.

Use `.env.example` como contrato local. Em produção, injete valores via Secrets/ArgoCD; não versione `.env`.

## Fluxos

- **Radar 24h:** `GET /api/portfolio` ranqueia ações por score, risco e impacto de sinais externos.
- **Análise pontual:** `POST /api/analyze` aceita `{ "ticker": "PETR4.SA" }`.
- **Treino:** `GET /api/training` gera cenários de comprar/manter/vender com contexto e resposta esperada.
- **Pesquisa:** `GET /api/research/:ticker` lê fast-news, feeds de mercado e papers/arXiv para estimar impacto.
- **Impacto de notícia/paper:** `FAST_NEWS_URL`, `MARKET_NEWS_FEEDS` e `PAPER_FEEDS` alimentam sinais externos e um viés `bullish`, `bearish` ou `neutral`.
- **Status operacional:** `GET /api/integrations/status` mostra integrações ativas e `missingForFull24h`. Para operação 24h completa, essa lista deve ficar vazia.

## Deployment

Este projeto é implantado automaticamente em um cluster **K3s** via **ArgoCD**.

- **URL de Produção**: [https://dinheirama.antonio-code.duckdns.org](https://dinheirama.antonio-code.duckdns.org)

## Limite de Uso

O radar é ferramenta educacional e de apoio. Ele sugere ações com base em preço, RSI, momentum e sinais externos, mas a decisão final precisa considerar carteira, liquidez, imposto, horizonte e risco pessoal.
