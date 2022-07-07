statusHelper = require("./node_helper.js"); //@todo change from singleton to class
DomFactory = require("./js/DomFactory.js")
module.exports = {
  defaults: {
    name: "raspberrypi"
  },

  start: function() {
    this.factory = new DomFactory(this.file(""));
    this.helper = statusHelper;
    this.helper.start((payload) => this.updateResults(payload));
    this.init()
  },
  
  getStyles: function () {
    return [this.file("./css/nowPlaying.css")];
  },

  getDom: function () {
    return this.factory.buildDom(this.playerState);
  },

  init: function (notification, payload) {
    if (notification === "MODULE_DOM_CREATED") {
      Log.info("sent api startup request");
      let pay = {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        refreshToken: this.config.refreshToken
      };
      Log.info(pay);
      Log.info(this.config);
      this.helper.notify("SPOTIFYSTATUS_SEND_CONFIG", this.config);
      this.helper.notify("SPOTIFYSTATUS_BEGIN_UPDATES", pay);
    }
  },

  updateResults: function (payload) {
    this.playerState = payload;
  }
};
