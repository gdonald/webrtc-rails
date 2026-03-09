// WebRTC + Action Cable — Stimulus controller
//
// SIGNALING FLOW (what happens when two people join the same room)
// ---------------------------------------------------------------
// 1. User A opens the room → subscribes to SignalingChannel → calls announce()
// 2. User B opens the room → subscribes → calls announce()
//    → SignalingChannel broadcasts { type: "user_joined", from: B }
// 3. User A receives "user_joined" from B
//    → creates RTCPeerConnection, adds local tracks
//    → creates an SDP offer and sends it via signal()
// 4. User B receives "offer" from A
//    → creates RTCPeerConnection
//    → sets A's offer as the remote description  ← must happen BEFORE adding tracks
//    → adds local tracks                         ← Unified Plan requires this order
//    → creates an SDP answer and sends it via signal()
// 5. User A receives "answer" from B → sets B's answer as remote description
// 6. Both sides exchange ICE candidates (network path options) via signal()
// 7. ICE negotiation completes → direct P2P media connection established
//    → audio/video flows peer-to-peer, Rails server is no longer involved

import { Controller } from "@hotwired/stimulus"
import consumer from "channels/consumer"

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ],
  // Pre-gather ICE candidates before setLocalDescription is called.
  // Without this, gathering only starts when the offer/answer is created,
  // adding extra latency before connectivity checks can begin.
  iceCandidatePoolSize: 4,
  // Bundle all media (audio + video) over a single ICE session.
  // Halves the number of candidate pairs that need to be checked.
  bundlePolicy: "max-bundle"
}

export default class extends Controller {
  static targets = [
    "localVideo",
    "remoteVideo",
    "status",
    "waitingOverlay",
    "cableState",
    "iceState",
    "logPanel",
    "localStats",
    "remoteStats"
  ]

  static values = {
    room:   String,
    userId: String
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async connect() {
    this.peers             = {}  // peerId → RTCPeerConnection
    this.pendingCandidates = {}  // peerId → [RTCIceCandidateInit] queued before remoteDescription is set
    this.localStream       = null
    this.statsInterval     = null
    this.prevStats         = {}  // for computing bitrate deltas between polls

    this.log("controller connect, userId: " + this.userIdValue + " room: " + this.roomValue)
    this.setStatus("Requesting camera…")
    await this.startLocalVideo()
    this.subscribeToSignaling()
  }

  disconnect() {
    if (this.subscription) this.subscription.unsubscribe()
    if (this.localStream)  this.localStream.getTracks().forEach(t => t.stop())
    Object.values(this.peers).forEach(pc => pc.close())
  }

  // ─── Local media ──────────────────────────────────────────────────────────

  async startLocalVideo() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      })
      this.localVideoTarget.srcObject = this.localStream
      this.log("camera ready, tracks: " + this.localStream.getTracks().map(t => t.kind).join(", "))
      this.setStatus("Waiting for others to join…")
    } catch (err) {
      this.log("getUserMedia failed: " + err.message, "error")
      this.setStatus(`Camera error: ${err.message}`)
    }
  }

  // ─── Action Cable subscription ────────────────────────────────────────────

  subscribeToSignaling() {
    this.subscription = consumer.subscriptions.create(
      { channel: "SignalingChannel", room: this.roomValue, user_id: this.userIdValue },
      {
        connected: () => {
          this.log("cable connected")
          this.setCableState("open")
          // On cable reconnect, tear down any connections stuck in "new" or
          // "connecting" state. They needed the cable to finish exchanging ICE
          // candidates and will never complete on their own. Re-announcing will
          // restart signaling cleanly. "connected" connections survive fine.
          Object.keys(this.peers).forEach(id => {
            const state = this.peers[id].connectionState
            if (state === "new" || state === "connecting") {
              this.log("tearing down stuck " + state + " connection to " + id.slice(0, 8) + " on cable reconnect", "warn")
              this.peers[id].close()
              delete this.peers[id]
              delete this.pendingCandidates[id]
            }
          })
          this.subscription.perform("announce", {})
          this.setStatus("Waiting for others to join…")
        },

        disconnected: () => {
          this.log("cable disconnected", "warn")
          this.setCableState("closed")
          this.setStatus("Reconnecting…")
          // Do NOT tear down peer connections here.
          // RTCPeerConnection is independent of Action Cable — once offer/answer/ICE
          // have been exchanged, the P2P connection can complete (or stay alive)
          // even while the signaling channel reconnects.
        },

        received: (data) => {
          // Log all non-log signals so we see the signaling dance in the panel
          if (data.type !== "log") {
            this.appendLog("local", "info",
              `← ${data.type} from ${data.from?.slice(0, 8)}${data.to ? " (directed)" : ""}`)
          }
          this.handleSignal(data).catch(err => {
            this.log("handleSignal error: " + err.message, "error")
            this.setStatus(`Error: ${err.message}`)
          })
        }
      }
    )
  }

  // ─── Signaling message router ─────────────────────────────────────────────

  async handleSignal(data) {
    // Ignore messages we sent ourselves
    if (data.from === this.userIdValue) return

    // Ignore directed messages not meant for us
    if (data.to && data.to !== this.userIdValue) return

    switch (data.type) {
      case "user_joined": {
        this.setStatus("Peer joined — connecting…")
        // user_joined means the peer is announcing a fresh start (initial load or
        // cable reconnect). Tear down any existing non-connected entry so we
        // negotiate cleanly. A fully "connected" P2P session survives cable blips.
        const existing = this.peers[data.from]
        if (existing && existing.connectionState !== "connected") {
          this.log("peer re-joined — clearing " + existing.connectionState + " connection to " + data.from.slice(0, 8), "warn")
          existing.close()
          delete this.peers[data.from]
          delete this.pendingCandidates[data.from]
        }
        await this.createOffer(data.from)
        break
      }

      case "offer":
        await this.handleOffer(data)
        break

      case "answer":
        await this.handleAnswer(data)
        break

      case "ice_candidate":
        await this.handleIceCandidate(data)
        break

      case "user_left":
        this.handlePeerLeft(data.from)
        break

      case "log":
        this.appendLog("peer", data.level || "info", data.message, data.from)
        break

      default:
        this.log("unknown signal type: " + data.type, "warn")
    }
  }

  // ─── RTCPeerConnection factory ────────────────────────────────────────────
  //
  // Sets up event handlers but does NOT add local tracks — callers do that
  // themselves at the right moment (before createOffer, after setRemoteDescription).

  buildPeerConnection(peerId) {
    const pc = new RTCPeerConnection(ICE_SERVERS)
    this.peers[peerId] = pc

    pc.ontrack = (event) => {
      this.log("ontrack from " + peerId.slice(0, 8) + " " + event.track.kind)
      this.remoteVideoTarget.srcObject = event.streams[0]
      if (this.hasWaitingOverlayTarget) this.waitingOverlayTarget.style.display = "none"
      this.setStatus("Connected!")
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.log("sending ICE candidate to " + peerId.slice(0, 8))
        this.subscription.perform("signal", {
          type:      "ice_candidate",
          candidate: event.candidate.toJSON(),
          to:        peerId
        })
      } else {
        this.log("ICE gathering complete for " + peerId.slice(0, 8))
      }
    }

    pc.onconnectionstatechange = () => {
      this.log("connection state → " + pc.connectionState + " peer: " + peerId.slice(0, 8),
        pc.connectionState === "failed" ? "error" : "info")
      this.setIceState(pc.connectionState)

      if (pc.connectionState === "connected") {
        this.startStatsPolling(pc)
      }
      if (pc.connectionState === "failed") {
        this.stopStatsPolling()
        this.setStatus("Connection failed — try reloading")
        this.handlePeerLeft(peerId)
      }
      if (pc.connectionState === "disconnected" || pc.connectionState === "closed") {
        this.stopStatsPolling()
      }
      // "disconnected" is often transient (network hiccup); the browser ICE agent
      // will try to recover automatically. Only tear down on "failed".
    }

    pc.onicegatheringstatechange = () => {
      this.log("ICE gathering state → " + pc.iceGatheringState)
    }

    return pc
  }

  addLocalTracks(pc) {
    if (!this.localStream) return
    this.localStream.getTracks().forEach(track => {
      this.log("adding local track: " + track.kind)
      pc.addTrack(track, this.localStream)
    })
  }

  // ─── Offer / Answer / ICE ─────────────────────────────────────────────────

  async createOffer(peerId) {
    if (this.peers[peerId]) {
      const state = this.peers[peerId].connectionState
      if (state === "connected" || state === "connecting") return
      // Stale connection (failed/closed/disconnected) — tear it down and retry
      this.log("closing stale connection to " + peerId.slice(0, 8) + " (was: " + state + ")", "warn")
      this.peers[peerId].close()
      delete this.peers[peerId]
    }

    this.log("creating offer to " + peerId.slice(0, 8))
    const pc = this.buildPeerConnection(peerId)

    // Offerer: add tracks first, then create offer
    this.addLocalTracks(pc)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)  // triggers ICE gathering

    this.subscription.perform("signal", {
      type: "offer",
      sdp:  { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      to:   peerId
    })
    this.log("offer sent to " + peerId.slice(0, 8))
  }

  async handleOffer(data) {
    if (this.peers[data.from]) {
      const state = this.peers[data.from].connectionState
      if (state === "connected" || state === "connecting") return
      // Stale entry — close it so we can process the fresh offer
      this.log("closing stale connection from " + data.from.slice(0, 8) + " (was: " + state + ")", "warn")
      this.peers[data.from].close()
      delete this.peers[data.from]
    }

    this.log("handling offer from " + data.from.slice(0, 8))
    const pc = this.buildPeerConnection(data.from)

    // Answerer: MUST set remote description BEFORE adding local tracks.
    // setRemoteDescription creates the transceivers for the offerer's tracks.
    // addTrack then maps our local tracks into those existing transceivers.
    // Doing it the other way around causes InvalidStateError in Unified Plan.
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
    this.log("remote description set, signaling state: " + pc.signalingState)

    // Flush any ICE candidates that arrived before the remote description was ready
    await this.flushPendingCandidates(data.from)

    this.addLocalTracks(pc)

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    this.subscription.perform("signal", {
      type: "answer",
      sdp:  { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
      to:   data.from
    })
    this.log("answer sent to " + data.from.slice(0, 8))
    this.setStatus("Connecting…")
  }

  async handleAnswer(data) {
    this.log("handling answer from " + data.from.slice(0, 8))
    const pc = this.peers[data.from]
    if (!pc) { this.log("no peer connection for answer from " + data.from.slice(0, 8), "warn"); return }

    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
    this.log("answer applied, signaling state: " + pc.signalingState)

    // Flush candidates that arrived before the answer was processed
    await this.flushPendingCandidates(data.from)
  }

  async handleIceCandidate(data) {
    const pc = this.peers[data.from]

    // Queue the candidate if the peer connection doesn't exist yet,
    // or if the remote description hasn't been set (addIceCandidate would throw).
    if (!pc || !pc.remoteDescription) {
      this.log("queuing ICE candidate from " + data.from.slice(0, 8) + " (not ready yet)")
      if (!this.pendingCandidates[data.from]) this.pendingCandidates[data.from] = []
      this.pendingCandidates[data.from].push(data.candidate)
      return
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
      this.log("ICE candidate added from " + data.from.slice(0, 8))
    } catch (err) {
      this.log("failed to add ICE candidate: " + err.message, "warn")
    }
  }

  async flushPendingCandidates(peerId) {
    const candidates = this.pendingCandidates[peerId] || []
    delete this.pendingCandidates[peerId]
    const pc = this.peers[peerId]
    if (!pc || candidates.length === 0) return

    this.log("flushing " + candidates.length + " queued ICE candidates for " + peerId.slice(0, 8))
    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (err) {
        this.log("failed to flush ICE candidate: " + err.message, "warn")
      }
    }
  }

  handlePeerLeft(peerId) {
    this.log("peer left: " + peerId.slice(0, 8), "warn")
    const pc = this.peers[peerId]
    if (pc) {
      const state = pc.connectionState
      // user_left fires on ANY Action Cable disconnect — transient or real.
      // Ignore it for every state except "failed"/"closed", which are
      // unambiguous terminal states. In particular, "new" (offer sent, answer
      // not yet received) and "connecting" (ICE in progress) must survive a
      // cable blip so the in-flight negotiation can still complete.
      // The RTCPeerConnection itself will tell us when the peer truly leaves (→ "failed").
      if (state !== "failed" && state !== "closed") {
        this.log("ignoring user_left — P2P is " + state + " for " + peerId.slice(0, 8), "warn")
        return
      }
      pc.close()
      delete this.peers[peerId]
    }
    delete this.pendingCandidates[peerId]
    this.stopStatsPolling()
    if (this.hasRemoteVideoTarget)   this.remoteVideoTarget.srcObject = null
    if (this.hasWaitingOverlayTarget) this.waitingOverlayTarget.style.display = ""
    this.setStatus("Peer disconnected — waiting for others…")
    this.setIceState("—")
  }

  // ─── Stats polling ────────────────────────────────────────────────────────
  //
  // Calls getStats() every second and displays RTT / FPS / bitrate on the
  // video tiles. Uses byte-count deltas between polls for bitrate calculation.

  startStatsPolling(pc) {
    this.stopStatsPolling()
    this.prevStats = {}
    this.statsInterval = setInterval(() => this.pollStats(pc), 1000)
  }

  stopStatsPolling() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval)
      this.statsInterval = null
    }
    if (this.hasLocalStatsTarget)  this.localStatsTarget.textContent  = ""
    if (this.hasRemoteStatsTarget) this.remoteStatsTarget.textContent = ""
    this.prevStats = {}
  }

  async pollStats(pc) {
    if (!pc || pc.connectionState !== "connected") return
    let report
    try { report = await pc.getStats() } catch { return }

    let rtt = null, inFps = null, outFps = null
    let inBytes = null, outBytes = null

    report.forEach(s => {
      // Nominated candidate-pair → RTT
      if (s.type === "candidate-pair" && s.nominated) {
        if (s.currentRoundTripTime != null) rtt = s.currentRoundTripTime
      }
      // Inbound video → incoming FPS + bytes
      if (s.type === "inbound-rtp" && s.kind === "video") {
        if (s.framesPerSecond != null) inFps = s.framesPerSecond
        if (s.bytesReceived    != null) inBytes = s.bytesReceived
      }
      // Outbound video → outgoing FPS + bytes
      if (s.type === "outbound-rtp" && s.kind === "video") {
        if (s.framesSent != null && s.framesEncoded != null) outFps = null // use framesPerSecond if present
        if (s.framesPerSecond != null) outFps = s.framesPerSecond
        if (s.bytesSent  != null) outBytes = s.bytesSent
      }
    })

    const now = Date.now()
    const dt  = this.prevStats.ts ? (now - this.prevStats.ts) / 1000 : null

    // Compute kbps from byte deltas
    const inKbps  = (dt && inBytes  != null && this.prevStats.inBytes  != null)
      ? Math.round((inBytes  - this.prevStats.inBytes)  * 8 / dt / 1000) : null
    const outKbps = (dt && outBytes != null && this.prevStats.outBytes != null)
      ? Math.round((outBytes - this.prevStats.outBytes) * 8 / dt / 1000) : null

    this.prevStats = { ts: now, inBytes, outBytes }

    // Remote tile: RTT · incoming FPS · incoming kbps
    if (this.hasRemoteStatsTarget) {
      const parts = []
      if (rtt   != null) parts.push(`${Math.round(rtt * 1000)} ms RTT`)
      if (inFps != null) parts.push(`${Math.round(inFps)} fps`)
      if (inKbps != null && inKbps >= 0) parts.push(`${inKbps} kbps`)
      this.remoteStatsTarget.textContent = parts.join("  ·  ")
    }

    // Local tile: outgoing FPS · outgoing kbps
    if (this.hasLocalStatsTarget) {
      const parts = []
      if (outFps  != null) parts.push(`${Math.round(outFps)} fps`)
      if (outKbps != null && outKbps >= 0) parts.push(`${outKbps} kbps`)
      this.localStatsTarget.textContent = parts.join("  ·  ")
    }
  }

  // ─── Logging ──────────────────────────────────────────────────────────────
  //
  // this.log() writes to the browser console AND broadcasts to the shared panel
  // so both machines' logs appear together.

  log(message, level = "info") {
    // Always write to browser console
    const prefix = "[WebRTC]"
    if (level === "error") console.error(prefix, message)
    else if (level === "warn") console.warn(prefix, message)
    else console.log(prefix, message)

    // Append to our own panel immediately (no round-trip needed)
    this.appendLog("local", level, message)

    // Broadcast to the room so the peer's panel gets it too
    if (this.subscription) {
      this.subscription.perform("log", {
        level,
        message,
        ts: Date.now()
      })
    }
  }

  // Append one row to the log panel
  // origin: "local" | "peer"
  appendLog(origin, level, message, peerId = null) {
    if (!this.hasLogPanelTarget) return

    const row = document.createElement("div")
    row.className = `log-row log-${origin} log-level-${level}`

    const ts = new Date().toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
    const label = origin === "local" ? "YOU" : ("PEER " + (peerId ? peerId.slice(0, 6) : ""))

    row.innerHTML =
      `<span class="log-ts">${ts}</span>` +
      `<span class="log-origin">${label}</span>` +
      `<span class="log-msg">${this.escapeHtml(message)}</span>`

    this.logPanelTarget.appendChild(row)
    this.logPanelTarget.scrollTop = this.logPanelTarget.scrollHeight
  }

  clearLog() {
    if (this.hasLogPanelTarget) this.logPanelTarget.innerHTML = ""
  }

  escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────

  setStatus(msg) {
    if (this.hasStatusTarget) this.statusTarget.textContent = msg
  }

  setCableState(state) {
    if (this.hasCableStateTarget) this.cableStateTarget.textContent = state
  }

  setIceState(state) {
    if (this.hasIceStateTarget) this.iceStateTarget.textContent = state
  }
}
