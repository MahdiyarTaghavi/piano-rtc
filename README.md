# PianoRTC

A real-time video chat application with a synchronised piano keyboard.  
Two users can connect, see each other via webcam, and hear each other play piano notes in real time.

Built with **Node.js**, **Express**, **Socket.IO**, and the browser **WebRTC API**.

---

## Project Structure

```
piano-rtc/
│
├── src/                         ← Server-side source code
│   ├── config/
│   │   └── server.config.js     ← All constants (port, paths, channel name)
│   ├── routes/
│   │   └── static.routes.js     ← Express static file serving
│   └── socket/
│       └── signaling.handler.js ← Socket.IO event handling (WebRTC + piano)
│
├── public/                      ← Client-side assets (served statically)
│   ├── js/
│   │   ├── WebRTCClient.js      ← Class: peer connections & signaling
│   │   ├── PianoController.js   ← Class: piano UI, audio, socket sync
│   │   └── app.js               ← Entry point: wires classes together
│   ├── styles.css
│   └── index.html
│
├── notes/                       ← MP3 audio samples (one per note)
├── ssl/                         ← Self-signed certs (not committed — see ssl/README.md)
├── server.js                    ← Application entry point
└── package.json
```

---

## Architecture

### Server

The server is split into three concerns:

| File | Responsibility |
|---|---|
| `server.js` | Bootstrap only — creates HTTPS server, wires modules |
| `src/config/server.config.js` | Single source of truth for all constants |
| `src/routes/static.routes.js` | Serves HTML, CSS, JS, and MP3 files |
| `src/socket/signaling.handler.js` | WebRTC signaling + piano key relay |

### Client

The client uses ES6 classes following the **Facade** and **Single Responsibility** patterns:

| File | Responsibility |
|---|---|
| `WebRTCClient.js` | Camera/mic access, peer connections, SDP/ICE exchange |
| `PianoController.js` | Piano UI, audio playback, keyboard bindings, socket sync |
| `app.js` | Composition root — creates socket, instantiates classes, joins channel |

### Design Patterns

- **Facade** (`WebRTCClient`, `SignalingHandler`) — complex subsystems exposed through a simple interface
- **Observer** (Socket.IO events) — components react to events without polling
- **Dependency Injection** — socket is passed into classes rather than created inside them; makes testing possible
- **Single Responsibility** — each class/module has exactly one reason to change

---

## Setup

### Prerequisites

- Node.js ≥ 18
- `openssl` (for generating SSL certificates)

### 1. Install dependencies

```bash
npm install
```

### 2. Generate SSL certificates

HTTPS is required for `getUserMedia` (camera/mic access in the browser).

```bash
mkdir -p ssl
openssl req -x509 -newkey rsa:4096 \
  -keyout ssl/server-key.pem \
  -out ssl/server-cert.pem \
  -days 365 -nodes \
  -subj "/CN=localhost"
```

See `ssl/README.md` for more detail.

### 3. Start the server

```bash
# Production
npm start

# Development (auto-restarts on file changes)
npm run dev
```

### 4. Open in browser

Navigate to `https://localhost:8080`.  
Accept the self-signed certificate warning (click **Advanced → Proceed**).

Open the same URL in a **second browser tab or a different device** on the same network.  
Both tabs should connect, show each other's video, and synchronise piano keypresses.

---

## Piano Keyboard Shortcuts

| Keys | Notes |
|---|---|
| `Z X C V B N M` | White keys: C D E F G A B |
| `S D G H J` | Black keys: C# D# F# G# A# |

You can also click the keys with the mouse.

---

## Troubleshooting

**Camera/mic not working** — Make sure you accepted the browser permission prompt. HTTPS is required; `http://` will not work.

**Can't connect to a second peer** — Both users must be on the same network, or you need a TURN server for NAT traversal. The current config uses Google's public STUN server only.

**`ssl/server-key.pem` not found** — Run the `openssl` command in step 2 above.
