#!/usr/bin/env node
// Patches OmniRoute after each build/install
// Run: node patch-omniroute.js
//
// Exit codes:
//   0  — all patches applied (or already applied)
//   1  — one or more patches failed; do NOT restart OmniRoute until resolved

const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Environment validation ────────────────────────────────────────────────────
const APPDATA =
  process.env.APPDATA ||
  (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Roaming") : null);

if (!APPDATA) {
  console.error("✗ This patch is Windows-only. APPDATA unset and platform=" + process.platform);
  process.exit(1);
}

const OMNIROUTE_DIR = path.join(APPDATA, "npm", "node_modules", "omniroute", "app");
const CHUNKS_DIR = path.join(OMNIROUTE_DIR, ".next", "server", "chunks");

if (!fs.existsSync(OMNIROUTE_DIR)) {
  console.error("✗ OmniRoute not found at " + OMNIROUTE_DIR);
  console.error("  Install first: npm i -g omniroute");
  process.exit(1);
}
if (!fs.existsSync(CHUNKS_DIR)) {
  console.error("✗ OmniRoute chunks dir missing: " + CHUNKS_DIR);
  console.error("  Build may have failed. Reinstall OmniRoute.");
  process.exit(1);
}

// ── Failure tracking + helpers ────────────────────────────────────────────────
let hadFailure = false;
function fail(msg) {
  console.error("✗ " + msg);
  hadFailure = true;
}
function ok(msg) {
  console.log("✓ " + msg);
}
function info(msg) {
  console.log("  " + msg);
}

function assertReplaced(before, after, label) {
  if (before === after) {
    fail(label + ": anchor not found — patch did not apply");
    return false;
  }
  return true;
}

function verifySentinel(fp, sentinel, label) {
  try {
    const after = fs.readFileSync(fp, "utf8");
    if (!after.includes(sentinel)) {
      fail(label + ': sentinel "' + sentinel + '" missing after write');
      return false;
    }
    return true;
  } catch (e) {
    fail(label + ": verification read failed — " + e.message);
    return false;
  }
}

function detectEol(txt) {
  return txt.includes("\r\n") ? "\r\n" : "\n";
}
function toEol(s, eol) {
  return eol === "\r\n" ? s.replace(/\r?\n/g, "\r\n") : s.replace(/\r\n/g, "\n");
}
function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Patch 1: chunk parse-phase — bypass request.json() when body pre-decoded ──
// server.js interceptor decompresses compressed POST bodies and stores the raw
// buffer in globalThis._preDecodedBodies keyed by an 'x-predecoded-id' header.
// This patch makes the bundled handleChat consult that map before calling
// request.json() (which fails with "Invalid JSON body" because undici cannot
// safely convert our reconstructed Node Readable into a Web ReadableStream).
function patchZstd() {
  const SENTINEL = "_predecoded_patched_v2";
  const FUNC_SIG_RE = /async function \w+\(\w+[,)]/;

  let files;
  try {
    files = fs.readdirSync(CHUNKS_DIR).filter((f) => f.endsWith(".js") && !f.endsWith(".map"));
  } catch (e) {
    fail("patchZstd: readdir failed — " + e.message);
    return;
  }

  for (const fn of files) {
    const fp = path.join(CHUNKS_DIR, fn);
    let txt;
    try {
      txt = fs.readFileSync(fp, "utf8").replace(/^\uFEFF/, "");
    } catch (e) {
      info("patchZstd: skip " + fn + " (" + e.message + ")");
      continue;
    }

    if (!txt.includes('startPhase("parse")') || !txt.includes("Invalid JSON body")) continue;

    // Detect stale-patched chunk: sentinel present but original function signature absent
    if (txt.includes(SENTINEL)) {
      if (FUNC_SIG_RE.test(txt)) {
        ok("patchZstd: already patched (" + fn + ")");
        return;
      }
      info("patchZstd: stale patched chunk " + fn + " — keep scanning");
      continue;
    }

    // Anchor to `async function NAME(firstParam, …)` so we capture the REAL
    // request parameter. Minifier emits `await a.json()` where `a` is a MODULE
    // IMPORT, not the request — so the var inside .json() is unreliable.
    const re =
      /async function \w+\((\w+)[,)][^]*?\{[^]*?try\{(\w+)\.startPhase\("parse"\),(\w+)=await \w+\.json\(\),\2\.endPhase\(\)\}catch\{return (\w+)\.warn\("CHAT","Invalid JSON body"\),\(0,(\w+\.\w+)\)\((\w+\.\w+)\.BAD_REQUEST,"Invalid JSON body"\)\}/;
    const m = txt.match(re);
    if (!m) {
      fail("patchZstd: pattern not found in " + fn + " (minifier output changed?)");
      return;
    }
    const [, reqParam, tracker, body, logger, errFn, statusObj] = m;

    const jsonExpr =
      `(async()=>{/*${SENTINEL}*/` +
      `const _id=${reqParam}.headers.get("x-predecoded-id");` +
      `if(_id&&globalThis._preDecodedBodies&&globalThis._preDecodedBodies.has(_id)){` +
      `const _e=globalThis._preDecodedBodies.get(_id);` +
      `globalThis._preDecodedBodies.delete(_id);` +
      `if(_e&&_e.timer)clearTimeout(_e.timer);` +
      `return JSON.parse(Buffer.from(_e&&_e.buf?_e.buf:_e).toString("utf-8"));` +
      `}` +
      `return await ${reqParam}.json();` +
      `})()`;

    // Build a tight try/catch replacement pinned to the captured variable names
    // (avoids accidentally matching a sibling try/catch block elsewhere).
    const tryCatchRe = new RegExp(
      `try\\{${escRe(tracker)}\\.startPhase\\("parse"\\),${escRe(body)}=await \\w+\\.json\\(\\),${escRe(tracker)}\\.endPhase\\(\\)\\}` +
        `catch\\{return \\w+\\.warn\\("CHAT","Invalid JSON body"\\),\\(0,\\w+\\.\\w+\\)\\(\\w+\\.\\w+\\.BAD_REQUEST,"Invalid JSON body"\\)\\}`
    );
    const replacement =
      `try{${tracker}.startPhase("parse"),${body}=await ${jsonExpr},${tracker}.endPhase()}` +
      `catch(_e){console.log("[chat-parse-err]",_e&&_e.message);` +
      `return ${logger}.warn("CHAT","Invalid JSON body"),(0,${errFn})(${statusObj}.BAD_REQUEST,"Invalid JSON body")}`;

    const patched = txt.replace(tryCatchRe, replacement);
    if (!assertReplaced(txt, patched, "patchZstd")) return;

    try {
      fs.writeFileSync(fp, patched, "utf8");
    } catch (e) {
      fail("patchZstd: write failed — " + e.message);
      return;
    }

    if (!verifySentinel(fp, SENTINEL, "patchZstd")) return;
    ok("patchZstd: patched " + fn + " (req=" + reqParam + ")");
    return;
  }
  fail("patchZstd: no chunk matched Invalid-JSON-body signature");
}

// ── Patch 2: server.js — compact endpoint + global Request patch ──────────────
function patchServerJs() {
  const FULLY_PATCHED = "__omniroute_fully_patched_v2__";
  const fp = path.join(OMNIROUTE_DIR, "server.js");

  let txt;
  try {
    txt = fs.readFileSync(fp, "utf8");
  } catch (e) {
    fail("patchServerJs: read failed — " + e.message);
    return;
  }

  if (txt.includes(FULLY_PATCHED)) {
    ok("patchServerJs: already fully patched");
    return;
  }

  const eol = detectEol(txt);

  // 1. http import
  if (!txt.includes("import http from 'node:http'")) {
    const before = txt;
    txt = txt.replace(
      "import module from 'node:module'",
      "import module from 'node:module'" + eol + "import http from 'node:http'"
    );
    if (!assertReplaced(before, txt, "patchServerJs: http import anchor")) return;
  }

  // 2. Compact interceptor block (only if not already present)
  if (!txt.includes("_compactSummaries")) {
    const before = txt;
    const compactCode = toEol(buildCompactCode(), eol);
    txt = txt.replace("startServer({", compactCode + "startServer({");
    if (!assertReplaced(before, txt, "patchServerJs: 'startServer({' anchor")) return;
  }

  // 3. Global Request patch before require('next')
  if (!txt.includes("__preDecodedPatched")) {
    const nextCalls = (txt.match(/require\('next'\)/g) || []).length;
    if (nextCalls !== 1) {
      fail("patchServerJs: expected exactly one require('next'), found " + nextCalls);
      return;
    }
    const before = txt;
    const globalReqPatch = toEol(buildGlobalReqPatch(), eol);
    txt = txt.replace("require('next')", globalReqPatch + "require('next')");
    if (!assertReplaced(before, txt, "patchServerJs: require('next') anchor")) return;
  }

  // 4. Stamp full-patched sentinel (outside any comment so minifiers can't strip)
  if (!txt.includes(FULLY_PATCHED)) {
    const before = txt;
    const stamp = `var ${FULLY_PATCHED}=1;${eol}`;
    txt = txt.replace("startServer({", stamp + "startServer({");
    if (!assertReplaced(before, txt, "patchServerJs: stamp anchor")) return;
  }

  try {
    fs.writeFileSync(fp, txt, "utf8");
  } catch (e) {
    fail("patchServerJs: write failed — " + e.message);
    return;
  }

  if (!verifySentinel(fp, FULLY_PATCHED, "patchServerJs: full sentinel")) return;
  if (!verifySentinel(fp, "_compactSummaries", "patchServerJs: compact block")) return;
  if (!verifySentinel(fp, "__preDecodedPatched", "patchServerJs: Request patch")) return;
  ok("patchServerJs: server.js patched");
}

function buildCompactCode() {
  return `
// ── Local compact ────────────────────────────────────────────────────────────
const _compactSummaries = new Map();
globalThis._preDecodedBodies = globalThis._preDecodedBodies || new Map();
const _preDecodedBodies = globalThis._preDecodedBodies;

function _makeReqFromBuf(buf, orig) {
  // Plain Readable + push(buf)/push(null). _preDecodedBody marker lets the
  // global Request patch skip undici's Node→Web stream conversion and use a
  // Web ReadableStream built directly from the buffer. In parallel, we stamp
  // an 'x-predecoded-id' header so the bundled handleChat can look up the
  // decoded buffer instead of calling request.json() (which would fail).
  const { Readable } = require('stream');
  const r = new Readable({ read() {} });
  r.push(buf); r.push(null);
  r.method = orig.method; r.url = orig.url;
  r.httpVersion = orig.httpVersion;
  r.httpVersionMajor = orig.httpVersionMajor;
  r.httpVersionMinor = orig.httpVersionMinor;
  r.socket = orig.socket || null;
  r.connection = r.socket;
  r.aborted = false;
  r.complete = true;
  r._preDecodedBody = buf;

  const id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  const timer = setTimeout(() => _preDecodedBodies.delete(id), 30000);
  _preDecodedBodies.set(id, { buf, timer });

  const h = { ...orig.headers };
  delete h['content-encoding'];
  r.headers = { ...h, 'content-length': String(buf.length), 'x-predecoded-id': id };
  const rawH = [];
  for (let i = 0; i < (orig.rawHeaders || []).length; i += 2) {
    if ((orig.rawHeaders[i] || '').toLowerCase() !== 'content-encoding') {
      rawH.push(orig.rawHeaders[i], orig.rawHeaders[i + 1]);
    }
  }
  rawH.push('x-predecoded-id', id);
  r.rawHeaders = rawH;
  r.trailers = orig.trailers || {}; r.rawTrailers = orig.rawTrailers || [];
  return r;
}

async function handleLocalCompact(req, res) {
  const fs = require('fs');
  const osMod = require('os');
  const chunks = [];
  await new Promise(r => { req.on('data', c => chunks.push(c)); req.on('end', r); });
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch (e) {}

  const homeDir = osMod.homedir();
  const sessDir = path.join(homeDir, '.codex', 'sessions');
  let latestFile = null, latestMtime = 0;
  function walk(d) {
    if (!fs.existsSync(d)) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.jsonl')) {
        try { const mt = fs.statSync(fp).mtimeMs; if (mt > latestMtime) { latestMtime = mt; latestFile = fp; } }
        catch (e) {}
      }
    }
  }
  walk(sessDir);

  let summary = 'Prior conversation compacted. Continue from current state.';
  if (latestFile) {
    try {
      const lines = fs.readFileSync(latestFile, 'utf8').split('\\n').filter(Boolean);
      const msgs = [];
      for (const l of lines) {
        try {
          const obj = JSON.parse(l);
          if (obj.type === 'response_item' && (obj.payload?.role === 'user' || obj.payload?.role === 'assistant')) {
            const text = (obj.payload.content || []).map(c => c.text || c.output || '').join('');
            if (text.trim()) msgs.push({ role: obj.payload.role, text });
          }
        } catch (e) {}
      }
      const recent = msgs.slice(-15);
      const older = msgs.slice(0, -15).map(m => ({ role: m.role, text: m.text.slice(0, 3000) }));
      const convo = [...older, ...recent].map(m => \`[\${m.role.toUpperCase()}]: \${m.text}\`).join('\\n\\n').slice(0, 120000);
      const authKey = process.env.OMNIROUTE_INTERNAL_KEY || '';
      if (!authKey) {
        console.warn('[compact] OMNIROUTE_INTERNAL_KEY unset; using fallback summary');
        summary = 'Context compacted (no upstream summary — set OMNIROUTE_INTERNAL_KEY to enable).';
      } else {
        const summaryBody = JSON.stringify({
          model: 'cc/claude-sonnet-4-6', max_tokens: 3000,
          messages: [{ role: 'user', content: \`You are compacting an ACTIVE coding session that is still in progress. The agent is resuming THIS SAME session (not reviewing historical work).\\n\\nWrite the summary in PRESENT TENSE describing what IS happening right now. Weight the MOST RECENT exchanges heavily — they describe the current state. Preserve exact file paths, error messages, in-progress edits, and last decisions verbatim.\\n\\nDO NOT instruct the agent to consult external memory (Kontext, _last_session.md, digest files) — that data is STALE and pre-dates this session. The summary you produce IS the authoritative current state.\\n\\nSession transcript:\\n\\n\${convo}\\n\\nSummary (present tense, authoritative):\` }]
        });
        summary = await new Promise(resolve => {
          const r2 = http.request({
            hostname: 'localhost', port: currentPort, path: '/v1/chat/completions', method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + authKey,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(summaryBody),
            },
          }, res2 => {
            const c2 = []; res2.on('data', x => c2.push(x));
            res2.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(c2).toString())?.choices?.[0]?.message?.content || 'Context compacted.'); }
              catch (e) { resolve('Context compacted.'); }
            });
          });
          r2.on('error', () => resolve('Context compacted.'));
          r2.write(summaryBody); r2.end();
        });
        summary = '=== MID-TASK RESUMPTION — CRITICAL DIRECTIVE ===\\n\\nYou are NOT starting a new conversation. You are resuming an IN-FLIGHT coding task. The turns below this header are the authoritative session state. Your NEXT action must be to continue the work described — not discovery, not setup, not introspection.\\n\\nMANDATORY — DO NOT DO ANY OF THE FOLLOWING:\\n- Do NOT invoke startup skills (using-superpowers, brainstorming, startup discipline).\\n- Do NOT read SKILL.md files or skill manifests.\\n- Do NOT probe MCP capabilities (list_mcp_resources, list_mcp_resource_templates, list_tools).\\n- Do NOT consult Kontext, _last_session.md, digest files, or ANY external memory — that data is STALE and pre-dates this session.\\n- Do NOT announce session continuity hooks or state "I am doing startup checks".\\n- Do NOT run Get-ChildItem, ls, or workspace exploration to "understand" the repo — you already know it from the summary.\\n\\nDO THIS INSTEAD:\\n- Read the summary below.\\n- Identify the last unfinished step.\\n- Execute it immediately.\\n\\n=== AUTHORITATIVE SESSION STATE ===\\n\\n' + summary;
      }
    } catch (e) {
      console.warn('[compact] session read/summary failed');
    }
  }

  const fakeId = 'resp_lc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  _compactSummaries.set(fakeId, summary);
  const rawModel = (body.model || 'gpt-4o').replace(/^[a-z]+\\//, '');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: fakeId, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: 'completed', model: rawModel,
    output: [{ type: 'message', role: 'assistant', id: 'msg_lc_' + Date.now().toString(36), status: 'completed', content: [{ type: 'output_text', text: summary }] }],
    previous_response_id: body.previous_response_id || null,
    usage: { input_tokens: 500, output_tokens: 300, total_tokens: 800 },
    parallel_tool_calls: true, temperature: 1.0, top_p: 1.0, store: true,
  }));
}

const _origCreateServer = http.createServer.bind(http);
http.createServer = function(opts, handler) {
  const h = typeof opts === 'function' ? opts : handler;
  const wrapped = (req, res) => {
    const url = req.url || '';
    if (url.includes('/responses/compact')) {
      handleLocalCompact(req, res).catch(err => {
        console.error('[compact] handler error:', err && err.message);
        if (!res.headersSent) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'compact failed', code: 'compact_failed' } }));
        }
      });
      return;
    }
    if (req.method === 'POST' && (url.match(/\\/responses$/) || url.match(/\\/chat\\/completions$/))) {
      const enc = (req.headers['content-encoding'] || '').toLowerCase();
      const needsDecompress = enc.includes('zstd') || enc.includes('br') || enc.includes('gzip') || enc.includes('deflate');
      const hasCompact = url.match(/\\/responses$/) && _compactSummaries.size > 0;
      if (!needsDecompress && !hasCompact) {
        if (h) h(req, res);
        else if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('no handler'); }
        return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks);
          let buf = raw;
          if (needsDecompress) {
            const zlib = require('zlib');
            buf = await new Promise((res2, rej) => {
              let d;
              if (enc.includes('zstd')) d = zlib.createZstdDecompress();
              else if (enc.includes('br')) d = zlib.createBrotliDecompress();
              else d = zlib.createGunzip();
              const out = []; d.on('data', x => out.push(x)); d.on('end', () => res2(Buffer.concat(out))); d.on('error', rej); d.end(raw);
            });
          }
          if (hasCompact) {
            let body = {}; try { body = JSON.parse(buf.toString('utf-8')); } catch (e) {}
            const prevId = body.previous_response_id;
            if (prevId && _compactSummaries.has(prevId)) {
              const summary = _compactSummaries.get(prevId);
              delete body.previous_response_id;
              body.instructions = (body.instructions ? body.instructions + '\\n\\n' : '') + '[COMPACTED PRIOR CONTEXT]\\n' + summary;
              buf = Buffer.from(JSON.stringify(body), 'utf-8');
            }
          }
          if (h) h(_makeReqFromBuf(buf, req), res);
          else if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('no handler'); }
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid request body', code: 'bad_request' } }));
          }
        }
      });
      return;
    }
    if (h) h(req, res);
    else if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('no handler'); }
  };
  return typeof opts === 'function' ? _origCreateServer(wrapped) : _origCreateServer(opts, wrapped);
};
// ─────────────────────────────────────────────────────────────────────────────

`;
}

function buildGlobalReqPatch() {
  return `
// ── Global Request patch (MUST run before \`require('next')\`) ─────────────────
;(function patchGlobalRequest() {
  const Orig = globalThis.Request;
  if (!Orig || Orig.__preDecodedPatched) return;
  class Patched extends Orig {
    constructor(input, init) {
      if (init && init.body && typeof init.body === 'object' &&
          Object.prototype.hasOwnProperty.call(init.body, '_preDecodedBody')) {
        const buf = init.body._preDecodedBody;
        const bodyStream = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(buf)); c.close(); }
        });
        init = { ...init, body: bodyStream, duplex: init.duplex || 'half' };
      }
      super(input, init);
    }
  }
  Patched.__preDecodedPatched = true;
  globalThis.Request = Patched;
  console.log('[patch] globalThis.Request patched for pre-decoded bodies');
})();

`;
}

// ── Patch 3: bypass API key validation (match and neutralize the guard) ───────
function patchApiKeyAuth() {
  const SENTINEL = "__apiauth_patched_v2__";
  const LEGACY_SENTINEL = "_apiauth_patched";

  let files;
  try {
    files = fs.readdirSync(CHUNKS_DIR).filter((f) => f.endsWith(".js") && !f.endsWith(".map"));
  } catch (e) {
    fail("patchApiKeyAuth: readdir failed — " + e.message);
    return;
  }

  for (const fn of files) {
    const fp = path.join(CHUNKS_DIR, fn);
    let txt;
    try {
      txt = fs.readFileSync(fp, "utf8").replace(/^\uFEFF/, "");
    } catch (e) {
      info("patchApiKeyAuth: skip " + fn + " (" + e.message + ")");
      continue;
    }

    if (txt.includes(SENTINEL)) {
      ok("patchApiKeyAuth: already patched (" + fn + ")");
      return;
    }
    if (txt.includes(LEGACY_SENTINEL)) {
      ok("patchApiKeyAuth: legacy-patched (" + fn + ") — leaving as-is");
      return;
    }
    if (!txt.includes("API key not found or invalid")) continue;

    // Match the full `if(COND)return warn(...)` so the replacement is self-contained
    // (no reliance on surrounding tokens). Anchor from `if(` through the warn call.
    const re =
      /if\(\w+&&!\w+&&!await \(0,\w+\.\w+\)\(\w+\)\)return \w+\.warn\("AUTH","API key not found or invalid \(must be created in API Manager\)"\)/;
    const m = txt.match(re);
    if (!m) {
      fail("patchApiKeyAuth: pattern not found in " + fn);
      return;
    }

    // Sentinel as a string literal — survives minifier comment stripping.
    const replacement = `if(false)return "${SENTINEL}"`;
    const patched = txt.replace(re, replacement);
    if (!assertReplaced(txt, patched, "patchApiKeyAuth")) return;

    try {
      fs.writeFileSync(fp, patched, "utf8");
    } catch (e) {
      fail("patchApiKeyAuth: write failed — " + e.message);
      return;
    }

    if (!verifySentinel(fp, SENTINEL, "patchApiKeyAuth")) return;
    ok("patchApiKeyAuth: patched " + fn);
    return;
  }
  fail("patchApiKeyAuth: no chunk contained the auth-check pattern");
}

// ── Run ───────────────────────────────────────────────────────────────────────
patchZstd();
patchServerJs();
patchApiKeyAuth();

if (hadFailure) {
  console.error("");
  console.error("✗ One or more patches FAILED. Do NOT restart OmniRoute until resolved.");
  process.exit(1);
}
console.log("");
console.log("✓ All patches applied. Restart OmniRoute.");
