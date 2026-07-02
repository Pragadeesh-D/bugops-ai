var http = require('http');
var fs = require('fs');
var path = require('path');
var mime = { html:'text/html', js:'text/javascript', css:'text/css', svg:'image/svg+xml', png:'image/png' };
var root = path.join(__dirname, 'bugops-app');
http.createServer(function(req,res){
  var u = req.url === '/' ? '/index.html' : req.url;
  var fp = path.join(root, u);
  var ext = path.extname(fp).slice(1);
  fs.readFile(fp, function(err, data){
    if (err) { res.writeHead(404, {'Content-Type':'text/html'}); res.end('Not found: ' + u); return; }
    res.writeHead(200, {'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control':'no-cache'});
    res.end(data);
  });
}).listen(3333, function(){ console.log('http://localhost:3333'); });
