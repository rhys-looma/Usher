// Stands in for the AWS load balancer in the dry run: ends TLS for both hosts with one certificate,
// routes by Host header, keeps Host, and adds X-Forwarded-For, -Proto and -Port the way an ALB does.
//
//   ROUTES=registry.example=registry:4200,quote.example=site:4100 CERT=… KEY=… node proxy.mjs

import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';

const routes = new Map((process.env.ROUTES ?? '').split(',').filter(Boolean).map((r) => r.split('=')));
const server = createServer({ cert: readFileSync(process.env.CERT), key: readFileSync(process.env.KEY) }, (req, res) => {
  const host = (req.headers.host ?? '').replace(/:443$/, '');
  const upstream = routes.get(host);
  if (!upstream) return void res.writeHead(404).end('no route for this host\n');
  const [hostname, port] = upstream.split(':');
  const forwardedFor = [req.headers['x-forwarded-for'], req.socket.remoteAddress?.replace(/^::ffff:/, '')].filter(Boolean).join(', ');
  const out = request({ hostname, port: Number(port), method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': forwardedFor, 'x-forwarded-proto': 'https', 'x-forwarded-port': '443' } }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  out.on('error', () => res.headersSent ? res.end() : res.writeHead(502).end('upstream unavailable\n'));
  req.pipe(out);
});
server.listen(443, () => console.log(`proxy on 443 for ${[...routes.keys()].join(', ')}`));
