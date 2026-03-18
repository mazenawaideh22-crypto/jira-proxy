require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const JIRA_CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID;
const JIRA_CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const LINEAR_CLIENT_ID = process.env.LINEAR_CLIENT_ID;
const LINEAR_CLIENT_SECRET = process.env.LINEAR_CLIENT_SECRET;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const BASE_URL = 'https://jira-proxy-production-ec4e.up.railway.app';

var pendingCodes = {};
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
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Structify</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#f0f0f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#111118;border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:40px;text-align:center;max-width:380px;width:90%}.icon{font-size:48px;margin-bottom:16px}h1{font-size:22px;font-weight:700;margin-bottom:8px}p{font-size:13px;color:#6b6b80;margin-bottom:24px;line-height:1.6}.code-box{background:#1a1a2e;border:2px solid #6366f1;border-radius:14px;padding:20px;margin-bottom:24px}.code-label{font-size:11px;color:#6b6b80;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px}.code{font-size:42px;font-weight:800;letter-spacing:0.2em;color:#a99fff;font-family:monospace}.note{font-size:11px;color:#3a3a4a}.close-btn{background:#6366f1;color:white;border:none;padding:12px 32px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;margin-top:16px}</style></head><body><div class="card"><div class="icon">✅</div><h1>Connected to ' + service + '!</h1><p>Enter this code in Structify to complete the connection.</p><div class="code-box"><div class="code-label">Your Plugin Code</div><div class="code">' + code + '</div></div><p class="note">This code expires in 5 minutes.</p><br><button class="close-btn" onclick="window.close()">Close & Return to Figma</button></div></body></html>';
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
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── DEBUG ──
app.get('/debug', function(req, res) {
  res.json({
    jiraClientId: JIRA_CLIENT_ID ? JIRA_CLIENT_ID.substring(0,8) : 'NOT SET',
    hasJiraSecret: !!JIRA_CLIENT_SECRET,
    hasGithubId: !!GITHUB_CLIENT_ID,
    hasLinearId: !!LINEAR_CLIENT_ID,
    hasClaudeKey: !!CLAUDE_API_KEY
  });
});

// ── JIRA OAUTH ──
app.get('/auth/jira', function(req, res) {
  var url = 'https://auth.atlassian.com/authorize' +
    '?audience=api.atlassian.com' +
    '&client_id=' + JIRA_CLIENT_ID +
    '&scope=' + encodeURIComponent('read:jira-work write:jira-work read:jira-user offline_access') +
    '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/jira/callback') +
    '&state=' + crypto.randomBytes(16).toString('hex') +
    '&response_type=code&prompt=consent';
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
    var cloudId = resourcesRes.data[0] ? resourcesRes.data[0].id : null;
    var jiraUrl = resourcesRes.data[0] ? resourcesRes.data[0].url : null;
    var pluginCode = generateCode({ provider: 'jira', accessToken: tokenRes.data.access_token, refreshToken: tokenRes.data.refresh_token, cloudId: cloudId, jiraUrl: jiraUrl });
    res.send(successPage(pluginCode, 'Jira'));
  } catch(e) { res.status(500).send('<h2>Error: ' + e.message + '</h2>'); }
});

// ── GITHUB OAUTH ──
app.get('/auth/github', function(req, res) {
  var url = 'https://github.com/login/oauth/authorize' +
    '?client_id=' + GITHUB_CLIENT_ID +
    '&scope=repo,user' +
    '&state=' + crypto.randomBytes(16).toString('hex');
  res.redirect(url);
});

app.get('/auth/github/callback', async function(req, res) {
  var code = req.query.code;
  if (!code) return res.status(400).send('<h2>Error: No code</h2>');
  try {
    var body = 'client_id=' + GITHUB_CLIENT_ID + '&client_secret=' + GITHUB_CLIENT_SECRET + '&code=' + code;
    var tokenRes = await httpsRequest({ hostname: 'github.com', path: '/login/oauth/access_token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (!tokenRes.data.access_token) return res.status(400).send('<h2>GitHub token error</h2>');
    var userRes = await httpsRequest({ hostname: 'api.github.com', path: '/user', method: 'GET', headers: { 'Authorization': 'Bearer ' + tokenRes.data.access_token, 'User-Agent': 'Structify', 'Accept': 'application/json' } });
    var pluginCode = generateCode({ provider: 'github', accessToken: tokenRes.data.access_token, username: userRes.data.login, name: userRes.data.name });
    res.send(successPage(pluginCode, 'GitHub'));
  } catch(e) { res.status(500).send('<h2>Error: ' + e.message + '</h2>'); }
});

// ── LINEAR OAUTH ──
app.get('/auth/linear', function(req, res) {
  var url = 'https://linear.app/oauth/authorize' +
    '?client_id=' + LINEAR_CLIENT_ID +
    '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/linear/callback') +
    '&response_type=code' +
    '&scope=read,write' +
    '&state=' + crypto.randomBytes(16).toString('hex');
  res.redirect(url);
});

app.get('/auth/linear/callback', async function(req, res) {
  var code = req.query.code;
  if (!code) return res.status(400).send('<h2>Error: No code</h2>');
  try {
    var body = JSON.stringify({ client_id: LINEAR_CLIENT_ID, client_secret: LINEAR_CLIENT_SECRET, code: code, redirect_uri: BASE_URL + '/auth/linear/callback', grant_type: 'authorization_code' });
    var tokenRes = await httpsRequest({ hostname: 'api.linear.app', path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (!tokenRes.data.access_token) return res.status(400).send('<h2>Linear token error: ' + JSON.stringify(tokenRes.data) + '</h2>');
    var pluginCode = generateCode({ provider: 'linear', accessToken: tokenRes.data.access_token });
    res.send(successPage(pluginCode, 'Linear'));
  } catch(e) { res.status(500).send('<h2>Error: ' + e.message + '</h2>'); }
});

// ── TOKEN EXCHANGE ──
app.get('/auth/token', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var code = req.query.code;
  if (!code || !pendingCodes[code]) return res.status(404).json({ error: 'Invalid or expired code' });
  if (Date.now() > pendingCodes[code].expiresAt) { delete pendingCodes[code]; return res.status(410).json({ error: 'Code expired' }); }
  var data = pendingCodes[code];
  delete pendingCodes[code];
  res.json(data);
});

// ── SPACES ──
app.get('/spaces', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.query.accessToken;
  var cloudId = req.query.cloudId;
  var provider = req.query.provider || 'jira';
  try {
    if (provider === 'github') {
      var ghRes = await httpsRequest({ hostname: 'api.github.com', path: '/user/repos?sort=updated&per_page=20', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'User-Agent': 'Structify', 'Accept': 'application/json' } });
      var spaces = (ghRes.data || []).map(function(r) { return { id: r.full_name, name: r.full_name }; });
      return res.json({ spaces: spaces });
    }
    if (provider === 'linear') {
      var query = JSON.stringify({ query: '{ teams { nodes { id name } } }' });
      var linRes = await httpsRequest({ hostname: 'api.linear.app', path: '/graphql', method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(query) } }, query);
      var nodes = linRes.data.data ? linRes.data.data.teams.nodes : [];
      return res.json({ spaces: nodes.map(function(t) { return { id: t.id, name: t.name }; }) });
    }
    // Jira projects
    var jiraRes = await httpsRequest({ hostname: 'api.atlassian.com', path: '/ex/jira/' + cloudId + '/rest/api/3/project/search?maxResults=50', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
    var projects = (jiraRes.data.values || []).map(function(p) { return { id: p.key, name: p.name }; });
    res.json({ spaces: projects });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DEBUG SPACES ──
app.get('/debug-spaces', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.query.accessToken;
  var cloudId = req.query.cloudId;
  try {
    var jiraRes = await httpsRequest({
      hostname: 'api.atlassian.com',
      path: '/ex/jira/' + cloudId + '/rest/api/3/project/search?maxResults=50',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' }
    });
    res.json({ status: jiraRes.status, data: jiraRes.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TICKETS ──
app.get('/tickets', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.query.accessToken;
  var cloudId = req.query.cloudId;
  var provider = req.query.provider || 'jira';
  try {
    var result;
    if (provider === 'github') {
      var ghRes = await httpsRequest({ hostname: 'api.github.com', path: '/issues?filter=assigned&state=open&per_page=20', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'User-Agent': 'Structify', 'Accept': 'application/json' } });
      var tickets = (ghRes.data || []).map(function(issue) {
        return { id: '#' + issue.number, title: issue.title, description: issue.body || 'No description' };
      });
      return res.json({ tickets: tickets });
    }
    if (provider === 'linear') {
      var query = JSON.stringify({ query: '{ issues(filter: { assignee: { isMe: { eq: true } } }) { nodes { id identifier title description } } }' });
      var linRes = await httpsRequest({ hostname: 'api.linear.app', path: '/graphql', method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(query) } }, query);
      var nodes = linRes.data.data ? linRes.data.data.issues.nodes : [];
      var tickets = nodes.map(function(i) { return { id: i.identifier, title: i.title, description: i.description || 'No description' }; });
      return res.json({ tickets: tickets });
    }
    // Jira
    var spaceId = req.query.spaceId;
    var jql = spaceId ? 'project%3D' + encodeURIComponent(spaceId) + '%20ORDER%20BY%20updated%20DESC' : 'assignee%3DcurrentUser()%20ORDER%20BY%20updated%20DESC';
    var jiraRes = await httpsRequest({ hostname: 'api.atlassian.com', path: '/ex/jira/' + cloudId + '/rest/api/3/search/jql?jql=' + jql + '&maxResults=30&fields=summary,description,status', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
    if (!jiraRes.data.issues) return res.status(500).json({ error: 'No issues', raw: jiraRes.data });
    var tickets = jiraRes.data.issues.map(function(issue) {
      var desc = 'No description';
      try { desc = issue.fields.description.content[0].content[0].text; } catch(e) {}
      return { id: issue.key, title: issue.fields.summary, description: desc };
    });
    res.json({ tickets: tickets });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLAUDE (server-side, key hidden) ──
app.post('/analyze', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var ticketId = req.body.ticketId;
  var ticketTitle = req.body.ticketTitle;
  var ticketDesc = req.body.ticketDesc;
  var industry = req.body.industry || 'Other';
  var deviceType = req.body.deviceType || 'mobile';
  var deviceW = req.body.deviceW || 390;
  var deviceH = req.body.deviceH || 844;
  var companyContext = req.body.companyContext || '';
  var additionalInstructions = req.body.additionalInstructions || '';

  var INDUSTRY_PROMPTS = {
    'E-commerce': 'Focus on: product browsing, cart flows, checkout, wishlist, order tracking, empty states, payment errors.',
    'Fintech / Banking': 'Focus on: security screens, verification flows, transaction history, KYC, biometric authentication.',
    'Food Delivery': 'Focus on: restaurant browsing, order flow, real-time tracking, rating screens, reorder flows.',
    'Travel & Booking': 'Focus on: search and filter flows, booking confirmation, itinerary management, cancellation flows.',
    'SaaS Dashboard': 'Focus on: data tables, analytics charts, settings pages, onboarding flows, permission errors.',
    'Healthcare': 'Focus on: appointment booking, patient records, prescription management, privacy screens.',
    'Education': 'Focus on: course browsing, lesson flows, progress tracking, quiz screens, offline access.',
    'Marketplace': 'Focus on: listing creation, seller dashboard, buyer protection, dispute resolution.',
    'Social Media': 'Focus on: feed screens, profile pages, content creation, notification center.',
    'Other': 'Focus on all standard UX patterns including core flows, errors, empty states, loading states.'
  };

  var systemPrompt = 'You are a senior UX architect. ' + (INDUSTRY_PROMPTS[industry] || INDUSTRY_PROMPTS['Other']) + ' Device: ' + deviceType + ' (' + deviceW + 'x' + deviceH + 'px). ' + (companyContext ? 'Company context: ' + companyContext + '.' : '') + ' ' + (additionalInstructions ? 'Additional: ' + additionalInstructions + '.' : '') + ' Analyze the Jira ticket and return a complete structured design plan as JSON only. Use this exact structure: { "feature_summary": "2-3 sentence overview", "designer_checklist": [{ "text": "Screen name", "required": true }], "touchpoints": { "primary": [{ "location": "Where", "ui_suggestion": "What", "interaction": "How", "impact": "High/Medium/Low" }], "secondary": [{ "location": "", "ui_suggestion": "", "interaction": "", "impact": "" }], "growth": ["idea 1"], "retention": ["idea 1"], "upsell": ["idea 1"] }, "sections": [{ "name": "Section Name", "overview": "What this section covers", "frames": [{ "title": "1. Screen Name", "screen_purpose": "Why", "ui_components": [{ "name": "Component", "required": true }], "primary_actions": ["Label 1", "Label 2", "Label 3"], "suggested_copy": { "headline": ["Option 1", "Option 2", "Option 3"], "message": ["Option 1", "Option 2", "Option 3"] }, "design_notes": [{ "text": "Note", "required": true }], "ai_suggested_components": ["Optional component"] }] }] }. Always include sections: Core Flow, Touchpoints, Edge Cases, Error States, Empty States, Loading States, Security and Privacy, Accessibility. Return only valid JSON.';

  var userPrompt = 'Analyze this ticket. ID: ' + ticketId + '. Title: ' + ticketTitle + '. Description: ' + ticketDesc + '. Return only valid JSON.';

  var body = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 8000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] });

  try {
    if (!CLAUDE_API_KEY) return res.status(500).json({ error: 'Claude API key not configured' });
    var claudeRes = await httpsRequest({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
    }, body);
    if (claudeRes.status !== 200) return res.status(500).json({ error: 'Claude returned ' + claudeRes.status, details: claudeRes.data });
    var rawText = claudeRes.data.content[0].text;
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    var start = rawText.indexOf('{');
    var end = rawText.lastIndexOf('}');
    if (start !== -1 && end !== -1) rawText = rawText.substring(start, end + 1);
    var plan = JSON.parse(rawText);
    res.json({ plan: plan });
  } catch(e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

// ── COMMENT ──
app.post('/comment', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.body.accessToken;
  var cloudId = req.body.cloudId;
  var ticketId = req.body.ticketId;
  var comment = req.body.comment;
  try {
    var body = JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] } });
    var result = await httpsRequest({ hostname: 'api.atlassian.com', path: '/ex/jira/' + cloudId + '/rest/api/3/issue/' + ticketId + '/comment', method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (result.status >= 400) return res.status(result.status).json({ error: result.data });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.options('*', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.sendStatus(200);
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() { console.log('Structify server running on port ' + PORT); });
