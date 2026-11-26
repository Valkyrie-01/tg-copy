// Распаковка данных из адреса Mini App: base64url → raw deflate → UTF-8 текст.
// Копия функций из copy.html (b64urlToBytes, inflateRaw, unpack): digest.html берёт их отсюда,
// copy.html пока держит свою копию — её не трогали, чтобы не рисковать окном /ask.
// Предел MAX_OUT — короткий адрес не развернётся в бомбу.
"use strict";
(function () {
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── raw inflate (RFC 1951) без зависимостей: для клиентов без DecompressionStream ──
const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEXT = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DEXT = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const CLORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
const MAX_OUT = 262144;          // 256 КБ текста — с запасом на сотни строк

function inflateRaw(src) {
  let pos = 0, buf = 0, cnt = 0;
  const out = [];
  function bits(n) {
    while (cnt < n) {
      if (pos >= src.length) throw new Error("данные оборваны");
      buf |= src[pos++] << cnt; cnt += 8;
    }
    const v = buf & ((1 << n) - 1);
    buf >>>= n; cnt -= n;
    return v;
  }
  function huff(lengths) {
    const count = new Array(16).fill(0), offs = new Array(16).fill(0), sym = [];
    for (const l of lengths) count[l]++;
    count[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    lengths.forEach((l, i) => { if (l) sym[offs[l]++] = i; });
    return { count, sym };
  }
  function decode(h) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error("битый код Хаффмана");
  }
  function grow() { if (out.length > MAX_OUT) throw new Error("данных больше предела"); }
  function codes(lit, dist) {
    for (;;) {
      const s = decode(lit);
      if (s < 256) { out.push(s); grow(); continue; }
      if (s === 256) return;
      const i = s - 257;
      if (i >= LBASE.length) throw new Error("битый код длины");
      const len = LBASE[i] + bits(LEXT[i]);
      const d = decode(dist);
      if (d >= DBASE.length) throw new Error("битый код расстояния");
      const back = DBASE[d] + bits(DEXT[d]);
      if (back > out.length) throw new Error("ссылка за начало данных");
      for (let k = 0; k < len; k++) out.push(out[out.length - back]);
      grow();
    }
  }
  let fixedLit = null, fixedDist = null;
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      buf = 0; cnt = 0;
      if (pos + 4 > src.length) throw new Error("данные оборваны");
      const len = src[pos] | (src[pos + 1] << 8);
      const nlen = src[pos + 2] | (src[pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error("битый блок без сжатия");
      pos += 4;
      if (pos + len > src.length) throw new Error("данные оборваны");
      for (let k = 0; k < len; k++) out.push(src[pos++]);
      grow();
    } else if (type === 1) {
      if (!fixedLit) {
        const l = [];
        for (let i = 0; i < 288; i++) l.push(i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8);
        fixedLit = huff(l); fixedDist = huff(new Array(30).fill(5));
      }
      codes(fixedLit, fixedDist);
    } else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const cl = new Array(19).fill(0);
      for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
      const clh = huff(cl), lens = [];
      while (lens.length < nlen + ndist) {
        const s = decode(clh);
        if (s < 16) lens.push(s);
        else if (s === 16) {
          if (!lens.length) throw new Error("повтор без предыдущей длины");
          const prev = lens[lens.length - 1];
          for (let r = 3 + bits(2); r > 0; r--) lens.push(prev);
        } else if (s === 17) for (let r = 3 + bits(3); r > 0; r--) lens.push(0);
        else for (let r = 11 + bits(7); r > 0; r--) lens.push(0);
      }
      codes(huff(lens.slice(0, nlen)), huff(lens.slice(nlen, nlen + ndist)));
    } else throw new Error("неизвестный тип блока");
  }
  return new Uint8Array(out);
}

async function unpack(param) {
  const bytes = b64urlToBytes(param);
  let native = null;
  try { native = new DecompressionStream("deflate-raw"); } catch (e) { /* старый движок */ }
  if (native) {
    // Встроенный путь есть — его ответ окончательный: битые данные не отдаются запасному
    // распаковщику на второй круг. Читаем кусками, чтобы оборвать бомбу на MAX_OUT.
    const reader = new Blob([bytes]).stream().pipeThrough(native).getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_OUT) { reader.cancel(); throw new Error("данных больше предела"); }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    return new TextDecoder("utf-8").decode(all);
  }
  return new TextDecoder("utf-8").decode(inflateRaw(bytes));
}
window.__unpack = { unpack, inflateRaw, MAX_OUT };
})();
