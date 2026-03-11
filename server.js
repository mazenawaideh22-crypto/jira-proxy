const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/tickets', function(req, res) {
  var jiraUrl = req.query.jiraUrl;
  var email = req.query.email;
  var token = req.query.token;

  if (!jiraUrl || !email || !token) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  var auth = Buffer.from(email + ':' + token).toString('base64');
  var urlObj = new URL(jiraUrl + '/rest/api/3/search/jql?jql=assignee=currentUser()&maxResults=20&fields=summary,description,status,assignee');

  var options = {
    hostname: urlObj.hostname,
    path: urlObj.pathname + urlObj.search,
    method: 'GET',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Accept': 'application/json'
    }
  };

  var request = https.request(options, function(response) {
    var body = '';
    response.on('data', function(chunk) { body += chunk; });
    response.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (!data.issues) {
          return res.status(500).json({ error: 'No issues found', raw: data });
        }
        var tickets = data.issues.map(function(issue) {
            var desc = 'No description';
            var title = 'No title';
            try {
              title = issue.fields && issue.fields.summary ? issue.fields.summary : 'No title';
            } catch(e) {}
            try {
              desc = issue.fields.description.content[0].content[0].text;
            } catch(e) {}
            return {
              id: issue.key,
              title: title,
              description: desc
            };
          });
        res.json({ tickets: tickets });
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  request.on('error', function(e) {
    res.status(500).json({ error: e.message });
  });

  request.end();
});

var PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('Jira proxy running on port ' + PORT);
});