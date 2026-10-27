import React, { useMemo, useState } from 'react';
import './HydroMonitoring.css';
import valeLogo from '../assets/vale-logo.png';

const UNITS = [
  ['LRN-01', 'Larona', 1], ['LRN-02', 'Larona', 2], ['LRN-03', 'Larona', 3],
  ['KRB-01', 'Karebbe', 1], ['KRB-02', 'Karebbe', 2],
  ['BLB-01', 'Balambano', 1], ['BLB-02', 'Balambano', 2],
];
const CHANNELS = [
  { id: 'TGB-X', label: 'TGB X', color: '#44dfbd', base: 48 },
  { id: 'TGB-Y', label: 'TGB Y', color: '#44dfbd', base: 41, dashed: true },
  { id: 'UGB-X', label: 'UGB X', color: '#47cfee', base: 36 },
  { id: 'UGB-Y', label: 'UGB Y', color: '#47cfee', base: 30, dashed: true },
  { id: 'LGB-X', label: 'LGB X', color: '#8e9dff', base: 27 },
  { id: 'LGB-Y', label: 'LGB Y', color: '#8e9dff', base: 23, dashed: true },
];
const BEARINGS = ['Turbine Guide Bearing', 'Upper Guide Bearing', 'Lower Guide Bearing'];
// Entirely synthetic fixture. No company data and no network connection.
const DEMO_END = Date.parse('2026-10-25T14:30:00+08:00');
const time = (t, date = false) => new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Makassar', ...(date ? { day: '2-digit', month: 'short' } : {}),
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(t));
const fmt = n => Number.isFinite(n) ? n.toFixed(1) : '—';
function fixture(unitIndex) {
  return Array.from({ length: 289 }, (_, i) => ({
    timestamp: DEMO_END - (288 - i) * 300000,
    values: Object.fromEntries(CHANNELS.map((c, j) => [c.id,
      c.base + unitIndex * 1.7 + 4 * Math.sin(i / 13 + j)
      + 1.8 * Math.sin(i * 1.3 + j) + 11 * Math.exp(-(((i - 218) / 11) ** 2)),
    ])),
  }));
}
function Tag({ children, tone = '' }) {
  return <span className={`hm-tag ${tone}`}><i />{children}</span>;
}
function Empty({ title, children }) {
  return <div className="hm-empty"><span aria-hidden="true">—</span><strong>{title}</strong><p>{children}</p></div>;
}
function Gauge({ channel, value, second, index, hasData }) {
  const radius = 82, length = Math.PI * radius;
  return <section className="hm-panel hm-bearing">
    <div className="hm-bearing-title"><h2>{BEARINGS[index]} <span>({channel.label.slice(0, 3)})</span></h2><i style={{ background: channel.color }} /></div>
    <svg viewBox="0 0 210 124" role="img" aria-label={`${channel.label}: ${fmt(value)} mikrometer peak-to-peak, data demo`}>
      <path d="M23 101 A82 82 0 0 1 187 101" fill="none" stroke="#2a3949" strokeWidth="8" />
      {hasData && <path d="M23 101 A82 82 0 0 1 187 101" fill="none" stroke={channel.color} strokeWidth="8" pathLength={length} strokeDasharray={`${length * Math.min(value / 100, 1)} ${length}`} />}
      <text x="105" y="82" textAnchor="middle" className="hm-gauge-value">{fmt(value)}</text>
      <text x="105" y="101" textAnchor="middle" className="hm-svg-label">µm p-p · X</text>
      <text x="20" y="122" className="hm-svg-label">0</text><text x="177" y="122" className="hm-svg-label">100</text>
    </svg>
    <div className="hm-bearing-bottom"><span>Y <b>{fmt(second)}</b> µm p-p</span><span>Skala demo</span></div>
    <p className="hm-threshold-note">Batas kondisi belum dikonfigurasi</p>
  </section>;
}
function Trend({ rows, visible }) {
  if (!rows.length) return <Empty title="Belum ada data pengukuran">Koneksi VibroSight belum tersedia.</Empty>;
  const w = 840, h = 310, left = 42, right = 18, top = 16, bottom = 34;
  const x = i => left + i / Math.max(1, rows.length - 1) * (w - left - right);
  const y = v => top + (1 - v / 100) * (h - top - bottom);
  return <svg className="hm-trend-svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Tren getaran sintetis dalam mikrometer peak-to-peak. Gunakan legenda untuk memilih kanal.">
    {[0, 25, 50, 75, 100].map(v => <g key={v}><line x1={left} x2={w - right} y1={y(v)} y2={y(v)} stroke="#283647" /><text x={left - 9} y={y(v) + 4} textAnchor="end" className="hm-svg-label">{v}</text></g>)}
    {[0, 1, 2, 3, 4, 5, 6].map(t => {
      const i = Math.round((rows.length - 1) * t / 6);
      return <g key={t}><line x1={x(i)} x2={x(i)} y1={top} y2={h - bottom} stroke="#22303f" /><text x={x(i)} y={h - 10} textAnchor={t === 0 ? 'start' : t === 6 ? 'end' : 'middle'} className="hm-svg-label">{time(rows[i].timestamp)}</text></g>;
    })}
    {CHANNELS.filter(c => visible.includes(c.id)).map(c => <g key={c.id}>
      <polyline points={rows.map((r, i) => `${x(i)},${y(r.values[c.id])}`).join(' ')} fill="none" stroke={c.color} strokeWidth="2" strokeDasharray={c.dashed ? '4 4' : undefined} />
      <circle cx={x(rows.length - 1)} cy={y(rows.at(-1).values[c.id])} r="3.5" fill={c.color}><title>{c.label}: {fmt(rows.at(-1).values[c.id])} µm p-p</title></circle>
    </g>)}
  </svg>;
}

export default function HydroMonitoring() {
  const [unitId, setUnitId] = useState('LRN-01');
  const [hours, setHours] = useState(24);
  const [demo, setDemo] = useState(true);
  const [visible, setVisible] = useState(CHANNELS.map(c => c.id));
  const [expanded, setExpanded] = useState(false);
  const unitIndex = UNITS.findIndex(u => u[0] === unitId), unit = UNITS[unitIndex];
  const rows = useMemo(() => demo ? fixture(unitIndex).filter(r => r.timestamp >= DEMO_END - hours * 3600000) : [], [demo, hours, unitIndex]);
  const last = rows.at(-1);
  const peaks = Object.fromEntries(CHANNELS.map(c => [c.id, rows.length ? Math.max(...rows.map(r => r.values[c.id])) : null]));
  const maxValue = rows.length ? Math.max(...Object.values(peaks)) : null;
  const peakChannel = rows.length ? CHANNELS.find(c => peaks[c.id] === maxValue)?.label : '—';
  const toggle = id => setVisible(v => v.includes(id) ? v.filter(c => c !== id) : [...v, id]);

  return <div className="hm-app">
    <header className="hm-header">
      <a className="hm-brand" href="#monitoring"><span className="hm-brand-mark" aria-hidden="true">≈</span><span>HYDRO <b>INSIGHT</b><small>HYDROELECTRIC OPERATIONS</small></span></a>
      <div className="hm-title"><h1>{unit[1]} Unit {unit[2]}</h1><p>VIBROSIGHT & PARTIAL DISCHARGE MONITORING</p></div>
      <div className="hm-header-controls"><label>UNIT SELECTION<select value={unitId} onChange={e => setUnitId(e.target.value)}>{['Larona', 'Karebbe', 'Balambano'].map(plant => <optgroup key={plant} label={plant}>{UNITS.filter(u => u[1] === plant).map(u => <option key={u[0]} value={u[0]}>{u[1]} · Unit {u[2]}</option>)}</optgroup>)}</select></label><div className="hm-time">WAKTU DATA DEMO<strong>{last ? time(last.timestamp, true) + ' WITA' : '—'}</strong></div></div>
    </header>
    <div className="hm-toolbar"><Tag tone="amber">{demo ? 'DEMO · DATA SINTETIS' : 'TANPA DATA'}</Tag><span className="hm-coverage">3 PLTA <i /> 7 unit <i /> {unitId}</span><span className="hm-connection"><i /> VibroSight belum terhubung</span><label className="hm-demo-toggle"><input type="checkbox" checked={demo} onChange={e => setDemo(e.target.checked)} /> Tampilkan demo</label></div>
    <main id="monitoring" className="hm-main">
      <section className="hm-kpis" aria-label="Ringkasan unit">
        <article className="hm-panel hm-kpi"><div><span>Vibration data</span><small>MECHANICAL</small></div><strong>{demo ? '6 kanal demo' : 'Belum tersedia'}</strong><p>TGB, UGB, LGB · sumbu X & Y</p></article>
        <article className="hm-panel hm-kpi"><div><span>Generator air-gap</span><small>GENERATOR</small></div><strong className="hm-dim">—</strong><p>Menunggu sumber data air-gap</p></article>
        <article className="hm-panel hm-kpi"><div><span>Max vibration · {hours} jam</span><small>DEMO</small></div><strong>{fmt(maxValue)} <em>µm p-p</em></strong><p>{peakChannel} · maksimum seluruh 6 kanal</p></article>
        <article className="hm-panel hm-kpi"><div><span>Partial discharge</span><small>ELECTRICAL</small></div><strong className="hm-dim">—</strong><p>Integrasi PD pada tahap berikutnya</p></article>
      </section>
      <div className={`hm-monitoring ${expanded ? 'hm-expanded' : ''}`}>
        <aside className="hm-bearings" aria-label="Pengukuran bantalan">{[0, 1, 2].map(i => <Gauge key={i} index={i} channel={CHANNELS[i * 2]} value={last?.values[CHANNELS[i * 2].id]} second={last?.values[CHANNELS[i * 2 + 1].id]} hasData={!!last} />)}</aside>
        <section className="hm-panel hm-trend">
          <div className="hm-panel-head"><div><h2>Vibration trend</h2><p>Radial shaft displacement · data sintetis · interval 5 menit</p></div><button className="hm-expand" onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Kembalikan susunan panel' : 'Perbesar panel grafik'} aria-pressed={expanded}>{expanded ? '↙' : '↗'}</button></div>
          <div className="hm-chart-tools"><div className="hm-periods" aria-label="Rentang waktu">{[1, 6, 24].map(h => <button key={h} className={h === hours ? 'is-active' : ''} onClick={() => setHours(h)} aria-pressed={h === hours}>{h} H</button>)}</div><span>{rows.length ? `${time(rows[0].timestamp, true)} — ${time(last.timestamp, true)} WITA` : 'Menunggu data'}</span></div>
          <div className="hm-legend" aria-label="Kanal grafik">{CHANNELS.map(c => <button key={c.id} aria-pressed={visible.includes(c.id)} className={visible.includes(c.id) ? '' : 'is-hidden'} onClick={() => toggle(c.id)}><i style={{ borderColor: c.color, borderStyle: c.dashed ? 'dashed' : 'solid' }} />{c.label}</button>)}</div>
          <p className="hm-axis-caption">Amplitude (peak-to-peak) · µm</p>
          <div className="hm-chart-wrap"><Trend rows={rows} visible={visible} />{rows.length > 0 && !visible.length && <div className="hm-chart-message">Pilih kanal melalui legenda untuk menampilkan tren.</div>}</div>
          <div className="hm-snapshot-heading"><span>CHANNEL SNAPSHOT</span><span>TERAKHIR / MAX {hours} JAM · µm p-p</span></div>
          <div className="hm-snapshots">{CHANNELS.map(c => <div key={c.id}><span style={{ color: c.color }}>{c.label}</span><p>{fmt(last?.values[c.id])} <small>/ {fmt(peaks[c.id])}</small></p></div>)}</div>
          <p className="hm-chart-note">Nilai ilustrasi untuk pengembangan tampilan. Tidak ada penilaian kondisi atau batas alarm operasional.</p>
        </section>
        <aside className="hm-analysis">
          <section className="hm-panel hm-orbit"><div className="hm-panel-head"><div><h2>Shaft orbit · X vs Y</h2><p>TGB · pasangan sinyal tersinkronisasi</p></div><Tag>Belum tersedia</Tag></div><div className="hm-orbit-body"><div className="hm-orbit-grid" aria-hidden="true"><span>Y</span><span>X</span></div><div><strong>Menunggu waveform</strong><p>Orbit memerlukan sinyal X/Y tersinkronisasi. Nilai ringkasan tidak digunakan untuk membentuk orbit.</p></div></div></section>
          <section className="hm-panel hm-pd"><div className="hm-panel-head"><div><h2>Partial discharge analysis</h2><p>Electrical monitoring</p></div></div><Empty title="Integrasi pada tahap berikutnya">Fokus saat ini adalah koneksi real-time VibroSight. Data dan satuan PD belum dikonfigurasi.</Empty><div className="hm-pd-footer"><span>Phase A <b>—</b></span><span>Phase B <b>—</b></span><span>Phase C <b>—</b></span></div></section>
        </aside>
      </div>
      <section className="hm-panel hm-activity"><div className="hm-activity-title"><h2>Monitoring activity</h2><span>STATUS PROTOTIPE</span><Tag tone="amber">Alarm belum terintegrasi</Tag></div><div className="hm-activity-grid"><div><i className="hm-event-dot" /><strong>{unit[1]} Unit {unit[2]} dipilih</strong><p>{demo ? 'Dataset sintetis tersedia untuk 6 kanal' : 'Data demo dinonaktifkan'}</p></div><div><i className="hm-event-dot amber" /><strong>Koneksi sumber belum tersedia</strong><p>Waktu penerimaan dan latensi belum terukur</p></div><div><i className="hm-event-dot blue" /><strong>Metadata perlu dikonfirmasi</strong><p>Satuan, jenis amplitudo, dan batas kondisi</p></div><div className="hm-quality"><strong>{demo ? 'DEMO / BUKAN LIVE' : 'NO DATA'}</strong><p>Riwayat kejadian sumber belum tersedia</p></div></div></section>
      <footer className="hm-footer"><span>PROTOTIPE · Seluruh nilai getaran sintetis. Tidak untuk keputusan operasi.</span><span>{unitId} / UNIT MONITORING</span></footer>
    </main>
  </div>;
}
