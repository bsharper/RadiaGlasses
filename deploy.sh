#!/usr/bin/env bash
set -e

DEPLOY_HOST="${DEPLOY_HOST:-example-server}"
SERVICE_NAME="${SERVICE_NAME:-radiacode-bridge-screen}"

./glasses/deploy.sh
./relay/deploy.sh
ssh "$DEPLOY_HOST" "sudo systemctl restart $SERVICE_NAME"
./relay/feeder/deploy.sh
