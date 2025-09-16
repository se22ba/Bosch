// rcp-decoder.js — utilidades RCP/TLV (BVMS/VRM)

(function(){
  const RCP = {};

  RCP.extractCommandHex = function(xml){
    const m = String(xml).match(/<hex>\s*(0x[0-9a-fA-F]+)\s*<\/hex>/);
    return m ? m[1].toLowerCase() : null;
  };

  RCP.extractRcpBytesFromXml = function(xml){
    const m = String(xml).match(/<str>([\s0-9a-fA-F]+)<\/str>/);
    if(!m) return new Uint8Array();
    const hex = m[1].trim().split(/\s+/).filter(Boolean);
    const out = new Uint8Array(hex.length);
    for (let i=0;i<hex.length;i++) out[i] = parseInt(hex[i],16) & 0xff;
    return out;
  };

  // Heurística de valor: UTF-16LE → string; 4 bytes → U32 LE; 2 bytes → U16 LE; otro → hex
  function decodeValue(bytes){
    const n = bytes.length;
    // ¿UTF-16LE?
    let zeros = 0;
    for (let i=1;i<n;i+=2) if (bytes[i]===0) zeros++;
    if (n>=4 && zeros >= Math.floor(n/4)) {
      let s = '';
      for (let i=0;i<n;i+=2){
        const code = bytes[i] | (bytes[i+1]<<8);
        if (code === 0) break;
        s += String.fromCharCode(code);
      }
      return s.trim();
    }
    if (n===4) return (bytes[0]|(bytes[1]<<8)|(bytes[2]<<16)|(bytes[3]<<24))>>>0;
    if (n===2) return (bytes[0]|(bytes[1]<<8))>>>0;
    return Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join(' ');
  }

  RCP.parseRcpTLV = function(bytes){
    const rows = [];
    let i = 0;
    while (i + 4 <= bytes.length){
      const id  = bytes[i] | (bytes[i+1]<<8);
      const len = bytes[i+2] | (bytes[i+3]<<8);
      const rest = bytes.length - (i + 4);
      if (len>=0 && len<=rest){
        const raw = bytes.subarray(i+4, i+4+len);
        rows.push({ id, len, raw, value: decodeValue(raw) });
        i += 4 + len;
      } else {
        i += 1; // desfasaje → busco próximo TLV
      }
    }
    return rows;
  };

  RCP.tlvToMap = function(rows){
    const m = {};
    for (const r of rows){
      const k = '0x' + r.id.toString(16).padStart(4,'0');
      m[k] = r.value;
    }
    return m;
  };

  window.RCP = RCP;
  console.log('[RCP] decoder loaded');
})();