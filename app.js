// ===== Config =====
const STALE_MIN = 10;   // sin avance de escritura => warn / no grabando
const LOW_BITRATE = 64; // kbps => warn
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
  const n = Number(v); if(!Number.isNaN(n) && n>100000) return new Date(n*1000); // epoch
  return null;
}

// ===== Normalización =====
function toCamera(it){
  return {
    name: it.name || it.cameraName || it.id || '(sin nombre)',
    assigned_blocks: asInt(it.assigned_blocks ?? it.blocks ?? 0),
    bitrate_kbps: asInt(it.bitrate_kbps ?? it.bitrate ?? 0),
    pool: it.pool || null,
    lun: it.lun || null,
    last_write_ts: parseTs(it.last_write_ts ?? it.last_write ?? it.lastWrite ?? it.last)
  };
}

function normalize(raw){
  if (typeof raw === 'object') {
    const items = raw.cameras || raw.items || raw.data || [];
    return items.map(toCamera);
  }
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  const cams = [];

  // XML-like tags
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

  // Tabla HTML
  doc.querySelectorAll('tr.camera-row, tr.cam-row, tr[data-type="camera"]').forEach(row=>{
    const cols=[...row.querySelectorAll('td,th')].map(c=>c.textContent.trim());
    cams.push(toCamera({
      name: cols[0], assigned_blocks: cols[1], bitrate_kbps: cols[2],
      pool: cols[3], lun: cols[4], last_write_ts: cols[5]
    }));
  });
  return cams;
}

// ===== Heurísticas =====
function health(c){
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
    tr.appendChild(td(c.assigned_blocks));                        // Bloques
    tr.appendChild(td(c.bitrate_kbps));                           // Bitrate
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

// ===== Fetch VRM =====
async function fetchVRM(url, user, pass, forceJson){
  const target = forceJson ? addParam(url,'format','json') : url;
  const headers = {};
  if (user || pass) headers['Authorization'] = basicAuth(user||'', pass||'');
  const r = await fetch(target, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  const ct = (r.headers.get('content-type')||'').toLowerCase();
  if (ct.includes('application/json')) return await r.json();
  return await r.text(); // HTML/XML
}

// ===== Wire-up =====
document.getElementById('btnRun').addEventListener('click', async ()=>{
  const btn = document.getElementById('btnRun');
  const status = document.getElementById('status');
  btn.disabled = true; status.textContent = 'Consultando…';

  try{
    const lines = document.getElementById('vrmUrls').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Ingresá al menos una URL de VRM');
    const user = document.getElementById('vrmUser').value.trim();
    const pass = document.getElementById('vrmPass').value.trim();
    const forceJson = document.getElementById('forceJson').checked;
    const wantDownload = document.getElementById('downloadJson').checked;

    const results = await Promise.allSettled(lines.map(u => fetchVRM(u, user, pass, forceJson)));

    const camsAll = [];
    const errors = [];
    results.forEach((res, i)=>{
      const vrm = lines[i];
      if (res.status === 'fulfilled') {
        const cams = normalize(res.value).map(c => ({...c, vrm}));
        camsAll.push(...cams);
      } else {
        errors.push(`${vrm}: ${res.reason}`);
      }
    });

    renderAll(camsAll);
    status.textContent = `OK (${camsAll.length} cámaras${errors.length?`, errores: ${errors.length}`:''})`;
    if (errors.length) console.warn('Errores VRM:', errors);

    if (wantDownload){
      const plain = camsAll.map(c=>({
        vrm:c.vrm, name:c.name,
        assigned_blocks:c.assigned_blocks, bitrate_kbps:c.bitrate_kbps,
        pool:c.pool, lun:c.lun,
        last_write_ts: c.last_write_ts ? c.last_write_ts.toISOString() : null
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