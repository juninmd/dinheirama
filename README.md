# Dinheirama

> Assistente privado para radar de ações brasileiras + Bitcoin.

[![Deployment Status](https://img.shields.io/badge/ArgoCD-Synced-success?style=for-the-badge&logo=argocd)](https://argocd.antonio-code.duckdns.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

## Descrição

O **Dinheirama** acompanha B3 e Bitcoin, calcula um score local de assimetria, sugere ação operacional (`comprar`, `acompanhar`, `reduzir`), mostra preço de entrada/stop/alvo e aponta fontes para leitura: RI das empresas e pesquisas acadêmicas.

Uso educacional. O app não conhece patrimônio, prazo, imposto ou tolerância a risco do usuário.

## 🛠️ Tech Stack

- **Frontend**: TypeScript + Vite
- **Runtime**: [Bun](https://bun.sh/)
- **Backend**: Hono + Yahoo Finance
- **IA**: LiteLLM opcional, Ollama como fallback, modelo local v0 como fallback final

## 🚀 Como Rodar Localmente

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
   cd ../core && bun install
   cd ../web && bun install
   ```
4. Inicie o servidor de desenvolvimento:
   ```bash
   cd ../web && bun run build
   cd ../core && bun run index.ts
   ```

## IA

Configure LiteLLM por variáveis de ambiente:

```bash
LITELLM_API_BASE=https://seu-litellm.example.com
LITELLM_API_KEY=...
LITELLM_MODEL=gpt-4o-mini
```

Sem LiteLLM, o backend tenta `OLLAMA_HOST` + `OLLAMA_MODEL`. Sem ambos, usa o modelo local v0 baseado em preço, RSI, momentum e volatilidade.

## 📦 Deployment

Este projeto é implantado automaticamente em um cluster **K3s** via **ArgoCD**.

- **URL de Produção**: [https://dinheirama.antonio-code.duckdns.org](https://dinheirama.antonio-code.duckdns.org)
