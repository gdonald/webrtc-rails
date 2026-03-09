# WebRTC + Action Cable

A minimal Rails 8 app demonstrating peer-to-peer video chat. Two browsers on the same network open a room URL, and video/audio flows directly between them. The Rails server is only involved in **signaling** — once the peers connect, the server carries no media at all.

## How it works

```
Browser A ──── WebSocket (Action Cable) ────► Rails server
Browser B ──── WebSocket (Action Cable) ────►     │
                                                   │ relays SDP offer/answer
                                                   │ and ICE candidates
Browser A ◄─────────────────────────────────────────────────── Browser B
         ◄══════════ P2P audio/video (no server) ══════════════►
```

### Signaling flow

1. User A opens a room → subscribes to `SignalingChannel` → calls `announce`
2. User B opens the same room → subscribes → calls `announce`
3. User A receives `user_joined` from B → creates an SDP **offer**, sends it via the channel
4. User B receives the offer → sets it as remote description → creates an SDP **answer** → sends it back
5. Both sides exchange **ICE candidates** (network path options) via the channel
6. ICE negotiation completes → direct P2P connection established
7. Audio/video flows browser-to-browser; Rails is no longer involved

### Key concepts

| Concept | Role |
|---|---|
| **Action Cable** | WebSocket channel used only for signaling (SDP + ICE) |
| **SDP** | Session Description Protocol — describes codecs and media capabilities |
| **ICE** | Interactive Connectivity Establishment — discovers usable network paths |
| **Trickle ICE** | ICE candidates sent incrementally as gathered, not all at once |
| **Unified Plan** | Modern WebRTC API; answerer must call `setRemoteDescription` *before* `addTrack` |
| **STUN** | Google's public STUN servers used to discover public IP/port via NAT |

## Stack

- **Ruby** 4.0.1 / **Rails** 8.1.2
- **Stimulus** — JS controller lifecycle, DOM targets, Stimulus values for server → JS data passing
- **Action Cable** — WebSocket framework; `async` adapter in development, `solid_cable` in production
- **Propshaft** — asset pipeline (no build step required)
- **importmap-rails** — ES module pinning; `@rails/actioncable` served as ESM

## Running locally

`bin/dev` always runs over HTTPS (required for `getUserMedia` on non-localhost origins). Before starting, generate a self-signed certificate:

```bash
mkdir -p config/ssl
openssl req -x509 -newkey rsa:2048 \
  -keyout config/ssl/dev.key \
  -out    config/ssl/dev.crt \
  -days 365 -nodes \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Then start the server:

```bash
bundle install
bin/dev
```

Open `https://localhost:3000`. Accept the self-signed cert warning (*Advanced → Proceed*) before trying the room page — the WebSocket (`wss://`) uses the same cert and must also be accepted.

`config/ssl/` is gitignored. Each developer generates their own cert.

## Running on a LAN (multi-machine testing)

Generate the cert with your LAN IP as the subject so other machines on the network can connect:

```bash
mkdir -p config/ssl
openssl req -x509 -newkey rsa:2048 \
  -keyout config/ssl/dev.key \
  -out    config/ssl/dev.crt \
  -days 365 -nodes \
  -subj "/CN=YOUR_IP" \
  -addext "subjectAltName=IP:YOUR_IP,IP:127.0.0.1,DNS:localhost"
```

Start with `bin/dev`, then open `https://YOUR_IP:3000` on each machine and accept the cert warning before trying the room page.

## Project structure

```
app/
  channels/
    application_cable/connection.rb   # assigns a random UUID per WS connection
    signaling_channel.rb              # relays offer/answer/ICE/log between room members
  controllers/
    rooms_controller.rb               # generates a fresh user_id (UUID) per page load
  javascript/
    channels/consumer.js              # shared Action Cable consumer singleton
    controllers/webrtc_controller.js  # all WebRTC logic: signaling, ICE, stats, log panel
  views/
    rooms/
      index.html.erb                  # lobby — enter a room name to join
      show.html.erb                   # room — two video tiles + live log panel
  assets/stylesheets/application.css  # dark-themed styles
config/
  puma.rb                             # server binding (HTTP or SSL)
  cable.yml                           # async adapter (dev), solid_cable (prod)
  environments/development.rb         # disable_request_forgery_protection = true for LAN access
```

## Signaling channel actions

| Action | Direction | Purpose |
|---|---|---|
| `subscribed` | server | stream from `signaling:{room}` |
| `announce` | client → server → room | broadcast `user_joined` after cable connects |
| `signal` | client → server → room | relay `offer` / `answer` / `ice_candidate` |
| `log` | client → server → room | relay debug log entries to the shared panel |
| `unsubscribed` | server | broadcast `user_left` on disconnect |

## Reconnection design

Action Cable WebSocket disconnects are common (transient network hiccups, server restarts). The design keeps the RTCPeerConnection alive across cable drops:

- **`user_left` signal is ignored** unless the RTCPeerConnection is in a terminal state (`failed` / `closed`). Transient cable drops fire `user_left` even when the P2P connection is healthy.
- **`user_joined` always restarts signaling** for non-`connected` peers — when a peer's cable reconnects they re-announce, and we tear down any stale in-flight negotiation and start fresh.
- **Cable `connected` callback** tears down any connection stuck in `new`/`connecting` state — these needed the cable to finish ICE exchange and can't self-recover.
- **`disconnected` RTCPeerConnection state** is ignored — the browser ICE agent recovers automatically. Only `failed` triggers cleanup.

## Live debug log panel

Every `this.log()` call in the Stimulus controller:
1. Writes to the browser console
2. Appends immediately to the local log panel (no round-trip)
3. Broadcasts via `subscription.perform("log", {...})` so the remote machine's panel shows it too

This lets you watch the full offer/answer/ICE exchange from both machines in one view without copy-pasting from the browser console.

## Per-tile stats overlay

Once connected, `RTCPeerConnection.getStats()` is polled every second:

| Tile | Metrics |
|---|---|
| **Remote** | RTT (ms), incoming FPS, incoming kbps |
| **Local** | outgoing FPS, outgoing kbps |

RTT comes from the nominated `candidate-pair` stat (`currentRoundTripTime × 1000`). Bitrate is computed from `bytesReceived`/`bytesSent` deltas between polls.
