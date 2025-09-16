// rcp-decoder.js
// Decodificador TLV para rcp.xml del VRM Cockpit (Bosch RCP+).
// Expone window.RCP con helpers para: extraer bytes, parsear TLVs y mapear a diccionario.

// === Utils hex/bytes ===
(function(){
  const hexStrToBytes = (s) =>
    new Uint8Array(s.trim().split(/\s+/).filter(Boolean).map(h => parseInt(h, 16)));
  const u16be = (b, o) => (b[o] << 8) | b[o + 1];
  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  // UTF-16BE null-terminated
  function readUtf16BE(b, o){
    const out = [];
    for (let i = o; i + 1 < b.length; i += 2) {
      if (b[i] === 0x00 && b[i+1] === 0x00) {
        return { text: new TextDecoder('utf-16be').decode(new Uint8Array(out)), next: i + 2 };
      }
      out.push(b[i], b[i+1]);
    }
    return { text: new TextDecoder('utf-16be').decode(new Uint8Array(out)), next: b.length };
  }

  // C-string ASCII null-terminated
  function readCString(b, o){
    let end = o;
    while (end < b.length && b[end] !== 0x00) end++;
    return { text: new TextDecoder().decode(b.slice(o, end)), next: Math.min(end + 1, b.length) };
  }

  /**
   * Parser TLV: id(2) + type(2) + value(variable)
   * Tipos vistos en tus dumps:
   *  0x0001 -> U8
   *  0x0002 -> U16 BE
   *  0x0004 -> U32 LE
   *  0x0022 -> UTF-16BE null-terminated
   *  otros  -> heurística: C-string ASCII si aplica; si no, U32 LE
   */
  function parseRcpTLV(bytes){
    const out = [];
    let i = 0;
    while (i + 4 <= bytes.length) {
      const id   = u16be(bytes, i); i += 2;
      const type = u16be(bytes, i); i += 2;

      let value, next = i;
      if (type === 0x0001) {            // U8
        if (next >= bytes.length) break;
        value = bytes[next]; next += 1;
      } else if (type === 0x0002) {     // U16 BE
        if (next + 2 > bytes.length) break;
        value = u16be(bytes, next); next += 2;
      } else if (type === 0x0004) {     // U32 LE
        if (next + 4 > bytes.length) break;
        value = u32le(bytes, next); next += 4;
      } else if (type === 0x0022) {     // UTF-16BE string
        const s = readUtf16BE(bytes, next);
        value = s.text; next = s.next;
      } else {
        // Heurística C-string
        let looks = false, j = next, cnt = 0;
        while (j < bytes.length && bytes[j] !== 0x00 && cnt < 64) {
          const c = bytes[j];
          if (c === 0x2d || (c >= 0x20 && c <= 0x7e)) { looks = true; cnt++; j++; }
          else { looks = false; break; }
        }
        if (looks && j < bytes.length && bytes[j] === 0x00) {
          const s = readCString(bytes, next);
          value = s.text; next = s.next;
        } else if (next + 4 <= bytes.length) {
          value = u32le(bytes, next); next += 4;
        } else {
          break;
        }
      }
      out.push({ id, type, value });
      i = next;
    }
    return out;
  }

  function tlvToMap(rows){
    const map = {};
    for (const r of rows) {
      const k = '0x' + r.id.toString(16).padStart(4, '0');
      if (map[k] === undefined) map[k] = r.value;
      else if (Array.isArray(map[k])) map[k].push(r.value);
      else map[k] = [map[k], r.value];
    }
    map._raw = rows;
    return map;
  }

  function extractRcpBytesFromXml(xmlText){
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const str = doc.querySelector('str')?.textContent?.trim();
    if (!str) throw new Error('No se encontró <str> en XML RCP');
    return hexStrToBytes(str);
  }

  function extractCommandHex(xmlText){
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const hx = doc.querySelector('hex')?.textContent?.trim();
    return hx ? hx.toLowerCase() : null;
  }

  // API pública
  window.RCP = {
    extractRcpBytesFromXml,
    parseRcpTLV,
    tlvToMap,
    extractCommandHex,
  };
})();
