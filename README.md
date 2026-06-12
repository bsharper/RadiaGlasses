# RadiaGlasses

RadiaGlasses displays live readings from a RadiaCode radiation detector on a Meta smart glasses browser, or any browser that can open the display page.

## Components

- `relay/feeder/` is a browser page that connects to a RadiaCode device over Web Bluetooth or WebUSB and posts readings to the relay.
- `relay/relay-server.js` is a small Node.js SSE relay. It receives readings by stream ID and forwards them to subscribers.
- `glasses/` is the 600x600 display page intended for smart glasses.
- `relay/bridge-server.js` is an optional local USB bridge for setups where the detector is plugged into the server directly.

## Requirements

- Node.js 18 or newer for the relay.
- HTTPS for hosted feeder/display pages. Browsers require HTTPS for Web Bluetooth and WebUSB.
- A Chromium-based browser for the feeder.
- Apache or nginx if you want to proxy the relay behind your main HTTPS site.

## Relay

Install dependencies and run the relay:

```bash
cd relay
npm install
PORT=8791 BASE_PATH=/bridge npm run relay
```

The relay listens on `127.0.0.1` by default. Proxy `/bridge/` to it with Apache or nginx; `relay/relay-apache.example.conf` has an Apache example.

## Usage

1. Open the feeder page, usually at `https://example.com/client_feeder`.
2. Connect to the RadiaCode with the BLE or USB button.
3. Copy the generated glasses URL and open it on the glasses display.

The feeder creates a random stream ID and sends readings to:

```text
POST /bridge/streams/{streamId}
```

The glasses page subscribes with:

```text
GET /bridge/streams/{streamId}/events
```

Stream IDs are routing identifiers, not authentication. If the relay is public, put it behind access controls appropriate for your deployment.

## Deployment Scripts

The deploy scripts are examples with generic defaults. Override targets with environment variables:

```bash
DEPLOY_HOST=your-server \
RELAY_REMOTE_DIR=~/radiaglasses-relay \
GLASSES_REMOTE_DIR=/var/www/radiaglasses/glasses \
FEEDER_REMOTE_DIR=/var/www/radiaglasses/client_feeder \
SERVICE_NAME=radiacode-bridge-screen \
./deploy.sh
```

Before installing `relay/radiacode-bridge-screen.service`, edit `User`, `Group`, and `WorkingDirectory` for your server. The service expects a `start` script in the relay directory that launches the relay with the desired environment.

## Health Check

```text
GET /bridge/health
```

returns JSON like:

```json
{ "ok": true, "streams": 1 }
```
