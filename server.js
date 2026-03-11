const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// Get all tickets
app.get('/tickets', async function(req, res) {
  var jiraUrl = req.query.jiraUrl;
  var email = req.query.email;
  var token = req.query.token;

  if (!jiraUrl || !email || !token) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    var response = await fetch(jiraUrl + '/rest/api/3/search?jql=assignee=currentUser()&maxResults=20', {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(email + ':' + token).toString('base64'),
        'Accept': 'application/json'
      }
    });

    var data = await response.json();

    var tickets = data.issues.map(function(issue) {
      var desc = '';
      try {
        desc = issue.fields.description.content[0].content[0].text;
      } catch(e) {
        desc = 'No description';
      }
      return {
        id: issue.key,
        title: issue.fields.summary,
        description: desc
      };
    });

    res.json({ tickets: tickets });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, function() {
  console.log('Jira proxy running on port 3000');
});