'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');

function createStatsWindow() {
  const win = new BrowserWindow({
    width:  420,
    height: 340,
    frame:           false,
    resizable:       false,
    skipTaskbar:     false,
    transparent:     false,
    backgroundColor: '#060830',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  return win;
}

module.exports = { createStatsWindow };
