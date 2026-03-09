// Action Cable consumer — the client-side WebSocket connection.
//
// `createConsumer()` opens a single WebSocket to /cable and multiplexes all
// channel subscriptions over it. Import this singleton wherever you need to
// subscribe to a channel (e.g. in the WebRTC Stimulus controller).
import { createConsumer } from "@rails/actioncable"

export default createConsumer()
