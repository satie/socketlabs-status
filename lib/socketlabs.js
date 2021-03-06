var fs = require('fs');
var path = require('path');
var constants = require('constants');
var url = require('url');
var https = require('https');
var http_proxy = require('https-proxy-agent');
var async = require('async');
var Bottleneck = require('bottleneck');
var Plugin = require('nagios-plugin');
var logger = require('./logger.js');

var conf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'conf', 'default.json')));
if (conf.proxy_enabled == "true") {
  var proxy_server = process.env.http_proxy || conf.proxy_server;
  logger.debug("Proxy is enabled. Setting " + proxy_server + " as the proxy server");
  var agent = new http_proxy(proxy_server);
}

exports.checkAccountData = function(username, password, serverids, callback) {
  var limiter = new Bottleneck(1, conf.api_time_to_wait_ms);

  var servers = serverids.split(',') || conf.server_ids;
  // var server = serverid || conf.server_id;
  var u = username || conf.api_user;
  var p = password || conf.api_password;

  var sp = new Plugin({shortName: 'socketlabs'});
  sp.setThresholds({
    'critical': conf.critical_threshold,
    'warning': conf.warning_threshold
  });

  async.whilst(() => {return servers.length > 0;}, function(callback) {
    var chunk = servers.splice(0, conf.api_concurrent_limit);

    chunk.forEach(function(c) {
      limiter.submit(
        checkServer, c, u, p, sp, (e, r) => {
          callback(null, r);
        });
    });
  }, function(err, r) {
    var msgObj = sp.checkMessages();
    sp.nagiosExit(msgObj.state, msgObj.message);
  });
};

var checkServer = function(server, u, p, sp, callback) {
  var options = {
      hostname: conf.api_host,
      path: '/' + conf.api_version + '/' + conf.account_data_api_path + '?serverid=' + server,
      method: 'GET',
      auth: u + ':' + p,
      headers: {
        'content-type': 'application/json'
      }
  };

  if (agent) {
    options.agent = agent;
  }

  var body = "";
  var req = https.request(options, (res) => {
    res.on('data', (d) => {
      body += d;
    });

    res.on('end', () => {
      try {
        var json = JSON.parse(body);
        if (json.result) {
          callback(json.result, null);
        } else {
          var serverId = json.object.ServerId;
          var messageCount = json.object.BillingPeriodMessageCount;
          var messageAllowance = json.object.MessageAllowance;
          var bandwidthCountGB = json.object.BillingPeriodBandwidthCountInGigabytes;
          var bandwidthAllowanceGB = json.object.BandwidthAllowanceInGigabytes;
          var apiCount = json.object.BillingPeriodApiCount;
          var apiAllowance = json.object.MaxApiAllowance;
          var isOverMessageAllowance = json.object.IsOverMessageAllowance;
          var isOverBandwidthAllowance = json.object.IsOverBandwidthAllowance;
          var isOverApiAllowance = json.object.IsOverApiAllowance;

          var msgUsage  = parseFloat((messageCount/messageAllowance) * 100).toFixed(2);
          var bwUsage = parseFloat((bandwidthCountGB/bandwidthAllowanceGB) * 100).toFixed(2);
          var apiUsage = parseFloat((apiCount/apiAllowance) * 100).toFixed(2);

          var state = sp.checkThreshold(msgUsage);
          sp.addMessage(state, "Server " + serverId + " - " + msgUsage + "% of total message allowance used");
          sp.addPerfData({
              label : "message-usage",
              value : msgUsage,
              uom : "%",
              threshold : sp.threshold
          });

          if (isOverMessageAllowance == "true") {
            sp.addMessage(sp.states.CRITICAL, msgUsage + "% of total message allowance used");
          }

          var state = sp.checkThreshold(bwUsage);
          sp.addMessage(state, "Server " + serverId + " - " + bwUsage + "% of total bandwidth allowance used");
          sp.addPerfData({
              label : "bandwidth-usage",
              value : bwUsage,
              uom : "%",
              threshold : sp.threshold
          });

          if (isOverBandwidthAllowance == "true") {
            sp.addMessage(sp.states.CRITICAL, bwUsage + "% of total bandwidth allowance used");
          }

          var state = sp.checkThreshold(apiUsage);
          sp.addMessage(state, "Server " + serverId + " - " + apiUsage + "% of total API allowance used");
          sp.addPerfData({
              label : "api-usage",
              value : apiUsage,
              uom : "%",
              threshold : sp.threshold
          });

          if (isOverApiAllowance == "true") {
            sp.addMessage(sp.states.CRITICAL, apiUsage + "% of total API allowance used");
          }

          logger.debug("Server - " + serverId + " : Message usage - " + messageCount + "/" + messageAllowance
                      + "; Bandwidth usage - " + bandwidthCountGB + "/" + bandwidthAllowanceGB
                      + "; API usage - " + apiCount + "/" + apiAllowance);

          var messageObj = sp.checkMessages();
          // logger.debug(messageObj);
          callback(null, messageObj);
        }
      } catch (parseError) {
        sp.addMessage(sp.states.CRITICAL, body + ' - ' + parseError);
        callback(parseError, null);
      }
    });
  });

  req.on('error', (e) => {
    callback(e, null);
  });

  req.end();
};
