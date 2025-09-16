// ===== Config =====
const STALE_MIN = 10;
const LOW_BITRATE = 64;
let chart;

// ===== Helpers =====
function basicAuth(u,p){ return 'Basic '+btoa(`${u}:${p}`); }
function addParam(url, k, v){
  try{ const u=new URL(url); u.searchParams.set(k,v); return u.toString(); }
  catch{ return url+(url.includes('?')?'&':'?')+encodeURIComponent(k)+'='+encodeURIComponent(v); }
}
function asInt(v){ const n=parseInt(v,10); return Number.isNaN(n)?0:n; }
function parseTs(v){
  if(!v) return null;
  const t = Date.parse(v); if(!Number.isNaN(t)) return new Date(t);
  const n = Number(v); if(!Number.isNaN(n) && n>100000) return new Date(n*1000);
  return null;
}
function isXmlRcp(text){ return typeof text === 'string' && /<rcp>/i.test(text) && /<str>/i.test(text); }
function getU(map, id){ const v = map?.[id]; return typeof v === 'number' ? v : null; }
function getS(map, id){ const v = map?.[id]; return typeof v === 'string' ? v : null; }
function safeHost(u){ try{ const x=new URL(u); return x.origin; } catch{ return u.replace(/\/+$/,''); } }

// ===== Normalización clásica (JSON/HTML) =====
function toCamera(it){
  return {
    name: it.name || it.cameraName || it.id || '(sin nombre)',
    assigned_blocks: asInt(it.assigned_blocks ?? it.blocks ?? 0),
    bitrate_kbps: asInt(it.bitrate_kbps ?? it.bitrate ?? 0),
    pool: it.pool || null,
    lun: it.lun || null,
    last_write_ts: parseTs(it.last_write_ts ?? it.last_write ?? it.lastWrite ?? it.last),
    vrm: it.vrm || ''
  };
}

function normalize(raw){
  if (typeof raw === 'object') {
    const items = raw.cameras || raw.items || raw.data || [];
    return items.map(toCamera);
  }
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const cams = [];
  doc.querySelectorAll('camera, Camera, CAM').forEach(tag=>{
    cams.push(toCamera({
      name: tag.getAttribute('name') || tag.getAttribute('id') || (tag.textContent||'').trim(),
      assigned_blocks: tag.getAttribute('assigned_blocks') || tag.getAttribute('blocks'),
      bitrate_kbps: tag.getAttribute('bitrate_kbps') || tag.getAttribute('bitrate'),
      pool: tag.getAttribute('pool'),
      lun: tag.getAttribute('lun'),
      last_write_ts: tag.getAttribute('last_write_ts') || tag.getAttribute('last_write') || tag.getAttribute('lastWrite'),
    }));
  });
  if (cams.length) return cams;
  doc.querySelectorAll('tr.camera-row, tr.cam-row, tr[data-type="camera"]').forEach(row=>{
    const cols=[...row.querySelectorAll('td,th')].map(c=>c.textContent.trim());
    cams.push(toCamera({
      name: cols[0], assigned_blocks: cols[1], bitrate_kbps: cols[2],
      pool: cols[3], lun: cols[4], last_write_ts: cols[5]
    }));
  });
  return cams;
}

// ===== RCP Context =====
const vrmCtx = {};
function rememberVrmContext(vrmKey, mapD028){
  const vrmName = getS(mapD028, '0x000f'); // "VRM 172.20.67.94"
  const lastWriteEpoch = getU(mapD028, '0x000a'); // epoch (si aplica)
  if (!vrmCtx[vrmKey]) vrmCtx[vrmKey] = {};
  if (vrmName) vrmCtx[vrmKey].vrm = vrmName.replace(/^VRM\s+/,'');
  if (lastWriteEpoch) vrmCtx[vrmKey].last_write = new Date(lastWriteEpoch * 1000);
}

// ===== parse 0xD062 → devices =====
function parseD062ToDevices(text, vrmKey){
  const bytes = window.RCP.extractRcpBytesFromXml(text);
  const rows  = window.RCP.parseRcpTLV(bytes);

  // Heurística: un nuevo "device block" empieza cuando aparece un campo URL UTF-16 (id 0x0006)
  const blocks = [];
  let current = null;

  function push(){ if (current) blocks.push(current); current=null; }
  for (const r of rows){
    const id = '0x' + r.id.toString(16).padStart(4,'0');
    // nuevo bloque si llega 0x0006 UTF-16 con "https://"
    if (id === '0x0006' && typeof r.value === 'string' && r.value.startsWith('https://')) {
      push();
      current = { fields: {}, url: r.value };
    }
    if (!current) continue;
    current.fields[id] = r.value;
  }
  push();

  // map a objetos "camera-like"
  const ctx = vrmCtx[vrmKey] || {};
  const list = blocks.map(b=>{
    // status: 0x0008 (U8) = 1 ⇒ online
    const online = Number(b.fields['0x0008']) === 1;
    const model  = (b.fields['0x0014'] && String(b.fields['0x0014'])) // UTF-16 nombre legible
                || (b.fields['0x0009'] && String(b.fields['0x0009'])) // modelo/alias
                || '---';

    // last write candidato (ajustable): 0x001d ó 0x000d/0x000f si parecen epoch
    const lw = ['0x001d','0x000f','0x000d','0x000a']
      .map(k=>Number(b.fields[k]))
      .find(n => Number.isFinite(n) && n > 100000);
    const lastWrite = lw ? new Date(lw * 1000) : (ctx.last_write || null);

    return {
      vrm: ctx.vrm || vrmKey,
      name: model,
      assigned_blocks: 0,
      bitrate_kbps: 0,
      pool: null,
      lun: null,
      last_write_ts: lastWrite,
      _status: online ? 'Online' : 'Offline',
      _health: online ? 'ok' : 'bad'
    };
  });

  return list;
}

function normalizeRcpXml(text, sourceUrl){
  const cmd = window.RCP.extractCommandHex(text) || '';
  const host = (()=>{
    try{ return new URL(sourceUrl).host; } catch{ return sourceUrl; }
  })();

  if (cmd === '0xd028') {
    const map = window.RCP.tlvToMap(window.RCP.parseRcpTLV(window.RCP.extractRcpBytesFromXml(text)));
    rememberVrmContext(host, map);
    return [];
  }
  if (cmd === '0xd062') {
    return parseD062ToDevices(text, host);
  }
  // Si llega 0xD02B/otros, podríamos sumarlos aquí, pero con D062 ya listamos devices.
  return [];
}

// ===== Heurísticas UI =====
function health(c){
  if (c._health) {
    if (c._health === 'ok')   return { cls:'ok', text:'✅ operativa' };
    if (c._health === 'bad')  return { cls:'bad', text:'❌ sin conexión' };
  }
  const hasBlocks = (c.assigned_blocks||0) > 0;
  const hasBitrate = (c.bitrate_kbps||0) > 0;
  let mins = null;
  if (c.last_write_ts) mins = (Date.now()-c.last_write_ts.getTime())/60000;
  if (!hasBitrate && !hasBlocks && (mins===null || mins>STALE_MIN)) {
    return { cls:'bad', text:'❌ sin conexión' };
  }
  if (hasBitrate && c.bitrate_kbps < LOW_BITRATE) {
    return { cls:'warn', text:'⚠️ bitrate bajo' };
  }
  return { cls:'ok', text:'✅ operativa' };
}
function isRecording(c){
  const hasBlocks = (c.assigned_blocks||0) > 0;
  if (!hasBlocks || !c.last_write_ts) return false;
  const mins = (Date.now()-c.last_write_ts.getTime())/60000;
  return mins <= STALE_MIN;
}

// ===== Render =====
function renderAll(rows){
  let sinConexion=0, operativas=0, grabando=0, sinGrab=0;
  rows.forEach(c=>{
    const h = health(c);
    if (h.cls==='bad') sinConexion++;
    if (h.cls!=='bad') operativas++;
    if (isRecording(c)) grabando++; else sinGrab++;
  });

  document.getElementById('kpiNoConn').textContent = sinConexion;
  document.getElementById('kpiOper').textContent   = operativas;
  document.getElementById('kpiRecOn').textContent  = grabando;
  document.getElementById('kpiRecOff').textContent = sinGrab;

  document.getElementById('totals').textContent = `Total cámaras: ${rows.length}`;
  const tb = document.getElementById('tbody'); tb.innerHTML='';
  rows.forEach(c=>{
    const h = health(c);
    const tr=document.createElement('tr');
    const td=t=>{ const x=document.createElement('td'); x.textContent=t; return x; };
    tr.appendChild(td(c.vrm||''));                                // VRM
    tr.appendChild(td(c.name));                                   // Nombre
    tr.appendChild(td(c.assigned_blocks ?? 0));                   // Bloques
    tr.appendChild(td(c.bitrate_kbps ?? 0));                      // Bitrate
    tr.appendChild(td([c.pool,c.lun].filter(Boolean).join('/'))); // Pool/LUN
    tr.appendChild(td(c.last_write_ts?c.last_write_ts.toLocaleString():'')); // Last write
    const t7=document.createElement('td');
    const pill=document.createElement('span'); pill.className='pill '+h.cls; pill.textContent = isRecording(c) ? '🎞️ grabando' : h.text;
    t7.appendChild(pill); tr.appendChild(t7);
    tb.appendChild(tr);
  });

  let ok=0,warn=0,bad=0;
  rows.forEach(c=>{ const h=health(c); if(h.cls==='ok') ok++; else if(h.cls==='warn') warn++; else bad++; });
  renderDonut(ok,warn,bad);
}

function renderDonut(ok,warn,bad){
  const ctx = document.getElementById('donut');
  if (chart) chart.destroy();
  chart = new Chart(ctx,{
    type:'doughnut',
    data:{ labels:['OK','Warn','Fail'], datasets:[{ data:[ok,warn,bad] }] },
    options:{ plugins:{ legend:{ position:'bottom' } } }
  });
}

// ===== Fetch =====
async function fetchAny(url, user, pass){
  const headers = {};
  if (user || pass) headers['Authorization'] = basicAuth(user||'', pass||'');
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  const ct = (r.headers.get('content-type')||'').toLowerCase();
  if (ct.includes('application/json')) return { kind:'json', body: await r.json() };
  const text = await r.text();
  if (isXmlRcp(text)) return { kind:'rcp', body:text };
  return { kind:'html', body:text };
}

// Construye endpoints RCP a partir de una URL base del VRM
function buildRcpEndpointsFromBase(u){
  const base = safeHost(u).replace(/\/vrmcockpit\/?$/,''); // limpia /vrmcockpit si vino
  const rcp = (cmd) => `${base}/rcp.xml?command=${cmd}&type=P_OCTET&direction=READ`;
  return [ rcp('0xD028'), rcp('0xD062') ];
}

// ===== Wire-up =====
document.getElementById('btnRun').addEventListener('click', async ()=>{
  const btn = document.getElementById('btnRun');
  const status = document.getElementById('status');
  btn.disabled = true; status.textContent = 'Consultando…';

  try{
    const lines = document.getElementById('vrmUrls').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Ingresá al menos una URL del VRM o rcp.xml');
    const user = document.getElementById('vrmUser').value.trim();
    const pass = document.getElementById('vrmPass').value.trim();
    const wantDownload = document.getElementById('downloadJson').checked;

    // Expande cada línea: si es base, arma 0xD028 y 0xD062; si ya es rcp.xml, la deja
    const targets = [];
    for (const u of lines){
      if (/rcp\.xml/i.test(u)) targets.push(u);
      else targets.push(...buildRcpEndpointsFromBase(u));
    }

    const results = await Promise.allSettled(targets.map(u => fetchAny(u, user, pass)));

    const camsAll = [];
    const errors = [];
    for (let i=0;i<results.length;i++){
      const src = targets[i];
      const res = results[i];
      if (res.status !== 'fulfilled') { errors.push(`${src}: ${res.reason}`); continue; }
      const { kind, body } = res.value;

      if (kind === 'json' || kind === 'html') {
        const cams = normalize(body).map(c => ({...c, vrm:''}));
        camsAll.push(...cams);
      } else if (kind === 'rcp') {
        const list = normalizeRcpXml(body, src);
        camsAll.push(...list);
      }
    }

    renderAll(camsAll);
    status.textContent = `OK (${camsAll.length} cámaras${errors.length?`, errores: ${errors.length}`:''})`;
    if (errors.length) console.warn('Errores VRM:', errors);

    if (wantDownload){
      const plain = camsAll.map(c=>({
        vrm:c.vrm, name:c.name,
        assigned_blocks:c.assigned_blocks ?? 0, bitrate_kbps:c.bitrate_kbps ?? 0,
        pool:c.pool, lun:c.lun,
        last_write_ts: c.last_write_ts ? c.last_write_ts.toISOString() : null,
        status: c._status || null
      }));
      const blob = new Blob([JSON.stringify(plain,null,2)], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href=url; a.download='vrm_status_normalizado.json'; a.click();
      setTimeout(()=>URL.revokeObjectURL(url), 1500);
    }
  }catch(e){
    console.error(e);
    status.textContent = 'Error: '+e.message;
  }finally{
    btn.disabled = false;
  }
});