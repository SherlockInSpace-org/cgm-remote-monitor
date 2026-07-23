'use strict';

var units = require('../units')();

var STATE_ID = 'pixelalarm-state';

var MODES = {
  OFF: 'off'
  , ARMED: 'armed'
  , TRIGGERED: 'triggered'
};

// Only real CGM readings newer than this qualify for the safety passthrough
// check; anything older is treated as "no current data".
var SAFETY_RECENCY_MS = 15 * 60 * 1000;

/**
 * Remote-triggerable SugarPixel alarm.
 *
 * Serves modified glucose data to a single configured token subject (the
 * SugarPixel display) while every other consumer keeps seeing real data.
 * Nothing is ever written to the entries collection; all interception is
 * read-time only.
 *
 * States:
 *   off       - the target subject sees real data (feature dormant)
 *   armed     - the target subject sees an empty feed
 *   triggered - the target subject sees a fake LOW value with a fresh
 *               timestamp; the trigger window starts counting when the
 *               fake value is first fetched, and reverts to armed after
 *               config.triggerDuration seconds (or config.triggerTimeout
 *               seconds if the device never fetches it)
 */
function init (env, ctx) {

  var enabled = env.settings.isEnabled('pixelalarm');
  var ext = (env.extendedSettings && env.extendedSettings.pixelalarm) || {};

  function positiveNumber (value, fallback) {
    var parsed = Number(value);
    return isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  var config = {
    subject: String(ext.subject || 'sugarpixel').toLowerCase()
    , value: positiveNumber(ext.value, 40)
    , triggerDuration: positiveNumber(ext.triggerDuration, 60)
    , triggerTimeout: positiveNumber(ext.triggerTimeout, 1800)
    // 0 disables the safety passthrough
    , safetyThreshold: isFinite(Number(ext.safetyThreshold)) && Number(ext.safetyThreshold) >= 0 ? Number(ext.safetyThreshold) : 55
  };

  var state = {
    mode: MODES.OFF
    , armedAt: null
    , triggeredAt: null
    , triggeredBy: null
    , firstServedAt: null
  };

  function collection () {
    return ctx.store.collection(env.pixelalarm_collection);
  }

  function persist () {
    if (!enabled || !ctx.store) { return; }
    var doc = {
      _id: STATE_ID
      , mode: state.mode
      , armedAt: state.armedAt
      , triggeredAt: state.triggeredAt
      , triggeredBy: state.triggeredBy
      , firstServedAt: state.firstServedAt
      , updated_at: new Date().toISOString()
    };
    collection().replaceOne({ _id: STATE_ID }, doc, { upsert: true })
      .catch(function persistFailed (err) {
        console.error('pixelalarm: unable to persist state', err);
      });
  }

  function load () {
    if (!enabled || !ctx.store) { return; }
    collection().findOne({ _id: STATE_ID })
      .then(function loaded (doc) {
        if (doc && doc.mode && doc.mode !== state.mode) {
          state.mode = doc.mode;
          state.armedAt = doc.armedAt || null;
          state.triggeredAt = doc.triggeredAt || null;
          state.triggeredBy = doc.triggeredBy || null;
          state.firstServedAt = doc.firstServedAt || null;
        }
        console.info('pixelalarm: enabled, mode is', state.mode, '- target subject is "' + config.subject + '"');
      })
      .catch(function loadFailed (err) {
        console.error('pixelalarm: unable to load persisted state', err);
      });
  }

  function revertToArmed (reason) {
    console.info('pixelalarm: reverting to armed -', reason);
    state.mode = MODES.ARMED;
    state.triggeredAt = null;
    state.triggeredBy = null;
    state.firstServedAt = null;
    persist();
  }

  function expireIfNeeded (now) {
    if (state.mode !== MODES.TRIGGERED) { return; }
    if (state.firstServedAt && now >= state.firstServedAt + config.triggerDuration * 1000) {
      revertToArmed('trigger window of ' + config.triggerDuration + 's elapsed');
    } else if (!state.firstServedAt && state.triggeredAt && now >= state.triggeredAt + config.triggerTimeout * 1000) {
      revertToArmed('trigger was never fetched within ' + config.triggerTimeout + 's');
    }
  }

  function iso (mills) {
    return mills ? new Date(mills).toISOString() : null;
  }

  function status () {
    expireIfNeeded(Date.now());
    return {
      enabled: enabled
      , mode: state.mode
      , armedAt: iso(state.armedAt)
      , triggeredAt: iso(state.triggeredAt)
      , triggeredBy: state.triggeredBy
      , firstServedAt: iso(state.firstServedAt)
      , expiresAt: state.mode === MODES.TRIGGERED && state.firstServedAt ? iso(state.firstServedAt + config.triggerDuration * 1000) : null
      , config: {
        subject: config.subject
        , value: config.value
        , triggerDurationSeconds: config.triggerDuration
        , triggerTimeoutSeconds: config.triggerTimeout
        , safetyThreshold: config.safetyThreshold
      }
    };
  }

  function arm (by) {
    console.info('pixelalarm: armed by', by);
    state.mode = MODES.ARMED;
    state.armedAt = Date.now();
    state.triggeredAt = null;
    state.triggeredBy = null;
    state.firstServedAt = null;
    persist();
    return status();
  }

  function disarm (by) {
    console.info('pixelalarm: disarmed by', by);
    state.mode = MODES.OFF;
    state.armedAt = null;
    state.triggeredAt = null;
    state.triggeredBy = null;
    state.firstServedAt = null;
    persist();
    return status();
  }

  // Returns null when not armed; triggering while already triggered restarts
  // the window so the alarm can be re-fired immediately.
  function trigger (by) {
    expireIfNeeded(Date.now());
    if (state.mode === MODES.OFF) { return null; }
    console.info('pixelalarm: triggered by', by);
    state.mode = MODES.TRIGGERED;
    state.triggeredAt = Date.now();
    state.triggeredBy = by || null;
    state.firstServedAt = null;
    persist();
    return status();
  }

  // The trigger window starts when the device first fetches the fake value,
  // not when the trigger was sent: the SugarPixel may poll as rarely as every
  // 5 minutes, so a short window anchored to the trigger time could expire
  // before the device ever sees the LOW.
  function served () {
    if (state.mode === MODES.TRIGGERED && !state.firstServedAt) {
      state.firstServedAt = Date.now();
      console.info('pixelalarm: fake value fetched by target, trigger window of', config.triggerDuration, 'seconds started');
      persist();
    }
  }

  function latestRealGlucose (now) {
    var sgvs = (ctx.ddata && ctx.ddata.sgvs) || [];
    var latest = null;
    for (var i = 0; i < sgvs.length; i++) {
      if (sgvs[i] && sgvs[i].mills && (!latest || sgvs[i].mills > latest.mills)) {
        latest = sgvs[i];
      }
    }
    if (latest && now - latest.mills <= SAFETY_RECENCY_MS && latest.mgdl > 0) {
      return latest.mgdl;
    }
    return null;
  }

  var NO_INTERCEPT = { intercept: false };

  function remember (req, decision) {
    req.pixelalarm_decision = decision;
    return decision;
  }

  /**
   * Decide whether this request should get modified data. The decision is
   * cached on the request so repeated calls (precheck + apply) resolve the
   * caller only once. Callback receives { intercept, action: 'blank'|'fake' }.
   */
  function decide (req, callback) {
    if (!enabled) { return callback(NO_INTERCEPT); }
    if (req.pixelalarm_decision) { return callback(req.pixelalarm_decision); }

    var now = Date.now();
    expireIfNeeded(now);

    if (state.mode === MODES.OFF) { return callback(remember(req, NO_INTERCEPT)); }

    ctx.authorization.resolveWithRequest(req, function resolved (err, result) {
      if (err || !result || !result.subject || String(result.subject.name).toLowerCase() !== config.subject) {
        return callback(remember(req, NO_INTERCEPT));
      }

      if (config.safetyThreshold > 0) {
        var realGlucose = latestRealGlucose(now);
        if (realGlucose !== null && realGlucose <= config.safetyThreshold) {
          console.info('pixelalarm: safety passthrough - real glucose', realGlucose, 'is at/below', config.safetyThreshold);
          return callback(remember(req, { intercept: false, safety: true }));
        }
      }

      var decision = {
        intercept: true
        , action: state.mode === MODES.TRIGGERED ? 'fake' : 'blank'
      };
      console.info('pixelalarm: intercepting', req.method, req.originalUrl, '->', decision.action);
      callback(remember(req, decision));
    });
  }

  function fakeId (now) {
    return ('000000000000000000000000' + now.toString(16)).slice(-24);
  }

  function makeFakeEntry (now) {
    return {
      _id: fakeId(now)
      , type: 'sgv'
      , sgv: config.value
      , direction: 'Flat'
      , device: 'pixelalarm'
      , date: now
      , mills: now
      , dateString: new Date(now).toISOString()
      , sysTime: new Date(now).toISOString()
      , utcOffset: 0
    };
  }

  function scaledValue (mmol) {
    return mmol ? units.mgdlToMMOL(config.value) : String(config.value);
  }

  function passthrough (req, res, next) {
    next();
  }

  /**
   * Router-level middleware for the v1 entries router. Decides early and,
   * when intercepting, strips If-Modified-Since so a 304 can't suppress the
   * fake/blank payload.
   */
  function interceptV1EntriesPrecheck (req, res, next) {
    if (req.method !== 'GET') { return next(); }
    decide(req, function decided (decision) {
      if (decision.intercept) {
        delete req.headers['if-modified-since'];
      }
      next();
    });
  }

  // Route-level middleware placed just before format_entries; replaces the
  // assembled res.entries payload for the target subject.
  function interceptV1EntriesApply (req, res, next) {
    decide(req, function decided (decision) {
      if (decision.intercept) {
        res.entries_err = null;
        if (decision.action === 'fake') {
          res.entries = [makeFakeEntry(Date.now())];
          served();
        } else {
          res.entries = [];
        }
      }
      next();
    });
  }

  // Short-circuits /pebble with an empty or fake bgs payload.
  function interceptPebble (req, res, next) {
    decide(req, function decided (decision) {
      if (!decision.intercept) { return next(); }
      var now = Date.now();
      var bgs = [];
      if (decision.action === 'fake') {
        bgs = [{
          sgv: scaledValue(req.mmol)
          , trend: 4
          , direction: 'Flat'
          , datetime: now
          , bgdelta: 0
        }];
        served();
      }
      res.setHeader('content-type', 'application/json');
      res.write(JSON.stringify({
        status: [{ now: now }]
        , bgs: bgs
        , cals: []
      }));
      res.end();
    });
  }

  // Short-circuits /api/v2/properties: {} when armed, minimal synthetic
  // bgnow/delta/direction when triggered (never a copy of the real
  // properties, so nothing real can leak through plugin output).
  function interceptProperties (req, res, next) {
    decide(req, function decided (decision) {
      if (!decision.intercept) { return next(); }
      if (decision.action !== 'fake') { return res.json({}); }
      var now = Date.now();
      var mmol = env.settings.units === 'mmol';
      res.json({
        bgnow: {
          mean: config.value
          , last: config.value
          , mills: now
          , sgvs: [{
            _id: fakeId(now)
            , mgdl: config.value
            , mills: now
            , device: 'pixelalarm'
            , direction: 'Flat'
            , scaled: mmol ? units.mgdlToMMOL(config.value) : config.value
          }]
        }
        , delta: {
          absolute: 0
          , elapsedMins: 5
          , interpolated: false
          , mean5MinsAgo: config.value
          , mgdl: 0
          , scaled: 0
          , display: '+0'
        }
        , direction: {
          value: 'Flat'
          , label: '→'
          , entity: '&#8594;'
        }
      });
      served();
    });
  }

  /**
   * Mounted on the API v3 app ahead of the generic collection routes.
   * Answers GET /entries* for the target subject with a search-shaped
   * payload. decide() only ever intercepts callers presenting a valid token
   * that resolves to the configured subject, so authentication has already
   * effectively happened.
   */
  function interceptV3 (req, res, next) {
    if (req.method !== 'GET' || !/^\/entries($|[/.?])/.test(req.path)) { return next(); }
    decide(req, function decided (decision) {
      if (!decision.intercept) { return next(); }
      var result = [];
      if (decision.action === 'fake') {
        var now = Date.now();
        var entry = makeFakeEntry(now);
        entry.identifier = entry._id;
        entry.srvModified = now;
        entry.srvCreated = now;
        result = [entry];
        served();
      }
      res.status(200).json({ status: 200, result: result });
    });
  }

  load();

  if (enabled) {
    console.info('pixelalarm: feature enabled with config', JSON.stringify(config));
  }

  var pixelalarm = {
    enabled: enabled
    , config: config
    , modes: MODES
    , status: status
    , arm: arm
    , disarm: disarm
    , trigger: trigger
    , served: served
    , decide: decide
    , interceptV1EntriesPrecheck: enabled ? interceptV1EntriesPrecheck : passthrough
    , interceptV1EntriesApply: enabled ? interceptV1EntriesApply : passthrough
    , interceptPebble: enabled ? interceptPebble : passthrough
    , interceptProperties: enabled ? interceptProperties : passthrough
    , interceptV3: enabled ? interceptV3 : passthrough
  };

  return pixelalarm;
}

module.exports = init;
