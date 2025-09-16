// server.js — Proxy VRM usando https.request (sin fetch), tolerante a TLS/cert viejos.
// Requiere: npm i express dotenv
// Ejecuta:  node server.js   →  http://localhost:3000

const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS básico
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Sirve tu front (index.html, app.js, rcp-decoder.js, styles.css)
app.use(express.static(path.join(__dirname)));

function cleanBase(vrm) {
  return (vrm || '').replace(/\/vrmcockpit\/?$/,'').replace(/\/+$/,'');
}

function resolveAuth(req) {
  // 1) Header Authorization si el cliente lo manda
  if (req.headers['authorization']) return req.headers['authorization'];
  // 2) Query ?user=&pass=
  const u = req.query.user || process.env.VRM_USER || '';
  const p = req.query.pass || process.env.VRM_PASS || '';
  if (u || p) return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  return undefined;
}

function doHttpsGetText(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const opts = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      method: 'GET',
      headers,
      // TLS permisivo (equipos con cert/IP/ciphers raros)
      rejectUnauthorized: false,
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1.3',
      ciphers: 'ALL:@SECLEVEL=0',
      honorCipherOrder: true,
      checkServerIdentity: () => undefined,  // evita CN/SAN mismatch
      servername: undefined,                 // quita SNI (ayuda con cert viejos)
      lookup: (host, _opts, cb) => cb(null, host, 4), // fuerza IPv4
      agent: false,            // sin keep-alive (equipos antiguos agradecen)
      timeout: 12000,
    };

    console.log(`[RAW] → ${opts.protocol}//${opts.hostname}:${opts.port}${opts.path}`);
    const req = lib.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        console.log(`[RAW] ← ${res.statusCode} ${res.headers['content-type'] || ''}`);
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });

    req.on('error', (err) => {
      console.error('[RAW][ERROR]', err?.code || '', err?.message || err);
      reject(err);
    });
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.end();
  });
}

// /api/rcp?vrm=https://IP[:PUERTO][/vrmcockpit]&cmd=0xD028[&user=..&pass=..]
app.get('/api/rcp', async (req, res) => {
  try {
    const vrmBase = cleanBase(req.query.vrm);
    const cmd = req.query.cmd || '0xD028';
    if (!vrmBase) return res.status(400).json({ error: 'Falta ?vrm' });

    const url = `${vrmBase}/rcp.xml?command=${encodeURIComponent(cmd)}&type=P_OCTET&direction=READ`;
    const headers = {};
    const auth = resolveAuth(req);
    if (auth) headers['Authorization'] = auth;

    console.log('[PROXY] →', url, 'Auth?', !!auth);
    const r = await doHttpsGetText(url, headers);

    res.setHeader('Content-Type', r.headers['content-type'] || 'application/xml; charset=utf-8');
    res.status(r.status).send(r.body);
  } catch (e) {
    console.error('[PROXY][ERROR]', e?.code || '', e?.message || e);
    res.status(500).json({ error: `${e?.code || ''} ${e?.message || e}`.trim() });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard + proxy en http://localhost:${PORT}`);
  console.log(`.env opcional: VRM_USER=usuario / VRM_PASS=clave`);
});