'use strict';

/**
 * WebRTCClient
 *
 * Manages the full WebRTC lifecycle for one browser session:
 *  - Acquiring local camera/microphone via getUserMedia
 *  - Joining a signaling channel
 *  - Creating and tearing down RTCPeerConnections per remote peer
 *  - Relaying ICE candidates and SDP offers/answers through the signaling server
 *  - Attaching remote media streams to the UI
 *  - Opening a RTCDataChannel for low-latency peer-to-peer data (piano notes)
 *
 * Design patterns:
 *  - **Facade**: hides RTCPeerConnection + DataChannel complexity behind a
 *    minimal public API: init(), join(), sendData(), and the onData callback.
 *  - **Dependency Injection**: receives the signaling socket rather than
 *    creating it internally, keeping the class testable and decoupled.
 *  - **Observer**: onData is a settable callback — callers register interest
 *    without this class knowing anything about piano keys.
 *
 * DataChannel notes (for the portfolio explanation):
 *  RTCDataChannel is a peer-to-peer channel riding the same DTLS/SCTP
 *  transport as the media tracks. Messages travel directly between browsers —
 *  the signaling server is NOT involved after the initial handshake.
 *  This makes it strictly lower latency than the previous socket-relay approach
 *  and removes the server as a bottleneck for note events.
 *
 *  Only the *offer* side creates the channel (createDataChannel).
 *  The *answer* side receives it through the ondatachannel event.
 *  Both sides end up with a symmetric RTCDataChannel object.
 */
class WebRTCClient {
  /**
   * @param {object}          options
   * @param {Socket}          options.socket      - shared Socket.IO signaling socket
   * @param {HTMLVideoElement} options.localVideo  - <video> for own camera feed
   * @param {HTMLVideoElement} options.remoteVideo - <video> for peer camera feed
   * @param {RTCIceServer[]}  [options.iceServers] - STUN / TURN server config
   */
  constructor({ socket, localVideo, remoteVideo, iceServers = [] }) {
    this._socket      = socket;
    this._localVideo  = localVideo;
    this._remoteVideo = remoteVideo;
    this._iceServers  = iceServers;

    /** @type {MediaStream|null} */
    this._localStream = null;

    /**
     * Peer registry: { [peerId]: RTCPeerConnection }
     * One RTCPeerConnection per remote peer (supports future multi-peer).
     */
    this._peers = {};

    /**
     * DataChannel registry: { [peerId]: RTCDataChannel }
     * Mirrors _peers — one channel per connection.
     */
    this._dataChannels = {};

    /**
     * onData — set this from outside to receive incoming data messages.
     * Called with the parsed message object whenever any peer sends data.
     *
     * @example
     *   rtcClient.onData = (msg) => piano.handleRemoteMessage(msg);
     *
     * @type {((msg: object) => void) | null}
     */
    this.onData = null;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Acquire local media and register all socket signaling listeners.
   * Must be called once before join().
   *
   * @returns {Promise<void>}
   */
  async init() {
    await this._setupLocalMedia();
    this._bindSignalingEvents();
  }

  /**
   * Join a named signaling channel. The server will notify other peers,
   * triggering the addPeer → offer/answer → ICE handshake sequence.
   *
   * @param {string} channel    - must match the channel name used by other peers
   * @param {object} [userdata] - optional metadata forwarded to the server
   */
  join(channel, userdata = {}) {
    this._socket.emit('join', { channel, userdata });
  }

  /**
   * Send arbitrary data to all connected peers via their DataChannels.
   * No-ops silently if no channel is open yet (e.g. before a peer joins).
   *
   * @param {object} message - will be JSON-serialised before sending
   */
  sendData(message) {
    const payload = JSON.stringify(message);
    for (const [peerId, dc] of Object.entries(this._dataChannels)) {
      if (dc.readyState === 'open') {
        dc.send(payload);
      } else {
        console.warn(`[DataChannel][${peerId}] not open (state: ${dc.readyState}), message dropped`);
      }
    }
  }

  // ─── Private: local media ──────────────────────────────────────────────────

  async _setupLocalMedia() {
    if (this._localStream) return; // idempotent

    try {
      this._localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      });
      this._localVideo.srcObject = this._localStream;
    } catch (err) {
      console.error('getUserMedia failed:', err);
      alert('Camera/microphone access was denied. Video chat will not work.');
    }
  }

  // ─── Private: signaling event binding ─────────────────────────────────────

  _bindSignalingEvents() {
    this._socket.on('addPeer',             (cfg) => this._onAddPeer(cfg));
    this._socket.on('sessionDescription',  (cfg) => this._onSessionDescription(cfg));
    this._socket.on('iceCandidate',        (cfg) => this._onIceCandidate(cfg));
  }

  // ─── Private: WebRTC peer lifecycle ───────────────────────────────────────

  /**
   * Server says: "a new peer exists, connect to them."
   * The peer with should_create_offer=true is responsible for the SDP offer
   * AND for creating the DataChannel (offer side always creates it).
   */
  async _onAddPeer({ peer_id, should_create_offer }) {
    if (this._peers[peer_id]) {
      console.warn(`[WebRTC] Already connected to peer ${peer_id}`);
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: this._iceServers });
    this._peers[peer_id] = pc;

    // Trickle ICE: forward candidates to the signaling server as they arrive
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this._socket.emit('relayICECandidate', {
          peer_id,
          ice_candidate: {
            sdpMLineIndex: candidate.sdpMLineIndex,
            candidate:     candidate.candidate,
          },
        });
      }
    };

    // Remote media tracks → attach to the video element
    pc.ontrack = ({ streams }) => {
      this._remoteVideo.srcObject = streams[0];
    };

    // Add local tracks so the peer gets our audio/video
    if (this._localStream) {
      this._localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this._localStream);
      });
    }

    if (should_create_offer) {
      // Offer side: create the DataChannel BEFORE creating the offer.
      // The channel negotiation is embedded in the SDP, so the answer
      // side will receive it via ondatachannel automatically.
      this._setupDataChannel(peer_id, pc.createDataChannel('piano'));
      await this._createAndSendOffer(peer_id, pc);
    } else {
      // Answer side: wait for the offer side to open the channel
      pc.ondatachannel = ({ channel }) => {
        this._setupDataChannel(peer_id, channel);
      };
    }
  }

  /**
   * Attach the standard event listeners to a DataChannel regardless of
   * which side created it. Kept separate so both code paths share the logic.
   *
   * @param {string}          peerId
   * @param {RTCDataChannel}  dc
   */
  _setupDataChannel(peerId, dc) {
    this._dataChannels[peerId] = dc;

    dc.onopen  = () => console.log(`[DataChannel][${peerId}] open`);
    dc.onclose = () => {
      console.log(`[DataChannel][${peerId}] closed`);
      delete this._dataChannels[peerId];
    };
    dc.onerror = (err) => console.error(`[DataChannel][${peerId}] error`, err);

    dc.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);
        // Deliver to whoever registered interest (e.g. PianoController)
        if (typeof this.onData === 'function') {
          this.onData(msg);
        }
      } catch (err) {
        console.error('[DataChannel] failed to parse message:', data, err);
      }
    };
  }

  async _createAndSendOffer(peerId, pc) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._socket.emit('relaySessionDescription', {
        peer_id:             peerId,
        session_description: offer,
      });
    } catch (err) {
      console.error('[WebRTC] Error creating offer:', err);
    }
  }

  async _onSessionDescription({ peer_id, session_description }) {
    const pc = this._peers[peer_id];
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(session_description));

      if (session_description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._socket.emit('relaySessionDescription', {
          peer_id,
          session_description: answer,
        });
      }
    } catch (err) {
      console.error('[WebRTC] Error handling session description:', err);
    }
  }

  _onIceCandidate({ peer_id, ice_candidate }) {
    const pc = this._peers[peer_id];
    pc?.addIceCandidate(new RTCIceCandidate(ice_candidate)).catch(console.error);
  }
}
