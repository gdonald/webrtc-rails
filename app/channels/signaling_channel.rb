# SignalingChannel — the WebRTC "phone book"
#
# WebRTC itself only handles peer-to-peer media streaming. Before two browsers
# can talk directly, they must exchange small metadata messages:
#
#   1. SDP Offer/Answer  — describes what codecs/formats each side supports
#   2. ICE Candidates    — possible network paths to reach each peer
#
# This channel relays those messages via Action Cable (WebSockets).
# Once the peers have exchanged enough signaling data, the media connection
# is established and this channel is no longer involved in the call.
#
# Multiple users can join the same room. Each client filters incoming messages
# using the `to` field (directed messages) or the `from` field (ignore own).
class SignalingChannel < ApplicationCable::Channel
  # Called when a client subscribes (i.e. opens the room page).
  # We stream from a named room so everyone in the same room gets the same
  # broadcast. Params come from the JS subscription create() call.
  def subscribed
    stream_from "signaling:#{params[:room]}"
  end

  # Called when a client disconnects (closes the tab / navigates away).
  # We notify remaining peers so they can clean up the dead connection.
  def unsubscribed
    broadcast({ type: "user_left", from: params[:user_id] })
  end

  # Explicit announce action — called by the client's `connected` callback
  # (after the WebSocket handshake is confirmed). Broadcasting here rather
  # than in `subscribed` ensures the client's `received` handler is ready.
  def announce(_data)
    broadcast({ type: "user_joined", from: params[:user_id] })
  end

  # Relay a signaling message (offer / answer / ice_candidate) to the room.
  # The client includes a `to` field with the target peer's user_id so other
  # clients know whether the message is meant for them.
  def signal(data)
    broadcast({
      type:      data["type"],
      sdp:       data["sdp"],
      candidate: data["candidate"],
      from:      params[:user_id],
      to:        data["to"]
    })
  end

  # Relay a debug log entry to all room participants so every connected
  # client can display logs from all machines in a shared panel.
  def log(data)
    broadcast({
      type:    "log",
      from:    params[:user_id],
      level:   data["level"],
      message: data["message"],
      ts:      data["ts"]
    })
  end

  private

  def broadcast(payload)
    ActionCable.server.broadcast("signaling:#{params[:room]}", payload)
  end
end
