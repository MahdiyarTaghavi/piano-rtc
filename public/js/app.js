'use strict';

/**
 * app.js — Client entry point
 *
 * Responsibility: composition root only.
 * - Creates the shared socket connection
 * - Instantiates WebRTCClient and PianoController with their dependencies
 * - Calls init() on each, then joins the default channel
 *
 * No business logic lives here. If this file grows, something is wrong.
 */

// Configuration
const CONFIG = {
  signalingServer: `${window.location.protocol}//${window.location.hostname}${window.location.port ? ':' + window.location.port : ''}`,
  channel:         'global-piano-channel',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

//(runs when DOM is ready)
document.addEventListener('DOMContentLoaded', async () => {
  // 1. One shared socket connection for both piano and WebRTC signaling
  const socket = io(CONFIG.signalingServer);

  // 2. WebRTC video/audio peer connections
  const rtcClient = new WebRTCClient({
    socket,
    localVideo:  document.getElementById('localVideo'),
    remoteVideo: document.getElementById('remoteVideo'),
    iceServers:  CONFIG.iceServers,
  });

  // 3. Piano keyboard UI and note synchronisation
  const piano = new PianoController(socket);

  // 4. Initialise both (order matters: media must be ready before joining)
  await rtcClient.init();
  piano.init();

  // 5. Join the shared channel: this triggers peer discovery on the server
  rtcClient.join(CONFIG.channel);
});
