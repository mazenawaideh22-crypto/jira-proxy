const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');

require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID;
const CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET;
const REDIRECT_URI = 'https://jira-proxy-production-ec4e.up.railway.app/auth/callback';

// Store temporary codes in memory
// { code: { accessToken, cloudId, expiresAt } }
var tokenStore = {};

function cleanExpired() {
  var now = Date.now();
  Object.keys(tokenStore).forEach(function(k) {
    if (tokenStore[k].expiresAt < now) delete tokenStore[k];
  });
}

// ── Step 1: Start OAuth flow ──
app.get('/auth/jira', function(req, res) {
  var state = crypto.randomBytes(16).toString('hex');
  var url = 'https://auth.atlassian.com/authorize' +
    '?audience=api.atlassian.com' +
    '&client_id=' + CLIENT_ID +
    '&scope=read%3Ajira-work%20write%3Ajira-work%20read%3Ajira-user%20offline_access' +
    '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
    '&state=' + state +
    '&response_type=code' +
    '&prompt=consent';
  res.redirect(url);
});

// ── Step 2: Handle callback ──
app.get('/auth/callback', function(req, res) {
  var code = req.query.code;
  if (!code) { return res.status(400).send('No code received'); }

  var body = JSON.stringify({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code: code,
    redirect_uri: REDIRECT_URI
  });

  var options = {
    hostname: 'auth.atlassian.com',
    path: '/oauth/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  var request = https.request(options, function(response) {
    var data = '';
    response.on('data', function(chunk) { data += chunk; });
    response.on('end', function() {
      try {
        var tokenData = JSON.parse(data);
        if (!tokenData.access_token) {
          return res.status(500).send('Failed to get token: ' + data);
        }

        // Get accessible resources (cloud IDs)
        var resourceOptions = {
          hostname: 'api.atlassian.com',
          path: '/oauth/token/accessible-resources',
          method: 'GET',
          headers: {
            'Authorization': 'Bearer ' + tokenData.access_token,
            'Accept': 'application/json'
          }
        };

        var resReq = https.request(resourceOptions, function(resResponse) {
          var resData = '';
          resResponse.on('data', function(chunk) { resData += chunk; });
          resResponse.on('end', function() {
            try {
              var resources = JSON.parse(resData);
              var cloudId = resources[0] && resources[0].id;
              var siteName = resources[0] && resources[0].name;

              // Generate 6-digit code
              var pluginCode = Math.floor(100000 + Math.random() * 900000).toString();

              // Store with 10 min expiry
              tokenStore[pluginCode] = {
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                cloudId: cloudId,
                siteName: siteName,
                expiresAt: Date.now() + 10 * 60 * 1000
              };

              cleanExpired();

              // Show success page
              res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>JiraAI Designer</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#f0f0f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#111118;border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:40px;text-align:center;max-width:380px}.logo{font-size:40px;margin-bottom:20px}.title{font-size:22px;font-weight:700;margin-bottom:8px}.sub{color:#6b6b80;font-size:14px;margin-bottom:32px}.code-label{font-size:11px;color:#6b6b80;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px}.code{font-size:48px;font-weight:800;letter-spacing:0.15em;color:#7c6dfa;background:rgba(124,109,250,0.1);border:2px solid rgba(124,109,250,0.3);border-radius:14px;padding:16px 32px;margin-bottom:16px;font-family:monospace}.hint{font-size:12px;color:#6b6b80;line-height:1.6}.site{color:#4dd98a;font-weight:600}</style></head><body><div class="card"><div class="logo">✦</div><h1 class="title">Connected!</h1><p class="sub">Linked to <span class="site">' + (siteName || 'your Jira') + '</span></p><div class="code-label">Enter this code in the plugin</div><div class="code">' + pluginCode + '</div><p class="hint">This code expires in <strong>10 minutes</strong>.<br>Go back to Figma and enter it.</p></div></body></html>');

            } catch(e) {
              res.status(500).send('Error parsing resources: ' + e.message);
            }
          });
        });
        resReq.on('error', function(e) { res.status(500).send('Resource error: ' + e.message); });
        resReq.end();

      } catch(e) {
        res.status(500).send('Error: ' + e.message);
      }
    });
  });

  request.on('error', function(e) { res.status(500).send('Request error: ' + e.message); });
  request.write(body);
  request.end();
});

// ── Step 3: Plugin exchanges code for token ──
app.post('/auth/exchange', function(req, res) {
  cleanExpired();
  var code = req.body.code;
  if (!code || !tokenStore[code]) {
    return res.status(404).json({ error: 'Invalid or expired code' });
  }
  var data = tokenStore[code];
  delete tokenStore[code];
  res.json({
    accessToken: data.accessToken,
    cloudId: data.cloudId,
    siteName: data.siteName
  });
});

// ── Tickets endpoint ──
app.get('/tickets', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var jiraUrl = req.query.jiraUrl;
  var email = req.query.email;
  var token = req.query.token;
  var accessToken = req.query.accessToken;
  var cloudId = req.query.cloudId;

  var hostname, path, authHeader;

  if (accessToken && cloudId) {
    hostname = 'api.atlassian.com';
    path = '/ex/jira/' + cloudId + '/rest/api/3/search/jql?jql=assignee=currentUser()&maxResults=20&fields=summary,description,status';
    authHeader = 'Bearer ' + accessToken;
  } else {
    if (!jiraUrl || !email || !token) { return res.status(400).json({ error: 'Missing parameters' }); }
    hostname = jiraUrl.replace('https://','').replace('http://','').replace(/\/$/,'');
    path = '/rest/api/3/search/jql?jql=project=KAN&maxResults=20&fields=summary,description,status,assignee';
    authHeader = 'Basic ' + Buffer.from(email + ':' + token).toString('base64');
  }

  var options = {
    hostname: hostname,
    path: path,
    method: 'GET',
    headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
  };

  var request = https.request(options, function(response) {
    var body = '';
    response.on('data', function(chunk) { body += chunk; });
    response.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (!data.issues) { return res.status(500).json({ error: 'No issues found', raw: data }); }
        var tickets = data.issues.map(function(issue) {
          var desc = 'No description';
          var title = 'No title';
          try { title = issue.fields.summary; } catch(e) {}
          try { desc = issue.fields.description.content[0].content[0].text; } catch(e) {}
          return { id: issue.key, title: title, description: desc };
        });
        res.json({ tickets: tickets });
      } catch(e) { res.status(500).json({ error: e.message }); }
    });
  });
  request.on('error', function(e) { res.status(500).json({ error: e.message }); });
  request.end();
});

// ── Comment endpoint ──
app.post('/comment', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var jiraUrl = req.body.jiraUrl;
  var email = req.body.email;
  var token = req.body.token;
  var accessToken = req.body.accessToken;
  var cloudId = req.body.cloudId;
  var ticketId = req.body.ticketId;
  var comment = req.body.comment;

  var hostname, path, authHeader;

  if (accessToken && cloudId) {
    hostname = 'api.atlassian.com';
    path = '/ex/jira/' + cloudId + '/rest/api/3/issue/' + ticketId + '/comment';
    authHeader = 'Bearer ' + accessToken;
  } else {
    hostname = jiraUrl.replace('https://','').replace('http://','').replace(/\/$/,'');
    path = '/rest/api/3/issue/' + ticketId + '/comment';
    authHeader = 'Basic ' + Buffer.from(email + ':' + token).toString('base64');
  }

  var body = JSON.stringify({
    body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] }
  });

  var options = {
    hostname: hostname,
    path: path,
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  var request = https.request(options, function(response) {
    var data = '';
    response.on('data', function(chunk) { data += chunk; });
    response.on('end', function() {
      try {
        var parsed = JSON.parse(data);
        if (response.statusCode >= 400) { return res.status(response.statusCode).json({ error: parsed }); }
        res.json({ success: true });
      } catch(e) { res.status(500).json({ error: e.message }); }
    });
  });
  request.on('error', function(e) { res.status(500).json({ error: e.message }); });
  request.write(body);
  request.end();
});

app.options('*', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.sendStatus(200);
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() { console.log('Server running on port ' + PORT); });
