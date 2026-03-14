const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

function jiraRequest(options, body, res, onSuccess) {
  var request = https.request(options, function(response) {
    var data = '';
    response.on('data', function(chunk) { data += chunk; });
    response.on('end', function() {
      try {
        var parsed = JSON.parse(data);
        onSuccess(parsed, response.statusCode);
      } catch(e) {
        res.status(500).json({ error: e.message, raw: data });
      }
    });
  });
  request.on('error', function(e) { res.status(500).json({ error: e.message }); });
  if (body) { request.write(body); }
  request.end();
}

app.get('/tickets', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var jiraUrl = req.query.jiraUrl;
  var email = req.query.email;
  var token = req.query.token;
  if (!jiraUrl || !email || !token) { return res.status(400).json({ error: 'Missing parameters' }); }
  var hostname = jiraUrl.replace('https://','').replace('http://','').replace(/\/$/,'');
  var auth = Buffer.from(email + ':' + token).toString('base64');
  var options = {
    hostname: hostname,
    path: '/rest/api/3/search/jql?jql=project=KAN&maxResults=20&fields=summary,description,status,assignee',
    method: 'GET',
    headers: { 'Authorization': 'Basic ' + auth, 'Accept': 'application/json' }
  };
  jiraRequest(options, null, res, function(data, status) {
    if (!data.issues) { return res.status(500).json({ error: 'No issues found', raw: data }); }
    var tickets = data.issues.map(function(issue) {
      var desc = 'No description';
      var title = 'No title';
      try { title = issue.fields.summary; } catch(e) {}
      try { desc = issue.fields.description.content[0].content[0].text; } catch(e) {}
      return { id: issue.key, title: title, description: desc };
    });
    res.json({ tickets: tickets });
  });
});

app.post('/comment', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var jiraUrl = req.body.jiraUrl;
  var email = req.body.email;
  var token = req.body.token;
  var ticketId = req.body.ticketId;
  var comment = req.body.comment;
  if (!jiraUrl || !email || !token || !ticketId || !comment) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  var hostname = jiraUrl.replace('https://','').replace('http://','').replace(/\/$/,'');
  var auth = Buffer.from(email + ':' + token).toString('base64');
  var body = JSON.stringify({
    body: {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }]
    }
  });
  var options = {
    hostname: hostname,
    path: '/rest/api/3/issue/' + ticketId + '/comment',
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };
  jiraRequest(options, body, res, function(data, status) {
    if (status >= 400) { return res.status(status).json({ error: data }); }
    res.json({ success: true, commentId: data.id });
  });
});

app.options('*', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.sendStatus(200);
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() { console.log('Jira proxy running on port ' + PORT); });
