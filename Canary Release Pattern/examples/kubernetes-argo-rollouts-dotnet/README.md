# Canary Release Example (Kubernetes + Argo Rollouts + .NET 8)

## What you get
- A simple .NET service that returns a `VERSION` value and simulates errors based on `ERROR_RATE`
- An Argo Rollouts `Rollout` that shifts traffic: 5% → 20% → 50% → 100%
- An `AnalysisTemplate` that gates progression using a **web metric** calling `/rollout-metric`

## Repo layout
- `app/` : .NET minimal API + Dockerfile
- `k8s/` : rollout, services, ingress, analysis template
- `scripts/` : helper scripts for a local Kind cluster (optional)
- `infra/` : kind config

## Run locally (Kind)
> If you already have a cluster + ingress, you can skip Kind.

1) Create cluster
```bash
kind create cluster --config infra/kind-config.yaml
```

2) Install NGINX ingress (quick)
```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=180s
```

3) Install Argo Rollouts
```bash
kubectl create namespace argo-rollouts || true
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml
```

4) Build images into Kind (demo)
```bash
docker build -t canary-demo:v1 app -f app/Dockerfile --build-arg VERSION=v1 --build-arg ERROR_RATE=0.00
docker build -t canary-demo:v2 app -f app/Dockerfile --build-arg VERSION=v2 --build-arg ERROR_RATE=0.03
kind load docker-image canary-demo:v1
kind load docker-image canary-demo:v2
```

5) Apply manifests
```bash
kubectl apply -f k8s/namespace.yaml
kubectl -n canary-demo apply -f k8s/
```

6) Watch the rollout
```bash
kubectl -n canary-demo get rollouts -w
```

7) Send traffic (in another terminal)
```bash
kubectl -n canary-demo port-forward svc/canary-demo-stable 8080:80
curl http://localhost:8080/
```

## Tips
- Increase ERROR_RATE in the canary image to force an abort.
- In production, replace the “web metric” with Prometheus/Datadog/New Relic signals.
