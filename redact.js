// claude-mcp-server/redact.js
// @ai-rules: [Pattern]: Single-source redaction (REDACT_SED + O(n) JS redact()), quote, readNbFlag, and stall-bounded flushStderr. [Constraint]: Node built-ins only, <= 100 lines.
import { readFileSync, openSync, writeSync, closeSync, fstatSync, constants } from 'node:fs';
import { Socket } from 'node:net';

export const quote = (s) => (typeof s !== 'string' ? "''" : "'" + s.replace(/'/g, "'\\''") + "'");
const SQ = "((\\\\?\"[^\"]*(\\\\?\"|$))|('[^']*('|$))|";
export const REDACT_SED = 'sed -E -u ' + [
  "s/[[:space:]]*-----BEGIN[^\\r\\n]*-----END[^\\r\\n]*/[REDACTED_PEM]/g; /-----BEGIN/,/-----END/{ " +
    "/-----BEGIN/s/.*/[REDACTED_PEM]/; /-----END/d; /^[[:space:]]*[A-Za-z0-9+\\/=]+[[:space:]]*$/d; /[Bb]ase64/d; }",
  "s/((\\\\?['\"])?\\b(proxy-)?authorization(\\\\?['\"])?[ \\t]*:[ \\t]*(([a-zA-Z0-9_-]+)[ \\t]+)?|\\b(bearer|token)[ \\t]+)" + SQ + "[^[:space:]\"'&]+)/\\1[REDACTED]/gI",
  "s/(\\bresponse[[:space:]]*=[[:space:]]*)" + SQ + "[^[:space:]\"',&]+)/\\1[REDACTED]/gI",
  "s/((\\\\?['\"])?\\b[a-zA-Z0-9_-]{0,128}(key|token|secret|password|credentials|private_key_id)(\\\\?['\"])?[[:space:]]*[=:][[:space:]]*)" + SQ + "[^[:space:]\"'&]+)/\\1[REDACTED]/gI",
  "s/(sk-ant-[a-zA-Z0-9_-]{4}|sk-proj-[a-zA-Z0-9_-]{4}|ya29\\.[a-zA-Z0-9_-]{4}|gh[pousr]_[a-zA-Z0-9]{4}|github_pat_[a-zA-Z0-9_]{4}|glpat-[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/\\1[REDACTED]/g",
  "s/(--api[_-]?key([[:space:]]+|=)|[?&](key|api[_-]?key|token)=)[^[:space:]\"'&]+/\\1[REDACTED]/gI; s/(https?:\\/\\/[^[:space:]\\/@:]+):[^[:space:]\\/@]+@/\\1:[REDACTED]@/g",
  "s/ey[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_.-]{10,}/[REDACTED_JWT]/g",
  "s/((\\\\?[\"'])?[Cc]ookie(\\\\?[\"'])?[[:space:]]*[:=][[:space:]]*)" + SQ + "[^[:space:]\\r\\n\"'}]+)/\\1[REDACTED]/gI; s/([Cc]ookie:[[:space:]]*)[^\\r\\n]+/\\1[REDACTED]/gI",
].map((e) => '-e ' + quote(e)).join(' ');

export const asStr = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
export const isPemBodyLine = (line) => /^[ \t]*[A-Za-z0-9+/=]+[ \t]*$|[Bb]ase64/.test(line);
const QV = "(?:\\\\?\"[^\"\\r\\n]*(?:\\\\?\"|(?=\\r|\\n|$))|'[^'\\r\\n]*(?:'|(?=\\r|\\n|$))|";
const RE_PEM1 = /(?:^|(?<=\r|\n))[ \t]*-----BEGIN[^\r\n]*-----END[^\r\n]*/g;
const RE_PEM2 = /(?:^|(?<=\r|\n))[ \t]*-----BEGIN[^\r\n]*(?:\r?\n(?:[ \t]*[A-Za-z0-9+/=]+[ \t]*(?=\r|\n|$)|[^\r\n]*[Bb]ase64[^\r\n]*))*(?:\r?\n[ \t]*-----END[^\r\n]*)?/g;
const RE_AUTH = new RegExp(`((?:\\\\?['"])?\\b(?:proxy-)?authorization(?:\\\\?['"])?[ \\t]*:[ \\t]*(?:[a-zA-Z0-9_-]+[ \\t]+)?|\\b(?:bearer|token)[ \\t]+)${QV}[^\\s"'&]+)`, 'gi');
const RE_KEY = new RegExp(`((?:\\\\?['"])?\\b[a-zA-Z0-9_-]{0,128}(?:key|token|secret|password|credentials|private_key_id)(?:\\\\?['"])?[ \\t]*[=:][ \\t]*)${QV}[^\\s"'&]+)`, 'gi');
const RE_TOK = /(sk-ant-[a-zA-Z0-9_-]{4}|sk-proj-[a-zA-Z0-9_-]{4}|ya29\.[a-zA-Z0-9_-]{4}|gh[pousr]_[a-zA-Z0-9]{4}|github_pat_[a-zA-Z0-9_]{4}|glpat-[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/g;
const RE_JWT = /ey[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_.-]{10,}/g;
const RE_URL = /(--api[_-]?key(?:[ \t]+|=)|[?&](?:key|api[_-]?key|token)=)[^\s"'&]+/gi;
const RE_BAUTH = /(https?:\/\/[^\s/@:]+):[^\s/@]+@/g;
const RE_COOKIE = new RegExp(`((?:\\\\?['"])?cookie(?:\\\\?['"])?[ \\t]*[:=][ \\t]*)${QV}[^\\s\\r\\n"'}]+)`, 'gi');
const RE_RESP = new RegExp(`(\\bresponse[ \\t]*=[ \\t]*)${QV}[^\\s"',&]+)`, 'gi');
const RE_CTRL = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[\r\n\x00-\x1f\x7f]+/g;

export function redact(v) {
  let s = asStr(v);
  if (s.includes('-----BEGIN')) s = s.replace(RE_PEM1, '[REDACTED_PEM]').replace(RE_PEM2, '[REDACTED_PEM]');
  return s.replace(RE_AUTH, '$1[REDACTED]').replace(RE_KEY, '$1[REDACTED]').replace(RE_TOK, '$1[REDACTED]')
    .replace(RE_JWT, '[REDACTED_JWT]').replace(RE_URL, '$1[REDACTED]').replace(RE_BAUTH, '$1:[REDACTED]@')
    .replace(RE_COOKIE, '$1[REDACTED]').replace(/(cookie:[ \t]*)[^\r\n]+/gi, '$1[REDACTED]').replace(RE_RESP, '$1[REDACTED]').replace(RE_CTRL, ' ');
}

export function readNbFlag(fd) {
  try {
    const m = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').match(/flags:\s*([0-7]+)/);
    return m ? (Number.parseInt(m[1], 8) & 0o4000) !== 0 : false;
  } catch { return false; }
}

export function flushStderr() {
  const data = readFileSync(0);
  if (!data.length) return;
  let st; try { st = fstatSync(2); } catch { return; }
  if (st.isFIFO()) {
    try {
      const fd = openSync('/proc/self/fd/2', constants.O_WRONLY | constants.O_NONBLOCK), waitBuf = new Int32Array(new SharedArrayBuffer(4));
      for (let off = 0, idle = 0; off < data.length;) {
        try { const n = writeSync(fd, data, off, Math.min(65536, data.length - off)); if (n > 0) { off += n; idle = 0; continue; } }
        catch (e) { if (e?.code !== 'EAGAIN') break; }
        if (++idle > 25) break;
        Atomics.wait(waitBuf, 0, 0, 10);
      }
      try { closeSync(fd); } catch {} return;
    } catch (e) { if (e?.code !== 'ENOENT') return; }
  }
  if (st.isSocket() || st.isFIFO()) {
    const wasNb = readNbFlag(2), s = new Socket({ fd: 2, readable: false, writable: true }); s.unref();
    const restore = () => { if (!wasNb) s?._handle?.setBlocking?.(true); };
    let off = 0, timer = null;
    const done = () => { if (timer) clearTimeout(timer); timer = null; restore(); process.exit(0); };
    const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(done, 250); };
    process.on('exit', restore); s.on('error', done);
    const pump = () => {
      arm();
      while (off < data.length) {
        const end = Math.min(data.length, off + 65536), ok = s.write(data.subarray(off, end));
        off = end; if (!ok) { s.once('drain', pump); return; }
      }
      if (s.writableLength > 0) { arm(); s.once('drain', done); } else done();
    };
    pump(); return;
  }
  for (let off = 0; off < data.length;) { try { const n = writeSync(2, data, off, data.length - off); if (n <= 0) break; off += n; } catch { break; } }
}
