'use strict';

/**
 * server.js — Application entry point
 *
 * Responsibility: bootstrap infrastructure only.
 * Business logic lives in src/routes/ and src/socket/.
 *
 * To start:  node server.js
 */

const fs      = require('fs');
const https   = require('https');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');

const config           = require('./src/config/server.config');
const { registerStaticRoutes } = require('./src/routes/static.routes');
const SignalingHandler = require('./src/socket/signaling.handler');

// 1. Express app
const app = express();
registerStaticRoutes(app);

// 2. HTTPS server
//  HTTPS is required because getUserMedia (camera/mic access) is only available
//  in secure contexts. We use a self-signed cert for local development.
const sslCredentials = {
  key:  fs.readFileSync(config.ssl.keyPath,  'utf8'),
  cert: fs.readFileSync(config.ssl.certPath, 'utf8'),
};
const httpsServer = https.createServer(sslCredentials, app);

// 3. Socket.IO
const io = new SocketIOServer(httpsServer);
const signalingHandler = new SignalingHandler();
signalingHandler.attach(io);

// 4. Start
// httpsServer.listen(config.server.port, () => {
//   console.log(`PianoRTC server running → https://localhost:${config.server.port}`);
// });
httpsServer.listen(config.server.port, "0.0.0.0", () => {
  console.log(`PianoRTC server running → https://localhost:${config.server.port}`);
});