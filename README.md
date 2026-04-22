# 💰 Dinheirama

> Controle financeiro simplificado, moderno e eficiente.

[![Deployment Status](https://img.shields.io/badge/ArgoCD-Synced-success?style=for-the-badge&logo=argocd)](https://argocd.antonio-code.duckdns.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

## 📝 Descrição

O **Dinheirama** é uma plataforma de gestão financeira pessoal projetada para oferecer uma visão clara e objetiva dos seus gastos e ganhos. Com uma interface intuitiva e recursos de análise avançados, ele ajuda você a tomar decisões financeiras mais inteligentes.

## 🛠️ Tech Stack

- **Frontend**: [React](https://reactjs.org/) + [Vite](https://vitejs.dev/)
- **Runtime**: [Bun](https://bun.sh/)
- **Estilização**: [Tailwind CSS](https://tailwindcss.com/)
- **Ícones**: [Lucide React](https://lucide.dev/)

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
   bun install
   ```
4. Inicie o servidor de desenvolvimento:
   ```bash
   bun dev
   ```

## 📦 Deployment

Este projeto é implantado automaticamente em um cluster **K3s** via **ArgoCD**.

- **URL de Produção**: [https://dinheirama.antonio-code.duckdns.org](https://dinheirama.antonio-code.duckdns.org)