#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

DEPLOY_HOST="${DEPLOY_HOST:-example-server}"
ARCHIVE="client_feeder_site.tar.gz"
REMOTE_TMP="/tmp/$ARCHIVE"
REMOTE_DIR="${FEEDER_REMOTE_DIR:-/var/www/radiaglasses/client_feeder}"

cleanup() {
  rm -f "$ARCHIVE" radiacode.js
}
trap cleanup EXIT

cp ../radiacode.js .
COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" index.html styles.css feeder.js radiacode.js

scp "$ARCHIVE" "$DEPLOY_HOST:$REMOTE_TMP"

ssh "$DEPLOY_HOST" "sudo bash -s" <<EOF
REMOTE_DIR="$REMOTE_DIR"
ARCHIVE="$ARCHIVE"
REMOTE_TMP="$REMOTE_TMP"
mkdir -p "\$REMOTE_DIR"
cp "\$REMOTE_TMP" "\$REMOTE_DIR/"
tar -xzf "\$REMOTE_DIR/\$ARCHIVE" -C "\$REMOTE_DIR"
rm "\$REMOTE_DIR/\$ARCHIVE" "\$REMOTE_TMP"
chown -R root:root "\$REMOTE_DIR"
EOF

echo "Done: deployed feeder site to $DEPLOY_HOST:$REMOTE_DIR"
