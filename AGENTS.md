# AGENTS.md

## Tech Stack
- **Architecture:** GitOps + Kubernetes
- **Deployment:** ArgoCD
- **Infrastructure:** Kubernetes manifests
- **CI/CD:** GitHub Actions

## Project Structure
```
dinheirama/
  k8s/              # Kubernetes manifests
  .github/          # GitHub Actions workflows
  README.md         # Project documentation
```

## Commands
- ArgoCD auto-syncs from Git
- `kubectl apply -f k8s/` - Manual apply

## Conventions
- GitOps workflow with ArgoCD
- Infrastructure as Code
- Declarative Kubernetes configuration
