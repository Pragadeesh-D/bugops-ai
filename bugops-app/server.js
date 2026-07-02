var http = require('http');
var fs = require('fs');
var path = require('path');

var MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon'
};

var port = process.env.PORT || 3000;
http.createServer(function(req, res) {
  var url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  var filePath = path.join(__dirname, url);

  fs.readFile(filePath, function(err, data) {
    if (err) {
      console.log('HTTP 404:', url);
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    console.log('HTTP 200:', url, '(' + data.length + ' bytes)');
    res.end(data);
  });
}).listen(port, function() {
  console.log('BugOps AI server running at http://localhost:' + port);
});
