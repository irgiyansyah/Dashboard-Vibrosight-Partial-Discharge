// Parser khusus ekspor HTML .xls Karebbe, bukan pembaca XLS biner/XLSX.
// Tidak memasukkan HTML sumber ke DOM dan tidak menjalankan script sumber.
const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').trim();
export function parseKarebbe(text, progress = () => {}) {
  if (!/<table\b/i.test(text)) throw new Error('Format harus tabel HTML ekspor .xls Karebbe. XLS biner/XLSX belum didukung.');
  const rows = text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  const cells = (row) => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => strip(m[1]));
  const first = rows.next();
  if (first.done) throw new Error('Tabel tidak memiliki baris.');
  const headers = cells(first.value[1]);
  if (headers[0]?.toLowerCase() !== 'timestamp') throw new Error('Kolom pertama harus TimeStamp.');
  if (new Set(headers).size !== headers.length) throw new Error('Nama kolom duplikat.');
  const required = [];
  for (const unit of ['KGS1', 'KGS2']) {
    for (const part of ['G', 'T']) for (const axis of ['X', 'Y']) required.push(`U-${unit}_I_${part}_VIB_${axis}_AXIS-AI`);
    for (const suffix of ['TGB-oil-temp-AI', 'TGB-Pad1-AI', 'TGB-Pad2-AI', 'TGB-Pad3-AI', 'Turb_Guide_Bear_Oil_Temp-AI']) required.push(`U-${unit}-${suffix}`);
  }
  if (headers.length !== 19 || required.some(h => !headers.includes(h))) throw new Error('Diperlukan 18 tag KGS1/KGS2 sesuai contoh Karebbe. Struktur file berbeda.');
  const columns = headers.slice(1).map(tag => ({tag, group: tag.includes('KGS1') ? 'KGS1' : 'KGS2', kind: tag.includes('_VIB_') ? 'vibration' : 'temperature', values: [], missing: 0, suspect: 0, negative: 0}));
  const times = []; let previous; let gaps = 0;
  for (const row of rows) {
    const c = cells(row[1]);
    if (c.length !== headers.length) throw new Error(`Jumlah kolom salah di baris data ${times.length + 1}.`);
    const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(c[0]);
    if (!m) throw new Error(`Timestamp tidak valid: ${c[0]}. Gunakan MM/DD/YYYY HH:mm:ss.`);
    const [, mo, day, year, hh, mm, ss] = m.map(Number);
    // UTC dipakai hanya sebagai koordinat waktu sumber tanpa konversi timezone.
    const t = Date.UTC(year, mo - 1, day, hh, mm, ss); const d = new Date(t);
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== day || d.getUTCHours() !== hh || d.getUTCMinutes() !== mm || d.getUTCSeconds() !== ss) throw new Error(`Tanggal di luar rentang: ${c[0]}.`);
    if (previous !== undefined && t <= previous) throw new Error('Timestamp duplikat atau tidak berurutan. Periksa file sumber.');
    if (previous !== undefined && t - previous !== 60000) gaps++;
    previous = t; times.push(t);
    columns.forEach((col, i) => {
      const raw = c[i + 1];
      const n = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ? Number(raw) : NaN;
      if (!Number.isFinite(n)) col.missing++;
      if (Number.isFinite(n) && col.kind === 'temperature' && n === -200) col.suspect++;
      if (Number.isFinite(n) && col.kind === 'vibration' && n < 0) col.negative++;
      col.values.push(n); // -200 tetap tersimpan sebagai nilai sumber.
    });
    if (times.length > 100000) throw new Error('Batas impor 100.000 timestamp per file.');
    if (times.length % 5000 === 0) progress(times.length);
  }
  if (!times.length) throw new Error('File tidak memiliki data pengukuran.');
  return {times: new Float64Array(times), columns: columns.map(c => ({...c, values: new Float64Array(c.values)})), gaps, count: times.length};
}

export function summarize(col, start, end) {
  let min = Infinity, max = -Infinity, sum = 0, count = 0, missing = 0, suspect = 0, negative = 0;
  for (let i = start; i <= end; i++) {
    const v = col.values[i];
    if (!Number.isFinite(v)) { missing++; continue; }
    if (col.kind === 'temperature' && v === -200) { suspect++; continue; }
    if (v < 0) negative++;
    min = Math.min(min, v); max = Math.max(max, v); sum += v; count++;
  }
  return {min: count ? min : null, max: count ? max : null, mean: count ? sum / count : null, count, missing, suspect, negative};
}

// Pertahankan min/max tiap bucket dan putuskan garis pada data hilang/gap waktu.
export function chartPoints(times, values, start, end, budget = 700) {
  const step = Math.max(1, Math.ceil((end - start + 1) / budget)); const points = [];
  for (let a = start; a <= end; a += step) {
    const b = Math.min(a + step - 1, end); let minI = a, maxI = a; let broken = false;
    for (let i = a; i <= b; i++) {
      if (!Number.isFinite(values[i]) || (i > start && times[i] - times[i - 1] > 60000)) broken = true;
      if (values[i] < values[minI]) minI = i;
      if (values[i] > values[maxI]) maxI = i;
    }
    if (broken) { points.push(null); continue; }
    for (const i of [...new Set([a, minI, maxI, b])].sort((x, y) => x - y)) points.push([times[i], values[i]]);
  }
  return points;
}
