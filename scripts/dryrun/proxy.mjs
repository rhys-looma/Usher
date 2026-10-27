// Stands in for CloudFront and the ALB in the dry run: ends TLS for both hosts with one certificate,
// routes by Host header (unchanged, as CloudFront's AllViewer policy forwards it), and writes the
// forwarded headers the two would: CloudFront drops any CloudFront-* header the viewer sent, adds
// CloudFront-Forwarded-Proto: https and appends the viewer to X-Forwarded-For; the ALB, reached
// over http, appends CloudFront's address and sets X-Forwarded-Proto: http.
//
//   ROUTES=registry.example=registry:4200,quote.example=site:4100 CERT=… KEY=… node proxy.mjs

import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';

const EDGE = '130.176.0.1'; // a CloudFront edge address, as the ALB would see it
const routes = new Map((process.env.ROUTES ?? '').split(',').filter(Boolean).map((r) => r.split('=')));
const server = createServer({ cert: readFileSync(process.env.CERT), key: readFileSync(process.env.KEY) }, (req, res) => {
  const host = (req.headers.host ?? '').replace(/:443$/, '');
  const upstream = routes.get(host);
  if (!upstream) return void res.writeHead(404).end('no route for this host\n');
  const [hostname, port] = upstream.split(':');
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith('cloudfront-')));
  const viewer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], viewer, EDGE].filter(Boolean).join(', ');
  headers['cloudfront-forwarded-proto'] = 'https';
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-port'] = '80';
  const out = request({ hostname, port: Number(port), method: req.method, path: req.url, headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  out.on('error', () => (res.headersSent ? res.end() : res.writeHead(502).end('upstream unavailable\n')));
  req.pipe(out);
});
server.listen(443, () => console.log(`CloudFront + ALB stand-in on 443 for ${[...routes.keys()].join(', ')}`));
