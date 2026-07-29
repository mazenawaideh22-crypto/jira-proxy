require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const crypto  = require('crypto');
const path    = require('path');
const helmet  = require('helmet');

const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
var _rateCounts = {};
function rateLimiter(maxPerMinute) {
  return function(req, res, next) {
    var key = (req.body && req.body.userId)
      ? 'uid:' + req.body.userId
      : (req.headers['x-forwarded-for'] || req.ip || 'unknown');
    var now = Date.now();
    if (!_rateCounts[key] || now > _rateCounts[key].resetAt) {
      _rateCounts[key] = { count: 0, resetAt: now + 60000 };
    }
    _rateCounts[key].count++;
    if (_rateCounts[key].count > maxPerMinute) {
      res.setHeader('Retry-After', Math.ceil((_rateCounts[key].resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    next();
  };
}
setInterval(function() {
  var now = Date.now();
  Object.keys(_rateCounts).forEach(function(k) {
    if (now > _rateCounts[k].resetAt) delete _rateCounts[k];
  });
}, 5 * 60 * 1000);

app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'Accept'] }));
app.options('*', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.sendStatus(200);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'ui.html')));

process.on('uncaughtException', function(err) { console.error('[CRASH] uncaughtException:', err.message, err.stack); });
process.on('unhandledRejection', function(reason) { console.error('[CRASH] unhandledRejection:', reason); });

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const JIRA_CLIENT_ID       = process.env.ATLASSIAN_CLIENT_ID;
const JIRA_CLIENT_SECRET   = process.env.ATLASSIAN_CLIENT_SECRET;
const GITLAB_CLIENT_ID     = process.env.GITLAB_CLIENT_ID;
const GITLAB_CLIENT_SECRET = process.env.GITLAB_CLIENT_SECRET;
const BASE_URL             = process.env.BASE_URL || 'https://jira-proxy-production-ec4e.up.railway.app';

// ─── IN-MEMORY STORES ────────────────────────────────────────────────────────
var pendingCodes  = {};
var pendingStates = {};

setInterval(function() {
  var now = Date.now();
  Object.keys(pendingCodes).forEach(function(c)  { if (pendingCodes[c].expiresAt < now) delete pendingCodes[c]; });
  Object.keys(pendingStates).forEach(function(s) { if (now - pendingStates[s].createdAt > 10 * 60 * 1000) delete pendingStates[s]; });
}, 60000);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function generateCode(data) {
  var code = Math.floor(100000 + Math.random() * 900000).toString();
  pendingCodes[code] = Object.assign({}, data, { expiresAt: Date.now() + 5 * 60 * 1000 });
  return code;
}

function successPage(code, service) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Structify</title>' +
    '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0f;color:#f0f0f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#111118;border:1px solid rgba(255,255,255,0.07);border-radius:24px;padding:40px 36px;text-align:center;max-width:380px;width:90%}.check-wrap{width:64px;height:64px;background:rgba(24,212,167,0.12);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;border:1.5px solid rgba(24,212,167,0.25)}.check-wrap svg{width:28px;height:28px}h1{font-size:20px;font-weight:700;margin-bottom:6px}.sub{font-size:12px;color:#6b6b80;margin-bottom:24px;line-height:1.6}.code-box{background:#0c1f1a;border:1.5px solid rgba(24,212,167,0.35);border-radius:16px;padding:18px 20px;margin-bottom:20px}.code-label{font-size:10px;color:#6b6b80;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:10px}.code{font-size:44px;font-weight:800;letter-spacing:0.22em;color:#18D4A7;font-family:ui-monospace,monospace}.timer-row{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:4px}.timer-label{font-size:11px;color:#3a3a4a}.timer-val{font-size:11px;font-weight:700;color:#18D4A7;min-width:34px}</style>' +
    '<script>try{if(window.history&&window.history.replaceState){window.history.replaceState({},"Structify","/?connected=1");}}catch(e){}<\/script>' +
    '</head><body><div class="card">' +
    '<div class="check-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="#18D4A7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
    '<h1>Connected to ' + service + '!</h1>' +
    '<p class="sub">Enter this code in Structify<br>to complete the connection.</p>' +
    '<div class="code-box"><div class="code-label">Your Plugin Code</div><div class="code">' + code + '</div>' +
    '<div class="timer-row"><span class="timer-label">Expires in</span><span class="timer-val" id="exp">5:00</span></div></div></div>' +
    '<script>(function(){var exp=300;var el=document.getElementById("exp");var t=setInterval(function(){exp--;if(exp<=0){clearInterval(t);el.textContent="0:00";return;}var m=Math.floor(exp/60),s=exp%60;el.textContent=m+":"+(s<10?"0":"")+s;},1000);})();<\/script>' +
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

// ─── JIRA AUTH ───────────────────────────────────────────────────────────────
app.get('/auth/jira', rateLimiter(10), async function(req, res) {
  var state = crypto.randomBytes(16).toString('hex');
  pendingStates[state] = { provider: 'jira', createdAt: Date.now() };
  var url = 'https://auth.atlassian.com/authorize' +
    '?audience=api.atlassian.com' +
    '&client_id=' + JIRA_CLIENT_ID +
    '&scope=' + encodeURIComponent('read:jira-work write:jira-work read:jira-user offline_access') +
    '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/jira/callback') +
    '&state=' + state + '&response_type=code';
  res.redirect(url);
});

app.get('/auth/jira/callback', async function(req, res) {
  var code = req.query.code, state = req.query.state;
  if (!code) return res.status(400).send('<h2>Error: No code</h2>');
  if (!state || !pendingStates[state] || pendingStates[state].provider !== 'jira')
    return res.status(403).send('<h2>Error: Invalid or expired state.</h2>');
  delete pendingStates[state];
  try {
    var body = JSON.stringify({ grant_type: 'authorization_code', client_id: JIRA_CLIENT_ID, client_secret: JIRA_CLIENT_SECRET, code: code, redirect_uri: BASE_URL + '/auth/jira/callback' });
    var tokenRes = await httpsRequest({ hostname: 'auth.atlassian.com', path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (!tokenRes.data.access_token) return res.status(400).send('<h2>Token error</h2>');
    var resourcesRes = await httpsRequest({ hostname: 'api.atlassian.com', path: '/oauth/token/accessible-resources', method: 'GET', headers: { 'Authorization': 'Bearer ' + tokenRes.data.access_token, 'Accept': 'application/json' } });
    var cloudId = resourcesRes.data[0] ? resourcesRes.data[0].id  : null;
    var jiraUrl = resourcesRes.data[0] ? resourcesRes.data[0].url : null;
    var pluginCode = generateCode({ provider: 'jira', accessToken: tokenRes.data.access_token, refreshToken: tokenRes.data.refresh_token, cloudId: cloudId, jiraUrl: jiraUrl });
    res.send(successPage(pluginCode, 'Jira'));
  } catch(e) { res.status(500).send('<h2>Error: ' + e.message + '</h2>'); }
});

// ─── GITLAB AUTH ─────────────────────────────────────────────────────────────
app.get('/auth/gitlab', rateLimiter(10), async function(req, res) {
  var state = crypto.randomBytes(16).toString('hex');
  pendingStates[state] = { provider: 'gitlab', createdAt: Date.now() };
  var url = 'https://gitlab.com/oauth/authorize' +
    '?client_id=' + GITLAB_CLIENT_ID +
    '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/gitlab/callback') +
    '&response_type=code' +
    '&scope=' + encodeURIComponent('api read_user') +  // ← Make sure 'api' is included
    '&state=' + state;
  res.redirect(url);
});

app.get('/auth/gitlab/callback', async function(req, res) {
  var code = req.query.code, state = req.query.state;
  console.log('[GITLAB] Callback received, code:', code ? code.substring(0, 10) + '...' : 'none');
  console.log('[GITLAB] State:', state);
  
  if (!code) return res.status(400).send('<h2>Error: No code</h2>');
  if (!state || !pendingStates[state] || pendingStates[state].provider !== 'gitlab')
    return res.status(403).send('<h2>Error: Invalid or expired state.</h2>');
  delete pendingStates[state];
  
  try {
    var body = 'client_id=' + encodeURIComponent(GITLAB_CLIENT_ID) +
      '&client_secret=' + encodeURIComponent(GITLAB_CLIENT_SECRET) +
      '&code=' + encodeURIComponent(code) +
      '&grant_type=authorization_code' +
      '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/gitlab/callback');
    
    console.log('[GITLAB] Exchanging code for token...');
    
    var tokenRes = await httpsRequest({ 
      hostname: 'gitlab.com', 
      path: '/oauth/token', 
      method: 'POST', 
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded', 
        'Content-Length': Buffer.byteLength(body) 
      } 
    }, body);
    
    console.log('[GITLAB] Token response status:', tokenRes.status);
    
    if (!tokenRes.data.access_token) {
      console.log('[GITLAB] No access token in response:', tokenRes.data);
      return res.status(400).send('<h2>GitLab token error</h2>');
    }
    
    console.log('[GITLAB] Access token received, first 10 chars:', tokenRes.data.access_token.substring(0, 10) + '...');
    
    var userRes = await httpsRequest({ 
      hostname: 'gitlab.com', 
      path: '/api/v4/user', 
      method: 'GET', 
      headers: { 
        'Authorization': 'Bearer ' + tokenRes.data.access_token, 
        'Accept': 'application/json' 
      } 
    });
    
    console.log('[GITLAB] User response status:', userRes.status);
    console.log('[GITLAB] Username:', userRes.data.username);
    
    var pluginCode = generateCode({ 
      provider: 'gitlab', 
      accessToken: tokenRes.data.access_token, 
      username: userRes.data.username, 
      name: userRes.data.name 
    });
    
    console.log('[GITLAB] Generated plugin code:', pluginCode);
    res.send(successPage(pluginCode, 'GitLab'));
    
  } catch(e) { 
    console.error('[GITLAB] Error:', e.message);
    res.status(500).send('<h2>Error: ' + e.message + '</h2>'); 
  }
});

// ─── AUTH TOKEN EXCHANGE ─────────────────────────────────────────────────────
app.get('/auth/token', rateLimiter(20), async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var code = req.query.code;
  
  console.log('[TOKEN] Code received:', code);
  console.log('[TOKEN] Pending codes keys:', Object.keys(pendingCodes));
  
  if (!code || !pendingCodes[code]) {
    console.log('[TOKEN] Invalid or expired code');
    return res.status(404).json({ error: 'Invalid or expired code' });
  }
  
  if (Date.now() > pendingCodes[code].expiresAt) { 
    console.log('[TOKEN] Code expired');
    delete pendingCodes[code]; 
    return res.status(410).json({ error: 'Code expired' }); 
  }
  
  var data = pendingCodes[code];
  console.log('[TOKEN] Data found:', {
    provider: data.provider,
    hasAccessToken: !!data.accessToken,
    hasRefreshToken: !!data.refreshToken
  });
  
  delete pendingCodes[code];
  res.json(data);
});

// ─── JIRA TOKEN REFRESH ──────────────────────────────────────────────────────
app.post('/auth/jira/refresh', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var refreshToken = req.body.refreshToken;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  try {
    var body = JSON.stringify({ grant_type: 'refresh_token', client_id: JIRA_CLIENT_ID, client_secret: JIRA_CLIENT_SECRET, refresh_token: refreshToken });
    var tokenRes = await httpsRequest({ hostname: 'auth.atlassian.com', path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (!tokenRes.data.access_token) return res.status(401).json({ error: 'Refresh failed', detail: tokenRes.data });
    res.json({ accessToken: tokenRes.data.access_token, refreshToken: tokenRes.data.refresh_token || refreshToken });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SPACES ──────────────────────────────────────────────────────────────────
app.post('/spaces', async function(req, res) {
  console.log('[SPACES] ===== REQUEST RECEIVED ====');
  res.header('Access-Control-Allow-Origin', '*');
  
  var accessToken = req.body.accessToken;
  var cloudId = req.body.cloudId || '';
  var provider = req.body.provider || 'jira';
  
  console.log('[SPACES] Provider:', provider);
  console.log('[SPACES] AccessToken present:', !!accessToken);
  console.log('[SPACES] AccessToken first 20 chars:', accessToken ? accessToken.substring(0, 20) + '...' : 'none');
  
  if (!accessToken) {
    console.log('[SPACES] ERROR: No access token provided');
    return res.status(401).json({ error: 'No access token provided' });
  }
  
  try {
    if (provider === 'gitlab') {
      console.log('[SPACES] Fetching GitLab projects...');
      
      // Try a simpler endpoint that should always work
      // First try: get user's projects (this should work with any valid token)
      var glRes = await httpsRequest({ 
        hostname: 'gitlab.com', 
        path: '/api/v4/projects?per_page=20', 
        method: 'GET', 
        headers: { 
          'Authorization': 'Bearer ' + accessToken, 
          'Accept': 'application/json' 
        } 
      });
      
      console.log('[SPACES] GitLab response status:', glRes.status);
      console.log('[SPACES] GitLab response type:', typeof glRes.data);
      
      if (glRes.status !== 200) {
        // If the first endpoint fails, try a different one
        console.log('[SPACES] First endpoint failed, trying /api/v4/user/projects...');
        
        var glRes2 = await httpsRequest({ 
          hostname: 'gitlab.com', 
          path: '/api/v4/user/projects?per_page=20', 
          method: 'GET', 
          headers: { 
            'Authorization': 'Bearer ' + accessToken, 
            'Accept': 'application/json' 
          } 
        });
        
        console.log('[SPACES] Second endpoint status:', glRes2.status);
        
        if (glRes2.status !== 200) {
          // If both fail, try the user endpoint to verify the token
          console.log('[SPACES] Projects endpoints failed, testing user endpoint...');
          
          var userRes = await httpsRequest({ 
            hostname: 'gitlab.com', 
            path: '/api/v4/user', 
            method: 'GET', 
            headers: { 
              'Authorization': 'Bearer ' + accessToken, 
              'Accept': 'application/json' 
            } 
          });
          
          console.log('[SPACES] User endpoint status:', userRes.status);
          console.log('[SPACES] User data:', userRes.data);
          
          if (userRes.status === 200) {
            // Token is valid but projects endpoint is failing
            console.log('[SPACES] Token is valid but projects endpoint failed');
            return res.status(500).json({ 
              error: 'GitLab token is valid but could not fetch projects. You may need to create a project first.',
              user: userRes.data.username
            });
          } else {
            return res.status(401).json({ 
              error: 'Invalid GitLab token. Please reconnect.',
              code: 'token_invalid'
            });
          }
        }
        
        // Use the second response
        var projects = glRes2.data || [];
        if (!Array.isArray(projects)) {
          projects = [];
        }
        
        console.log('[SPACES] GitLab projects (second endpoint) count:', projects.length);
        
        var spaces = projects.map(function(p) { 
          return { 
            id: String(p.id), 
            name: p.name_with_namespace || p.name || 'Unnamed Project' 
          }; 
        });
        
        console.log('[SPACES] Returning', spaces.length, 'projects');
        return res.json({ spaces: spaces });
      }
      
      // Use the first response
      var projects = glRes.data || [];
      if (!Array.isArray(projects)) {
        projects = [];
      }
      
      console.log('[SPACES] GitLab projects (first endpoint) count:', projects.length);
      
      var spaces = projects.map(function(p) { 
        return { 
          id: String(p.id), 
          name: p.name_with_namespace || p.name || 'Unnamed Project' 
        }; 
      });
      
      console.log('[SPACES] Returning', spaces.length, 'projects');
      res.json({ spaces: spaces });
      
    } else {
      // Jira code
      console.log('[SPACES] Fetching Jira projects...');
      var jiraRes = await httpsRequest({ 
        hostname: 'api.atlassian.com', 
        path: '/ex/jira/' + cloudId + '/rest/api/3/project/search?maxResults=50', 
        method: 'GET', 
        headers: { 
          'Authorization': 'Bearer ' + accessToken, 
          'Accept': 'application/json' 
        } 
      });
      
      console.log('[SPACES] Jira response status:', jiraRes.status);
      
      if (jiraRes.status !== 200) {
        console.log('[SPACES] Jira error response:', jiraRes.data);
        return res.status(jiraRes.status).json({ 
          error: 'Jira API error', 
          details: jiraRes.data 
        });
      }
      
      var spaces = (jiraRes.data.values || []).map(function(p) { 
        return { id: p.key, name: p.name }; 
      });
      
      console.log('[SPACES] Returning', spaces.length, 'Jira projects');
      res.json({ spaces: spaces });
    }
    
  } catch(e) { 
    console.log('[SPACES] CATCH ERROR:', e.message);
    console.log('[SPACES] Error stack:', e.stack);
    res.status(500).json({ 
      error: 'Server error: ' + e.message,
      stack: e.stack 
    });
  }
});
// ─── TICKETS ─────────────────────────────────────────────────────────────────
app.post('/tickets', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.body.accessToken, cloudId = req.body.cloudId, provider = req.body.provider || 'jira';
  try {
    if (provider === 'gitlab') {
      var projectId = req.body.spaceId;
      if (!projectId) return res.status(400).json({ error: 'spaceId required for GitLab' });
      var glRes = await httpsRequest({ hostname: 'gitlab.com', path: '/api/v4/projects/' + encodeURIComponent(projectId) + '/issues?state=opened&per_page=30', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
      return res.json({ tickets: (glRes.data || []).map(function(i) { return { id: String(i.iid), title: i.title, description: i.description || 'No description' }; }) });
    }
    var spaceId = req.body.spaceId;
    var jql = spaceId ? 'project%3D' + encodeURIComponent(spaceId) + '%20ORDER%20BY%20updated%20DESC' : 'assignee%3DcurrentUser()%20ORDER%20BY%20updated%20DESC';
    var jiraRes = await httpsRequest({ hostname: 'api.atlassian.com', path: '/ex/jira/' + cloudId + '/rest/api/3/search/jql?jql=' + jql + '&maxResults=30&fields=summary,description,status,priority', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
    if (!jiraRes.data.issues) return res.status(500).json({ error: 'No issues', raw: jiraRes.data });
    res.json({ tickets: jiraRes.data.issues.map(function(issue) {
      var desc = 'No description';
      try { desc = issue.fields.description.content[0].content[0].text; } catch(e) {}
      return { id: issue.key, title: issue.fields.summary, description: desc, priority: (issue.fields.priority && issue.fields.priority.name) || '' };
    })});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── TEST CONNECTION (BYOK key validation) ───────────────────────────────────
app.post('/test-connection', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var provider = req.body.provider || 'anthropic';
  var apiKey   = req.body.key || '';
  var model    = req.body.model || '';
  try {
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
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ─── ENTERPRISE TEST CONNECTION ─────────────────────────────────────────────
app.post('/test-enterprise', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var entType = req.body.entType || 'azure';
  var url     = req.body.url || '';
  var apiKey  = req.body.key || '';
  var model   = req.body.model || '';
  if (!url || !apiKey) return res.json({ ok: false, error: 'URL and API key required' });
  try {
    var testUrl = new URL(url);
    var testRes = await httpsRequest({
      hostname: testUrl.hostname,
      path: testUrl.pathname + '/openai/deployments/' + (model || 'gpt-4o') + '/chat/completions?api-version=2024-02-15-preview',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey }
    }, JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }));
    if (testRes.status === 200 || testRes.status === 201) return res.json({ ok: true, message: 'Endpoint reachable' });
    return res.json({ ok: false, error: 'Status ' + testRes.status });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ─── ANALYZE (uses user's own API key — no usage limits) ────────────────────
app.post('/analyze', rateLimiter(30), async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  req.socket.setTimeout(120000);
  res.setTimeout(120000);

  if (req.body.userId) {
    console.log('[ANALYZE] userId:', req.body.userId);
  }

  var userApiKey   = req.body.apiKey   || '';
  var userProvider = req.body.provider || 'anthropic';
  var userModel    = req.body.model    || '';

  var isEnterprise = req.body.aiMode === 'enterprise';
  if (isEnterprise) {
    userApiKey = req.body.entKey || userApiKey;
    userProvider = 'enterprise';
  }

  if (!userApiKey) return res.status(400).json({ error: 'API key required. Please add your API key in Settings.' });

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
    'E-commerce':        'Focus on: product browsing, cart flows, checkout, wishlist, order tracking, empty states, payment errors.',
    'Fintech / Banking': 'Focus on: security screens, verification flows, transaction history, KYC, biometric authentication.',
    'Food Delivery':     'Focus on: restaurant browsing, order flow, real-time tracking, rating screens, reorder flows.',
    'Travel & Booking':  'Focus on: search and filter flows, booking confirmation, itinerary management, cancellation flows.',
    'SaaS Dashboard':    'Focus on: data tables, analytics charts, settings pages, onboarding flows, permission errors.',
    'Healthcare':        'Focus on: appointment booking, patient records, prescription management, privacy screens.',
    'Education':         'Focus on: course browsing, lesson flows, progress tracking, quiz screens, offline access.',
    'Marketplace':       'Focus on: listing creation, seller dashboard, buyer protection, dispute resolution.',
    'Social Media':      'Focus on: feed screens, profile pages, content creation, notification center.',
    'Other':             'Focus on all standard UX patterns including core flows, errors, empty states, loading states.'
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

  try {
    var r;
    
    if (isEnterprise) {
      var endpoint = req.body.entEndpoint || '';
      var entType = req.body.entType || 'azure';
      var entModel = req.body.entModel || '';
      
      if (!endpoint) return res.status(400).json({ error: 'Enterprise endpoint required' });
      
      var fullUrl = endpoint;
      if (entType === 'azure') {
        var deployment = entModel || 'gpt-4o';
        if (!fullUrl.endsWith('/')) fullUrl += '/';
        fullUrl += 'openai/deployments/' + deployment + '/chat/completions?api-version=2024-02-15-preview';
      }
      
      var urlObj = new URL(fullUrl);
      var body = JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 4096
      });
      
      r = await httpsRequest({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': userApiKey,
          'Content-Length': Buffer.byteLength(body)
        }
      }, body);
      
      if (r.status !== 200) return res.status(500).json({ error: 'Enterprise AI returned ' + r.status, details: r.data });
      rawText = r.data.choices[0].message.content;
      
    } else {
      if (userProvider === 'anthropic') {
        var body = JSON.stringify({ model: userModel || 'claude-haiku-4-5-20251001', max_tokens: 16000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] });
        r = await httpsRequest({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': userApiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, body);
      } else if (userProvider === 'openai') {
        var body = JSON.stringify({ model: userModel || 'gpt-4o-mini', max_tokens: 4096, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] });
        r = await httpsRequest({ hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + userApiKey, 'Content-Length': Buffer.byteLength(body) } }, body);
      } else if (userProvider === 'gemini') {
        var model = userModel || 'gemini-1.5-flash';
        var body = JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents: [{ parts: [{ text: userPrompt }] }] });
        r = await httpsRequest({ hostname: 'generativelanguage.googleapis.com', path: '/v1beta/models/' + model + ':generateContent?key=' + userApiKey, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
      } else {
        var body = JSON.stringify({ model: userModel || 'mistral-small', max_tokens: 4096, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] });
        r = await httpsRequest({ hostname: 'api.mistral.ai', path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + userApiKey, 'Content-Length': Buffer.byteLength(body) } }, body);
      }

      if (r.status !== 200) return res.status(500).json({ error: 'AI returned ' + r.status, details: r.data });

      var rawText;
      if (userProvider === 'anthropic') rawText = r.data.content[0].text;
      else if (userProvider === 'openai' || userProvider === 'mistral') rawText = r.data.choices[0].message.content;
      else if (userProvider === 'gemini') rawText = r.data.candidates[0].content.parts[0].text;
    }

    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    var start = rawText.indexOf('{'), end = rawText.lastIndexOf('}');
    if (start !== -1 && end !== -1) rawText = rawText.substring(start, end + 1);

    var plan;
    try {
      plan = JSON.parse(rawText);
    } catch(parseErr) {
      var repaired = rawText;
      var opens   = (repaired.match(/{/g)||[]).length - (repaired.match(/}/g)||[]).length;
      var openArr = (repaired.match(/\[/g)||[]).length - (repaired.match(/\]/g)||[]).length;
      for (var i = 0; i < openArr; i++) repaired += ']';
      for (var i = 0; i < opens;   i++) repaired += '}';
      try { plan = JSON.parse(repaired); } catch(e2) { throw parseErr; }
    }

    console.log('[ANALYZE] provider=' + userProvider + ' ticketId=' + ticketId);
    res.json({ plan: plan });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CHAT ────────────────────────────────────────────────────────────────────
app.post('/chat', rateLimiter(30), async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  
  var isEnterprise = req.body.aiMode === 'enterprise';
  var userApiKey   = isEnterprise ? req.body.entKey : req.body.byokKey || '';
  var userProvider = isEnterprise ? 'enterprise' : req.body.byokProvider || 'anthropic';
  var userModel    = isEnterprise ? req.body.entModel : req.body.byokModel || '';
  
  // If no API key is provided, try to get it from the stored key in the request
  if (!userApiKey && req.body.apiKey) {
    userApiKey = req.body.apiKey;
  }
  
  if (!userApiKey) {
    console.log('[CHAT] No API key provided');
    return res.json({ text: 'Please add your API key in Settings.', intent: 'none', suggestion: '', target: '' });
  }

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

  var systemPrompt = 'You are an expert AI design assistant inside a Figma plugin called Structify.\n' + context + '\n\n' +
    'You help designers edit the Guide card (the annotation panel next to each device frame). The Guide card has these sections: title, purpose, DESIGN NOTES, UI COMPONENTS, ACTIONS, Copy.\n\n' +
    'CRITICAL: Never modify or duplicate the device frame itself. Only ever add or edit text in the Guide card.\n' +
    'When the user says "add copies" or "add copy" — they mean adding copywriting to the Copy section. Do NOT duplicate a frame.\n\n' +
    'Respond ONLY with a valid JSON object, no markdown:\n' +
    '{"text":"<your reply, max 40 words>","intent":"<none|delete|replace|add>","suggestion":"<exact text, empty for none/delete>","target":"<title|purpose|note|component|action>"}\n\n' +
    'Make suggestions specific and professional. Max 12 words per suggestion.';

  var messages = history.map(function(h) { return { role: h.role, content: h.content }; });
  messages.push({ role: 'user', content: message });

  try {
    var r;
    if (isEnterprise) {
      var endpoint = req.body.entEndpoint || '';
      var entType = req.body.entType || 'azure';
      var entModel = req.body.entModel || '';
      
      if (!endpoint) return res.json({ text: 'Enterprise endpoint required', intent: 'none', suggestion: '', target: '' });
      
      var fullUrl = endpoint;
      if (entType === 'azure') {
        var deployment = entModel || 'gpt-4o';
        if (!fullUrl.endsWith('/')) fullUrl += '/';
        fullUrl += 'openai/deployments/' + deployment + '/chat/completions?api-version=2024-02-15-preview';
      }
      
      var urlObj = new URL(fullUrl);
      var body = JSON.stringify({
        messages: [{ role: 'system', content: systemPrompt }].concat(messages),
        max_tokens: 500
      });
      
      r = await httpsRequest({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': userApiKey,
          'Content-Length': Buffer.byteLength(body)
        }
      }, body);
      
      if (r.status !== 200) return res.json({ text: 'Enterprise AI error: ' + r.status, intent: 'none', suggestion: '', target: '' });
      var raw = r.data.choices[0].message.content.trim();
      
    } else if (userProvider === 'anthropic') {
      var body = JSON.stringify({ model: userModel || 'claude-haiku-4-5-20251001', max_tokens: 500, system: systemPrompt, messages: messages });
      r = await httpsRequest({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': userApiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, body);
      if (r.status !== 200) return res.json({ text: 'AI error: ' + r.status, intent: 'none', suggestion: '', target: '' });
      var raw = r.data.content[0].text.trim();
    } else if (userProvider === 'openai') {
      var body = JSON.stringify({ model: userModel || 'gpt-4o-mini', max_tokens: 500, messages: [{ role: 'system', content: systemPrompt }].concat(messages) });
      r = await httpsRequest({ hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + userApiKey, 'Content-Length': Buffer.byteLength(body) } }, body);
      if (r.status !== 200) return res.json({ text: 'AI error: ' + r.status, intent: 'none', suggestion: '', target: '' });
      var raw = r.data.choices[0].message.content.trim();
    } else {
      var body = JSON.stringify({ model: userModel || 'mistral-small', max_tokens: 500, messages: [{ role: 'system', content: systemPrompt }].concat(messages) });
      r = await httpsRequest({ hostname: 'api.mistral.ai', path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + userApiKey, 'Content-Length': Buffer.byteLength(body) } }, body);
      if (r.status !== 200) return res.json({ text: 'AI error: ' + r.status, intent: 'none', suggestion: '', target: '' });
      var raw = r.data.choices[0].message.content.trim();
    }

    raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
    var parsed;
    try { parsed = JSON.parse(raw); } catch(e) { parsed = { text: raw, intent: 'none', suggestion: '', target: '' }; }
    res.json({ text: parsed.text || raw, intent: parsed.intent || 'none', suggestion: parsed.suggestion || '', target: parsed.target || '' });
  } catch(e) { res.json({ text: 'Error: ' + e.message, intent: 'none', suggestion: '', target: '' }); }
});

// ─── GENERATE COMMENT ────────────────────────────────────────────────────────
app.post('/generate-comment', rateLimiter(20), async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  
  var isEnterprise = req.body.aiMode === 'enterprise';
  var userApiKey   = isEnterprise ? req.body.entKey : req.body.byokKey || '';
  var userProvider = isEnterprise ? 'enterprise' : req.body.byokProvider || 'anthropic';
  var userModel    = req.body.byokModel || '';
  var prompt       = req.body.prompt   || '';
  
  if (!prompt)     return res.status(400).json({ error: 'prompt required' });
  if (!userApiKey) return res.status(400).json({ error: 'API key required' });

  try {
    var r;
    if (isEnterprise) {
      var endpoint = req.body.entEndpoint || '';
      var entType = req.body.entType || 'azure';
      var entModel = req.body.entModel || '';
      
      if (!endpoint) return res.status(400).json({ error: 'Enterprise endpoint required' });
      
      var fullUrl = endpoint;
      if (entType === 'azure') {
        var deployment = entModel || 'gpt-4o';
        if (!fullUrl.endsWith('/')) fullUrl += '/';
        fullUrl += 'openai/deployments/' + deployment + '/chat/completions?api-version=2024-02-15-preview';
      }
      
      var urlObj = new URL(fullUrl);
      var body = JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300
      });
      
      r = await httpsRequest({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': userApiKey,
          'Content-Length': Buffer.byteLength(body)
        }
      }, body);
      
      if (r.status !== 200) return res.status(500).json({ error: 'Enterprise AI error: ' + r.status });
      res.json({ comment: r.data.choices[0].message.content.trim() });
      
    } else if (userProvider === 'anthropic') {
      var body = JSON.stringify({ model: userModel || 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt + '\n\nRespond with only the comment text, no preamble.' }] });
      r = await httpsRequest({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': userApiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, body);
      if (r.status !== 200) return res.status(500).json({ error: 'AI error: ' + r.status });
      res.json({ comment: r.data.content[0].text.trim() });
    } else if (userProvider === 'openai') {
      var body = JSON.stringify({ model: userModel || 'gpt-4o-mini', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
      r = await httpsRequest({ hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + userApiKey, 'Content-Length': Buffer.byteLength(body) } }, body);
      if (r.status !== 200) return res.status(500).json({ error: 'AI error: ' + r.status });
      res.json({ comment: r.data.choices[0].message.content.trim() });
    } else {
      res.json({ comment: '' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── COMMENT (post to Jira/GitLab) ───────────────────────────────────────────
app.post('/comment', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.body.accessToken, cloudId = req.body.cloudId || '', ticketId = req.body.ticketId || '', comment = req.body.comment || '', provider = req.body.provider || 'jira', spaceId = req.body.spaceId || '';
  try {
    var result;
    if (provider === 'gitlab') {
      var issueIid = String(ticketId).replace(/[^0-9]/g, '').trim();
      var projectId = String(spaceId || cloudId).trim();
      if (!projectId) return res.status(400).json({ error: 'Missing project ID.' });
      if (!issueIid)  return res.status(400).json({ error: 'Missing issue ID.' });
      var glBody = JSON.stringify({ body: comment });
      result = await httpsRequest({ hostname: 'gitlab.com', path: '/api/v4/projects/' + encodeURIComponent(projectId) + '/issues/' + issueIid + '/notes', method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(glBody) } }, glBody);
    } else {
      var jBody = JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] } });
      result = await httpsRequest({ hostname: 'api.atlassian.com', path: '/ex/jira/' + cloudId + '/rest/api/3/issue/' + ticketId + '/comment', method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(jBody) } }, jBody);
    }
    if (result.status >= 400) return res.status(result.status).json({ error: result.data });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── START ───────────────────────────────────────────────────────────────────
var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('Structify (free/BYOK) server running on port ' + PORT);
});
