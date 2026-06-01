'use strict';

/**
 * PianoController
 *
 * Owns all piano-related concerns:
 *  - Mapping keyboard keys → piano notes
 *  - Playing / stopping audio samples
 *  - Highlighting the active key in the UI
 *  - Sending key events to the remote peer via WebRTC DataChannel
 *  - Handling incoming key events from the remote peer
 *
 * Design patterns:
 *  - **Single Responsibility**: this class knows about piano only. It has no
 *    knowledge of WebRTC internals — it communicates through a narrow interface
 *    on the rtcClient dependency (sendData / onData).
 *  - **Dependency Injection**: both the socket (for signaling, unused here now)
 *    and rtcClient are injected at construction time, not created internally.
 *    This keeps the class unit-testable: swap rtcClient for a spy object and
 *    assert that sendData() was called with the right payload.
 *  - **Observer**: DOM keydown/keyup events trigger private handlers, which in
 *    turn emit over the DataChannel. Incoming DataChannel messages flow back
 *    through the onData callback registered in app.js.
 *
 * Why DataChannel instead of Socket.IO?
 *  The previous implementation sent key events to the server via socket.emit,
 *  and the server broadcast them to all connected clients. This means every
 *  note travelled: Client A → server → Client B, adding at least one
 *  server round-trip of latency. With RTCDataChannel the message travels
 *  directly between browsers over the established DTLS/SCTP transport —
 *  the same encrypted tunnel already used for audio/video. The server is
 *  completely out of the note path after the initial WebRTC handshake.
 */
class PianoController {
  /**
   * @param {WebRTCClient} rtcClient - the shared WebRTC client instance;
   *   used to send data to peers (sendData) and to register a receive
   *   handler (onData). No socket dependency needed anymore.
   */
  constructor(rtcClient) {
    this._rtcClient = rtcClient;

    // Keyboard shortcuts — index in this array maps to index in _whiteKeys / _blackKeys
    this._WHITE_KEYS = ['z', 'x', 'c', 'v', 'b', 'n', 'm'];
    this._BLACK_KEYS = ['s', 'd', 'g', 'h', 'j'];

    // DOM references — queried once and cached to avoid repeated DOM lookups
    this._allKeys   = document.querySelectorAll('.key');
    this._whiteKeys = document.querySelectorAll('.key.white');
    this._blackKeys = document.querySelectorAll('.key.black');
  }

  /**
   * Bind all event listeners.
   * Call once after the DOM is ready and after rtcClient.init() has resolved.
   */
  init() {
    this._bindMouseEvents();
    this._bindKeyboardEvents();
    this._bindDataChannelEvents();
  }

  // ─── Private: event binding ────────────────────────────────────────────────

  _bindMouseEvents() {
    this._allKeys.forEach((key) => {
      key.addEventListener('mousedown', () => {
        this._playNote(key);
        // Emit over DataChannel using the key's data-note attribute as the ID.
        // This is more robust than an index for mouse clicks because the DOM
        // order is the only stable identifier available here.
        this._rtcClient.sendData({ type: 'noteOn', note: key.dataset.note });
      });
      key.addEventListener('mouseup', () => {
        this._stopNote(key);
        this._rtcClient.sendData({ type: 'noteOff', note: key.dataset.note });
      });
      key.addEventListener('mouseleave', () => {
        this._stopNote(key);
        this._rtcClient.sendData({ type: 'noteOff', note: key.dataset.note });
      });
    });
  }

  _bindKeyboardEvents() {
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return; // suppress key-hold repeats

      const whiteIndex = this._WHITE_KEYS.indexOf(e.key);
      const blackIndex = this._BLACK_KEYS.indexOf(e.key);
      if (whiteIndex === -1 && blackIndex === -1) return;

      // Play locally
      if (whiteIndex > -1) this._playNote(this._whiteKeys[whiteIndex]);
      if (blackIndex > -1) this._playNote(this._blackKeys[blackIndex]);

      // Send to peer via DataChannel — use indices (same as before for keyboard)
      this._rtcClient.sendData({ type: 'keydown', whiteKeyIndex: whiteIndex, blackKeyIndex: blackIndex });
    });

    document.addEventListener('keyup', (e) => {
      if (e.repeat) return;

      const whiteIndex = this._WHITE_KEYS.indexOf(e.key);
      const blackIndex = this._BLACK_KEYS.indexOf(e.key);
      if (whiteIndex === -1 && blackIndex === -1) return;

      if (whiteIndex > -1) this._stopNote(this._whiteKeys[whiteIndex]);
      if (blackIndex > -1) this._stopNote(this._blackKeys[blackIndex]);

      this._rtcClient.sendData({ type: 'keyup', whiteKeyIndex: whiteIndex, blackKeyIndex: blackIndex });
    });
  }

  /**
   * Register this controller as the handler for incoming DataChannel messages.
   * rtcClient.onData is a single-slot callback — app.js wires it here.
   * All message routing is done by the `type` field in the message object.
   */
  _bindDataChannelEvents() {
    this._rtcClient.onData = (msg) => this._handleRemoteMessage(msg);
  }

  // ─── Private: remote message handler ──────────────────────────────────────

  /**
   * Dispatch an incoming DataChannel message to the right piano action.
   * Using a type-dispatched object (a lightweight Command pattern) keeps
   * this method flat and easy to extend with new message types.
   *
   * @param {{ type: string, [key: string]: * }} msg
   */
  _handleRemoteMessage(msg) {
    switch (msg.type) {
      // Keyboard-originated events (index-based)
      case 'keydown':
        if (msg.whiteKeyIndex > -1) this._playNote(this._whiteKeys[msg.whiteKeyIndex]);
        if (msg.blackKeyIndex > -1) this._playNote(this._blackKeys[msg.blackKeyIndex]);
        break;

      case 'keyup':
        if (msg.whiteKeyIndex > -1) this._stopNote(this._whiteKeys[msg.whiteKeyIndex]);
        if (msg.blackKeyIndex > -1) this._stopNote(this._blackKeys[msg.blackKeyIndex]);
        break;

      // Mouse-originated events (note-name-based)
      case 'noteOn': {
        const el = this._findKeyByNote(msg.note);
        if (el) this._playNote(el);
        break;
      }

      case 'noteOff': {
        const el = this._findKeyByNote(msg.note);
        if (el) this._stopNote(el);
        break;
      }

      default:
        console.warn('[PianoController] unknown message type:', msg.type);
    }
  }

  /**
   * Find a key DOM element by its data-note attribute.
   * O(n) but n ≤ 12 so no optimisation is warranted.
   *
   * @param {string} note
   * @returns {HTMLElement|null}
   */
  _findKeyByNote(note) {
    return [...this._allKeys].find((k) => k.dataset.note === note) ?? null;
  }

  // ─── Private: audio helpers ────────────────────────────────────────────────

  /**
   * Play the audio sample linked to a key element and mark the key active.
   * currentTime = 0 allows re-triggering a note while its audio is still playing.
   *
   * @param {HTMLElement} keyEl
   */
  _playNote(keyEl) {
    if (!keyEl) return;
    const audio = document.getElementById(keyEl.dataset.note);
    if (!audio) return;

    audio.currentTime = 0;
    audio.play().catch(() => {
      // Autoplay may be blocked before the first user gesture — safe to ignore.
    });
    keyEl.classList.add('active');
    audio.addEventListener('ended', () => keyEl.classList.remove('active'), { once: true });
  }

  /**
   * Pause the audio for a key and remove its active highlight.
   *
   * @param {HTMLElement} keyEl
   */
  _stopNote(keyEl) {
    if (!keyEl) return;
    const audio = document.getElementById(keyEl.dataset.note);
    if (!audio) return;

    audio.pause();
    audio.currentTime = 0;
    keyEl.classList.remove('active');
  }
}
