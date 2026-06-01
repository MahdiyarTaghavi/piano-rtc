'use strict';

/**
 * app.js — Client composition root
 *
 * Responsibility: wire the application together. Nothing else.
 *  - Creates the shared Socket.IO connection for signaling
 *  - Instantiates WebRTCClient and PianoController with their dependencies
 *  - Calls init() on each in the correct order
 *  - Joins the signaling channel to start peer discovery
 *
 * Dependency graph (what depends on what):
 *
 *   socket  →  WebRTCClient  →  PianoController
 *
 * socket is the only thing PianoController no longer needs directly —
 * it communicates exclusively through rtcClient.sendData / rtcClient.onData
 * after the WebRTC handshake completes. The signaling socket is only used
 * for the initial offer/answer/ICE exchange, which WebRTCClient handles.
 *
 * If this file grows beyond wiring, something belongs in one of the classes.
 */

const CONFIG = {
  signalingServer: `${window.location.protocol}//${window.location.hostname}${window.location.port ? ':' + window.location.port : ''}`,
  channel:         'global-piano-channel',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

document.addEventListener('DOMContentLoaded', async () => {

  // 1. One socket for WebRTC signaling (offer/answer/ICE only — no notes)
  const socket = io(CONFIG.signalingServer);

  // 2. WebRTC handles video, audio, AND the DataChannel for piano events
  const rtcClient = new WebRTCClient({
    socket,
    localVideo:  document.getElementById('localVideo'),
    remoteVideo: document.getElementById('remoteVideo'),
    iceServers:  CONFIG.iceServers,
  });

  // 3. Piano receives rtcClient — it calls sendData() to send notes
  //    and sets rtcClient.onData to receive notes from the peer.
  //    No socket reference needed here anymore.
  const piano = new PianoController(rtcClient);

  // 4. Initialise both (order matters: media must be ready before joining)
  await rtcClient.init();
  piano.init();

  // 5. Join the shared channel → triggers peer discovery on the server
  //    After this, the server sends addPeer events which kick off the
  //    offer/answer handshake including DataChannel negotiation.
  rtcClient.join(CONFIG.channel);
});
