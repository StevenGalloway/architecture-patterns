#!/usr/bin/env bash
set -euo pipefail

echo "1) Create Kind cluster"
kind create cluster --config infra/kind-config.yaml || true

echo "2) Install NGINX ingress"
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=180s

echo "3) Install Argo Rollouts"
kubectl create namespace argo-rollouts || true
kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

echo "4) Build and load images"
docker build -t canary-demo:v1 app -f app/Dockerfile --build-arg VERSION=v1 --build-arg ERROR_RATE=0.00
docker build -t canary-demo:v2 app -f app/Dockerfile --build-arg VERSION=v2 --build-arg ERROR_RATE=0.03
kind load docker-image canary-demo:v1
kind load docker-image canary-demo:v2

echo "5) Apply manifests"
kubectl apply -f k8s/namespace.yaml
kubectl -n canary-demo apply -f k8s/

echo "6) Watch rollout"
kubectl -n canary-demo get rollouts -w
