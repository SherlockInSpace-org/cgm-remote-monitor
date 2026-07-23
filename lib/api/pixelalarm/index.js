'use strict';

/**
 * Control API for the remote SugarPixel alarm (see lib/server/pixelalarm.js).
 *
 * Permissions (all lowercase, deliberately two-segment so the default
 * 'readable' role (*:*:read) does NOT match them):
 *   pixelalarm:read    - GET  /pixelalarm/status
 *   pixelalarm:admin   - POST /pixelalarm/arm, POST /pixelalarm/disarm
 *   pixelalarm:trigger - POST /pixelalarm/trigger
 *
 * The admin API_SECRET resolves to '*' and passes all of them.
 */
function configure (app, wares, ctx) {
  var express = require('express')
    , api = express.Router();

  api.use(wares.compression());
  api.use(wares.bodyParser.json({
    limit: '1Mb'
  }));
  api.use(wares.urlencodedParser);
  api.use(wares.sendJSONStatus);

  // Resolves who is acting for audit logging; the API_SECRET admin has no
  // subject, so it is reported as 'admin'.
  function actorName (req, callback) {
    ctx.authorization.resolveWithRequest(req, function resolved (err, result) {
      callback(result && result.subject && result.subject.name ? result.subject.name : 'admin');
    });
  }

  api.get('/pixelalarm/status', ctx.authorization.isPermitted('pixelalarm:read'), function getStatus (req, res) {
    res.json(ctx.pixelalarm.status());
  });

  api.post('/pixelalarm/arm', ctx.authorization.isPermitted('pixelalarm:admin'), function postArm (req, res) {
    actorName(req, function withActor (by) {
      res.json(ctx.pixelalarm.arm(by));
    });
  });

  api.post('/pixelalarm/disarm', ctx.authorization.isPermitted('pixelalarm:admin'), function postDisarm (req, res) {
    actorName(req, function withActor (by) {
      res.json(ctx.pixelalarm.disarm(by));
    });
  });

  api.post('/pixelalarm/trigger', ctx.authorization.isPermitted('pixelalarm:trigger'), function postTrigger (req, res) {
    actorName(req, function withActor (by) {
      var result = ctx.pixelalarm.trigger(by);
      if (!result) {
        return res.status(409).json({
          status: 409
          , message: 'pixelalarm is not armed'
          , current: ctx.pixelalarm.status()
        });
      }
      res.json(result);
    });
  });

  return api;
}

module.exports = configure;
