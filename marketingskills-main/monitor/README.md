# Marketing Skills Monitor

A dependency-free Node.js dashboard for checking configured HTTP endpoints. It periodically checks each endpoint, reports response status and latency, and pushes updates to the browser over Server-Sent Events.

## Requirements

- Node.js 18 or newer

## Run

From the repository root, copy `monitor/config.example.json` to `monitor/targets.json`, then edit the target names, URLs, and expected status codes.

```powershell
Copy-Item monitor/config.example.json monitor/targets.json
node monitor/server.js
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The default configuration file is optional; without it the dashboard starts with no targets and displays setup instructions.

Each target uses a GET request. URLs must use HTTP or HTTPS and must not include credentials or fragments. Configure endpoints you own or are authorized to monitor. The app binds to `127.0.0.1` by default; set `MONITOR_HOST` only when intentionally exposing it on a trusted network.

## Configuration

`monitor/targets.json` accepts up to 50 endpoints:

```json
{
  "targets": [
    {
      "name": "Marketing API",
      "url": "https://api.example.com/health",
      "expectedStatus": 200
    }
  ]
}
```

Names must be unique (case-insensitive). `expectedStatus` defaults to `200`. The checker does not follow redirects, so an unexpected redirect is shown as a failed check.

| Environment variable | Default | Description |
|---|---:|---|
| `PORT` | `3000` | HTTP port (`1`-`65535`) |
| `MONITOR_HOST` | `127.0.0.1` | Interface to bind |
| `MONITOR_INTERVAL_MS` | `15000` | Check interval (`250`-`300000` ms) |
| `MONITOR_TIMEOUT_MS` | `5000` | Per-request timeout (`250`-`300000` ms) |

The read-only endpoints are `GET /api/health`, `GET /api/status`, and `GET /api/events` (SSE). The dashboard and API do not accept target URLs from HTTP requests.

## Test

```powershell
node --test monitor/test/monitor.test.js monitor/test/server.test.js
```
