'use strict';
// True when running inside Cloudflare Workers / Durable Objects (and false under plain Node).
exports.isCF = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
