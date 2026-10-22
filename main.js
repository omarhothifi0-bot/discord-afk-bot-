import http from 'node:http';
import {
  Room, RoomEvent, LocalVideoTrack, TrackPublishOptions,
  TrackSource, VideoBufferType, VideoFrame, VideoSource,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';

// ═══════════════ FILL THESE IN ═══════════════
const CONFIG = {
  LIVEKIT_URL: 'wss://your-project.livekit.cloud',
  ROOM_ID:     'my-room-123',
  TOKEN:       'PASTE_YOUR_ACCESS_TOKEN_HERE',
  IDENTITY:    'black-screen-bot',
};
// ═════════════════════════════════════════════

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 10;
const PORT = Number(process.env.PORT) || 8080;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let connected = false;
let lastError = null;
const startedAt = Date.now();

/* ---------- health endpoint (host uses it to see we're alive) ---------- */
http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(connected ? 200 : 503, { 'content-type': 'text/plain' });
    return res.end(connected ? 'ok' : 'reconnecting');
  }
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      connected, room: CONFIG.ROOM_ID,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000), lastError,
    }, null, 2));
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('black-screen-bot\n');
}).listen(PORT, () => log(`health server on :${PORT}`));

/* ---------- token: mint a fresh one if key+secret exist, else use TOKEN ---------- */
async function makeToken() {
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!key || !secret) return CONFIG.TOKEN;

  const at = new AccessToken(key, secret, {
    identity: CONFIG.IDENTITY,
    name: 'Black Screen',
    ttl: '7d',
  });
  at.addGrant({
    roomJoin: true,
    room: CONFIG.ROOM_ID,
    roomCreate: true,
    canPublish: true,
    canSubscribe: false,
  });
  return at.toJwt();
}

/* ---------- one connection lifetime ---------- */
async function runSession() {
  const room = new Room();
  let timer = null;

  try {
    const source = new VideoSource(WIDTH, HEIGHT);
    const track = LocalVideoTrack.createVideoTrack('black-screen', source);

    const options = new TrackPublishOptions();
    const shareSource = TrackSource.SOURCE_SCREENSHARE ?? TrackSource.SCREEN_SHARE;
    if (shareSource !== undefined) options.source = shareSource;
    options.simulcast = false;

    // one opaque-black RGBA buffer, reused for every frame
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255; // alpha

    await room.connect(CONFIG.LIVEKIT_URL, await makeToken(), { autoSubscribe: false });
    log(`joined "${CONFIG.ROOM_ID}" as ${CONFIG.IDENTITY}`);
    connected = true;

    await room.localParticipant.publishTrack(track, options);
    log('black screen share published');

    timer = setInterval(() => {
      try {
        source.captureFrame(new VideoFrame(pixels, WIDTH, HEIGHT, VideoBufferType.RGBA));
      } catch (e) { log('captureFrame:', e.message); }
    }, Math.round(1000 / FPS));

    room.on(RoomEvent.Reconnecting, () => log('reconnecting...'));
    room.on(RoomEvent.Reconnected, () => log('reconnected'));
    room.on(RoomEvent.ParticipantConnected, (p) => log('viewer joined:', p?.identity ?? '?'));

    await new Promise((resolve) => room.on(RoomEvent.Disconnected, resolve));
    log('disconnected');
  } finally {
    clearInterval(timer);
    connected = false;
    try { await room.disconnect(); } catch {}
    try { room.close?.(); } catch {}
  }
}

/* ---------- forever loop, exponential backoff ---------- */
async function main() {
  let backoff = 1000;
  for (;;) {
    try {
      await runSession();
      backoff = 1000;
    } catch (err) {
      lastError = err?.message ?? String(err);
      log('session error:', lastError);
      if (/401|unauthor|expired|jwt|token/i.test(lastError)) {
        log('  -> token rejected. Paste a fresh TOKEN, or set LIVEKIT_API_KEY / LIVEKIT_API_SECRET.');
      }
    }
    log(`retrying in ${backoff / 1000}s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

process.on('unhandledRejection', (e) => log('unhandledRejection:', e));

let down = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (down) process.exit(0);
    down = true;
    log(`${sig} received, exiting`);
    setTimeout(() => process.exit(0), 500);
  });
}

main();
