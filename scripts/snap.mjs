/**
 * Dev helper: drives headless Chrome over CDP (no deps — uses Node's
 * built-in WebSocket) to screenshot the app after real wall-clock time,
 * so animations actually play. Usage:
 *   node scripts/snap.mjs <url> <outfile.png> [waitMs]
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Any number of trailing click args: "x,y[,afterWaitMs]" executed in order.
const [url = 'http://localhost:5179/', out = '/tmp/snap.png', waitMs = '4000', ...clicks] = process.argv.slice(2);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const chrome = execFile(CHROME, [
  '--headless=new', '--disable-gpu-sandbox', '--enable-unsafe-webgpu',
  '--use-angle=metal', `--remote-debugging-port=${PORT}`,
  '--window-size=1600,1000', '--no-first-run', 'about:blank',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets = null;
for (let i = 0; i < 20 && !targets; i++) {
  await sleep(700);
  targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()).catch(() => null);
}
if (!targets) { console.error('could not reach Chrome debug port'); chrome.kill(); process.exit(1); }
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });

let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
await send('Page.enable');
// Hash-only URL differences don't reload a document — go blank first so a
// reused tab always does a full load.
await send('Page.navigate', { url: 'about:blank' });
await sleep(200);
await send('Page.navigate', { url });
await sleep(parseInt(waitMs, 10));

for (const click of clicks) {
  const [cx, cy, after = '2500'] = click.split(',');
  const x = parseInt(cx, 10), y = parseInt(cy, 10);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  await sleep(parseInt(after, 10));
}

// SNAP_EVAL='expr' — evaluate in the page and log the JSON result.
if (process.env.SNAP_EVAL) {
  const res = await send('Runtime.evaluate', {
    expression: `JSON.stringify(${process.env.SNAP_EVAL})`,
    returnByValue: true,
  });
  console.log('eval:', res.result?.result?.value ?? JSON.stringify(res.result));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved', out);
console.log('--- console ---');
for (const l of logs) console.log(l);

chrome.kill();
process.exit(0);
