// ===== Config mínima =====
const STALE_MIN = 10;   // si “last write” > 10 min → warn
const LOW_BITRATE = 64; // kbps umbral

// ===== Helpers =====
function $(id){ return document.getElementById(id); }
function asLines(v){ return (v||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean); }
function tsNow(){ return new Date(); }
function minutesDiff(a,b){ return Math.round((a-b)/60000); }
function toText(v){ return (v==null?'':String(v)); }

// Devuelve 2 endpoints (0xD028 y 0xD062) usando el proxy local
function buildRcpEndpointsFromBase(u){
  const base = u.replace(/\/vrmcockpit\/?$/,'').replace(/\/+$/,''); // limpia trailing y cockpit
  const user = $('vrmUser').value.trim();
  const pass = $('vrmPass').value.trim();
  const authQS = (user || pass) ? `&user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}` : '';
  return [
    `/api/rcp?vrm=${encodeURIComponent(base)}&cmd=0xD028${authQS}`,
    `/api/rcp?vrm=${encodeURIComponent(base)}&cmd=0xD062${authQS}`
  ];
}

async function fetchText(url){
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return await r.text();
}

// ===== Parseadores RCP (usa rcp-decoder.js) =====
function parseRcpXml(xml){
  const cmd = window.RCP.extractCommandHex(xml) || '0x0000';
  const bytes = window.RCP.extractRcpBytesFromXml(xml);
  const tlv = window.RCP.parseRcpTLV(bytes);
  return { cmd, tlv, map: window.RCP.tlvToMap(tlv) };
}

// Heurística para 0xD062: agrupar por cada URL/host UTF-16 que parezca cámara
function devicesFromD062(tlvRows, vrmHost){
  const out = [];
  let cur = null;

  const flush = () => { if (cur) out.push(cur); cur = null; };

  for (const r of tlvRows){
    const idHex = '0x' + r.id.toString(16).padStart(4,'0');
    const v = r.value;

    // Inicio de dispositivo: campo con URL/host (“https://service@ip:port”, “CAM1 VRM 94”, etc.)
    if (typeof v === 'string' && /https?:\/\/|vrm|cam|device|ip\s*\d/i.test(v)) {
      flush();
      cur = { vrm: vrmHost, name: '', address: '', online: null, recording: null, note: '' };
      // Si es URL, úsala como address provisional
      if (/^https?:\/\//i.test(v)) cur.address = v;
      else cur.name = v;
      continue;
    }

    if (!cur) continue;

    // Nombre (UTF-16) suele venir en algún TLV string:
    if (!cur.name && typeof v === 'string' && v.length>0 && !/^https?:\/\//i.test(v) && !/^\d+$/.test(v)) {
      cur.name = v;
    }
    // Dirección (otra URL o IP)
    if (!cur.address && typeof v === 'string' && /^https?:\/\//i.test(v)) cur.address = v;

    // Flags simples (id y semántica a ojo, según dumps reales)
    if (idHex === '0x0008' || idHex === '0x0009' || idHex === '0x0015') {
      // 0/1 o valores pequeños → “online”
      if (typeof v === 'number') cur.online = (v !== 0);
      if (typeof v === 'string' && /^\d+$/.test(v)) cur.online = (parseInt(v,10)!==0);
    }

    // Heurística de “grabando”: si existen contadores, bytes, o “blocks” >0 en r.raw
    if (idHex === '0x0018' || idHex === '0x0019' || idHex === '0x001a' || idHex === '0x0021') {
      if (typeof v === 'number') {
        if (cur.recording==null) cur.recording = (v>0);
        else cur.recording = cur.recording || (v>0);
      }
    }

    // Notas: bitrate bajo, estados raros, etc. (si hay un U32 chico donde esperamos mayor)
    if (idHex === '0x0010' && typeof v === 'number' && v>0) {
      // ejemplo: 0x0010 a veces viene como "bitrate actual (kbps)"
      if (v < LOW_BITRATE) cur.note = (cur.note||'') + `bitrate bajo (${v}kbps) `;
    }
  }
  flush();
  return out;
}

// Normaliza un VRM (dos respuestas) a lista de dispositivos
function normalizeVrm(vrmHost, xml028, xml062){
  const out = [];
  try{
    const p28 = parseRcpXml(xml028);
    const p62 = parseRcpXml(xml062);
    // Si 0xD062 trae TLV que podemos agrupar → úsalo
    let devs = devicesFromD062(p62.tlv, vrmHost);
    // Fallback: si nada detectado, muestra al menos el VRM “vivo”
    if (devs.length === 0) {
      devs = [{ vrm: vrmHost, name: '(sin parser D062)', address: '', online: true, recording: null, note: 'Parser básico: ajustar mapeos' }];
    }
    out.push(...devs);
  }catch(e){
    out.push({ vrm: vrmHost, name: '(error parseo)', address: '', online: null, recording: null, note: String(e) });
  }
  return out;
}

// ===== UI =====
function render(devices){
  const t = $('tblBody'); t.innerHTML = '';
  let off=0,on=0,rec=0,noRec=0;

  for (const d of devices){
    const state = d.online===true ? 'Online' : (d.online===false ? 'Offline' : 'N/D');
    const recTx = d.recording===true ? 'Grabando' : (d.recording===false ? 'Sin grabación' : 'N/D');

    if (d.online===true) on++; else if (d.online===false) off++;
    if (d.recording===true) rec++; else if (d.recording===false) noRec++;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${toText(d.vrm)}</td>
      <td>${toText(d.name)}</td>
      <td class="muted">${toText(d.address)}</td>
      <td class="${d.online===true?'ok':(d.online===false?'fail':'')}">${state}</td>
      <td class="${d.recording===true?'ok':(d.recording===false?'warn':'')}">${recTx}</td>
      <td class="muted">${toText(d.note)}</td>`;
    t.appendChild(tr);
  }

  $('cntOffline').innerText = off;
  $('cntOnline').innerText = on;
  $('cntRecording').innerText = rec;
  $('cntNoRecording').innerText = noRec;
  $('hintStatus').innerText = `OK (${devices.length} cámaras, errores: 0)`;
}

async function consultar(){
  const bases = asLines($('vrmList').value);
  if (bases.length===0){ alert('Pegá al menos una URL de VRM'); return; }

  const allDevices = [];
  const errores = [];

  for (const base of bases){
    try{
      const [u28,u62] = buildRcpEndpointsFromBase(base);
      const [x28,x62] = await Promise.all([fetchText(u28), fetchText(u62)]);
      // VRM host para mostrar bonito
      let host = '';
      try{ host = (new URL(base.replace(/\/+$/,''))).host; }catch{ host = base; }
      const devs = normalizeVrm(host, x28, x62);
      allDevices.push(...devs);
    }catch(e){
      console.warn('Error VRM', base, e);
      errores.push({ vrm: base, error: String(e) });
    }
  }

  if (allDevices.length===0 && errores.length){
    $('hintStatus').innerText = `Errores: ${errores.length} (ver consola)`;
  }
  render(allDevices);
}

window.addEventListener('DOMContentLoaded', ()=>{
  $('btnConsultar').addEventListener('click', consultar);
  console.log('[UI] listo');
});