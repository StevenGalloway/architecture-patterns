#!/usr/bin/env bash
set -euo pipefail

FQDN="${1:-}"
if [[ -z "$FQDN" ]]; then
  echo "Usage: ./smoke-test.sh service.example.com"
  exit 1
fi

for i in {1..20}; do
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://${FQDN}/")
  echo "${ts} code=${code}"
  sleep 2
done
