const { app, BrowserWindow, ipcMain } = require('electron')
const {fork} = require('child_process')
const config = require('getconfig')
const path = require('path')
app.allowRendererProcessReuse = false
let win;
function createWindow () {
  win = new BrowserWindow({
    //x: config.xPos,
    //y: config.yPos,
    //width: config.width,
    //height: config.height,
    fullscreen: true,
    webPreferences: {
      nodeIntegration: true
    },
    frame: false,
    //alwaysOnTop: true,
    //transparent: true
  })

  win.loadFile('index.html');
  win.webContents.on('render-process-gone', e => {
    if (e.details !== 'killed') {
      app.relaunch();
    }
  })
}

app.whenReady().then(createWindow);
console.log(path.join(__dirname, 'node_helper.js'))
const helper = fork(path.join(__dirname, 'node_helper.js'), ['yo'], {
	stdio: ['pipe', 'pipe', 'pipe', 'ipc']
});

helper.on('message', (m) => {
  if (typeof(m) !== 'string'){
    console.log("forwarding state")
    win.webContents.send('playerState', m)
  }  else {
    console.log("message from fork")
  }
  console.log(m)
})

process.stderr.old_write = process.stderr.write
process.stderr.write = function (data, cb){
  console.log((typeof data) + "!")
  return process.stderr.old_write(data, cb)
}
helper.send(config);
helper.send("SPOTIFYSTATUS_BEGIN_UPDATES")
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {

    app.quit()
  }
})
