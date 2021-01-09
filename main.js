const { app, BrowserWindow } = require('electron')
const config = require('getconfig')
app.allowRendererProcessReuse = false
function createWindow () {
  const win = new BrowserWindow({
    x: config.xPos,
    y: config.yPos,
    width: config.width,
    height: config.height,
    webPreferences: {
      nodeIntegration: true
    },
    frame: false,
    alwaysOnTop: true,
    transparent: true
  })

  win.loadFile('index.html');

}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
