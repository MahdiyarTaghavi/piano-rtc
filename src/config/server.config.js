'use strict';

const path = require('path');

/**
 * Central configuration for the PianoRTC server.
 * All environment-sensitive values live here so no magic numbers
 * are scattered across the codebase.
 */
const config = {
  server: {
    port: process.env.PORT || 8080,
  },

  ssl: {
    keyPath:  path.resolve(__dirname, '../../ssl/server-key.pem'),
    certPath: path.resolve(__dirname, '../../ssl/server-cert.pem'),
  },

  paths: {
    public: path.resolve(__dirname, '../../public'),
    notes:  path.resolve(__dirname, '../../notes'),
  },

  webrtc: {
    defaultChannel: 'global-piano-channel',
  },
};

module.exports = config;
