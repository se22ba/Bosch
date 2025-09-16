const express = require('express');
const fetch = require('node-fetch'); // Node 18+ ya trae fetch nativo
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use(express.static(path.join(__dirname)));

function makeAuthHeader(req) {
  const h = req.headers['authorization'];
  if (h) return h;
  const user = process.env.VRM_USER || '';
  const pass = process.env.VRM_PASS || '';
  if (!user && !pass) return undefined;
  const basic = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${basic}`;
}

app.get('/api/rcp', async (req, res) => {
  try {
    const vrmBase = (req.query.vrm || '').replace(/\/vrmcockpit\/?$/,'').replace(/\/+$/,'');
    const cmd = req.query.cmd || '0xD028';
    if (!vrmBase) return res.status(400).json({error:'Falta ?vrm'});
    const url = `${vrmBase}/rcp.xml?command=${encodeURIComponent(cmd)}&type=P_OCTET&direction=READ`;
    const headers = {};
    const auth = makeAuthHeader(req);
    if (auth) headers['Authorization'] = auth;
    const r = await fetch(url, { headers });
    const text = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/xml');
    res.status(r.status).send(text);
  } catch (e) {
    res.status(500).json({error: String(e)});
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard en http://localhost:${PORT}`);
});