// Shared between the shell process and the preferences window: no Shell imports here.

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Turns what the user typed (a full URL or a bare domain) into a domain name.
 *
 * @param {string} text - e.g. "https://www.example.com/path?q=1"
 * @returns {string|null} e.g. "www.example.com", or null if not valid
 */
export function normalizeSite(text) {
    let s = text.trim().toLowerCase();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
    s = s.replace(/[/?#].*$/, '');                // path, query, fragment
    s = s.replace(/^[^@]*@/, '');                 // user info
    s = s.replace(/:\d+$/, '');                   // port
    s = s.replace(/\.$/, '');
    return HOSTNAME_RE.test(s) ? s : null;
}
