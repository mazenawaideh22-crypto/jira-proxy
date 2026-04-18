require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');
const path = require('path');

const app = express();

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

// Hardcoded price IDs (sandbox) — swap for live IDs when going to production
const PADDLE_PRICES = {
  structify: {
    pro:        'pri_01knyef6jehzp54m8jzxg5jsyq',
    business:   'pri_01knyehb9cma5x9sdbth6rqsyz',
    enterprise: 'pri_01knyembbkrk5zr1p48ye31z6m'
  },
  byok: {
    pro:        'pri_01knyeqsqktpsk8vw794vk6wjy',
    business:   'pri_01knyervp1edd4h68nsgg7fs3d',
    enterprise: 'pri_01knyesx3pqrzcr0hbrczsev6w'
  }
};

// ─── STORES ──────────────────────────────────────────────────────────────────
var pendingCodes = {};
const DEVELOPER_IDS = [];
const FREE_LIMIT = 3;

// ─── PERSISTENT FILE STORE ───────────────────────────────────────────────────
const fs = require('fs');
const STORE_FILE = path.join(__dirname, 'store.json');

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      var raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      console.log('[STORE] Loaded. users=' + Object.keys(raw.usageStore || {}).length + ' paid=' + Object.keys(raw.paidUsers || {}).length);
      return raw;
    }
  } catch(e) { console.error('[STORE] Load error:', e.message); }
  return { usageStore: {}, paidUsers: {} };
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ usageStore: usageStore, paidUsers: paidUsers }, null, 2));
  } catch(e) { console.error('[STORE] Save error:', e.message); }
}

var _store    = loadStore();
var usageStore = _store.usageStore || {};  // userId -> number of free uses
var paidUsers  = _store.paidUsers  || {};  // userId -> { plan, type, seats, paidAt }

// ─── HELPERS ─────────────────────────────────────────────────────────────────
setInterval(function() {
  var now = Date.now();
  Object.keys(pendingCodes).forEach(function(code) {
    if (pendingCodes[code].expiresAt < now) delete pendingCodes[code];
  });
}, 60000);

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
var PLAN_LIMITS = { pro: 15, business: 40, enterprise: 40 };
var PLAN_SEATS  = { pro: 1, business: 1, enterprise: 5 };

app.get('/usage', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.query.userId;
  var isDev  = DEVELOPER_IDS.includes(userId);
  var paid   = paidUsers[userId] || null;
  var isPaid = isDev || (!!paid && (!paid.accessUntil || Date.now() < paid.accessUntil));
  var planLimit = paid ? ((PLAN_LIMITS[paid.plan] || 15) + (paid.bonusGenerations || 0)) : FREE_LIMIT;
  var count  = usageStore[userId] || 0;
  var isCancelledButActive = !!(paid && paid.cancelledAt && isPaid);
  res.json({
    count:       count,
    limit:       isPaid ? planLimit : FREE_LIMIT,
    allowed:     isDev || (isPaid && count < planLimit) || (!isPaid && count < FREE_LIMIT),
    isPaid:      isPaid,
    plan:        isPaid && paid ? paid.plan : null,
    planType:    isPaid && paid ? paid.type : null,
    cancelled:   isCancelledButActive,
    accessUntil: paid && paid.accessUntil ? paid.accessUntil : null
  });
});

// ─── CHECK PAID STATUS ───────────────────────────────────────────────────────
app.get('/check-paid', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  var isDev  = DEVELOPER_IDS.includes(userId);
  var paid   = paidUsers[userId] || null;
  var isPaid = isDev || (!!paid && (!paid.accessUntil || Date.now() < paid.accessUntil));
  var isCancelledButActive = !!(paid && paid.cancelledAt && isPaid);
  res.json({
    isPaid:      isPaid,
    plan:        isPaid && paid ? paid.plan : null,
    planType:    isPaid && paid ? paid.type : null,
    seats:       isPaid && paid ? paid.seats : null,
    cancelled:   isCancelledButActive,
    accessUntil: paid && paid.accessUntil ? paid.accessUntil : null
  });
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
app.post('/paddle/webhook', function(req, res) {
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
      var existing    = paidUsers[userId] || {};
      var pending     = existing.pendingUpgrade;
      var alreadySaved = existing.plan === plan && existing.bonusGenerations !== undefined;
      var carryOver   = (!alreadySaved && pending && pending.newPlan === plan) ? (pending.carryOver || 0) : (existing.bonusGenerations || 0);
      paidUsers[userId] = {
        plan: plan, type: type, seats: seats,
        paidAt: existing.paidAt || Date.now(),
        subscriptionId: subscriptionId,
        bonusGenerations: carryOver
      };
      if (!alreadySaved) usageStore[userId] = 0;
      // If enterprise, generate a team code and store it
      if (plan === 'enterprise') {
        if (!existing.teamCode) {
          var teamCode = 'ENT-' + Math.random().toString(36).toUpperCase().slice(2, 8);
          paidUsers[userId].teamCode  = teamCode;
          paidUsers[userId].teamOwner = userId;
          paidUsers[userId].teamMembers = existing.teamMembers || [];
        } else {
          paidUsers[userId].teamCode    = existing.teamCode;
          paidUsers[userId].teamOwner   = existing.teamOwner || userId;
          paidUsers[userId].teamMembers = existing.teamMembers || [];
        }
      }
      saveStore();
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
        Object.keys(paidUsers).forEach(function(uid) {
          if (paidUsers[uid].subscriptionId === subIdEvt) userId2 = uid;
        });
        if (userId2) {
          console.log('[PADDLE WEBHOOK] Resolved userId=' + userId2 + ' via subscriptionId=' + subIdEvt);
        } else {
          console.log('[PADDLE WEBHOOK] ⚠️ subscription.cancelled — no userId in custom_data and no match for subId=' + subIdEvt);
        }
      }
    }

    if (userId2 && paidUsers[userId2]) {
      var effectiveAt = (event.data.scheduled_change && event.data.scheduled_change.effective_at)
        || (event.data.current_billing_period && event.data.current_billing_period.ends_at)
        || null;
      var accessUntilTs = effectiveAt ? new Date(effectiveAt).getTime() : Date.now();
      paidUsers[userId2].cancelledAt  = Date.now();
      paidUsers[userId2].accessUntil  = accessUntilTs;
      saveStore();
      console.log('[PADDLE WEBHOOK] ❌ Cancelled: userId=' + userId2 + ' accessUntil=' + new Date(accessUntilTs).toISOString());
    } else if (!userId2) {
      console.log('[PADDLE WEBHOOK] ⚠️ subscription.cancelled ignored — could not resolve userId. custom_data=' + JSON.stringify(cd2));
    }
  }

  res.sendStatus(200);
});

// ─── UPGRADE (carry-over) ────────────────────────────────────────────────────
app.post('/paddle/upgrade', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId  = req.body.userId;
  var newPlan = req.body.newPlan;
  var newType = req.body.newType || 'structify';
  var seats   = parseInt(req.body.seats) || 1;
  if (!userId || !newPlan) return res.status(400).json({ error: 'userId and newPlan required' });
  var paid      = paidUsers[userId] || null;
  var oldPlan   = paid ? paid.plan : null;
  var oldLimit  = oldPlan ? ((PLAN_LIMITS[oldPlan] || 0) + (paid.bonusGenerations || 0)) : FREE_LIMIT;
  var usedCount = usageStore[userId] || 0;
  var remaining = Math.max(0, oldLimit - usedCount);
  if (!paidUsers[userId]) paidUsers[userId] = {};
  paidUsers[userId].pendingUpgrade = {
    newPlan: newPlan, newType: newType, seats: seats,
    carryOver: remaining, requestedAt: Date.now()
  };
  saveStore();
  console.log('[UPGRADE] userId=' + userId + ' ' + oldPlan + ' → ' + newPlan + ' carryOver=' + remaining);
  res.json({ ok: true, carryOver: remaining });
});

// ─── ENTERPRISE TEAM ──────────────────────────────────────────────────────────
// GET /team/code?userId=XXX  — returns the owner's team code + member list
app.get('/team/code', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  var paid = paidUsers[userId];
  if (!paid || paid.plan !== 'enterprise') return res.status(403).json({ error: 'Enterprise plan required' });
  var maxSeats  = paid.seats || 5;
  var members   = paid.teamMembers || [];
  var used      = members.length + 1; // +1 for owner
  res.json({
    teamCode: paid.teamCode,
    owner:    userId,
    members:  members,
    used:     used,
    maxSeats: maxSeats
  });
});

// POST /team/join  { userId, teamCode }  — member joins an enterprise team
app.post('/team/join', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId   = req.body.userId;
  var teamCode = (req.body.teamCode || '').toUpperCase().trim();
  if (!userId || !teamCode) return res.status(400).json({ error: 'userId and teamCode required' });

  // Find the owner who has this teamCode
  var ownerId = null;
  Object.keys(paidUsers).forEach(function(uid) {
    if (paidUsers[uid].teamCode === teamCode) ownerId = uid;
  });
  if (!ownerId) return res.status(404).json({ error: 'Team code not found' });

  var owner    = paidUsers[ownerId];
  var maxSeats = owner.seats || 5;
  var members  = owner.teamMembers || [];

  // Already a member or already the owner
  if (ownerId === userId) return res.status(400).json({ error: 'You are the team owner' });
  if (members.includes(userId)) {
    // Already joined — just return success
    return res.json({ ok: true, plan: owner.plan, type: owner.type, alreadyMember: true });
  }

  // Check seat limit (owner + members)
  if (members.length + 1 >= maxSeats) {
    return res.status(403).json({ error: 'Team is full (' + maxSeats + '/' + maxSeats + ' seats used)' });
  }

  // Add member
  members.push(userId);
  paidUsers[ownerId].teamMembers = members;

  // Give member paid access mirrored from owner
  paidUsers[userId] = {
    plan: owner.plan, type: owner.type, seats: 1,
    paidAt: Date.now(), teamMemberOf: ownerId,
    bonusGenerations: 0
  };
  usageStore[userId] = usageStore[userId] || 0;
  saveStore();
  console.log('[TEAM JOIN] userId=' + userId + ' joined team of ownerId=' + ownerId + ' code=' + teamCode);
  res.json({ ok: true, plan: owner.plan, type: owner.type });
});

// POST /team/leave  { userId }  — member leaves a team
app.post('/team/leave', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.body.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  var paid = paidUsers[userId];
  if (!paid || !paid.teamMemberOf) return res.status(400).json({ error: 'Not a team member' });
  var ownerId = paid.teamMemberOf;
  if (paidUsers[ownerId] && paidUsers[ownerId].teamMembers) {
    paidUsers[ownerId].teamMembers = paidUsers[ownerId].teamMembers.filter(function(m) { return m !== userId; });
  }
  delete paidUsers[userId];
  saveStore();
  console.log('[TEAM LEAVE] userId=' + userId + ' left team of ownerId=' + ownerId);
  res.json({ ok: true });
});

// POST /team/remove  { ownerId, memberId }  — owner removes a member
app.post('/team/remove', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var ownerId  = req.body.ownerId;
  var memberId = req.body.memberId;
  if (!ownerId || !memberId) return res.status(400).json({ error: 'ownerId and memberId required' });
  var owner = paidUsers[ownerId];
  if (!owner || owner.plan !== 'enterprise') return res.status(403).json({ error: 'Enterprise plan required' });
  if (paidUsers[ownerId].teamMembers) {
    paidUsers[ownerId].teamMembers = paidUsers[ownerId].teamMembers.filter(function(m) { return m !== memberId; });
  }
  if (paidUsers[memberId] && paidUsers[memberId].teamMemberOf === ownerId) {
    delete paidUsers[memberId];
  }
  saveStore();
  console.log('[TEAM REMOVE] ownerId=' + ownerId + ' removed memberId=' + memberId);
  res.json({ ok: true });
});

// ─── DEBUG ───────────────────────────────────────────────────────────────────
app.get('/debug', function(req, res) {
  res.json({
    jiraClientId:    JIRA_CLIENT_ID ? JIRA_CLIENT_ID.substring(0, 8) : 'NOT SET',
    hasJiraSecret:   !!JIRA_CLIENT_SECRET,
    hasGitlabId:     !!GITLAB_CLIENT_ID,
    hasClaudeKey:    !!CLAUDE_API_KEY,
    paddleEnv:       PADDLE_ENV,
    hasPaddleSecret: !!PADDLE_WEBHOOK_SECRET,
    paidUsersCount:  Object.keys(paidUsers).length,
    prices:          PADDLE_PRICES
  });
});

// ─── JIRA AUTH ───────────────────────────────────────────────────────────────
app.get('/auth/jira', function(req, res) {
  var url = 'https://auth.atlassian.com/authorize' +
    '?audience=api.atlassian.com' +
    '&client_id=' + JIRA_CLIENT_ID +
    '&scope=' + encodeURIComponent('read:jira-work write:jira-work read:jira-user offline_access') +
    '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/jira/callback') +
    '&state=' + crypto.randomBytes(16).toString('hex') +
    '&response_type=code';
  res.redirect(url);
});

app.get('/auth/jira/callback', async function(req, res) {
  var code = req.query.code;
  if (!code) return res.status(400).send('<h2>Error: No code</h2>');
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
app.get('/auth/gitlab', function(req, res) {
  var url = 'https://gitlab.com/oauth/authorize' +
    '?client_id=' + GITLAB_CLIENT_ID +
    '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/gitlab/callback') +
    '&response_type=code' +
    '&scope=' + encodeURIComponent('api') +
    '&state=' + crypto.randomBytes(16).toString('hex');
  res.redirect(url);
});

app.get('/auth/gitlab/callback', async function(req, res) {
  var code = req.query.code;
  if (!code) return res.status(400).send('<h2>Error: No code</h2>');
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
app.get('/auth/token', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var code = req.query.code;
  if (!code || !pendingCodes[code]) return res.status(404).json({ error: 'Invalid or expired code' });
  if (Date.now() > pendingCodes[code].expiresAt) { delete pendingCodes[code]; return res.status(410).json({ error: 'Code expired' }); }
  var data = pendingCodes[code];
  delete pendingCodes[code];
  res.json(data);
});

// ─── SPACES ──────────────────────────────────────────────────────────────────
app.get('/spaces', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.query.accessToken;
  var cloudId     = req.query.cloudId;
  var provider    = req.query.provider || 'jira';
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
app.get('/tickets', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.query.accessToken;
  var cloudId     = req.query.cloudId;
  var provider    = req.query.provider || 'jira';
  try {
    if (provider === 'gitlab') {
      var projectId = req.query.spaceId;
      if (!projectId) return res.status(400).json({ error: 'spaceId required for GitLab' });
      var glPath = '/api/v4/projects/' + encodeURIComponent(projectId) + '/issues?state=opened&per_page=30';
      var glRes = await httpsRequest({ hostname: 'gitlab.com', path: glPath, method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
      var tickets = (glRes.data || []).map(function(issue) {
        return { id: String(issue.iid), title: issue.title, description: issue.description || 'No description' };
      });
      return res.json({ tickets: tickets });
    }
    var spaceId = req.query.spaceId;
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
  var isPaid = !!(paidUsers[userId]);

  var paidRecord = paidUsers[userId] || null;
  // Respect accessUntil: cancelled users keep access until period ends
  if (paidRecord && paidRecord.accessUntil && Date.now() >= paidRecord.accessUntil) {
    isPaid = false;
  }
  var userLimit = isDev ? 999999 : (isPaid ? ((PLAN_LIMITS[paidRecord.plan] || 15) + (paidRecord.bonusGenerations || 0)) : FREE_LIMIT);
  var count = usageStore[userId] || 0;

  if (!isDev) {
    if (count >= userLimit) {
      console.log('[ANALYZE] limit_reached for userId=' + userId + ' count=' + count + '/' + userLimit);
      return res.json({ error: 'limit_reached' });
    }
    usageStore[userId] = count + 1;
    saveStore();
    console.log('[ANALYZE] userId=' + userId + ' usage=' + (count + 1) + '/' + userLimit + ' isPaid=' + isPaid);
  }

  var ticketId               = req.body.ticketId;
  var ticketTitle            = req.body.ticketTitle;
  var ticketDesc             = req.body.ticketDesc;
  var industry               = req.body.industry || 'Other';
  var deviceType             = req.body.deviceType || 'mobile';
  var deviceW                = req.body.deviceW || 390;
  var deviceH                = req.body.deviceH || 844;
  var companyContext         = req.body.companyContext || '';
  var additionalInstructions = req.body.additionalInstructions || '';

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

  var paid = paidUsers[userId];
  if (!paid) return res.status(400).json({ error: 'No active subscription found' });

  // Already cancelled — return existing accessUntil immediately, don't call Paddle again
  if (paid.cancelledAt && paid.accessUntil) {
    console.log('[CANCEL] Already cancelled for userId=' + userId + ' accessUntil=' + new Date(paid.accessUntil).toISOString());
    return res.json({ ok: true, accessUntil: paid.accessUntil, alreadyCancelled: true });
  }

  var subscriptionId = paid.subscriptionId;

  // No subscriptionId — cancel immediately as fallback
  if (!subscriptionId) {
    paidUsers[userId].cancelledAt = Date.now();
    paidUsers[userId].accessUntil = Date.now();
    saveStore();
    console.log('[CANCEL] No subscriptionId — cancelled immediately for userId=' + userId);
    return res.json({ ok: true, accessUntil: null });
  }

  var paddleApiKey = process.env.PADDLE_API_KEY || '';

  // No API key — cancel immediately as fallback
  if (!paddleApiKey) {
    paidUsers[userId].cancelledAt = Date.now();
    paidUsers[userId].accessUntil = Date.now();
    saveStore();
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
      paidUsers[userId].cancelledAt = Date.now();
      if (!paidUsers[userId].accessUntil) {
        // Try to read scheduled_change.effective_at from Paddle response
        var paddleEffective = cancelRes.data && cancelRes.data.data &&
          cancelRes.data.data.scheduled_change && cancelRes.data.data.scheduled_change.effective_at;
        if (paddleEffective) {
          paidUsers[userId].accessUntil = new Date(paddleEffective).getTime();
          console.log('[CANCEL] accessUntil from Paddle response: ' + paddleEffective);
        } else {
          var approxEnd = (paid.paidAt || Date.now()) + 30 * 24 * 60 * 60 * 1000;
          paidUsers[userId].accessUntil = approxEnd;
          console.log('[CANCEL] accessUntil approximated to 30 days from paidAt');
        }
      }
      saveStore();
      console.log('[CANCEL] ✅ Queued: userId=' + userId + ' accessUntil=' + new Date(paidUsers[userId].accessUntil).toISOString());
      return res.json({ ok: true, accessUntil: paidUsers[userId].accessUntil });
    } else {
      console.error('[CANCEL] ❌ Paddle rejected cancel: status=' + cancelRes.status + ' body=' + JSON.stringify(cancelRes.data));
      return res.status(500).json({ error: 'Paddle cancel failed: ' + cancelRes.status, detail: cancelRes.data });
    }
  } catch(e) {
    console.error('[CANCEL] Paddle API error:', e.message);
    return res.status(500).json({ error: 'Network error contacting Paddle: ' + e.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('Structify server running on port ' + PORT);
  console.log('Paddle env: ' + PADDLE_ENV);
  console.log('Paddle webhook secret set: ' + !!PADDLE_WEBHOOK_SECRET);
  console.log('Price IDs loaded: ' + JSON.stringify(PADDLE_PRICES));
});
