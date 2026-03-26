# Service Mesh Example (Linkerd + Bun services)

## What it demonstrates
- Sidecar injection + **mTLS** for service-to-service traffic (Linkerd)
- Route definition via **ServiceProfile** (timeout + retryable)
- **TrafficSplit** (SMI) 90/10 between backend v1/v2
- Mesh observability guidance (topology + golden signals)

## Prerequisites
- Kubernetes cluster (Kind works)
- Linkerd installed (control plane + viz recommended)
- Optional: linkerd-smi extension for TrafficSplit (depending on your Linkerd setup)

> The YAML assumes Linkerd is installed and sidecar injection is enabled in the namespace.

## Quickstart (Kind)
See `scripts/quickstart-kind.sh`.

## Build images (Kind)
From repo root of this example:
```bash
docker build -t mesh-backend:v1 apps/backend --build-arg VERSION=v1
docker build -t mesh-backend:v2 apps/backend --build-arg VERSION=v2
docker build -t mesh-frontend:latest apps/frontend

kind load docker-image mesh-backend:v1 mesh-backend:v2 mesh-frontend:latest
```

## Deploy
```bash
kubectl apply -f k8s/namespace.yaml
kubectl -n canary-mesh apply -f k8s/
```

## Test (port-forward)
```bash
kubectl -n canary-mesh port-forward svc/frontend 8080:80
curl -s http://localhost:8080/ | jq .
```

## Observe (examples)
Topology:
```bash
linkerd viz edges -n canary-mesh
linkerd viz routes -n canary-mesh backend
```

Metrics:
```bash
linkerd viz stat -n canary-mesh deploy/frontend
linkerd viz stat -n canary-mesh deploy/backend-v1
linkerd viz stat -n canary-mesh deploy/backend-v2
```

## Change the canary weight
Edit `k8s/trafficsplit.yaml` weights (e.g., 50/50) and re-apply:
```bash
kubectl -n canary-mesh apply -f k8s/trafficsplit.yaml
```

## Notes
- Retries are powerful but dangerous: only retry idempotent routes and cap the overall timeout budget.
- For stricter policy and advanced routing, evaluate mesh options accordingly.
