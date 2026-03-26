#!/usr/bin/env bash
set -euo pipefail

echo "1) Create Kind cluster"
kind create cluster --config infra/kind-config.yaml || true

echo
echo "2) (Manual) Install Linkerd"
echo "   - Install CLI: https://linkerd.io/2/getting-started/"
echo "   - Then run:"
echo "       linkerd check --pre"
echo "       linkerd install | kubectl apply -f -"
echo "       linkerd check"
echo "       linkerd viz install | kubectl apply -f -   (recommended)"
echo
echo "3) Build and load images into Kind"
echo "   docker build -t mesh-backend:v1 apps/backend"
echo "   docker build -t mesh-backend:v2 apps/backend"
echo "   docker build -t mesh-frontend:latest apps/frontend"
echo "   kind load docker-image mesh-backend:v1 mesh-backend:v2 mesh-frontend:latest"
echo
echo "4) Apply manifests"
echo "   kubectl apply -f k8s/namespace.yaml"
echo "   kubectl -n canary-mesh apply -f k8s/"
echo
echo "5) Port-forward and test"
echo "   kubectl -n canary-mesh port-forward svc/frontend 8080:80"
echo "   curl -s http://localhost:8080/"
