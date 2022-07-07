/* eslint-disable prettier/prettier */

const SpotifyWebApi = require("spotify-web-api-node");
const dayjs = require("dayjs");
const duration = require("dayjs/plugin/duration");
const isSameOrAfter = require("dayjs/plugin/isSameOrAfter");
const dbus = require("dbus-next");
const Variant = dbus.Variant;
const DataIntegrator = require("./js/DataIntegrator.js");
dayjs.extend(isSameOrAfter);
dayjs.extend(duration);

class DBusInterface {
  constructor() {
    // Spotify
    this.api = undefined;
    this.validUntil = undefined;

    // DBus
    this.bus = dbus.systemBus();
    this.bus.getProxyObject("org.bluez", "/").then((result) => {
      this.obj = result;
      this.manager = this.obj.getInterface("org.freedesktop.DBus.ObjectManager");
    }, (err) => process.send(err));
    
    // Bluetooth
    this.deviceStates = {};
    this.bluetoothPlayerInterface = undefined;
    this.currentDevice = undefined;
    
    this.integrator = undefined;
    process.send("finished setup")
  }

  socketNotificationReceived(payload) {
    if (payload === "SPOTIFYSTATUS_BEGIN_UPDATES") {
      process.send("Received startup signal");
      if (this.api === undefined) {
        process.send("Creating Spotify API object with credentials:");
        process.send(payload);
        this.api = new SpotifyWebApi({
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          refreshToken: this.config.refreshToken
        });

        this.ensureAccessToken();
        setInterval(async () => {
          this.ensureAccessToken();
          let apiResult = await this.api.getMyCurrentPlaybackState();
          let bluetoothData = await this.getBluetoothData();
          let spotifyData = this.processSpotifyData(apiResult.body);
          let payload = this.integrator.integrateSpotifyBluetooth({bluetooth: bluetoothData, spotify: spotifyData});
          process.send(payload);
        }, 500);
      }

      this.bus.getProxyObject("org.bluez", "/org/bluez/hci0").then(async r => {
        process.send("Paired Bluetooth Devices:");
        let anyDevices = false;
        for (let deviceName of r.nodes){
          anyDevices = true;
          process.send(deviceName)
        }
        if (!anyDevices){
          process.send("no devices found!")
        }

        //For each device already paired on startup,
        for (let i = 0; i <  r.nodes.length; i++){
          let deviceName = r.nodes[i];

          let deviceTopNode = await this.bus.getProxyObject("org.bluez", deviceName)
            .catch(err => {process.send(`No device interface found for device ${deviceName}`)});
          let devicePlayerNode = await this.bus.getProxyObject("org.bluez", deviceName + "/player0")
            .catch(err => {process.send(`No player found for device ${deviceName}`)});
          let deviceProperties = deviceTopNode.getInterface("org.freedesktop.DBus.Properties");
          

          //Set human-legible device alias
          this.deviceStates[deviceName] = {
            connected: false, 
            alias: (await deviceProperties.Get("org.bluez.Device1", "Alias")).value
          };         
          //if this device's alias isn't listed to be ignored,
          process.send("Alias: ")
          process.send(this.deviceStates[deviceName].alias)
          if (this.config.ignoreDevices.includes(this.deviceStates[deviceName].alias)){ //if this device is on the ignore list, don't do anything
            process.send('Ignoring')
            continue;
          }
          //Try to connect to this device and read its player state
          try {
            await this.setBluetoothInterface(deviceTopNode, devicePlayerNode, deviceName);
          } catch (err) {
            process.send(`No player found on startup for ${deviceName}`)
          }

          //Set a listener for changes in this device's connection state
          deviceProperties.on("PropertiesChanged", async (iface, changed, invalidated) => {
            if (iface === "org.bluez.Device1") {
              for (let property of Object.keys(changed)){
                if (property === "Connected") {
                  let x = changed[property];
                  if (x.value === true) {
                      process.send(`Creating D-Bus Bluetooth interface for new connection: ${deviceName}`);
                      let iterations = 0;
                      let retries = setInterval(async () => {
                        try{
                          let updatedDeviceTopNode = await this.bus.getProxyObject("org.bluez", deviceName);
                          let updatedDevicePlayerNode = await this.bus.getProxyObject("org.bluez", deviceName + "/player0");
                          await this.setBluetoothInterface(updatedDeviceTopNode, updatedDevicePlayerNode, deviceName);
                          clearInterval(retries);
                        } catch (err) {
                          process.send("retrying...")
                          iterations = iterations + 1;
                          if (iterations > 15) {
                            clearInterval(retries);
                            process.send(`Listener creation timed out for ${deviceName}. Maybe disconnect and reconnect? Final error:`);
                            process.send(err);
                          }
                        }
                      }, 1000);
                  } else {
                    this.deviceStates[deviceName].connected = false;
                    process.send(`Device disconnected: ${deviceName}`);
                  }
                  process.send(this.deviceStates)
                }
              }
            }
          });
        }
      }, err => process.send(err));
    } else {
        this.config = payload;
        this.integrator = new DataIntegrator(this.config.name);
    }
  }

  async setBluetoothInterface(deviceNode, playerNode, deviceName) {
    let mediaPlayer = playerNode.getInterface("org.freedesktop.DBus.Properties");
    process.send(`Successfully created player interface to ${deviceName}`);
    this.bluetoothPlayerInterface = mediaPlayer;
    this.deviceStates[deviceName].connected = true;

  }

  isBluetoothConnected() {
    for (let deviceName of Object.keys(this.deviceStates)){
      if (this.deviceStates[deviceName].connected){
        return {connected: true, deviceAlias: this.deviceStates[deviceName].alias};
      }
    }
    return {connected: false, deviceAlias: null};
  }

  async getBluetoothData() {  //@todo refactor heavily
    let connectionStatus = this.isBluetoothConnected();
    if (!connectionStatus.connected){
      return {
        connected: false,
        active: null,
        deviceAlias: null,
        trackName: null,
        progress: null,
        duration: null
      }
    }
    if (this.bluetoothPlayerInterface === undefined){
      console.error("Connected to device , but no interface established!")
      return {
        connected: false,
        active: null,
        deviceAlias: null,
        trackName: null,
        progress: null,
        duration: null
      }
    }
    
    // otherwise, assume we have the right interface selected
    let position, track, duration;
    let badInterface = false;
    let positionVariant, trackVariant;
    let active = true;

    try { 
      positionVariant = await this.bluetoothPlayerInterface.Get("org.bluez.MediaPlayer1", "Position");
      position = positionVariant.value;
    } catch (err) {
      position = null;
    }
    try {
      trackVariant = await this.bluetoothPlayerInterface.Get("org.bluez.MediaPlayer1", "Track");
    } catch (err) {
      active = false;
    }
    try {
      track = trackVariant.value.Title.value;
    } catch (err){
      track = null;
    }
    try {
      duration = trackVariant.value.Duration.value
    } catch (err) {
      duration = null;
    }

    if (track === "Not Provided"){
      active = false;
    }
    return {
      connected: true,
      active: active,
      deviceAlias: connectionStatus.deviceAlias,
      trackName: track,
      position: position,
      duration: duration
    }
  }

  processSpotifyData(apiResult) {
    if (apiResult.item === null || apiResult.item === undefined) {
      return {
        active: false,
        imgUrl: null,
        trackName: null,
        position: null,
        duration: null
      };
    }
    let device = apiResult.device.name
    let progress = apiResult.progress_ms
    let stamp = apiResult.timestamp
    let duration = apiResult.item.duration_ms;

    return {
      device: device,
      active: true,
      imgUrl: apiResult.item.album.images[0].url,
      trackName: apiResult.item.name,
      position: apiResult.progress_ms,
      duration: apiResult.item.duration_ms
    };
  }

  ensureAccessToken() {
    if (
      this.validUntil === undefined ||
      dayjs().isSameOrAfter(this.validUntil)
    ) {
      this.api.refreshAccessToken().then(
        (result) => {
          process.send("Refreshed token:");
          process.send(result.body);
          this.api.setAccessToken(result.body.access_token);
          let lastRefreshed = dayjs();
          this.validUntil = lastRefreshed.add(result.body.expires_in, "seconds");
        },
        (err) => console.error(err)
      );
    }
  }
}
try {

  
let interf = new DBusInterface()

process.on('message', (m) => {
  process.send(m)
  interf.socketNotificationReceived(m)
  })
} catch (e) {
  process.send(e.message)
}