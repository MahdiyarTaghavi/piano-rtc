'use strict';

const express = require('express');
const path    = require('path');
const config  = require('../config/server.config');

/**
 * Registers all static-asset routes on the given Express app.
 *
 * Design note: instead of one route per MP3 file (as in the original),
 * we use express.static to serve the entire `public/` and `notes/`
 * directories. This is idiomatic Express and scales automatically as
 * new files are added.
 *
 * @param {express.Application} app
 */
function registerStaticRoutes(app) {
  // Serve everything inside /public (HTML, CSS, client JS)
  app.use(express.static(config.paths.public));

  // Serve MP3 note files under the /notes URL prefix
  app.use('/notes', express.static(config.paths.notes));

  // Fallback: any unknown GET → index.html (supports future SPA routing)
  app.get('*', (_req, res) => {
    res.sendFile(path.join(config.paths.public, 'index.html'));
  });
}

module.exports = { registerStaticRoutes };
