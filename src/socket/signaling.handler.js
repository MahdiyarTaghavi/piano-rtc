'use strict';

/**
 * SignalingHandler
 *
 * Encapsulates all Socket.IO event handling for:
 *  - WebRTC peer signaling  (join, relayICECandidate, relaySessionDescription)
 *  - Piano synchronisation  (keydown, keyup  →  receiveKeyDown, receiveKeyUp)
 *
 * Design patterns used:
 *  - **Facade**: one class hides the complexity of channel management and
 *    peer-to-peer relaying behind a clean `attach(io)` interface.
 *  - **Observer**: socket events are the observable; handler methods are the
 *    observers — registered in one place, easy to extend or test individually.
 *
 * Keeping this class separate from server.js respects the
 * Single Responsibility Principle: the server bootstraps infrastructure,
 * this class owns the real-time communication protocol.
 */
class SignalingHandler {
  constructor() {
    /**
     * channels: { [channelName]: { [socketId]: Socket } }
     * Tracks which sockets are in which channel so we can broadcast
     * addPeer events to the right peers only.
     */
    this.channels = {};

    /**
     * sockets: { [socketId]: Socket }
     * A flat registry so we can look up any socket by id when relaying
     * ICE candidates or session descriptions.
     */
    this.sockets = {};
  }

  /**
   * Attach all event listeners to the Socket.IO server instance.
   * Call this once after the server is ready.
   *
   * @param {import('socket.io').Server} io
   */
  attach(io) {
    this._io = io;

    io.on('connection', (socket) => {
      this._onConnection(socket);
    });
  }

  // Private: connection lifecycle

  _onConnection(socket) {
    socket.channels = {};
    this.sockets[socket.id] = socket;
    console.log(`[${socket.id}] connected`);

    socket.on('join',                  (cfg)         => this._onJoin(socket, cfg));
    socket.on('relayICECandidate',     (cfg)         => this._onRelayICE(socket, cfg));
    socket.on('relaySessionDescription',(cfg)        => this._onRelaySessionDescription(socket, cfg));
    socket.on('keydown',               (white, black) => this._onKeyDown(socket, white, black));
    socket.on('keyup',                 (white, black) => this._onKeyUp(socket, white, black));
    socket.on('disconnect',            ()            => this._onDisconnect(socket));
  }

  _onDisconnect(socket) {
    console.log(`[${socket.id}] disconnected`);

    // Remove from every channel this socket was part of
    for (const channel of Object.keys(socket.channels)) {
      delete this.channels[channel]?.[socket.id];
    }

    delete this.sockets[socket.id];
  }

  // Private: WebRTC signaling

  /**
   * A peer joins a channel. We tell every existing peer to add the newcomer,
   * and tell the newcomer to add every existing peer (with offer duty).
   */
  _onJoin(socket, { channel, userdata }) {
    console.log(`[${socket.id}] joining channel "${channel}"`, userdata);

    if (socket.channels[channel]) {
      console.warn(`[${socket.id}] already in channel "${channel}"`);
      return;
    }

    this.channels[channel] ??= {};

    // Notify existing peers → they add the newcomer (no offer)
    // Notify newcomer       → it adds each existing peer (with offer)
    for (const peerId of Object.keys(this.channels[channel])) {
      this.channels[channel][peerId].emit('addPeer', {
        peer_id: socket.id,
        should_create_offer: false,
      });
      socket.emit('addPeer', {
        peer_id: peerId,
        should_create_offer: true,
      });
    }

    this.channels[channel][socket.id] = socket;
    socket.channels[channel] = channel;
  }

  /** Relay an ICE candidate from one peer to another. */
  _onRelayICE(socket, { peer_id, ice_candidate }) {
    console.log(`[${socket.id}] relaying ICE → [${peer_id}]`);
    this.sockets[peer_id]?.emit('iceCandidate', {
      peer_id: socket.id,
      ice_candidate,
    });
  }

  /** Relay an SDP offer or answer from one peer to another. */
  _onRelaySessionDescription(socket, { peer_id, session_description }) {
    console.log(`[${socket.id}] relaying SDP → [${peer_id}]`);
    this.sockets[peer_id]?.emit('sessionDescription', {
      peer_id: socket.id,
      session_description,
    });
  }

  // Private: piano synchronisation

  /**
   * A key was pressed. Broadcast to ALL connected clients (including sender)
   * so the UI stays in sync across tabs/devices.
   */
  _onKeyDown(socket, whiteKeyIndex, blackKeyIndex) {
    console.log(`[${socket.id}] keydown white=${whiteKeyIndex} black=${blackKeyIndex}`);
    this._io.emit('receiveKeyDown', { whiteKeyIndex, blackKeyIndex });
  }

  _onKeyUp(socket, whiteKeyIndex, blackKeyIndex) {
    console.log(`[${socket.id}] keyup white=${whiteKeyIndex} black=${blackKeyIndex}`);
    this._io.emit('receiveKeyUp', { whiteKeyIndex, blackKeyIndex });
  }
}

module.exports = SignalingHandler;
