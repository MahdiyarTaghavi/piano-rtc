'use strict';

/**
 * PianoController
 *
 * Owns all piano-related concerns:
 *  - Mapping keyboard keys → piano notes
 *  - Playing / stopping audio samples
 *  - Highlighting the active key in the UI
 *  - Emitting socket events when the local user presses a key
 *  - Applying remote key events received from the socket
 *
 * Design patterns:
 *  - **Single Responsibility**: this class knows about piano only; it has no
 *    knowledge of WebRTC, video, or the socket connection directly — it
 *    receives a `socket` dependency at construction time (Dependency Injection).
 *  - **Observer**: DOM events (mousedown/keydown) trigger internal handlers
 *    which are kept private (prefixed with _).
 */
class PianoController {
  /**
   * @param {import('socket.io-client').Socket} socket  - shared socket instance
   */
  constructor(socket) {
    this._socket = socket;

    // Keyboard shortcuts for white and black keys respectively
    this._WHITE_KEYS = ['z', 'x', 'c', 'v', 'b', 'n', 'm'];
    this._BLACK_KEYS = ['s', 'd', 'g', 'h', 'j'];

    // DOM references — queried once and cached
    this._allKeys   = document.querySelectorAll('.key');
    this._whiteKeys = document.querySelectorAll('.key.white');
    this._blackKeys = document.querySelectorAll('.key.black');
  }

  /**
   * Bind all event listeners.
   * Call once after the DOM is ready.
   */
  init() {
    this._bindMouseEvents();
    this._bindKeyboardEvents();
    this._bindSocketEvents();
  }

  // Private: event binding

  _bindMouseEvents() {
    this._allKeys.forEach((key) => {
      key.addEventListener('mousedown', () => {
        this._playNote(key);
        // Mouse clicks are local-only and do NOT emit a socket event here,
        // because we have no index for mouse-selected keys. You can extend
        // this if needed by resolving the key's index from its data-note.
      });
      key.addEventListener('mouseup', () => this._stopNote(key));
      // Also stop if the cursor leaves while pressed
      key.addEventListener('mouseleave', () => this._stopNote(key));
    });
  }

  _bindKeyboardEvents() {
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return; // suppress key-hold repeats

      const whiteIndex = this._WHITE_KEYS.indexOf(e.key);
      const blackIndex = this._BLACK_KEYS.indexOf(e.key);

      if (whiteIndex === -1 && blackIndex === -1) return; // not a piano key

      // Play locally
      if (whiteIndex > -1) this._playNote(this._whiteKeys[whiteIndex]);
      if (blackIndex > -1) this._playNote(this._blackKeys[blackIndex]);

      // Notify the server so other clients hear it too
      this._socket.emit('keydown', whiteIndex, blackIndex);
    });

    document.addEventListener('keyup', (e) => {
      if (e.repeat) return;

      const whiteIndex = this._WHITE_KEYS.indexOf(e.key);
      const blackIndex = this._BLACK_KEYS.indexOf(e.key);

      if (whiteIndex === -1 && blackIndex === -1) return;

      if (whiteIndex > -1) this._stopNote(this._whiteKeys[whiteIndex]);
      if (blackIndex > -1) this._stopNote(this._blackKeys[blackIndex]);

      this._socket.emit('keyup', whiteIndex, blackIndex);
    });
  }

  _bindSocketEvents() {
    // A remote peer pressed a key → play it here
    this._socket.on('receiveKeyDown', ({ whiteKeyIndex, blackKeyIndex }) => {
      if (whiteKeyIndex > -1) this._playNote(this._whiteKeys[whiteKeyIndex]);
      if (blackKeyIndex > -1) this._playNote(this._blackKeys[blackKeyIndex]);
    });

    // A remote peer released a key → stop it here
    this._socket.on('receiveKeyUp', ({ whiteKeyIndex, blackKeyIndex }) => {
      if (whiteKeyIndex > -1) this._stopNote(this._whiteKeys[whiteKeyIndex]);
      if (blackKeyIndex > -1) this._stopNote(this._blackKeys[blackKeyIndex]);
    });
  }

  // Private: audio helpers

  /**
   * Play the audio sample associated with a key element and mark it active.
   * @param {HTMLElement} keyEl
   */
  _playNote(keyEl) {
    if (!keyEl) return;
    const audio = document.getElementById(keyEl.dataset.note);
    if (!audio) return;

    audio.currentTime = 0; // allow re-trigger while already playing
    audio.play().catch(() => {
      // Autoplay may be blocked before the first user gesture — safe to ignore.
    });
    keyEl.classList.add('active');

    // Remove active class when audio ends naturally (covers mouse-click case)
    audio.addEventListener('ended', () => keyEl.classList.remove('active'), { once: true });
  }

  /**
   * Pause and reset the audio for a key and remove its active highlight.
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
