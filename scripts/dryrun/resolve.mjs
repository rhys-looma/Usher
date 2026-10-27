// For processes on this machine in the dry run: the deployment's host names resolve to the local
// stand-in load balancer, and Chromium is told the same and to accept its certificate. Loaded with
// node --import, with USHER_DRYRUN_HOSTS=registry.example,quote.example.

import dns from 'node:dns';
import { createRequire } from 'node:module';

const hosts = new Set((process.env.USHER_DRYRUN_HOSTS ?? '').split(',').filter(Boolean));
const original = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  if (!hosts.has(hostname)) return original.call(dns, hostname, options, callback);
  const cb = typeof options === 'function' ? options : callback;
  const all = typeof options === 'object' && options?.all;
  process.nextTick(() => (all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)));
};

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launch = chromium.launch.bind(chromium);
chromium.launch = (options = {}) =>
  launch({ ...options, args: [...(options.args ?? []), `--host-resolver-rules=${[...hosts].map((h) => `MAP ${h} 127.0.0.1`).join(',')}`, '--ignore-certificate-errors'] });
