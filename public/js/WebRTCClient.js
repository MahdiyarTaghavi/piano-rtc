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
 *
 * Design patterns:
 *  - **Facade**: hides the complexity of RTCPeerConnection management and
 *    Socket.IO signaling behind a two-method public API: `init()` and `join()`.
 *  - **Dependency Injection**: receives the signaling socket rather than
 *    creating it internally, keeping the class testable and decoupled.
 */
class WebRTCClient {
  /**
   * @param {object}   options
   * @param {import('socket.io-client').Socket} options.socket      - shared signaling socket
   * @param {HTMLVideoElement}                  options.localVideo  - <video> for own camera
   * @param {HTMLVideoElement}                  options.remoteVideo - <video> for peer camera
   * @param {RTCIceServer[]}                   [options.iceServers] - STUN/TURN config
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
     * One RTCPeerConnection per remote peer.
     */
    this._peers = {};
  }

  /**
   * Request local media and register signaling socket listeners.
   * Must be called once before `join()`.
   *
   * @returns {Promise<void>}
   */
  async init() {
    await this._setupLocalMedia();
    this._bindSignalingEvents();
  }

  /**
   * Join a named channel on the signaling server.
   * Other peers in the channel will be notified to connect.
   *
   * @param {string} channel   - channel name (matches server config default)
   * @param {object} [userdata] - arbitrary metadata sent to server
   */
  join(channel, userdata = {}) {
    this._socket.emit('join', { channel, userdata });
  }

  // Private: local media

  async _setupLocalMedia() {
    if (this._localStream) return; // already acquired

    try {
      this._localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width:  { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user',
        },
      });
      this._localVideo.srcObject = this._localStream;
    } catch (err) {
      console.error('getUserMedia failed:', err);
      alert('Camera/microphone access was denied. Video chat will not work.');
    }
  }

  // Private: signaling event binding

  _bindSignalingEvents() {
    this._socket.on('addPeer',            (cfg) => this._onAddPeer(cfg));
    this._socket.on('sessionDescription', (cfg) => this._onSessionDescription(cfg));
    this._socket.on('iceCandidate',       (cfg) => this._onIceCandidate(cfg));
  }

  // Private: WebRTC signaling handlers

  /**
   * Server instructs us to open a connection with a new peer.
   * If `should_create_offer` is true, we are responsible for initiating.
   */
  async _onAddPeer({ peer_id, should_create_offer }) {
    if (this._peers[peer_id]) {
      console.warn(`Already connected to peer ${peer_id}`);
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: this._iceServers });
    this._peers[peer_id] = pc;

    // Forward ICE candidates to the signaling server for relay
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

    // When remote tracks arrive, attach them to the remote video element
    pc.ontrack = ({ streams }) => {
      this._remoteVideo.srcObject = streams[0];
    };

    // Add local tracks to the connection
    if (this._localStream) {
      this._localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this._localStream);
      });
    }

    if (should_create_offer) {
      await this._createAndSendOffer(peer_id, pc);
    }
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
      console.error('Error creating offer:', err);
    }
  }

  async _onSessionDescription({ peer_id, session_description }) {
    const pc = this._peers[peer_id];
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(session_description));

      // If we received an offer, respond with an answer
      if (session_description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._socket.emit('relaySessionDescription', {
          peer_id,
          session_description: answer,
        });
      }
    } catch (err) {
      console.error('Error handling session description:', err);
    }
  }

  _onIceCandidate({ peer_id, ice_candidate }) {
    const pc = this._peers[peer_id];
    pc?.addIceCandidate(new RTCIceCandidate(ice_candidate)).catch(console.error);
  }
}
