const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'depth_debug.log');
fs.writeFileSync(LOG_FILE, '');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      fs.appendFileSync(LOG_FILE, body + '\n');
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(3099, () => console.log('Log server on :3099, writing to', LOG_FILE));
