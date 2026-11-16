/* Shared HTTP URL allowlist for the app and its JavaScript worker runtime. */
(function (root, factory) {
  const isAllowedHttpUrl = factory();
  if (typeof module === 'object' && module.exports) module.exports = { isAllowedHttpUrl };
  else root.UrlPolicy = { isAllowedHttpUrl };
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return function isAllowedHttpUrl(value) {
    try {
      const u = value instanceof URL ? value : new URL(String(value));
      if (u.protocol === 'https:') return true;
      if (u.protocol !== 'http:') return false;
      const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
      if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true;
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
        const octets = host.split('.').map(Number);
        if (octets.some((n) => n > 255)) return false;
        return octets[0] === 10 || octets[0] === 127 ||
          (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
          (octets[0] === 192 && octets[1] === 168) ||
          (octets[0] === 169 && octets[1] === 254);
      }
      return false;
    } catch (e) { return false; }
  };
});
