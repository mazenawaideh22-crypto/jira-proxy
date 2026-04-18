require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

// ─── SECURITY HEADERS ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Disabled — Paddle.js loads from CDN
  crossOriginEmbedderPolicy: false
}));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
// /analyze: max 10 requests per minute per IP (prevents Claude API cost abuse)
app.use('/analyze', rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, slow down.' } }));
// /chat: max 30 per minute per IP
app.use('/chat', rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }));
// /auth/token: max 20 per minute per IP (prevents brute-force on 6-digit codes)
app.use('/auth/token', rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }));
// /auth/jira and /auth/gitlab: max 10 per minute per IP
app.use('/auth/jira', rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/auth/gitlab', rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
// /generate-comment: max 20 per minute per IP
app.use('/generate-comment', rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }));

// IMPORTANT: Raw body parser MUST come before express.json()
// Paddle webhook needs the raw body for signature verification
app.use('/paddle/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.options('*', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

process.on('uncaughtException', function(err) {
  console.error('[CRASH] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', function(reason) {
  console.error('[CRASH] unhandledRejection:', reason);
});

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const JIRA_CLIENT_ID       = process.env.ATLASSIAN_CLIENT_ID;
const JIRA_CLIENT_SECRET   = process.env.ATLASSIAN_CLIENT_SECRET;
const GITLAB_CLIENT_ID     = process.env.GITLAB_CLIENT_ID;
const GITLAB_CLIENT_SECRET = process.env.GITLAB_CLIENT_SECRET;
const CLAUDE_API_KEY       = process.env.CLAUDE_API_KEY;
const BASE_URL             = 'https://jira-proxy-production-ec4e.up.railway.app';

// ─── PADDLE CONFIG ───────────────────────────────────────────────────────────
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';
const PADDLE_ENV            = process.env.PADDLE_ENV || 'sandbox';

// Price IDs loaded from env vars — set these in Railway for both sandbox and live.
// Sandbox vars:  PADDLE_PRICE_STRUCTIFY_PRO, PADDLE_PRICE_STRUCTIFY_BUS, etc.
// When going live: update the same env vars to your live price IDs — no code change needed.
const PADDLE_PRICES = {
  structify: {
    pro:        process.env.PADDLE_PRICE_STRUCTIFY_PRO        || 'pri_01knyef6jehzp54m8jzxg5jsyq',
    business:   process.env.PADDLE_PRICE_STRUCTIFY_BUS        || 'pri_01knyehb9cma5x9sdbth6rqsyz',
    enterprise: process.env.PADDLE_PRICE_STRUCTIFY_ENT        || 'pri_01knyembbkrk5zr1p48ye31z6m'
  },
  byok: {
    pro:        process.env.PADDLE_PRICE_BYOK_PRO             || 'pri_01knyeqsqktpsk8vw794vk6wjy',
    business:   process.env.PADDLE_PRICE_BYOK_BUS             || 'pri_01knyervp1edd4h68nsgg7fs3d',
    enterprise: process.env.PADDLE_PRICE_BYOK_ENT             || 'pri_01knyesx3pqrzcr0hbrczsev6w'
  }
};

// ─── STORES ──────────────────────────────────────────────────────────────────
var pendingCodes = {};
var DEVELOPER_IDS = (process.env.DEVELOPER_IDS || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
const FREE_LIMIT = 3;

// ─── POSTGRESQL DATABASE ──────────────────────────────────────────────────────
// Railway: add the PostgreSQL plugin → DATABASE_URL is set automatically.
// Schema is created on first boot via initDB().
const { Pool } = require('pg');

var pool = null;

async function initDB() {
  var url = process.env.DATABASE_URL || '';
  if (!url) {
    console.error('[DB] No DATABASE_URL set. Add the PostgreSQL plugin in Railway.');
    process.exit(1);
  }
  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false }   // Required for Railway Postgres
  });

  // Test connection
  var client = await pool.connect();
  console.log('[DB] PostgreSQL connected');

  // Create tables if they don't exist
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id          TEXT PRIMARY KEY,
      plan             TEXT,
      plan_type        TEXT,
      seats            INT DEFAULT 1,
      paid_at          BIGINT,
      subscription_id  TEXT,
      cancelled_at     BIGINT,
      access_until     BIGINT,
      bonus_generations INT DEFAULT 0,
      team_code        TEXT,
      team_owner       TEXT,
      team_member_of   TEXT,
      pending_upgrade  JSONB,
      created_at       TIMESTAMP DEFAULT NOW(),
      updated_at       TIMESTAMP DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS usage (
      user_id    TEXT PRIMARY KEY,
      count      INT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS generations (
      id           SERIAL PRIMARY KEY,
      user_id      TEXT,
      billing_user TEXT,
      ticket_id    TEXT,
      ticket_title TEXT,
      plan         TEXT,
      plan_type    TEXT,
      industry     TEXT,
      device_type  TEXT,
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      owner_id   TEXT,
      member_id  TEXT,
      joined_at  TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (owner_id, member_id)
    )
  `);

  // Indexes for common queries
  await client.query('CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_users_team_code ON users(team_code)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_users_team_member_of ON users(team_member_of)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_generations_created ON generations(created_at)');

  client.release();
  console.log('[DB] Tables ready');
}

// ─── DB HELPER FUNCTIONS ──────────────────────────────────────────────────────

async function getUser(userId) {
  var r = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
  return r.rows[0] || null;
}

async function getUsage(userId) {
  var r = await pool.query('SELECT count FROM usage WHERE user_id = $1', [userId]);
  return r.rows[0] ? r.rows[0].count : 0;
}

async function setUsage(userId, count) {
  await pool.query(
    'INSERT INTO usage (user_id, count, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET count = $2, updated_at = NOW()',
    [userId, count]
  );
}

async function incrementUsage(userId) {
  var r = await pool.query(
    'INSERT INTO usage (user_id, count, updated_at) VALUES ($1, 1, NOW()) ON CONFLICT (user_id) DO UPDATE SET count = usage.count + 1, updated_at = NOW() RETURNING count',
    [userId]
  );
  return r.rows[0].count;
}

async function saveUser(userId, data) {
  await pool.query(
    `INSERT INTO users (user_id, plan, plan_type, seats, paid_at, subscription_id,
      cancelled_at, access_until, bonus_generations, team_code, team_owner,
      team_member_of, pending_upgrade, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       plan=$2, plan_type=$3, seats=$4, paid_at=$5, subscription_id=$6,
       cancelled_at=$7, access_until=$8, bonus_generations=$9,
       team_code=$10, team_owner=$11, team_member_of=$12,
       pending_upgrade=$13, updated_at=NOW()`,
    [
      userId,
      data.plan || null,
      data.type || data.plan_type || null,
      data.seats || 1,
      data.paidAt || data.paid_at || null,
      data.subscriptionId || data.subscription_id || null,
      data.cancelledAt || data.cancelled_at || null,
      data.accessUntil || data.access_until || null,
      data.bonusGenerations || data.bonus_generations || 0,
      data.teamCode || data.team_code || null,
      data.teamOwner || data.team_owner || null,
      data.teamMemberOf || data.team_member_of || null,
      data.pendingUpgrade ? JSON.stringify(data.pendingUpgrade) : null
    ]
  );
}

async function deleteUser(userId) {
  await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
  // Keep usage record for audit
}

async function getTeamMembers(ownerId) {
  var r = await pool.query('SELECT member_id FROM team_members WHERE owner_id = $1', [ownerId]);
  return r.rows.map(function(row) { return row.member_id; });
}

async function addTeamMember(ownerId, memberId) {
  await pool.query(
    'INSERT INTO team_members (owner_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [ownerId, memberId]
  );
}

async function removeTeamMember(ownerId, memberId) {
  await pool.query('DELETE FROM team_members WHERE owner_id = $1 AND member_id = $2', [ownerId, memberId]);
}

async function logGeneration(userId, billingUserId, data) {
  try {
    await pool.query(
      'INSERT INTO generations (user_id, billing_user, ticket_id, ticket_title, plan, plan_type, industry, device_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [userId, billingUserId, data.ticketId || null, data.ticketTitle || null,
       data.plan || null, data.planType || null, data.industry || null, data.deviceType || null]
    );
  } catch(e) { console.error('[DB] logGeneration error:', e.message); }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
// Clean expired pending OAuth codes every minute
setInterval(function() {
  var now = Date.now();
  Object.keys(pendingCodes).forEach(function(code) {
    if (pendingCodes[code].expiresAt < now) delete pendingCodes[code];
  });
}, 60000);

// Daily cleanup — remove fully-expired cancelled users from DB
setInterval(async function() {
  try {
    var r = await pool.query(
      'DELETE FROM users WHERE cancelled_at IS NOT NULL AND access_until IS NOT NULL AND access_until < $1 RETURNING user_id',
      [Date.now()]
    );
    if (r.rowCount > 0) {
      console.log('[CLEANUP] Removed ' + r.rowCount + ' fully-expired cancelled user(s)');
    }
  } catch(e) { console.error('[CLEANUP] Error:', e.message); }
}, 24 * 60 * 60 * 1000);

// Initialize database then start server
initDB().then(function() {
  var PORT = process.env.PORT || 8080;
  app.listen(PORT, function() {
    console.log('Structify server running on port ' + PORT);
    console.log('Paddle env: ' + PADDLE_ENV);
  });
}).catch(function(e) {
  console.error('[DB] Failed to initialize:', e.message);
  process.exit(1);
});

function generateCode(data) {
  var code = Math.floor(100000 + Math.random() * 900000).toString();
  pendingCodes[code] = Object.assign({}, data, { expiresAt: Date.now() + 5 * 60 * 1000 });
  return code;
}

function successPage(code, service) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Structify</title>' +
    '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0f;color:#f0f0f5;display:flex;align-items:center;justify-content:center;min-height:100vh}' +
    '.card{background:#111118;border:1px solid rgba(255,255,255,0.07);border-radius:24px;padding:40px 36px;text-align:center;max-width:380px;width:90%;position:relative;overflow:hidden}' +
    '.check-wrap{width:64px;height:64px;background:rgba(24,212,167,0.12);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;border:1.5px solid rgba(24,212,167,0.25)}' +
    '.check-wrap svg{width:28px;height:28px}' +
    'h1{font-size:20px;font-weight:700;margin-bottom:6px;letter-spacing:-0.01em}' +
    '.sub{font-size:12px;color:#6b6b80;margin-bottom:24px;line-height:1.6}' +
    '.code-box{background:#0c1f1a;border:1.5px solid rgba(24,212,167,0.35);border-radius:16px;padding:18px 20px;margin-bottom:20px;position:relative}' +
    '.code-label{font-size:10px;color:#6b6b80;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:10px}' +
    '.code{font-size:44px;font-weight:800;letter-spacing:0.22em;color:#18D4A7;font-family:ui-monospace,monospace;text-shadow:0 0 32px rgba(24,212,167,0.25)}' +
    '.timer-row{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:4px}' +
    '.timer-label{font-size:11px;color:#3a3a4a}' +
    '.timer-val{font-size:11px;font-weight:700;color:#18D4A7;font-variant-numeric:tabular-nums;min-width:34px}' +
    '</style>' +
    '<script>try{if(window.history&&window.history.replaceState){window.history.replaceState({},"Structify","/?connected=1");}}catch(e){}<\/script>' +
    '</head><body>' +
    '<div class="card">' +
      '<div class="check-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="#18D4A7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
      '<h1>Connected to ' + service + '!</h1>' +
      '<p class="sub">Enter this code in Structify<br>to complete the connection.</p>' +
      '<div class="code-box">' +
        '<div class="code-label">Your Plugin Code</div>' +
        '<div class="code">' + code + '</div>' +
        '<div class="timer-row"><span class="timer-label">Expires in</span><span class="timer-val" id="exp">5:00</span></div>' +
      '</div>' +
    '</div>' +
    '<script>' +
    '(function(){' +
    'var exp=300;' +
    'var expEl=document.getElementById("exp");' +
    'var expTimer=setInterval(function(){' +
      'exp--;' +
      'if(exp<=0){clearInterval(expTimer);expEl.textContent="0:00";return;}' +
      'var m=Math.floor(exp/60),s=exp%60;' +
      'expEl.textContent=m+":"+(s<10?"0":"")+s;' +
    '},1000);' +
    '})();' +
    '<\/script>' +
    '</body></html>';
}

function httpsRequest(options, body) {
  return new Promise(function(resolve, reject) {
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.setTimeout(120000, function() { req.destroy(new Error('Request timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── USAGE ENDPOINT ──────────────────────────────────────────────────────────
var PLAN_LIMITS = { pro: 15, business: 40, enterprise: 25 };
var PLAN_SEATS  = { pro: 1, business: 1, enterprise: 5 };

app.get('/usage', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.query.userId;
  var isDev  = DEVELOPER_IDS.includes(userId);
  try {
    var paid   = await getUser(userId);
    var isPaid = isDev || (!!paid && (!paid.access_until || Date.now() < paid.access_until));

    // Enterprise members each get their OWN 25-generation counter.
    // Pro/Business: track against userId directly (no shared pool).
    // billingId is always the individual user for all plans.
    var billingId   = userId;
    var billingPaid = paid;

    // For non-enterprise team members, still resolve plan from owner
    if (isPaid && paid && paid.team_member_of && paid.plan !== 'enterprise') {
      billingId   = paid.team_member_of;
      billingPaid = await getUser(billingId) || paid;
    }

    var planLimit = billingPaid ? ((PLAN_LIMITS[billingPaid.plan] || 15) + (billingPaid.bonus_generations || 0)) : FREE_LIMIT;
    var count  = await getUsage(userId); // always per-user
    var isCancelledButActive = !!(paid && paid.cancelled_at && isPaid);
    res.json({
      count:       count,
      limit:       isPaid ? planLimit : FREE_LIMIT,
      allowed:     isDev || (isPaid && count < planLimit) || (!isPaid && count < FREE_LIMIT),
      isPaid:      isPaid,
      plan:        isPaid && paid ? paid.plan : null,
      planType:    isPaid && paid ? paid.plan_type : null,
      cancelled:   isCancelledButActive,
      accessUntil: paid && paid.access_until ? paid.access_until : null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CHECK PAID STATUS ───────────────────────────────────────────────────────
app.get('/check-paid', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  var isDev  = DEVELOPER_IDS.includes(userId);
  try {
    var paid   = await getUser(userId);
    var isPaid = isDev || (!!paid && (!paid.access_until || Date.now() < paid.access_until));
    var isCancelledButActive = !!(paid && paid.cancelled_at && isPaid);
    res.json({
      isPaid:      isPaid,
      plan:        isPaid && paid ? paid.plan : null,
      planType:    isPaid && paid ? paid.plan_type : null,
      seats:       isPaid && paid ? paid.seats : null,
      cancelled:   isCancelledButActive,
      accessUntil: paid && paid.access_until ? paid.access_until : null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PADDLE CHECKOUT URL ─────────────────────────────────────────────────────
// GET /paddle/checkout-url?userId=XXX&plan=pro&type=structify&seats=1
// ─── PADDLE CHECKOUT INFO (new: returns priceId + clientToken for Paddle.js) ──
app.get('/paddle/checkout-url', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.query.userId;
  var plan   = req.query.plan  || 'pro';
  var type   = req.query.type  || 'structify';
  var seats  = parseInt(req.query.seats) || 1;

  if (!userId) return res.status(400).json({ error: 'userId required' });

  var clientToken = process.env.PADDLE_CLIENT_TOKEN || '';
  if (!clientToken) return res.status(500).json({ error: 'PADDLE_CLIENT_TOKEN not set in Railway' });

  var priceGroup = PADDLE_PRICES[type] || PADDLE_PRICES.structify;
  var priceId    = priceGroup[plan] || priceGroup.pro;
  var isSandbox  = PADDLE_ENV !== 'live';

  console.log('[PADDLE] checkout info → plan=' + plan + ' type=' + type + ' userId=' + userId + ' priceId=' + priceId);
  res.json({ priceId: priceId, clientToken: clientToken, userId: userId, plan: plan, type: type, seats: seats, sandbox: isSandbox });
});

// ─── PADDLE WEBHOOK ──────────────────────────────────────────────────────────
// Register in Paddle dashboard → Developer Tools → Notifications:
//   URL: https://jira-proxy-production-ec4e.up.railway.app/paddle/webhook
//   Events: subscription.activated, transaction.completed
app.post('/paddle/webhook', async function(req, res) {
  var signature = req.headers['paddle-signature'] || '';
  var parts     = {};
  signature.split(';').forEach(function(part) {
    var kv = part.split('=');
    if (kv.length === 2) parts[kv[0]] = kv[1];
  });

  var ts = parts['ts'];
  var h1 = parts['h1'];

  if (!ts || !h1 || !PADDLE_WEBHOOK_SECRET) {
    console.log('[PADDLE WEBHOOK] Missing signature or secret — rejecting');
    return res.status(401).json({ error: 'Missing signature' });
  }
  var rawBody  = req.body;
  var expected = crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(ts + ':').update(rawBody).digest('hex');

  // Reject webhooks older than 5 minutes — prevents replay attacks
  var tsAge = Math.abs(Date.now() / 1000 - parseInt(ts, 10));
  if (tsAge > 300) {
    console.log('[PADDLE WEBHOOK] Rejected stale webhook — age=' + Math.round(tsAge) + 's');
    return res.status(401).json({ error: 'Webhook timestamp too old' });
  }

  if (expected !== h1) {
    console.log('[PADDLE WEBHOOK] Invalid signature — rejecting');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  var event;
  try { event = JSON.parse(rawBody); }
  catch(e) { return res.status(400).json({ error: 'Bad JSON' }); }

  console.log('[PADDLE WEBHOOK] event_type=' + event.event_type);

  if (
    event.event_type === 'subscription.activated' ||
    event.event_type === 'transaction.completed'
  ) {
    var cd    = event.data && event.data.custom_data;
    var userId = cd && cd.userId;
    var plan   = (cd && cd.plan)  || 'pro';
    var type   = (cd && cd.type)  || 'structify';
    var seats  = parseInt((cd && cd.seats) || 1);

    if (userId) {
      var subscriptionId = (event.data && event.data.subscription_id) || (event.data && event.data.id) || null;
      var existing    = await getUser(userId) || {};
      var pending     = existing.pending_upgrade ? (typeof existing.pending_upgrade === 'string' ? JSON.parse(existing.pending_upgrade) : existing.pending_upgrade) : null;
      var alreadySaved = existing.plan === plan && existing.bonus_generations !== undefined;
      var carryOver   = (!alreadySaved && pending && pending.newPlan === plan) ? (pending.carryOver || 0) : (existing.bonus_generations || 0);
      var teamCode = existing.team_code || null;
      if (plan === 'enterprise' && !teamCode) {
        teamCode = 'ENT-' + Math.random().toString(36).toUpperCase().slice(2, 8);
      }
      await saveUser(userId, {
        plan: plan, type: type, seats: seats,
        paidAt: existing.paid_at || Date.now(),
        subscriptionId: subscriptionId,
        bonusGenerations: carryOver,
        teamCode: teamCode,
        teamOwner: plan === 'enterprise' ? (existing.team_owner || userId) : null,
        teamMemberOf: existing.team_member_of || null
      });
      if (!alreadySaved) await setUsage(userId, 0);
      console.log('[PADDLE WEBHOOK] ✅ Paid: userId=' + userId + ' plan=' + plan + ' type=' + type + ' seats=' + seats + ' subId=' + subscriptionId + ' carryOver=' + carryOver);
    } else {
      console.log('[PADDLE WEBHOOK] ⚠️  No userId in custom_data');
    }
  }

  // Subscription cancelled — set accessUntil from Paddle's billing period end, don't delete
  if (event.event_type === 'subscription.cancelled') {
    var cd2     = event.data && event.data.custom_data;
    var userId2 = cd2 && cd2.userId;

    // Fallback: if no userId in custom_data, find user by subscriptionId
    if (!userId2) {
      var subIdEvt = event.data && event.data.id;
      if (subIdEvt) {
        var subRow = await pool.query('SELECT user_id FROM users WHERE subscription_id = $1 LIMIT 1', [subIdEvt]);
        if (subRow.rows[0]) {
          userId2 = subRow.rows[0].user_id;
          console.log('[PADDLE WEBHOOK] Resolved userId=' + userId2 + ' via subscriptionId=' + subIdEvt);
        } else {
          console.log('[PADDLE WEBHOOK] ⚠️ subscription.cancelled — no userId in custom_data and no match for subId=' + subIdEvt);
        }
      }
    }

    if (userId2) {
      var u2 = await getUser(userId2);
      if (u2) {
        var effectiveAt = (event.data.scheduled_change && event.data.scheduled_change.effective_at)
          || (event.data.current_billing_period && event.data.current_billing_period.ends_at)
          || null;
        var accessUntilTs = effectiveAt ? new Date(effectiveAt).getTime() : Date.now();
        await saveUser(userId2, Object.assign({}, u2, {
          cancelledAt: Date.now(),
          accessUntil: accessUntilTs
        }));
        console.log('[PADDLE WEBHOOK] ❌ Cancelled: userId=' + userId2 + ' accessUntil=' + new Date(accessUntilTs).toISOString());
      }
    } else {
      console.log('[PADDLE WEBHOOK] ⚠️ subscription.cancelled ignored — could not resolve userId. custom_data=' + JSON.stringify(cd2));
    }
  }

  // Subscription renewed — reset generation count for the new billing period
  if (event.event_type === 'subscription.updated') {
    var cdU   = event.data && event.data.custom_data;
    var userIdU = cdU && cdU.userId;

    // Fallback: match by subscriptionId
    if (!userIdU) {
      var subIdU2 = event.data && event.data.id;
      if (subIdU2) {
        var subRow2 = await pool.query('SELECT user_id FROM users WHERE subscription_id = $1 LIMIT 1', [subIdU2]);
        if (subRow2.rows[0]) userIdU = subRow2.rows[0].user_id;
      }
    }

    if (userIdU) {
      var uRec = await getUser(userIdU);
      if (uRec) {
        var isRenewal = !event.data.scheduled_change;
        if (isRenewal) {
          await setUsage(userIdU, 0);
          await saveUser(userIdU, Object.assign({}, uRec, { bonusGenerations: 0 }));
          console.log('[PADDLE WEBHOOK] 🔄 Renewed: userId=' + userIdU + ' — usage reset to 0');
        }
      }
    }
  }

  res.sendStatus(200);
});

// ─── UPGRADE (carry-over) ────────────────────────────────────────────────────
app.post('/paddle/upgrade', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId  = req.body.userId;
  var newPlan = req.body.newPlan;
  var newType = req.body.newType || 'structify';
  var seats   = parseInt(req.body.seats) || 1;
  if (!userId || !newPlan) return res.status(400).json({ error: 'userId and newPlan required' });
  try {
    var paid      = await getUser(userId) || {};
    var oldPlan   = paid.plan || null;
    var oldLimit  = oldPlan ? ((PLAN_LIMITS[oldPlan] || 0) + (paid.bonus_generations || 0)) : FREE_LIMIT;
    var usedCount = await getUsage(userId);
    var remaining = Math.max(0, oldLimit - usedCount);
    await saveUser(userId, Object.assign({}, paid, {
      pendingUpgrade: { newPlan: newPlan, newType: newType, seats: seats, carryOver: remaining, requestedAt: Date.now() }
    }));
    console.log('[UPGRADE] userId=' + userId + ' ' + oldPlan + ' → ' + newPlan + ' carryOver=' + remaining);
    res.json({ ok: true, carryOver: remaining });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ENTERPRISE TEAM ──────────────────────────────────────────────────────────
// GET /team/code?userId=XXX  — returns the owner's team code + member list
app.get('/team/code', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    var paid = await getUser(userId);
    if (!paid || paid.plan !== 'enterprise') return res.status(403).json({ error: 'Enterprise plan required' });
    var members  = await getTeamMembers(userId);
    var maxSeats = paid.seats || 5;
    res.json({
      teamCode: paid.team_code,
      owner:    userId,
      members:  members,
      used:     members.length + 1,
      maxSeats: maxSeats
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /team/join  { userId, teamCode }  — member joins an enterprise team
app.post('/team/join', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId   = req.body.userId;
  var teamCode = (req.body.teamCode || '').toUpperCase().trim();
  if (!userId || !teamCode) return res.status(400).json({ error: 'userId and teamCode required' });

  try {
    var ownerRow = await pool.query('SELECT * FROM users WHERE team_code = $1 LIMIT 1', [teamCode]);
    if (!ownerRow.rows[0]) return res.status(404).json({ error: 'Team code not found' });
    var owner   = ownerRow.rows[0];
    var ownerId = owner.user_id;

    if (owner.plan !== 'enterprise') return res.status(403).json({ error: 'Team owner does not have an enterprise plan' });
    if (owner.access_until && Date.now() >= owner.access_until) return res.status(403).json({ error: 'Team owner\'s subscription has expired' });
    if (ownerId === userId) return res.status(400).json({ error: 'You are the team owner' });

    var members  = await getTeamMembers(ownerId);
    var maxSeats = owner.seats || 5;

    if (members.includes(userId)) return res.json({ ok: true, plan: owner.plan, type: owner.plan_type, alreadyMember: true });
    if (members.length + 1 >= maxSeats) return res.status(403).json({ error: 'Team is full (' + maxSeats + '/' + maxSeats + ' seats used)' });

    await addTeamMember(ownerId, userId);
    await saveUser(userId, { plan: owner.plan, type: owner.plan_type, seats: 1, paidAt: Date.now(), teamMemberOf: ownerId, bonusGenerations: 0 });

    console.log('[TEAM JOIN] userId=' + userId + ' joined team of ownerId=' + ownerId + ' code=' + teamCode);
    res.json({ ok: true, plan: owner.plan, type: owner.plan_type });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /team/leave  { userId }  — member leaves a team
app.post('/team/leave', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.body.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    var paid = await getUser(userId);
    if (!paid || !paid.team_member_of) return res.status(400).json({ error: 'Not a team member' });
    var ownerId = paid.team_member_of;
    await removeTeamMember(ownerId, userId);
    await deleteUser(userId);
    console.log('[TEAM LEAVE] userId=' + userId + ' left team of ownerId=' + ownerId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /team/remove  { ownerId, memberId }  — owner removes a member
app.post('/team/remove', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var ownerId  = req.body.ownerId;
  var memberId = req.body.memberId;
  if (!ownerId || !memberId) return res.status(400).json({ error: 'ownerId and memberId required' });
  try {
    var owner = await getUser(ownerId);
    if (!owner || owner.plan !== 'enterprise') return res.status(403).json({ error: 'Enterprise plan required' });
    await removeTeamMember(ownerId, memberId);
    var member = await getUser(memberId);
    if (member && member.team_member_of === ownerId) await deleteUser(memberId);
    console.log('[TEAM REMOVE] ownerId=' + ownerId + ' removed memberId=' + memberId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── DEBUG ───────────────────────────────────────────────────────────────────
// Protected with DEBUG_KEY env var — set this in Railway to a long random string
app.get('/debug', async function(req, res) {
  var debugKey = process.env.DEBUG_KEY || '';
  if (!debugKey || req.headers['x-debug-key'] !== debugKey) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({
    jiraClientId:    JIRA_CLIENT_ID ? JIRA_CLIENT_ID.substring(0, 8) : 'NOT SET',
    hasJiraSecret:   !!JIRA_CLIENT_SECRET,
    hasGitlabId:     !!GITLAB_CLIENT_ID,
    hasClaudeKey:    !!CLAUDE_API_KEY,
    paddleEnv:       PADDLE_ENV,
    hasPaddleSecret: !!PADDLE_WEBHOOK_SECRET,
    paidUsersCount:  (await pool.query("SELECT COUNT(*) FROM users WHERE cancelled_at IS NULL")).rows[0].count,
    prices:          PADDLE_PRICES
  });
});

// ─── OAUTH STATE STORE (in-memory, short-lived) ───────────────────────────────
var pendingStates = {}; // state -> { provider, createdAt }
setInterval(function() {
  var now = Date.now();
  Object.keys(pendingStates).forEach(function(s) {
    if (now - pendingStates[s].createdAt > 10 * 60 * 1000) delete pendingStates[s];
  });
}, 60000);

// ─── JIRA AUTH ───────────────────────────────────────────────────────────────
app.get('/auth/jira', async function(req, res) {
  var state = crypto.randomBytes(16).toString('hex');
  pendingStates[state] = { provider: 'jira', createdAt: Date.now() };
  var url = 'https://auth.atlassian.com/authorize' +
    '?audience=api.atlassian.com' +
    '&client_id=' + JIRA_CLIENT_ID +
    '&scope=' + encodeURIComponent('read:jira-work write:jira-work read:jira-user offline_access') +
    '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/jira/callback') +
    '&state=' + state +
    '&response_type=code';
  res.redirect(url);
});

app.get('/auth/jira/callback', async function(req, res) {
  var code  = req.query.code;
  var state = req.query.state;
  if (!code) return res.status(400).send('<h2>Error: No code</h2>');
  if (!state || !pendingStates[state] || pendingStates[state].provider !== 'jira') {
    return res.status(403).send('<h2>Error: Invalid or expired state. Please try connecting again.</h2>');
  }
  delete pendingStates[state];
  try {
    var body = JSON.stringify({ grant_type: 'authorization_code', client_id: JIRA_CLIENT_ID, client_secret: JIRA_CLIENT_SECRET, code: code, redirect_uri: BASE_URL + '/auth/jira/callback' });
    var tokenRes = await httpsRequest({ hostname: 'auth.atlassian.com', path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (!tokenRes.data.access_token) return res.status(400).send('<h2>Token error: ' + JSON.stringify(tokenRes.data) + '</h2>');
    var resourcesRes = await httpsRequest({ hostname: 'api.atlassian.com', path: '/oauth/token/accessible-resources', method: 'GET', headers: { 'Authorization': 'Bearer ' + tokenRes.data.access_token, 'Accept': 'application/json' } });
    var cloudId = resourcesRes.data[0] ? resourcesRes.data[0].id  : null;
    var jiraUrl = resourcesRes.data[0] ? resourcesRes.data[0].url : null;
    var pluginCode = generateCode({ provider: 'jira', accessToken: tokenRes.data.access_token, refreshToken: tokenRes.data.refresh_token, cloudId: cloudId, jiraUrl: jiraUrl });
    res.send(successPage(pluginCode, 'Jira'));
  } catch(e) { res.status(500).send('<h2>Error: ' + e.message + '</h2>'); }
});

// ─── GITLAB AUTH ─────────────────────────────────────────────────────────────
app.get('/auth/gitlab', async function(req, res) {
  var state = crypto.randomBytes(16).toString('hex');
  pendingStates[state] = { provider: 'gitlab', createdAt: Date.now() };
  var url = 'https://gitlab.com/oauth/authorize' +
    '?client_id=' + GITLAB_CLIENT_ID +
    '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/gitlab/callback') +
    '&response_type=code' +
    '&scope=' + encodeURIComponent('api') +
    '&state=' + state;
  res.redirect(url);
});

app.get('/auth/gitlab/callback', async function(req, res) {
  var code  = req.query.code;
  var state = req.query.state;
  if (!code) return res.status(400).send('<h2>Error: No code</h2>');
  if (!state || !pendingStates[state] || pendingStates[state].provider !== 'gitlab') {
    return res.status(403).send('<h2>Error: Invalid or expired state. Please try connecting again.</h2>');
  }
  delete pendingStates[state];
  try {
    var body = 'client_id=' + encodeURIComponent(GITLAB_CLIENT_ID) +
      '&client_secret=' + encodeURIComponent(GITLAB_CLIENT_SECRET) +
      '&code=' + encodeURIComponent(code) +
      '&grant_type=authorization_code' +
      '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/gitlab/callback');
    var tokenRes = await httpsRequest({ hostname: 'gitlab.com', path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (!tokenRes.data.access_token) return res.status(400).send('<h2>GitLab token error: ' + JSON.stringify(tokenRes.data) + '</h2>');
    var userRes = await httpsRequest({ hostname: 'gitlab.com', path: '/api/v4/user', method: 'GET', headers: { 'Authorization': 'Bearer ' + tokenRes.data.access_token, 'Accept': 'application/json' } });
    var pluginCode = generateCode({ provider: 'gitlab', accessToken: tokenRes.data.access_token, username: userRes.data.username, name: userRes.data.name });
    res.send(successPage(pluginCode, 'GitLab'));
  } catch(e) { res.status(500).send('<h2>Error: ' + e.message + '</h2>'); }
});

// ─── AUTH TOKEN EXCHANGE ─────────────────────────────────────────────────────
app.get('/auth/token', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var code = req.query.code;
  if (!code || !pendingCodes[code]) return res.status(404).json({ error: 'Invalid or expired code' });
  if (Date.now() > pendingCodes[code].expiresAt) { delete pendingCodes[code]; return res.status(410).json({ error: 'Code expired' }); }
  var data = pendingCodes[code];
  delete pendingCodes[code];
  res.json(data);
});

// ─── JIRA TOKEN REFRESH ──────────────────────────────────────────────────────
// Called by code.js when a Jira API call returns 401 (token expired)
app.post('/auth/jira/refresh', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var refreshToken = req.body.refreshToken;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  try {
    var body = JSON.stringify({
      grant_type:    'refresh_token',
      client_id:     JIRA_CLIENT_ID,
      client_secret: JIRA_CLIENT_SECRET,
      refresh_token: refreshToken
    });
    var tokenRes = await httpsRequest({
      hostname: 'auth.atlassian.com', path: '/oauth/token', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, body);
    if (!tokenRes.data.access_token) {
      return res.status(401).json({ error: 'Refresh failed', detail: tokenRes.data });
    }
    res.json({ accessToken: tokenRes.data.access_token, refreshToken: tokenRes.data.refresh_token || refreshToken });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SPACES ──────────────────────────────────────────────────────────────────
// POST instead of GET so accessToken never appears in server logs or browser history
app.post('/spaces', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.body.accessToken;
  var cloudId     = req.body.cloudId;
  var provider    = req.body.provider || 'jira';
  try {
    if (provider === 'gitlab') {
      var glRes = await httpsRequest({ hostname: 'gitlab.com', path: '/api/v4/projects?membership=true&order_by=last_activity_at&per_page=20', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
      var spaces = (glRes.data || []).map(function(p) { return { id: String(p.id), name: p.name_with_namespace || p.name }; });
      return res.json({ spaces: spaces });
    }
    var jiraRes = await httpsRequest({ hostname: 'api.atlassian.com', path: '/ex/jira/' + cloudId + '/rest/api/3/project/search?maxResults=50', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
    var projects = (jiraRes.data.values || []).map(function(p) { return { id: p.key, name: p.name }; });
    res.json({ spaces: projects });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug-spaces', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.query.accessToken;
  var cloudId     = req.query.cloudId;
  try {
    var jiraRes = await httpsRequest({ hostname: 'api.atlassian.com', path: '/ex/jira/' + cloudId + '/rest/api/3/project/search?maxResults=50', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
    res.json({ status: jiraRes.status, data: jiraRes.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── TICKETS ─────────────────────────────────────────────────────────────────
app.post('/tickets', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.body.accessToken;
  var cloudId     = req.body.cloudId;
  var provider    = req.body.provider || 'jira';
  try {
    if (provider === 'gitlab') {
      var projectId = req.body.spaceId;
      if (!projectId) return res.status(400).json({ error: 'spaceId required for GitLab' });
      var glPath = '/api/v4/projects/' + encodeURIComponent(projectId) + '/issues?state=opened&per_page=30';
      var glRes = await httpsRequest({ hostname: 'gitlab.com', path: glPath, method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
      var tickets = (glRes.data || []).map(function(issue) {
        return { id: String(issue.iid), title: issue.title, description: issue.description || 'No description' };
      });
      return res.json({ tickets: tickets });
    }
    var spaceId = req.body.spaceId;
    var jql = spaceId ? 'project%3D' + encodeURIComponent(spaceId) + '%20ORDER%20BY%20updated%20DESC' : 'assignee%3DcurrentUser()%20ORDER%20BY%20updated%20DESC';
    var jiraRes = await httpsRequest({ hostname: 'api.atlassian.com', path: '/ex/jira/' + cloudId + '/rest/api/3/search/jql?jql=' + jql + '&maxResults=30&fields=summary,description,status,priority', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
    if (!jiraRes.data.issues) return res.status(500).json({ error: 'No issues', raw: jiraRes.data });
    var tickets = jiraRes.data.issues.map(function(issue) {
      var desc = 'No description';
      try { desc = issue.fields.description.content[0].content[0].text; } catch(e) {}
      var pri = (issue.fields.priority && issue.fields.priority.name) ? issue.fields.priority.name : '';
      return { id: issue.key, title: issue.fields.summary, description: desc, priority: pri };
    });
    res.json({ tickets: tickets });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CHAT ────────────────────────────────────────────────────────────────────
app.post('/chat', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  if (!CLAUDE_API_KEY) return res.json({ text: 'API key not configured.', intent: 'none', suggestion: '', target: '' });
  var message     = req.body.message    || '';
  var frameName   = req.body.frameName  || '';
  var nodeContent = req.body.nodeContent || {};
  var ticketTitle = req.body.ticketTitle || '';
  var plan        = req.body.plan;
  var history     = (req.body.history || []).slice(-8);

  var context = 'Selected frame: "' + frameName + '".';
  if (ticketTitle) context += ' Ticket: "' + ticketTitle + '".';
  if (plan && plan.feature_summary) context += ' Feature: ' + plan.feature_summary + '.';
  if (Object.keys(nodeContent).length > 0) context += ' Guide card content: ' + JSON.stringify(nodeContent).substring(0, 600) + '.';

  var systemPrompt = 'You are an expert AI design assistant inside a Figma plugin called Structify.\n' +
    context + '\n\n' +
    'You help designers edit the Guide card (the annotation panel next to each device frame). ' +
    'The Guide card has these sections: title (frame name), purpose (description), ' +
    'DESIGN NOTES, UI COMPONENTS, ACTIONS, Copy (headline and body copy suggestions).\n\n' +
    'CRITICAL: Never modify or duplicate the device frame itself. Only ever add or edit text in the Guide card.\n' +
    'CRITICAL: When the user says "add copies", "add copy", "add UX copy", or "add text copy" — they mean adding copywriting/text content to the Copy section of the Guide card. Do NOT interpret this as duplicating a frame.\n\n' +
    'When the user says things like "add [something]" or "I want to add [something]":\n' +
    '1. Determine which Guide section it belongs to: notes/requirements → note, UI elements/buttons/components → component, user flows/interactions → action, headlines/body text/microcopy/copies/copy → target=copy\n' +
    '2. Return intent="add" with a professional suggestion and the correct target\n' +
    '3. The user will then click "Add" to confirm — you do NOT add it automatically\n\n' +
    'Respond ONLY with a valid JSON object, no markdown, no extra text:\n' +
    '{"text":"<your reply to user, max 40 words>","intent":"<none|delete|replace|add>","suggestion":"<exact text content, empty for none/delete>","target":"<title|purpose|note|component|action>"}\n\n' +
    'Intent meanings:\n' +
    '- none: just answer/explain, no Figma change needed\n' +
    '- delete: user wants to delete the selected frame entirely. target=frame, suggestion=""\n' +
    '- replace: user wants to change existing text in the Guide. suggestion=the new full text, target=which section\n' +
    '- add: user wants to add a new item to the Guide. suggestion=the item text with correct prefix, target=note|component|action\n\n' +
    'Make suggestions as plain text, no emoji prefixes. For copy suggestions (target=copy), format the suggestion as: "headline text / body text" using a forward slash to separate them.\n' +
    'Make suggestions specific, professional design copy based on the frame context. Max 12 words per suggestion.';

  var messages = history.map(function(h) { return { role: h.role, content: h.content }; });
  messages.push({ role: 'user', content: message });
  var body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: systemPrompt, messages: messages });
  try {
    var r = await httpsRequest({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (r.status !== 200) return res.json({ text: 'AI error: ' + r.status, intent: 'none', suggestion: '', target: '' });
    var raw = r.data.content[0].text.trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    var parsed;
    try { parsed = JSON.parse(raw); } catch(e) { parsed = { text: raw, intent: 'none', suggestion: '', target: '' }; }
    res.json({ text: parsed.text || raw, intent: parsed.intent || 'none', suggestion: parsed.suggestion || '', target: parsed.target || '' });
  } catch(e) { res.json({ text: 'Error: ' + e.message, intent: 'none', suggestion: '', target: '' }); }
});

// ─── TEST CONNECTION ──────────────────────────────────────────────────────────
app.post('/test-connection', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var isEnterprise = req.body.entType || req.body.type === 'enterprise';
  var provider     = req.body.provider || 'anthropic';
  var apiKey       = req.body.key || '';
  var model        = req.body.model || '';
  try {
    if (!isEnterprise) {
      var hostname, reqPath, headers, body;
      if (provider === 'anthropic') {
        hostname = 'api.anthropic.com'; reqPath = '/v1/messages';
        body = JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) };
      } else if (provider === 'openai') {
        hostname = 'api.openai.com'; reqPath = '/v1/chat/completions';
        body = JSON.stringify({ model: model || 'gpt-4o-mini', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(body) };
      } else if (provider === 'gemini') {
        hostname = 'generativelanguage.googleapis.com'; reqPath = '/v1beta/models/' + (model || 'gemini-1.5-flash') + ':generateContent?key=' + apiKey;
        body = JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] });
        headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      } else {
        hostname = 'api.mistral.ai'; reqPath = '/v1/chat/completions';
        body = JSON.stringify({ model: model || 'mistral-small', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
        headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(body) };
      }
      var r = await httpsRequest({ hostname: hostname, path: reqPath, method: 'POST', headers: headers }, body);
      if (r.status === 200 || r.status === 201) return res.json({ ok: true, message: 'Connected to ' + provider });
      return res.json({ ok: false, error: 'Status ' + r.status + ': ' + (r.data && r.data.error ? (r.data.error.message || JSON.stringify(r.data.error)) : 'Check API key') });
    } else {
      var entUrl = req.body.url || '';
      if (!entUrl) return res.json({ ok: false, error: 'No endpoint URL provided' });
      var url2 = new URL(entUrl);
      var gr = await httpsRequest({ hostname: url2.hostname, path: '/', method: 'GET', headers: { 'Accept': 'application/json' } }, '');
      if (gr.status && gr.status > 0) return res.json({ ok: true, message: 'Endpoint reachable. Configure your credentials and start using.' });
      return res.json({ ok: false, error: 'Could not reach endpoint' });
    }
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ─── ANALYZE ─────────────────────────────────────────────────────────────────
app.post('/analyze', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  req.socket.setTimeout(120000);
  res.setTimeout(120000);

  var userId = req.body.userId;
  var isDev  = DEVELOPER_IDS.includes(userId);

  var paidRecord = await getUser(userId);
  var isPaid = isDev || (!!paidRecord && (!paidRecord.access_until || Date.now() < paidRecord.access_until));

  // Enterprise members each get their OWN 25-generation counter — billingUserId = userId.
  // This means each of the 5 seats can generate 25 times independently.
  var billingUserId = userId;

  // Resolve paidRecord: for team members get owner's record to check plan/limit
  if (isPaid && paidRecord && paidRecord.team_member_of) {
    var ownerRecord = await getUser(paidRecord.team_member_of);
    if (ownerRecord) paidRecord = ownerRecord; // use owner's plan for limit lookup
    // billingUserId stays as userId — each member has their own count
  }

  var userLimit = isDev ? 999999 : (isPaid ? ((PLAN_LIMITS[paidRecord.plan] || 15) + (paidRecord.bonus_generations || 0)) : FREE_LIMIT);
  var count = await getUsage(billingUserId); // always per-user

  if (!isDev && count >= userLimit) {
    console.log('[ANALYZE] limit_reached for userId=' + userId + ' billingUserId=' + billingUserId + ' count=' + count + '/' + userLimit);
    return res.json({ error: 'limit_reached' });
  }

  var ticketId               = (req.body.ticketId    || '').toString().substring(0, 100);
  var ticketTitle            = (req.body.ticketTitle  || '').toString().substring(0, 200);
  var ticketDesc             = (req.body.ticketDesc   || '').toString().substring(0, 5000);
  var industry               = req.body.industry || 'Other';
  var deviceType             = req.body.deviceType || 'mobile';
  var deviceW                = req.body.deviceW || 390;
  var deviceH                = req.body.deviceH || 844;
  var companyContext         = (req.body.companyContext         || '').toString().substring(0, 500);
  var additionalInstructions = (req.body.additionalInstructions || '').toString().substring(0, 500);

  var INDUSTRY_PROMPTS = {
    'E-commerce':       'Focus on: product browsing, cart flows, checkout, wishlist, order tracking, empty states, payment errors.',
    'Fintech / Banking':'Focus on: security screens, verification flows, transaction history, KYC, biometric authentication.',
    'Food Delivery':    'Focus on: restaurant browsing, order flow, real-time tracking, rating screens, reorder flows.',
    'Travel & Booking': 'Focus on: search and filter flows, booking confirmation, itinerary management, cancellation flows.',
    'SaaS Dashboard':   'Focus on: data tables, analytics charts, settings pages, onboarding flows, permission errors.',
    'Healthcare':       'Focus on: appointment booking, patient records, prescription management, privacy screens.',
    'Education':        'Focus on: course browsing, lesson flows, progress tracking, quiz screens, offline access.',
    'Marketplace':      'Focus on: listing creation, seller dashboard, buyer protection, dispute resolution.',
    'Social Media':     'Focus on: feed screens, profile pages, content creation, notification center.',
    'Other':            'Focus on all standard UX patterns including core flows, errors, empty states, loading states.'
  };

  var systemPrompt = 'You are a senior UX architect. ' + (INDUSTRY_PROMPTS[industry] || INDUSTRY_PROMPTS['Other']) +
    ' Device: ' + deviceType + ' (' + deviceW + 'x' + deviceH + 'px).' +
    (companyContext ? ' Company: ' + companyContext + '.' : '') +
    (additionalInstructions ? ' Extra: ' + additionalInstructions + '.' : '') +
    ' Return ONLY valid JSON, no markdown. STRICT LIMITS: max 2 items per array, max 8 words per string value, max 2 frames per section.' +
    ' Structure: {"feature_summary":"1 sentence","designer_checklist":[{"text":"screen name","required":true}],' +
    '"touchpoints":{"primary":[{"location":"x","ui_suggestion":"x","interaction":"x","impact":"High"}],"growth":["x"],"retention":["x"],"upsell":["x"]},' +
    '"sections":[{"name":"x","applicable":true,"reason":"x","overview":"x","frames":[{"title":"1. Screen","screen_purpose":"x","ui_components":[{"name":"x","required":true}],"primary_actions":["x"],"suggested_copy":{"headline":["x"],"message":["x"]},"design_notes":[{"text":"x","required":true}],"ai_suggested_components":["x"]}]}]}.' +
    ' 8 sections in order: Core Flow, Touchpoints, Edge Cases, Error States, Empty States, Loading States, Security & Privacy, Accessibility.' +
    ' Set applicable:false with empty frames:[] for irrelevant sections. designer_checklist: one item per major screen in the feature flow.';

  var userPrompt = 'Analyze this ticket. ID: ' + ticketId + '. Title: ' + ticketTitle + '. Description: ' + ticketDesc + '. Return only valid JSON.';
  var body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] });

  try {
    if (!CLAUDE_API_KEY) { return res.status(500).json({ error: 'Claude API key not configured' }); }
    var claudeRes = await httpsRequest({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (claudeRes.status !== 200) { return res.status(500).json({ error: 'Claude returned ' + claudeRes.status, details: claudeRes.data }); }
    var rawText = claudeRes.data.content[0].text;
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    var start = rawText.indexOf('{'); var end = rawText.lastIndexOf('}');
    if (start !== -1 && end !== -1) rawText = rawText.substring(start, end + 1);
    var plan;
    try {
      plan = JSON.parse(rawText);
    } catch(parseErr) {
      var repaired = rawText;
      var opens    = (repaired.match(/{/g) || []).length - (repaired.match(/}/g) || []).length;
      var openArr  = (repaired.match(/\[/g) || []).length - (repaired.match(/\]/g) || []).length;
      for (var i = 0; i < openArr; i++) repaired += ']';
      for (var i = 0; i < opens;   i++) repaired += '}';
      try { plan = JSON.parse(repaired); }
      catch(e2) {
        var lastGood = rawText.lastIndexOf(',"name"');
        if (lastGood > 100) {
          repaired = rawText.substring(0, lastGood) + ']}]}';
          try { plan = JSON.parse(repaired); } catch(e3) { throw parseErr; }
        } else { throw parseErr; }
      }
    }
    res.json({ plan: plan });
    // Only count the generation after a successful response — not on failure or timeout
    if (!isDev) {
      var newCount = await incrementUsage(billingUserId);
      await logGeneration(userId, billingUserId, {
        ticketId: ticketId, ticketTitle: ticketTitle,
        plan: paidRecord ? paidRecord.plan : null,
        planType: paidRecord ? paidRecord.plan_type : null,
        industry: industry, deviceType: deviceType
      });
      console.log('[ANALYZE] userId=' + userId + ' billingUserId=' + billingUserId + ' usage=' + newCount + '/' + userLimit + ' isPaid=' + isPaid);
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── GENERATE COMMENT (AI handoff comment — does NOT count as a generation) ──
app.post('/generate-comment', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var prompt = req.body.prompt || '';
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!CLAUDE_API_KEY) return res.status(500).json({ error: 'Claude API key not configured' });

  var body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt + '\n\nRespond with only the comment text, no preamble.' }]
  });
  try {
    var r = await httpsRequest({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    }, body);
    if (r.status !== 200) return res.status(500).json({ error: 'Claude error: ' + r.status });
    var text = r.data.content[0].text.trim();
    res.json({ comment: text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── COMMENT ─────────────────────────────────────────────────────────────────
app.post('/comment', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.body.accessToken;
  var cloudId     = req.body.cloudId    || '';
  var ticketId    = req.body.ticketId   || '';
  var comment     = req.body.comment    || '';
  var provider    = req.body.provider   || 'jira';
  var spaceId     = req.body.spaceId    || '';
  try {
    var result;
    if (provider === 'gitlab') {
      var issueIid  = String(ticketId).replace(/[^0-9]/g, '').trim();
      var projectId = String(spaceId || cloudId).trim();
      if (!projectId) return res.status(400).json({ error: 'Missing project ID.' });
      if (!issueIid)  return res.status(400).json({ error: 'Missing issue ID.' });
      var glPath = '/api/v4/projects/' + encodeURIComponent(projectId) + '/issues/' + issueIid + '/notes';
      var glBody = JSON.stringify({ body: comment });
      result = await httpsRequest({ hostname: 'gitlab.com', path: glPath, method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(glBody) } }, glBody);
    } else {
      var jBody = JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] } });
      result = await httpsRequest({ hostname: 'api.atlassian.com', path: '/ex/jira/' + cloudId + '/rest/api/3/issue/' + ticketId + '/comment', method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(jBody) } }, jBody);
    }
    if (result.status >= 400) return res.status(result.status).json({ error: result.data });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PADDLE CANCEL SUBSCRIPTION ──────────────────────────────────────────────
// Professional approach: only call Paddle's API — do NOT immediately delete paidUsers.
// The subscription.cancelled webhook sets accessUntil so user keeps access until period ends.
app.post('/paddle/cancel', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.body.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  var paid = await getUser(userId);
  if (!paid) return res.status(400).json({ error: 'No active subscription found' });

  // Already cancelled — return existing accessUntil immediately, don't call Paddle again
  if (paid.cancelled_at && paid.access_until) {
    console.log('[CANCEL] Already cancelled for userId=' + userId + ' accessUntil=' + new Date(paid.access_until).toISOString());
    return res.json({ ok: true, accessUntil: paid.access_until, alreadyCancelled: true });
  }

  var subscriptionId = paid.subscription_id;

  // No subscriptionId — cancel immediately as fallback
  if (!subscriptionId) {
    await saveUser(userId, Object.assign({}, paid, { cancelledAt: Date.now(), accessUntil: Date.now() }));
    console.log('[CANCEL] No subscriptionId — cancelled immediately for userId=' + userId);
    return res.json({ ok: true, accessUntil: null });
  }

  var paddleApiKey = process.env.PADDLE_API_KEY || '';

  // No API key — cancel immediately as fallback
  if (!paddleApiKey) {
    await saveUser(userId, Object.assign({}, paid, { cancelledAt: Date.now(), accessUntil: Date.now() }));
    console.log('[CANCEL] No PADDLE_API_KEY — cancelled immediately for userId=' + userId);
    return res.json({ ok: true, accessUntil: null });
  }

  try {
    var isSandbox  = PADDLE_ENV !== 'live';
    var hostname   = isSandbox ? 'sandbox-api.paddle.com' : 'api.paddle.com';
    var cancelBody = JSON.stringify({ effective_from: 'next_billing_period' });
    var cancelRes  = await httpsRequest({
      hostname: hostname,
      path: '/subscriptions/' + subscriptionId + '/cancel',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + paddleApiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(cancelBody)
      }
    }, cancelBody);

    console.log('[CANCEL] Paddle API response: ' + cancelRes.status + ' body=' + JSON.stringify(cancelRes.data));

    // subscription_locked_pending_changes means already queued — treat as success
    var alreadyQueued = cancelRes.status === 400 &&
      cancelRes.data && cancelRes.data.error &&
      cancelRes.data.error.code === 'subscription_locked_pending_changes';

    if (cancelRes.status === 200 || cancelRes.status === 204 || alreadyQueued) {
      if (alreadyQueued) {
        console.log('[CANCEL] Already queued for cancellation — treating as success: userId=' + userId);
      }
      // Mark cancelled locally — use accessUntil from Paddle response if available,
      // else keep existing accessUntil, else fall back to approx 30-day period
      var cancelledAt = Date.now();
      var accessUntilFinal = paid.access_until || null;
      if (!accessUntilFinal) {
        var paddleEffective = cancelRes.data && cancelRes.data.data &&
          cancelRes.data.data.scheduled_change && cancelRes.data.data.scheduled_change.effective_at;
        if (paddleEffective) {
          accessUntilFinal = new Date(paddleEffective).getTime();
          console.log('[CANCEL] accessUntil from Paddle response: ' + paddleEffective);
        } else {
          accessUntilFinal = (paid.paid_at || Date.now()) + 30 * 24 * 60 * 60 * 1000;
          console.log('[CANCEL] accessUntil approximated to 30 days from paidAt');
        }
      }
      await saveUser(userId, Object.assign({}, paid, { cancelledAt: cancelledAt, accessUntil: accessUntilFinal }));
      console.log('[CANCEL] ✅ Queued: userId=' + userId + ' accessUntil=' + new Date(accessUntilFinal).toISOString());
      return res.json({ ok: true, accessUntil: accessUntilFinal });
    } else {
      console.error('[CANCEL] ❌ Paddle rejected cancel: status=' + cancelRes.status + ' body=' + JSON.stringify(cancelRes.data));
      return res.status(500).json({ error: 'Paddle cancel failed: ' + cancelRes.status, detail: cancelRes.data });
    }
  } catch(e) {
    console.error('[CANCEL] Paddle API error:', e.message);
    return res.status(500).json({ error: 'Network error contacting Paddle: ' + e.message });
  }
});
