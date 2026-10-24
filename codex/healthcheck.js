'use strict';
const http = require('http');
const req = http.get({hostname: '127.0.0.1', port: Number(process.env.PORT || 8765), path: '/healthz', timeout: 4000}, res => {
  res.resume(); process.exitCode = res.statusCode === 200 ? 0 : 1;
});
req.on('timeout', () => req.destroy(new Error('Health check timed out')));
req.on('error', () => { process.exitCode = 1; });
