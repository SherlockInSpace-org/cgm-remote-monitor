'use strict';

const _ = require('lodash');
const request = require('supertest');
const language = require('../lib/language')();
require('should');

describe('Pixelalarm API', function () {
  this.timeout(30000);
  const self = this;
  const known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  // Trigger window intentionally short so expiry is testable; long enough
  // that the block of assertions between trigger and expiry can't race it.
  const TRIGGER_DURATION_SECONDS = 3;

  const managedEnvVars = {
    ENABLE: 'careportal api pixelalarm'
    , PIXELALARM_SUBJECT: 'sugarpixel'
    , PIXELALARM_VALUE: '40'
    , PIXELALARM_TRIGGER_DURATION: String(TRIGGER_DURATION_SECONDS)
    , PIXELALARM_TRIGGER_TIMEOUT: '600'
    , PIXELALARM_SAFETY_THRESHOLD: '55'
  };
  const savedEnvVars = {};

  function createRole (authStorage, name, permissions) {
    return new Promise((resolve, reject) => {
      let role = _.find(authStorage.roles, { name });
      if (role) { return resolve(role); }
      authStorage.createRole({ name, permissions, notes: '' }, function afterCreate (err) {
        if (err) { return reject(err); }
        resolve(_.find(authStorage.roles, { name }));
      });
    });
  }

  function createSubject (authStorage, name, roles) {
    return new Promise((resolve, reject) => {
      let subject = _.find(authStorage.subjects, { name });
      if (subject) { return resolve(subject); }
      authStorage.createSubject({ name, roles, notes: '' }, function afterCreate (err) {
        if (err) { return reject(err); }
        resolve(_.find(authStorage.subjects, { name }));
      });
    });
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    _.forEach(managedEnvVars, function (value, key) {
      savedEnvVars[key] = process.env[key];
      process.env[key] = value;
    });

    const api = require('../lib/api/');
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.authFailDelay = 50;
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(async function booted (ctx) {
      self.ctx = ctx;
      self.app.use('/api/v1', api(self.env, ctx));
      self.app.use('/api/v2/authorization', ctx.authorization.endpoints);
      self.app.get('/pebble', ctx.pebble);
      self.app.use('/properties', ctx.properties);

      // Minimal stand-in for the API v3 app: the interceptor in front of a
      // marker route, exactly how lib/api3/index.js mounts it in front of
      // the generic collection routes.
      const v3ish = require('express')();
      v3ish.use(ctx.pixelalarm.interceptV3);
      v3ish.get('/entries', function (req, res) { res.json({ status: 200, result: 'REAL-V3' }); });
      self.app.use('/api/v3', v3ish);

      try {
        await createRole(ctx.authorization.storage, 'pixelalarm-remote', ['pixelalarm:read', 'pixelalarm:trigger']);
        const sugarpixel = await createSubject(ctx.authorization.storage, 'sugarpixel', ['readable']);
        const wife = await createSubject(ctx.authorization.storage, 'wife', ['pixelalarm-remote']);
        self.pixelToken = sugarpixel.accessToken;
        self.wifeToken = wife.accessToken;

        // Seed one real CGM entry so live-data assertions have something to see
        request(self.app)
          .post('/api/v1/entries/')
          .set('api-secret', known)
          .send([{ type: 'sgv', sgv: 100, date: Date.now(), dateString: new Date().toISOString(), direction: 'Flat', device: 'test-cgm' }])
          .expect(200)
          .end(done);
      } catch (err) {
        done(err);
      }
    });
  });

  after(async function () {
    _.forEach(managedEnvVars, function (value, key) {
      if (savedEnvVars[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnvVars[key];
      }
    });
    if (self.ctx && self.ctx.store) {
      const prefix = self.env.authentication_collections_prefix;
      await self.ctx.store.collection(prefix + 'subjects').deleteMany({ name: { $in: ['sugarpixel', 'wife'] } });
      await self.ctx.store.collection(prefix + 'roles').deleteMany({ name: 'pixelalarm-remote' });
      await self.ctx.store.collection(self.env.pixelalarm_collection).deleteMany({});
      await self.ctx.store.collection(self.env.entries_collection).deleteMany({ device: 'test-cgm' });
    }
  });

  it('rejects anonymous status reads even on a readable site', function (done) {
    request(self.app)
      .get('/api/v1/pixelalarm/status')
      .expect(401, done);
  });

  it('rejects arm attempts from the trigger-only token', function (done) {
    request(self.app)
      .post('/api/v1/pixelalarm/arm?token=' + self.wifeToken)
      .expect(401, done);
  });

  it('rejects trigger attempts from the readable sugarpixel token', function (done) {
    request(self.app)
      .post('/api/v1/pixelalarm/trigger?token=' + self.pixelToken)
      .expect(401, done);
  });

  it('reports mode off to the admin and the remote token', function (done) {
    request(self.app)
      .get('/api/v1/pixelalarm/status')
      .set('api-secret', known)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.enabled.should.equal(true);
        res.body.mode.should.equal('off');
        res.body.config.value.should.equal(40);
        request(self.app)
          .get('/api/v1/pixelalarm/status?token=' + self.wifeToken)
          .expect(200)
          .end(function (err2, res2) {
            if (err2) { return done(err2); }
            res2.body.mode.should.equal('off');
            done();
          });
      });
  });

  it('returns 409 when triggering while not armed', function (done) {
    request(self.app)
      .post('/api/v1/pixelalarm/trigger?token=' + self.wifeToken)
      .expect(409)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.current.mode.should.equal('off');
        done();
      });
  });

  it('serves real data to the sugarpixel token while off', function (done) {
    request(self.app)
      .get('/api/v1/entries/sgv.json?count=10&token=' + self.pixelToken)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.should.be.an.Array();
        res.body.length.should.be.above(0, 'expected real entries');
        _.some(res.body, { device: 'pixelalarm' }).should.equal(false, 'no fake entries expected');
        done();
      });
  });

  it('arms via the admin secret', function (done) {
    request(self.app)
      .post('/api/v1/pixelalarm/arm')
      .set('api-secret', known)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.mode.should.equal('armed');
        should(res.body.armedAt).not.be.null();
        done();
      });
  });

  it('serves an empty feed to the sugarpixel token while armed', function (done) {
    request(self.app)
      .get('/api/v1/entries/sgv.json?count=10&token=' + self.pixelToken)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.should.be.an.Array();
        res.body.length.should.equal(0);
        request(self.app)
          .get('/pebble?token=' + self.pixelToken)
          .expect(200)
          .end(function (err2, res2) {
            if (err2) { return done(err2); }
            res2.body.bgs.should.be.an.Array();
            res2.body.bgs.length.should.equal(0);
            done();
          });
      });
  });

  it('keeps serving real data to the admin while armed', function (done) {
    request(self.app)
      .get('/api/v1/entries.json?count=10')
      .set('api-secret', known)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.length.should.be.above(0, 'expected real entries for the admin');
        _.some(res.body, { device: 'pixelalarm' }).should.equal(false, 'no fake entries for the admin');
        done();
      });
  });

  it('passes real data through while armed when real glucose is at/below the safety threshold', function (done) {
    self.ctx.ddata.sgvs = [{ mills: Date.now(), mgdl: 45 }];
    request(self.app)
      .get('/api/v1/entries/sgv.json?count=10&token=' + self.pixelToken)
      .expect(200)
      .end(function (err, res) {
        self.ctx.ddata.sgvs = [];
        if (err) { return done(err); }
        res.body.length.should.be.above(0, 'expected real data during safety passthrough');
        _.some(res.body, { device: 'pixelalarm' }).should.equal(false, 'no fake entries during safety passthrough');
        done();
      });
  });

  it('triggers via the remote token and serves the fake LOW to the sugarpixel token', function (done) {
    request(self.app)
      .post('/api/v1/pixelalarm/trigger?token=' + self.wifeToken)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.mode.should.equal('triggered');
        res.body.triggeredBy.should.equal('wife');
        should(res.body.firstServedAt).be.null();
        request(self.app)
          .get('/api/v1/entries/sgv.json?count=10&token=' + self.pixelToken)
          .expect(200)
          .end(function (err2, res2) {
            if (err2) { return done(err2); }
            res2.body.length.should.equal(1);
            res2.body[0].sgv.should.equal(40);
            res2.body[0].type.should.equal('sgv');
            res2.body[0].device.should.equal('pixelalarm');
            res2.body[0].direction.should.equal('Flat');
            (Date.now() - res2.body[0].date).should.be.below(10000, 'fake entry must have a fresh timestamp');
            done();
          });
      });
  });

  it('starts the trigger window on first fetch and reports expiresAt', function (done) {
    request(self.app)
      .get('/api/v1/pixelalarm/status?token=' + self.wifeToken)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.mode.should.equal('triggered');
        should(res.body.firstServedAt).not.be.null();
        should(res.body.expiresAt).not.be.null();
        done();
      });
  });

  it('ignores If-Modified-Since while intercepting', function (done) {
    request(self.app)
      .get('/api/v1/entries.json?count=10&token=' + self.pixelToken)
      .set('If-Modified-Since', new Date(Date.now() + 60000).toUTCString())
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.length.should.equal(1);
        res.body[0].device.should.equal('pixelalarm');
        done();
      });
  });

  it('serves the fake LOW on /pebble and /properties while triggered', function (done) {
    request(self.app)
      .get('/pebble?token=' + self.pixelToken)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.bgs.length.should.equal(1);
        res.body.bgs[0].sgv.should.equal('40');
        res.body.bgs[0].trend.should.equal(4);
        request(self.app)
          .get('/properties?token=' + self.pixelToken)
          .expect(200)
          .end(function (err2, res2) {
            if (err2) { return done(err2); }
            res2.body.bgnow.last.should.equal(40);
            res2.body.delta.mgdl.should.equal(0);
            done();
          });
      });
  });

  it('short-circuits API v3 entries reads for the sugarpixel token only', function (done) {
    request(self.app)
      .get('/api/v3/entries?token=' + self.pixelToken)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.result.should.be.an.Array();
        res.body.result.length.should.equal(1);
        res.body.result[0].sgv.should.equal(40);
        res.body.result[0].should.have.property('identifier');
        request(self.app)
          .get('/api/v3/entries')
          .set('api-secret', known)
          .expect(200)
          .end(function (err2, res2) {
            if (err2) { return done(err2); }
            res2.body.result.should.equal('REAL-V3');
            done();
          });
      });
  });

  it('keeps serving real data to the admin while triggered', function (done) {
    request(self.app)
      .get('/api/v1/entries.json?count=10')
      .set('api-secret', known)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        _.some(res.body, { device: 'pixelalarm' }).should.equal(false, 'no fake entries for the admin');
        res.body.length.should.be.above(0, 'expected real entries for the admin');
        done();
      });
  });

  it('re-triggering restarts the window, then reverts to armed after the window elapses', function (done) {
    request(self.app)
      .post('/api/v1/pixelalarm/trigger?token=' + self.wifeToken)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.mode.should.equal('triggered');
        should(res.body.firstServedAt).be.null();
        // First fetch starts the window...
        request(self.app)
          .get('/api/v1/entries/sgv.json?count=1&token=' + self.pixelToken)
          .expect(200)
          .end(function (err2, res2) {
            if (err2) { return done(err2); }
            res2.body.length.should.equal(1);
            res2.body[0].sgv.should.equal(40);
            // ...and after it elapses the feed is blank again
            setTimeout(function afterWindow () {
              request(self.app)
                .get('/api/v1/entries/sgv.json?count=1&token=' + self.pixelToken)
                .expect(200)
                .end(function (err3, res3) {
                  if (err3) { return done(err3); }
                  res3.body.length.should.equal(0);
                  request(self.app)
                    .get('/api/v1/pixelalarm/status?token=' + self.wifeToken)
                    .expect(200)
                    .end(function (err4, res4) {
                      if (err4) { return done(err4); }
                      res4.body.mode.should.equal('armed');
                      done();
                    });
                });
            }, TRIGGER_DURATION_SECONDS * 1000 + 500);
          });
      });
  });

  it('disarms via the admin secret and restores live data to the sugarpixel token', function (done) {
    request(self.app)
      .post('/api/v1/pixelalarm/disarm')
      .set('api-secret', known)
      .expect(200)
      .end(function (err, res) {
        if (err) { return done(err); }
        res.body.mode.should.equal('off');
        request(self.app)
          .get('/api/v1/entries/sgv.json?count=10&token=' + self.pixelToken)
          .expect(200)
          .end(function (err2, res2) {
            if (err2) { return done(err2); }
            res2.body.length.should.be.above(0, 'expected real data after disarm');
            _.some(res2.body, { device: 'pixelalarm' }).should.equal(false, 'no fake entries after disarm');
            done();
          });
      });
  });
});
