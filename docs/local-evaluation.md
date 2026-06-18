# Local evaluation

This app exposes a real Pi coding-agent session with filesystem and shell tools. Treat any reachable instance as a remote-code-execution service for the account running `npm start`.

## Build and run

```bash
npm ci --ignore-scripts
npm run build
HOST=127.0.0.1 PORT=3001 npm start
```

For LAN-only evaluation, bind explicitly to all interfaces on a trusted network:

```bash
HOST=0.0.0.0 PORT=3001 npm start
```

If you want application-layer shared-secret protection, set `PI_WEBUI_TOKEN` and open `/?token=<token>` once. The token is stored in browser local storage for reconnects; see the README security note about query-string exposure.

Health check:

```bash
curl -I http://127.0.0.1:3001/
```

WebSocket smoke check:

```bash
node --input-type=module - <<'JS'
import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:3001/api/ws');
ws.on('open', () => ws.send(JSON.stringify({ type: 'getModels' })));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'models') {
    console.log(msg.models.length, `${msg.current?.provider}/${msg.current?.id}`);
    ws.close();
  }
});
JS
```

## Evaluation notes

- The app vendors B612 regular/bold under `client/fonts/` and applies it globally through `client/app.css` variables.
- The model selector shows scoped/default Pi models first by default. Use the dropdown's `Show all` control to include every available configured model.
- The sessions sidebar is intentionally limited and cached: `SESSION_LIST_LIMIT` defaults to `50`, and `SESSION_LIST_CACHE_MS` defaults to `10000`. This avoids parsing every historical JSONL file on each sidebar open.
- WebSocket `Origin` checks are always enabled. `PI_WEBUI_TOKEN` is optional and adds a shared secret on top of origin checks.
