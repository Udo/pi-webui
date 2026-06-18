# Local evaluation on aiworker

This fork is evaluated from `/root/projects/pi-webui` on the aiworker container.

Because the app exposes a Pi coding-agent session with filesystem and shell tools, the local evaluation server is bound to loopback by default using `HOST=127.0.0.1`. Use an SSH tunnel to reach it from another machine instead of exposing it directly.

## Commands used

```bash
npm ci --ignore-scripts
npm run build
HOST=127.0.0.1 PORT=3001 npm start
```

Health check:

```bash
curl -I http://127.0.0.1:3001/
```

Model selector smoke check:

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

The app vendors B612 regular/bold under `client/fonts/` and applies it globally through `client/app.css` variables.

## Repository remotes

- `origin`: `ssh://git@git.openfu.com:11622/udo/pi-webui.git`
- `upstream`: `https://github.com/Zetaphor/pi-webui.git`
