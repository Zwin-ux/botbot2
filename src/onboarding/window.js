const { BrowserWindow } = require('electron');
const path = require('path');

function createOnboardingWindow() {
  const win = new BrowserWindow({
    width:           560,
    height:          460,
    resizable:       false,
    center:          true,
    frame:           false,
    transparent:     false,
    backgroundColor: '#0b0b12',
    show:            false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

module.exports = { createOnboardingWindow };
