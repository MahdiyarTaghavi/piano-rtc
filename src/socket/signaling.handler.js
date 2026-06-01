'use strict';

/**
 * SignalingHandler
 *
 * Encapsulates all Socket.IO event handling for WebRTC peer signaling only:
 *  - join              → peer discovery and addPeer broadcast
 *  - relayICECandidate → ICE candidate relay between peers
 *  - relaySessionDescription → SDP offer/answer relay between peers
 *
 * Piano key events are intentionally absent here. They used to be relayed
 * through this server (keydown → receiveKeyDown), but are now sent directly
 * between browsers via RTCDataChannel. The server has no role in note
 * delivery after the initial handshake — which is architecturally correct:
 * the server should not be in the data path for real-time user interaction.
 *
 * Design patterns:
 *  - **Facade**: one class hides channel management and peer relay behind a
 *    single attach(io) call.
 *  - **Observer**: Socket.IO events are the observable; private handler methods
 *    are the observers — each registered once in _onConnection, easy to extend.
 *  - **Single Responsibility**: this class owns the signaling protocol only.
 *    server.js owns infrastructure. Config owns constants.
 */
class SignalingHandler {
  constructor() {
    /**
     * channels: { [channelName]: { [socketId]: Socket } }
     * Tracks membership so addPeer events reach only the right peers.
     */
    this.channels = {};

    /**
     * sockets: { [socketId]: Socket }
     * Flat registry for direct peer-to-peer relay lookups.
     */
    this.sockets = {};
  }

  /**
   * Attach all Socket.IO listeners to the server instance.
   * Call once during server bootstrap.
   *
   * @param {import('socket.io').Server} io
   */
  attach(io) {
    this._io = io;
    io.on('connection', (socket) => this._onConnection(socket));
  }

  // ─── Private: connection lifecycle ────────────────────────────────────────

  _onConnection(socket) {
    socket.channels = {};
    this.sockets[socket.id] = socket;
    console.log(`[${socket.id}] connected`);

    socket.on('join',                    (cfg) => this._onJoin(socket, cfg));
    socket.on('relayICECandidate',       (cfg) => this._onRelayICE(socket, cfg));
    socket.on('relaySessionDescription', (cfg) => this._onRelaySessionDescription(socket, cfg));
    socket.on('disconnect',              ()    => this._onDisconnect(socket));

    // Note: no keydown / keyup handlers — those are now peer-to-peer via
    // RTCDataChannel and never reach this server.
  }

  _onDisconnect(socket) {
    console.log(`[${socket.id}] disconnected`);
    for (const channel of Object.keys(socket.channels)) {
      delete this.channels[channel]?.[socket.id];
    }
    delete this.sockets[socket.id];
  }

  // ─── Private: WebRTC signaling ─────────────────────────────────────────────

  /**
   * A new peer wants to join a channel.
   * We tell every existing peer to add the newcomer (no offer duty),
   * and tell the newcomer to add each existing peer (with offer duty).
   * The offer-duty peer is also responsible for creating the DataChannel.
   */
  _onJoin(socket, { channel, userdata }) {
    console.log(`[${socket.id}] joining channel "${channel}"`, userdata);

    if (socket.channels[channel]) {
      console.warn(`[${socket.id}] already in channel "${channel}"`);
      return;
    }

    this.channels[channel] ??= {};

    for (const peerId of Object.keys(this.channels[channel])) {
      // Existing peer: you will receive the newcomer's offer
      this.channels[channel][peerId].emit('addPeer', {
        peer_id:             socket.id,
        should_create_offer: false,
      });
      // Newcomer: create the offer (and the DataChannel) for each existing peer
      socket.emit('addPeer', {
        peer_id:             peerId,
        should_create_offer: true,
      });
    }

    this.channels[channel][socket.id] = socket;
    socket.channels[channel] = channel;
  }

  /** Relay an ICE candidate from one peer to its target. */
  _onRelayICE(socket, { peer_id, ice_candidate }) {
    console.log(`[${socket.id}] relaying ICE → [${peer_id}]`);
    this.sockets[peer_id]?.emit('iceCandidate', {
      peer_id:       socket.id,
      ice_candidate,
    });
  }

  /** Relay an SDP offer or answer from one peer to its target. */
  _onRelaySessionDescription(socket, { peer_id, session_description }) {
    console.log(`[${socket.id}] relaying SDP → [${peer_id}]`);
    this.sockets[peer_id]?.emit('sessionDescription', {
      peer_id:             socket.id,
      session_description,
    });
  }
}

module.exports = SignalingHandler;
