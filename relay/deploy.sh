#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

DEPLOY_HOST="${DEPLOY_HOST:-example-server}"
ARCHIVE="radiacode_relay.tar.gz"
REMOTE_TMP="/tmp/$ARCHIVE"
RELAY_REMOTE_DIR="${RELAY_REMOTE_DIR:-~/radiaglasses-relay}"

cleanup() {
  rm -f "$ARCHIVE"
}
trap cleanup EXIT

COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" \
  relay-server.js \
  package.json \
  package-lock.json \
  relay-apache.example.conf \
  radiacode-bridge-screen.service

scp "$ARCHIVE" "$DEPLOY_HOST:$REMOTE_TMP"

ssh "$DEPLOY_HOST" "RELAY_REMOTE_DIR='$RELAY_REMOTE_DIR' ARCHIVE='$ARCHIVE' REMOTE_TMP='$REMOTE_TMP' bash -s" <<'EOF'
REMOTE_DIR="${RELAY_REMOTE_DIR/#\~/$HOME}"
mkdir -p "$REMOTE_DIR"
cp "$REMOTE_TMP" "$REMOTE_DIR/"
tar -xzf "$REMOTE_DIR/$ARCHIVE" -C "$REMOTE_DIR"
rm "$REMOTE_DIR/$ARCHIVE" "$REMOTE_TMP"
EOF

echo "Done: deployed relay to $DEPLOY_HOST:$RELAY_REMOTE_DIR"
