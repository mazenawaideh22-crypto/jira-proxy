require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID;
const CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET;
const REDIRECT_URI = 'https://jira-proxy-production-ec4e.up.railway.app/auth/callback';
const SCOPES = 'read:jira-work write:jira-work read:me offline_access';

// In-memory store for codes (expires in 5 min)
var pendingCodes = {};

function cleanup() {
  var now = Date.now();
  Object.keys(pendingCodes).forEach(function(code) {
    if (pendingCodes[code].expiresAt < now) {
      delete pendingCodes[code];
    }
  });
}
setInterval(cleanup, 60000);

// ── AUTH: Redirect to Atlassian ──
app.get('/auth/jira', function(req, res) {
  var state = crypto.randomBytes(16).toString('hex');
  var url = 'https://auth.atlassian.com/authorize' +
    '?audience=api.atlassian.com' +
    '&client_id=' + CLIENT_ID +
    '&scope=' + encodeURIComponent(SCOPES) +
    '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
    '&state=' + state +
    '&response_type=code' +
    '&prompt=consent';
  res.redirect(url);
});

// ── AUTH: Callback from Atlassian ──
app.get('/auth/callback', function(req, res) {
  var code = req.query.code;
  if (!code) {
    return res.status(400).send('<h2>Error: No code returned from Atlassian</h2>');
  }

  // Exchange code for token
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
          return res.status(400).send('<h2>Error getting token: ' + JSON.stringify(tokenData) + '</h2>');
        }

        // Get cloud ID
        var accessToken = tokenData.access_token;
        var cloudOptions = {
          hostname: 'api.atlassian.com',
          path: '/oauth/token/accessible-resources',
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
        };

        var cloudReq = https.request(cloudOptions, function(cloudRes) {
          var cloudData = '';
          cloudRes.on('data', function(c) { cloudData += c; });
          cloudRes.on('end', function() {
            try {
              var resources = JSON.parse(cloudData);
              var cloudId = resources[0] ? resources[0].id : null;
              var jiraUrl = resources[0] ? resources[0].url : null;

              // Generate 6-digit code
              var pluginCode = Math.floor(100000 + Math.random() * 900000).toString();
              pendingCodes[pluginCode] = {
                accessToken: accessToken,
                refreshToken: tokenData.refresh_token,
                cloudId: cloudId,
                jiraUrl: jiraUrl,
                expiresAt: Date.now() + 5 * 60 * 1000
              };

              // Show success page
              res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>JiraAI Designer — Connected!</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: #0a0a0f; color: #f0f0f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #111118; border: 1px solid rgba(255,255,255,0.08); border-radius: 20px; padding: 40px; text-align: center; max-width: 380px; width: 90%; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
  p { font-size: 13px; color: #6b6b80; margin-bottom: 24px; line-height: 1.6; }
  .code-box { background: #1a1a2e; border: 2px solid #6366f1; border-radius: 14px; padding: 20px; margin-bottom: 24px; }
  .code-label { font-size: 11px; color: #6b6b80; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px; }
  .code { font-size: 42px; font-weight: 800; letter-spacing: 0.2em; color: #a99fff; font-family: monospace; }
  .note { font-size: 11px; color: #3a3a4a; }
  .close-btn { background: #6366f1; color: white; border: none; padding: 12px 32px; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>Connected to Jira!</h1>
  <p>Enter this code in the JiraAI Designer plugin to complete the connection.</p>
  <div class="code-box">
    <div class="code-label">Your Plugin Code</div>
    <div class="code">` + pluginCode + `</div>
  </div>
  <p class="note">This code expires in 5 minutes.</p>
  <br>
  <button class="close-btn" onclick="window.close()">Close & Return to Figma</button>
</div>
</body>
</html>`);
            } catch(e) {
              res.status(500).send('<h2>Error: ' + e.message + '</h2>');
            }
          });
        });
        cloudReq.on('error', function(e) { res.status(500).send('<h2>Cloud error: ' + e.message + '</h2>'); });
        cloudReq.end();

      } catch(e) {
        res.status(500).send('<h2>Parse error: ' + e.message + '</h2>');
      }
    });
  });
  request.on('error', function(e) { res.status(500).send('<h2>Request error: ' + e.message + '</h2>'); });
  request.write(body);
  request.end();
});

// ── PLUGIN: Exchange code for token ──
app.get('/auth/token', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var code = req.query.code;
  if (!code || !pendingCodes[code]) {
    return res.status(404).json({ error: 'Invalid or expired code' });
  }
  var data = pendingCodes[code];
  if (Date.now() > data.expiresAt) {
    delete pendingCodes[code];
    return res.status(410).json({ error: 'Code expired' });
  }
  delete pendingCodes[code];
  res.json({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    cloudId: data.cloudId,
    jiraUrl: data.jiraUrl
  });
});

// ── TICKETS ──
app.get('/tickets', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.query.accessToken;
  var cloudId = req.query.cloudId;
  var jiraUrl = req.query.jiraUrl;
  var email = req.query.email;
  var token = req.query.token;

  var useOAuth = accessToken && cloudId;
  var hostname, path, authHeader;

  if (useOAuth) {
    hostname = 'api.atlassian.com';
    path = '/ex/jira/' + cloudId + '/rest/api/3/search/jql?jql=assignee=currentUser()&maxResults=20&fields=summary,description,status,assignee';
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

// ── COMMENT ──
app.post('/comment', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.body.accessToken;
  var cloudId = req.body.cloudId;
  var jiraUrl = req.body.jiraUrl;
  var email = req.body.email;
  var token = req.body.token;
  var ticketId = req.body.ticketId;
  var comment = req.body.comment;

  var useOAuth = accessToken && cloudId;
  var hostname, path, authHeader;

  if (useOAuth) {
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
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) }
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

app.get('/debug', function(req, res) {
  res.json({
    clientIdFirst8: process.env.ATLASSIAN_CLIENT_ID ? process.env.ATLASSIAN_CLIENT_ID.substring(0, 8) : 'NOT SET',
    hasSecret: !!process.env.ATLASSIAN_CLIENT_SECRET
  });
});
