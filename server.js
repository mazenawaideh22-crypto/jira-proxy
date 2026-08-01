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

app.use(express.json({ limit: '50mb' }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'Accept'] }));
app.options('*', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
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
const ADMIN_KEY            = process.env.ADMIN_KEY || 'dev-key-123';

// ─── IN-MEMORY STORES ────────────────────────────────────────────────────────
var pendingCodes  = {};
var pendingStates = {};

// ─── PERSISTED STORE: SUPPORT TICKETS ────────────────────────────────────────
// These used to live only in a RAM array, so every redeploy (new Node process)
// wiped all tickets. We now load them from disk on boot and save after every
// write, so a deploy no longer destroys user data.
//
// IMPORTANT: this only survives redeploys if DATA_DIR points at a persistent
// disk/volume. On platforms with an ephemeral filesystem (e.g. Railway without
// a Volume attached), the file itself gets wiped on deploy just like RAM did.
// In Railway: Project → Service → Settings → Volumes → add a volume mounted at
// the path you set DATA_DIR to (e.g. /data), then set env var DATA_DIR=/data.
// For a more robust/scalable long-term fix, migrate this to a real database
// (Railway Postgres, etc.) instead of a JSON file.
const fs = require('fs');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');

function loadTickets() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(TICKETS_FILE)) {
      var raw = fs.readFileSync(TICKETS_FILE, 'utf8');
      var parsed = JSON.parse(raw);
      return {
        tickets: Array.isArray(parsed.tickets) ? parsed.tickets : [],
        nextId: parsed.nextId || 1
      };
    }
  } catch (e) {
    console.error('[TICKETS] Failed to load tickets.json, starting empty:', e.message);
  }
  return { tickets: [], nextId: 1 };
}

var _loaded = loadTickets();
var supportTickets = _loaded.tickets;
var ticketIdCounter = _loaded.nextId;

function saveTickets() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TICKETS_FILE, JSON.stringify({ tickets: supportTickets, nextId: ticketIdCounter }, null, 2));
  } catch (e) {
    console.error('[TICKETS] Failed to save tickets.json:', e.message);
  }
}

console.log('[TICKETS] Loaded ' + supportTickets.length + ' ticket(s) from ' + TICKETS_FILE);

setInterval(function() {
  var now = Date.now();
  Object.keys(pendingCodes).forEach(function(c)  { if (pendingCodes[c].expiresAt < now) delete pendingCodes[c]; });
  Object.keys(pendingStates).forEach(function(s) { if (now - pendingStates[s].createdAt > 10 * 60 * 1000) delete pendingStates[s]; });
}, 60000);

// ─── SUPPORT TICKETS ──────────────────────────────────────────────────────────
app.post('/api/support/tickets', express.json(), function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var { subject, message, email, userId, priority, attachments } = req.body;
  if (!subject || !message) {
    return res.status(400).json({ error: 'Subject and message are required' });
  }
  
  var ticket = {
    id: ticketIdCounter++,
    subject: subject.substring(0, 200),
    message: message.substring(0, 5000),
    email: email || 'anonymous',
    userId: userId || 'anonymous',
    priority: priority || 'medium',
    status: 'new',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    replies: [],
    attachments: attachments || []
  };
  
  supportTickets.push(ticket);
  saveTickets();
  console.log('[SUPPORT] New ticket #' + ticket.id + ' from userId: ' + ticket.userId + ' priority: ' + ticket.priority + ' attachments: ' + (attachments ? attachments.length : 0));
  
  res.json({ success: true, ticketId: ticket.id });
});

app.get('/api/support/tickets', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var userId = req.query.userId || 'anonymous';
  var userTickets = supportTickets.filter(function(t) { 
    return t.userId === userId || t.email === userId;
  });
  res.json({ tickets: userTickets });
});

app.post('/api/support/tickets/:id/reply', express.json(), function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var ticketId = parseInt(req.params.id);
  var { message, isAdmin } = req.body;
  
  var ticket = supportTickets.find(function(t) { return t.id === ticketId; });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  
  ticket.replies.push({
    message: message,
    isAdmin: isAdmin || false,
    createdAt: new Date().toISOString()
  });
  ticket.updatedAt = new Date().toISOString();
  if (isAdmin) ticket.status = 'in_progress';
  saveTickets();
  
  res.json({ success: true });
});

app.delete('/api/support/tickets/:id', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var ticketId = parseInt(req.params.id);
  var index = supportTickets.findIndex(function(t) { return t.id === ticketId; });
  if (index === -1) return res.status(404).json({ error: 'Ticket not found' });
  supportTickets.splice(index, 1);
  saveTickets();
  res.json({ success: true });
});

// ─── DEVELOPER TICKET DASHBOARD ──────────────────────────────────────────────
app.get('/admin/tickets', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  
  var adminKey = req.query.key;
  
  if (adminKey !== ADMIN_KEY) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Admin Access</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #0a0a0f; color: #f0f0f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .card { background: #111118; border: 1px solid rgba(255,255,255,0.07); border-radius: 24px; padding: 40px; max-width: 400px; width: 90%; }
        input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: #1a1a24; color: #f0f0f5; font-size: 14px; margin-bottom: 12px; box-sizing: border-box; }
        button { width: 100%; padding: 12px; background: #18D4A7; border: none; border-radius: 8px; color: #07101F; font-weight: 700; font-size: 14px; cursor: pointer; }
        h1 { color: #18D4A7; margin-bottom: 8px; }
        .sub { color: #6b6b80; font-size: 14px; margin-bottom: 24px; }
      </style>
      </head>
      <body>
        <div class="card">
          <h1>🔐 Admin Access</h1>
          <p class="sub">Enter the admin key to view support tickets</p>
          <input type="password" id="adminKeyInput" placeholder="Enter admin key..." onkeydown="if(event.key==='Enter')submitKey()"/>
          <button onclick="submitKey()">Access Dashboard</button>
          <script>
            function submitKey() {
              var key = document.getElementById('adminKeyInput').value.trim();
              if (key) window.location.href = '/admin/tickets?key=' + encodeURIComponent(key);
            }
          </script>
        </div>
      </body>
      </html>
    `);
  }
  
  var html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>Support Ticket Dashboard</title>
    <meta charset="UTF-8">
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0f; color: #f0f0f5; padding: 20px; }
      .container { max-width: 1200px; margin: 0 auto; }
      .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.07); }
      .header h1 { font-size: 24px; color: #18D4A7; }
      .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
      .stat-card { background: #111118; border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 16px 24px; flex: 1; min-width: 120px; }
      .stat-number { font-size: 28px; font-weight: 700; color: #18D4A7; }
      .stat-label { font-size: 12px; color: #6b6b80; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.08em; }
      .filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
      .filter-btn { padding: 6px 16px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: #6b6b80; cursor: pointer; font-size: 12px; transition: all 0.2s; }
      .filter-btn:hover { border-color: #18D4A7; color: #18D4A7; }
      .filter-btn.active { background: #18D4A7; color: #07101F; border-color: #18D4A7; }
      .ticket-list { display: flex; flex-direction: column; gap: 12px; }
      .ticket { background: #111118; border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 16px 20px; transition: border-color 0.2s; }
      .ticket:hover { border-color: rgba(24,212,167,0.3); }
      .ticket-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; flex-wrap: wrap; gap: 8px; }
      .ticket-id { font-weight: 700; color: #18D4A7; font-size: 14px; }
      .ticket-subject { font-weight: 600; color: #f0f0f5; font-size: 15px; flex: 1; }
      .ticket-status { padding: 4px 12px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
      .status-new { background: rgba(38,132,255,0.2); color: #5badff; }
      .status-in_progress { background: rgba(255,193,7,0.2); color: #ffc107; }
      .status-resolved { background: rgba(24,212,167,0.2); color: #18D4A7; }
      .status-closed { background: rgba(107,107,128,0.2); color: #6b6b80; }
      .ticket-meta { font-size: 12px; color: #6b6b80; margin-bottom: 8px; display: flex; gap: 16px; flex-wrap: wrap; }
      .ticket-message { color: #a0a0b0; font-size: 13px; line-height: 1.6; margin-bottom: 12px; padding: 8px 12px; background: rgba(255,255,255,0.03); border-radius: 8px; }
      .ticket-attachments { margin-top: 6px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px; }
      .ticket-attachments details { cursor: pointer; }
      .ticket-attachments summary { font-size: 10px; color: #6b6b80; font-weight: 600; }
      .ticket-attachments summary:hover { color: #18D4A7; }
      .ticket-attachments .attach-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px; font-size: 10px; color: #6b6b80; border-bottom: 1px solid rgba(255,255,255,0.03); }
      .ticket-attachments .attach-item:last-child { border-bottom: none; }
      .ticket-attachments .attach-item:hover { background: rgba(255,255,255,0.02); }
      .ticket-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
      .ticket-actions button { padding: 6px 14px; border-radius: 6px; border: none; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s; font-family: -apple-system, sans-serif; }
      .btn-reply { background: rgba(24,212,167,0.15); color: #18D4A7; border: 1px solid rgba(24,212,167,0.2); }
      .btn-reply:hover { background: rgba(24,212,167,0.25); }
      .btn-resolve { background: rgba(24,212,167,0.2); color: #18D4A7; }
      .btn-resolve:hover { background: rgba(24,212,167,0.3); }
      .btn-close { background: rgba(107,107,128,0.2); color: #6b6b80; }
      .btn-close:hover { background: rgba(107,107,128,0.3); }
      .btn-delete { background: rgba(255,77,106,0.15); color: #ff7a90; }
      .btn-delete:hover { background: rgba(255,77,106,0.25); }
      .btn-preview { padding: 2px 10px; border-radius: 4px; border: 1px solid #18D4A7; background: transparent; color: #18D4A7; font-size: 9px; cursor: pointer; font-family: -apple-system, sans-serif; }
      .btn-preview:hover { background: rgba(24,212,167,0.15); }
      .reply-area { display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.07); }
      .reply-area.open { display: block; }
      .reply-area textarea { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: #1a1a24; color: #f0f0f5; font-size: 13px; resize: vertical; min-height: 60px; font-family: -apple-system, sans-serif; margin-bottom: 8px; box-sizing: border-box; }
      .reply-area textarea:focus { outline: none; border-color: #18D4A7; }
      .reply-area .reply-actions { display: flex; gap: 8px; }
      .reply-area .reply-actions button { padding: 6px 16px; border-radius: 6px; border: none; font-size: 12px; font-weight: 600; cursor: pointer; }
      .btn-send-reply { background: #18D4A7; color: #07101F; }
      .btn-send-reply:hover { opacity: 0.85; }
      .btn-cancel-reply { background: transparent; color: #6b6b80; border: 1px solid rgba(255,255,255,0.1); }
      .btn-cancel-reply:hover { background: rgba(255,255,255,0.05); }
      .replies { margin-top: 8px; padding: 8px 12px; background: rgba(255,255,255,0.02); border-radius: 8px; }
      .reply { font-size: 12px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
      .reply:last-child { border-bottom: none; }
      .reply-admin { color: #18D4A7; }
      .reply-user { color: #5badff; }
      .reply-meta { font-size: 10px; color: #6b6b80; margin-left: 8px; }
      .empty-state { text-align: center; padding: 60px 20px; color: #6b6b80; }
      .refresh-btn { padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: #6b6b80; cursor: pointer; font-size: 12px; transition: all 0.2s; }
      .refresh-btn:hover { border-color: #18D4A7; color: #18D4A7; }
      .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
      .dot-new { background: #5badff; }
      .dot-in_progress { background: #ffc107; }
      .dot-resolved { background: #18D4A7; }
      .dot-closed { background: #6b6b80; }
      .priority-badge { padding: 2px 8px; border-radius: 4px; font-size: 9px; font-weight: 600; }
      .priority-critical { background: rgba(255,77,106,0.2); color: #ff4d6a; }
      .priority-high { background: rgba(255,122,144,0.2); color: #ff7a90; }
      .priority-medium { background: rgba(255,193,7,0.2); color: #ffc107; }
      .priority-low { background: rgba(24,212,167,0.2); color: #18D4A7; }
      .logout-link { color: #6b6b80; text-decoration: none; font-size: 12px; }
      .logout-link:hover { color: #f0f0f5; }
      @media (max-width: 768px) {
        .ticket-header { flex-direction: column; align-items: flex-start; }
        .stats { flex-direction: column; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>🎫 Support Tickets</h1>
       
      </div>
      
      <div class="stats" id="stats">
        <div class="stat-card"><div class="stat-number" id="stat-total">0</div><div class="stat-label">Total</div></div>
        <div class="stat-card"><div class="stat-number" id="stat-new">0</div><div class="stat-label">New</div></div>
        <div class="stat-card"><div class="stat-number" id="stat-in-progress">0</div><div class="stat-label">In Progress</div></div>
        <div class="stat-card"><div class="stat-number" id="stat-resolved">0</div><div class="stat-label">Resolved</div></div>
        <div class="stat-card"><div class="stat-number" id="stat-closed">0</div><div class="stat-label">Closed</div></div>
      </div>
      
      <div class="filters">
        <button class="filter-btn active" data-filter="all" onclick="filterTickets('all',this)">All</button>
        <button class="filter-btn" data-filter="new" onclick="filterTickets('new',this)">New</button>
        <button class="filter-btn" data-filter="in_progress" onclick="filterTickets('in_progress',this)">In Progress</button>
        <button class="filter-btn" data-filter="resolved" onclick="filterTickets('resolved',this)">Resolved</button>
        <button class="filter-btn" data-filter="closed" onclick="filterTickets('closed',this)">Closed</button>
      </div>
      
      <div class="ticket-list" id="ticketList">
        <div class="empty-state">Loading tickets...</div>
      </div>
    </div>
    
    <script>
      var allTickets = [];
      var currentFilter = 'all';
      
      function escapeHtml(text) {
        if (!text) return '';
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
      
      function viewAttachment(ticketId, attachIdx) {
        var ticket = allTickets.find(function(t) { return t.id === ticketId; });
        if (!ticket || !ticket.attachments || !ticket.attachments[attachIdx]) {
          alert('Attachment not found.');
          return;
        }
        var att = ticket.attachments[attachIdx];
        if (!att.data) {
          alert('No data available for this attachment.');
          return;
        }
        
        var win = window.open('', '_blank');
        if (!win) {
          alert('Please allow popups to view attachments.');
          return;
        }
        
        var isImage = att.type && att.type.startsWith('image/');
        var isPDF = att.type && att.type === 'application/pdf';
        
        win.document.write('<html><head><title>' + escapeHtml(att.name) + '</title>');
        win.document.write('<style>');
        win.document.write('body { margin:0; display:flex; align-items:center; justify-content:center; min-height:100vh; background:#0a0a0f; font-family:-apple-system,sans-serif; }');
        win.document.write('img { max-width:100%; max-height:100vh; object-fit:contain; }');
        win.document.write('.file-info { color:#f0f0f5; padding:20px; text-align:center; max-width:600px; }');
        win.document.write('.file-info .icon { font-size:64px; margin-bottom:16px; }');
        win.document.write('.file-info .name { font-size:18px; font-weight:600; margin-bottom:8px; word-break:break-all; }');
        win.document.write('.file-info .size { font-size:14px; color:#6b6b80; }');
        win.document.write('.file-info .type { font-size:12px; color:#6b6b80; margin-top:8px; }');
        win.document.write('.file-info .actions { margin-top:16px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }');
        win.document.write('.file-info .actions a, .file-info .actions button { display:inline-block; padding:10px 24px; background:#18D4A7; color:#07101F; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; text-decoration:none; }');
        win.document.write('.file-info .actions a:hover, .file-info .actions button:hover { opacity:0.85; }');
        win.document.write('.file-info .actions .secondary { background:transparent; color:#18D4A7; border:1px solid #18D4A7; }');
        win.document.write('</style>');
        win.document.write('</head><body>');
        
        if (isImage) {
          win.document.write('<img src="data:' + att.type + ';base64,' + att.data + '" alt="' + escapeHtml(att.name) + '" />');
        } else if (isPDF) {
          win.document.write('<div class="file-info">');
          win.document.write('<div class="icon">📄</div>');
          win.document.write('<div class="name">' + escapeHtml(att.name) + '</div>');
          win.document.write('<div class="size">' + Math.round(att.size/1024) + ' KB</div>');
          win.document.write('<div class="type">PDF Document</div>');
          win.document.write('<div class="actions">');
          win.document.write('<a href="data:application/pdf;base64,' + att.data + '" download="' + escapeHtml(att.name) + '">⬇ Download PDF</a>');
          win.document.write('</div>');
          win.document.write('</div>');
        } else {
          var fileTypeLabel = att.type || 'Unknown type';
          win.document.write('<div class="file-info">');
          win.document.write('<div class="icon">📄</div>');
          win.document.write('<div class="name">' + escapeHtml(att.name) + '</div>');
          win.document.write('<div class="size">' + Math.round(att.size/1024) + ' KB</div>');
          win.document.write('<div class="type">' + escapeHtml(fileTypeLabel) + '</div>');
          win.document.write('<div class="actions">');
          win.document.write('<a href="data:' + att.type + ';base64,' + att.data + '" download="' + escapeHtml(att.name) + '">⬇ Download File</a>');
          win.document.write('</div>');
          win.document.write('</div>');
        }
        
        win.document.write('</body></html>');
        win.document.close();
      }
      
      function fetchTickets() {
        fetch('/api/support/tickets')
          .then(r => r.json())
          .then(data => {
            allTickets = data.tickets || [];
            updateStats();
            renderTickets();
          })
          .catch(err => {
            document.getElementById('ticketList').innerHTML = '<div class="empty-state">❌ Failed to load tickets: ' + err.message + '</div>';
          });
      }
      
      function updateStats() {
        var stats = { total: 0, new: 0, in_progress: 0, resolved: 0, closed: 0 };
        allTickets.forEach(function(t) {
          stats.total++;
          if (stats[t.status] !== undefined) stats[t.status]++;
        });
        document.getElementById('stat-total').textContent = stats.total;
        document.getElementById('stat-new').textContent = stats['new'];
        document.getElementById('stat-in-progress').textContent = stats['in_progress'];
        document.getElementById('stat-resolved').textContent = stats['resolved'];
        document.getElementById('stat-closed').textContent = stats['closed'];
      }
      
      function renderTickets() {
        var list = document.getElementById('ticketList');
        var filtered = allTickets.filter(function(t) {
          return currentFilter === 'all' || t.status === currentFilter;
        });
        
        if (filtered.length === 0) {
          list.innerHTML = '<div class="empty-state">No tickets found.</div>';
          return;
        }
        
        var html = '';
        filtered.forEach(function(t) {
          var statusLabels = {
            'new': 'New',
            'in_progress': 'In Progress',
            'resolved': 'Resolved',
            'closed': 'Closed'
          };
          var statusClass = 'status-' + t.status;
          var dotClass = 'dot-' + t.status;
          
          var priorityLabels = {
            'critical': { label: '🔥 Critical', cls: 'priority-critical' },
            'high': { label: '🔴 Incident', cls: 'priority-high' },
            'medium': { label: '🟡 Medium', cls: 'priority-medium' },
            'low': { label: '🟢 General', cls: 'priority-low' }
          };
          var pr = priorityLabels[t.priority || 'low'] || priorityLabels['low'];
          
          html += '<div class="ticket" id="ticket-' + t.id + '">';
          html += '<div class="ticket-header">';
          html += '<span class="ticket-id">#' + t.id + '</span>';
          html += '<span class="ticket-subject">' + escapeHtml(t.subject) + '</span>';
          html += '<div style="display:flex;gap:4px;flex-wrap:wrap">';
          html += '<span class="priority-badge ' + pr.cls + '">' + pr.label + '</span>';
          html += '<span class="ticket-status ' + statusClass + '"><span class="status-dot ' + dotClass + '"></span>' + statusLabels[t.status] + '</span>';
          html += '</div>';
          html += '</div>';
          html += '<div class="ticket-meta">';
          html += '<span>📧 ' + escapeHtml(t.email || 'anonymous') + '</span>';
          html += '<span>🕐 ' + new Date(t.createdAt).toLocaleString() + '</span>';
          html += '<span>🔄 Updated: ' + new Date(t.updatedAt).toLocaleString() + '</span>';
          html += '<span>👤 ' + escapeHtml(t.userId || 'unknown') + '</span>';
          html += '</div>';
          html += '<div class="ticket-message">' + escapeHtml(t.message) + '</div>';
          
          // Attachments
          if (t.attachments && t.attachments.length > 0) {
            html += '<div class="ticket-attachments">';
            html += '<details>';
            html += '<summary>📎 Attachments (' + t.attachments.length + ')</summary>';
            html += '<div style="margin-top:4px;padding:4px 0">';
            t.attachments.forEach(function(a, idx) {
              var isImage = a.type && a.type.startsWith('image/');
              var isPDF = a.type && a.type === 'application/pdf';
              var icon = isImage ? '🖼️' : (isPDF ? '📑' : '📄');
              html += '<div class="attach-item">';
              html += '<span>' + icon + '</span>';
              html += '<span style="flex:1">' + escapeHtml(a.name) + '</span>';
              html += '<span style="font-size:8px;color:#6b6b80">' + Math.round(a.size/1024) + 'KB</span>';
              if (a.data) {
                html += '<button class="btn-preview" onclick="viewAttachment(' + t.id + ',' + idx + ')">';
                html += isImage ? '👁️ Preview' : '⬇ Download';
                html += '</button>';
              }
              html += '</div>';
            });
            html += '</div></details>';
            html += '</div>';
          }
          
          // Replies
          if (t.replies && t.replies.length > 0) {
            html += '<div class="replies">';
            t.replies.forEach(function(r) {
              var label = r.isAdmin ? '👨‍💻 Support' : '👤 User';
              var cls = r.isAdmin ? 'reply-admin' : 'reply-user';
              html += '<div class="reply ' + cls + '">';
              html += '<strong>' + label + ':</strong> ' + escapeHtml(r.message);
              html += '<span class="reply-meta">' + new Date(r.createdAt).toLocaleString() + '</span>';
              html += '</div>';
            });
            html += '</div>';
          }
          
          html += '<div class="ticket-actions">';
          html += '<button class="btn-reply" onclick="toggleReply(' + t.id + ')">💬 Reply</button>';
          if (t.status !== 'resolved') {
            html += '<button class="btn-resolve" onclick="updateStatus(' + t.id + ',\\'resolved\\')">✓ Resolve</button>';
          }
          if (t.status !== 'closed') {
            html += '<button class="btn-close" onclick="updateStatus(' + t.id + ',\\'closed\\')">✕ Close</button>';
          }
          if (t.status === 'new' || t.status === 'in_progress') {
            html += '<button class="btn-delete" onclick="deleteTicket(' + t.id + ')">🗑 Delete</button>';
          }
          html += '</div>';
          
          html += '<div class="reply-area" id="reply-area-' + t.id + '">';
          html += '<textarea id="reply-text-' + t.id + '" placeholder="Type your reply..."></textarea>';
          html += '<div class="reply-actions">';
          html += '<button class="btn-send-reply" onclick="sendReply(' + t.id + ')">Send Reply</button>';
          html += '<button class="btn-cancel-reply" onclick="toggleReply(' + t.id + ')">Cancel</button>';
          html += '</div>';
          html += '</div>';
          
          html += '</div>';
        });
        
        list.innerHTML = html;
      }
      
      function filterTickets(filter, btn) {
        currentFilter = filter;
        document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
        if (btn) btn.classList.add('active');
        renderTickets();
      }
      
      function toggleReply(id) {
        var area = document.getElementById('reply-area-' + id);
        if (area) {
          area.classList.toggle('open');
          if (area.classList.contains('open')) {
            document.getElementById('reply-text-' + id).focus();
          }
        }
      }
      
      function sendReply(id) {
        var text = document.getElementById('reply-text-' + id).value.trim();
        if (!text) { alert('Please enter a reply.'); return; }
        
        fetch('/api/support/tickets/' + id + '/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, isAdmin: true })
        })
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            document.getElementById('reply-text-' + id).value = '';
            document.getElementById('reply-area-' + id).classList.remove('open');
            fetchTickets();
          } else {
            alert('Failed to send reply: ' + (data.error || 'unknown error'));
          }
        })
        .catch(err => alert('Error: ' + err.message));
      }
      
      function updateStatus(id, status) {
        if (!confirm('Change ticket #' + id + ' status to "' + status + '"?')) return;
        
        fetch('/api/support/tickets/' + id + '/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            message: 'Status updated to: ' + status,
            isAdmin: true 
          })
        })
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            var ticket = allTickets.find(function(t) { return t.id === id; });
            if (ticket) ticket.status = status;
            renderTickets();
            updateStats();
          } else {
            alert('Failed to update status.');
          }
        })
        .catch(err => alert('Error: ' + err.message));
      }
      
      function deleteTicket(id) {
        if (!confirm('Delete ticket #' + id + '? This cannot be undone.')) return;
        
        fetch('/api/support/tickets/' + id, {
          method: 'DELETE'
        })
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            allTickets = allTickets.filter(function(t) { return t.id !== id; });
            renderTickets();
            updateStats();
          } else {
            alert('Failed to delete ticket.');
          }
        })
        .catch(err => alert('Error: ' + err.message));
      }
      
      // Auto-refresh every 30 seconds
      setInterval(fetchTickets, 30000);
      
      // Initial load
      fetchTickets();
    </script>
  </body>
  </html>
  `;
  
  res.send(html);
});

// Admin API endpoint to get all tickets (for the dashboard)
app.get('/api/admin/tickets', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var adminKey = req.query.key;
  
  if (adminKey !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({ tickets: supportTickets });
});

// ─── WHAT'S NEW ──────────────────────────────────────────────────────────────
app.get('/api/whats-new', function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.json({
    updates: [
      {
        version: '1.1.0',
        date: '2026-07-30',
        title: 'Support System & Bug Fixes',
        items: [
          'Added in-app support ticket system',
          'Fixed code validation error messages',
          'Fixed Apple Watch display issues',
          'Improved history view & reuse functionality',
          'Added What\'s New, Help & Support, and Privacy Policy pages',
          'Admin dashboard for managing support tickets',
          'Attachment preview and download in admin dashboard'
        ]
      },
      {
        version: '1.0.0',
        date: '2026-07-15',
        title: 'Initial Release',
        items: [
          'Jira and GitLab integration',
          'AI-powered design structure generation',
          'Figma plugin with real-time editing',
          'BYOK support for OpenAI, Anthropic, Gemini'
        ]
      }
    ]
  });
});

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
    try {
      var opts = Object.assign({}, options, {
        headers: Object.assign({ 'User-Agent': 'Structify-Proxy/1.0' }, options.headers || {})
      });
      var req = https.request(opts, function(res) {
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
    } catch(e) {
      reject(new Error('Request setup failed: ' + e.message));
    }
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
    '&response_type=code&scope=' + encodeURIComponent('api') + '&state=' + state;
  res.redirect(url);
});

app.get('/auth/gitlab/callback', async function(req, res) {
  var code = req.query.code, state = req.query.state;
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
    var tokenRes = await httpsRequest({ hostname: 'gitlab.com', path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (!tokenRes.data.access_token) return res.status(400).send('<h2>GitLab token error</h2>');
    var userRes = await httpsRequest({ hostname: 'gitlab.com', path: '/api/v4/user', method: 'GET', headers: { 'Authorization': 'Bearer ' + tokenRes.data.access_token, 'Accept': 'application/json' } });
  var pluginCode = generateCode({ provider: 'gitlab', accessToken: tokenRes.data.access_token, refreshToken: tokenRes.data.refresh_token, username: userRes.data.username, name: userRes.data.name, userId: userRes.data.id });
    res.send(successPage(pluginCode, 'GitLab'));
  } catch(e) { res.status(500).send('<h2>Error: ' + e.message + '</h2>'); }
});

// ─── AUTH TOKEN EXCHANGE ─────────────────────────────────────────────────────
app.get('/auth/token', rateLimiter(20), async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var code = req.query.code;
  
  if (!code) {
    return res.status(400).json({ 
      error: 'No code provided. Please enter the 6-digit code from your browser.' 
    });
  }
  
  if (!pendingCodes[code]) {
    return res.status(404).json({ 
      error: '❌ Invalid code. Please make sure you entered the correct 6-digit code from your browser window.' 
    });
  }
  
  if (Date.now() > pendingCodes[code].expiresAt) { 
    delete pendingCodes[code]; 
    return res.status(410).json({ 
      error: '⏰ Code expired. Please click "Open browser again" to get a new code.' 
    }); 
  }
  
  var data = pendingCodes[code];
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

// ─── GITLAB TOKEN REFRESH ────────────────────────────────────────────────────
app.post('/auth/gitlab/refresh', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var refreshToken = req.body.refreshToken;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  try {
    var body = 'client_id=' + encodeURIComponent(GITLAB_CLIENT_ID) +
      '&client_secret=' + encodeURIComponent(GITLAB_CLIENT_SECRET) +
      '&refresh_token=' + encodeURIComponent(refreshToken) +
      '&grant_type=refresh_token' +
      '&redirect_uri=' + encodeURIComponent(BASE_URL + '/auth/gitlab/callback');
    var tokenRes = await httpsRequest({ hostname: 'gitlab.com', path: '/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (!tokenRes.data.access_token) return res.status(401).json({ error: 'Refresh failed', detail: tokenRes.data });
    res.json({ accessToken: tokenRes.data.access_token, refreshToken: tokenRes.data.refresh_token || refreshToken });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SPACES ──────────────────────────────────────────────────────────────────
app.post('/spaces', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.body.accessToken, cloudId = req.body.cloudId, provider = req.body.provider || 'jira';
  if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
  
  try {
    if (provider === 'gitlab') {
      var userRes = await httpsRequest({ hostname: 'gitlab.com', path: '/api/v4/user', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
      
      if (userRes.status !== 200 || !userRes.data.id) {
         return res.status(userRes.status || 401).json({ error: 'Could not fetch GitLab user profile' });
      }
      
      var userId = userRes.data.id;
      
      var glRes = await httpsRequest({ hostname: 'gitlab.com', path: '/api/v4/users/' + userId + '/projects?simple=true&per_page=50', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
      
      return res.json({ spaces: (glRes.data || []).map(function(p) { return { id: String(p.id), name: p.name, webUrl: p.web_url || '' }; }) });
    }
    
    var jiraRes = await httpsRequest({ hostname: 'api.atlassian.com', path: '/ex/jira/' + cloudId + '/rest/api/3/project/search?maxResults=50', method: 'GET', headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } });
    res.json({ spaces: (jiraRes.data.values || []).map(function(p) { return { id: p.key, name: p.name }; }) });
  } catch(e) { console.error('[SPACES] Exception:', e.stack || e.message); res.status(500).json({ error: e.message }); }
});

// ─── TICKETS ─────────────────────────────────────────────────────────────────
app.post('/tickets', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  var accessToken = req.body.accessToken, cloudId = req.body.cloudId, provider = req.body.provider || 'jira';
  if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
  try {
    if (provider === 'gitlab') {
      var projectId = req.body.spaceId;
      console.log('[TICKETS] GitLab projectId:', projectId);
      
      if (!projectId) return res.status(400).json({ error: 'spaceId required for GitLab' });
      
      var glRes = await httpsRequest({ 
        hostname: 'gitlab.com', 
        path: '/api/v4/projects/' + encodeURIComponent(projectId) + '/issues?per_page=50', 
        method: 'GET', 
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } 
      });
      
      console.log('[TICKETS] GitLab response status:', glRes.status);
      
      if (glRes.status !== 200 || !Array.isArray(glRes.data)) {
        console.error('[TICKETS] GitLab error:', glRes.status, JSON.stringify(glRes.data).slice(0, 500));
        return res.status(glRes.status || 500).json({ error: 'GitLab error', detail: glRes.data });
      }
      
      var tickets = glRes.data.map(function(issue) {
        return {
          id: issue.iid,
          title: issue.title,
          description: issue.description || 'No description',
          status: issue.state,
          assignee: issue.assignee ? issue.assignee.name : 'Unassigned',
          reporter: issue.author ? issue.author.name : 'Unknown',
          created: issue.created_at ? new Date(issue.created_at).toLocaleDateString() : '',
          milestone: issue.milestone ? issue.milestone.title : 'None',
          labels: issue.labels ? issue.labels.join(', ') : '',
          dueDate: issue.due_date ? new Date(issue.due_date).toLocaleDateString() : '',
          weight: issue.weight || '-',
          issueType: issue.issue_type || 'issue'
        };
      });
      
      return res.json({ tickets: tickets });
    }
    
    var spaceId = req.body.spaceId;
    var jql = spaceId ? 'project%3D' + encodeURIComponent(spaceId) + '%20ORDER%20BY%20updated%20DESC' : 'assignee%3DcurrentUser()%20ORDER%20BY%20updated%20DESC';
    var jiraRes = await httpsRequest({ 
      hostname: 'api.atlassian.com', 
      path: '/ex/jira/' + cloudId + '/rest/api/3/search/jql?jql=' + jql + '&maxResults=30&fields=summary,description,status,priority,assignee,reporter,issuetype,created', 
      method: 'GET', 
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json' } 
    });
    
    if (!jiraRes.data.issues) return res.status(500).json({ error: 'No issues', raw: jiraRes.data });
    
    var tickets = jiraRes.data.issues.map(function(issue) {
      var desc = 'No description';
      try { 
        if (issue.fields.description && issue.fields.description.content) {
          desc = issue.fields.description.content[0].content[0].text; 
        }
      } catch(e) {}
      
      return { 
        id: issue.key, 
        title: issue.fields.summary, 
        description: desc, 
        priority: (issue.fields.priority && issue.fields.priority.name) || '',
        status: issue.fields.status ? issue.fields.status.name : '',
        assignee: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
        reporter: issue.fields.reporter ? issue.fields.reporter.displayName : 'Unknown',
        issueType: issue.fields.issuetype ? issue.fields.issuetype.name : '',
        created: issue.fields.created ? new Date(issue.fields.created).toLocaleDateString() : ''
      };
    });
    
    res.json({ tickets: tickets });
  } catch(e) { 
    console.error('[TICKETS] Exception:', e.stack || e.message); 
    res.status(500).json({ error: e.message }); 
  }
});

// ─── TEST CONNECTION ─────────────────────────────────────────────────────────
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

// ─── ANALYZE ─────────────────────────────────────────────────────────────────
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
  var userApiKey   = isEnterprise ? req.body.entKey   : req.body.byokKey   || '';
  var userProvider = isEnterprise ? 'enterprise'      : req.body.byokProvider || 'anthropic';
  var userModel    = req.body.byokModel || '';
  
  if (!userApiKey) return res.json({ text: 'Please add your API key in Settings.', intent: 'none', suggestion: '', target: '' });

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
  var userApiKey   = isEnterprise ? req.body.entKey   : req.body.byokKey   || '';
  var userProvider = isEnterprise ? 'enterprise'      : req.body.byokProvider || 'anthropic';
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

// ─── COMMENT ─────────────────────────────────────────────────────────────────
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
  console.log('Admin dashboard available at: ' + BASE_URL + '/admin/tickets?key=' + ADMIN_KEY);
});
