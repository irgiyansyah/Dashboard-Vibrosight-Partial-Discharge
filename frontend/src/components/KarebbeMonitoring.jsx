import React, {useEffect, useMemo, useRef, useState} from 'react';
import HydroMonitoring from './HydroMonitoring.jsx';
import valeLogo from '../assets/vale-logo.png';
import {summarize, chartPoints} from './karebbeParser.mjs';
import './KarebbeMonitoring.css';

// Memori tab saja. Bertahan saat berpindah menu, hilang saat reload/tab ditutup.
let session = {data: null, mapping: {KGS1: '', KGS2: ''}};
const DEFAULT_UNITS = [['LRN-01','Larona',1],['LRN-02','Larona',2],['LRN-03','Larona',3],['KRB-01','Karebbe',1],['KRB-02','Karebbe',2],['BLB-01','Balambano',1],['BLB-02','Balambano',2]];
const number = n => Number.isFinite(n) ? n.toLocaleString('id-ID', {maximumFractionDigits: 2}) : '—';
const date = t => new Intl.DateTimeFormat('id-ID',{timeZone:'UTC',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(t);
const label = u => `${u[1]} · ${typeof u[2] === 'number' ? `Unit ${u[2]}` : u[2]}`;
const colors = ['#14325c','#14325c','#147ba5','#147ba5'];
const shortTag = tag => tag.split('_I_')[1]?.replace('-AI','').replaceAll('_',' ') ?? tag.replace(/^U-KGS[12]-/,'').replace(/-AI$/,'');

function Plot({data, columns, start, end, visible}) {
  const active = columns.filter(c => visible.includes(c.tag));
  const stats = active.map(c => summarize(c,start,end)).filter(s => s.count);
  if (!stats.length) return <div className="kh-empty">Pilih kanal yang memiliki data untuk menampilkan grafik.</div>;
  const lo = Math.min(...stats.map(s=>s.min)); const hi = Math.max(...stats.map(s=>s.max));
  const pad = Math.max((hi-lo)*0.1,1), yMin=lo-pad, yMax=hi+pad;
  const x = t => 65+(t-data.times[start])/Math.max(1,data.times[end]-data.times[start])*865;
  const y = v => 20+(yMax-v)/(yMax-yMin)*240;
  return <svg className="kh-chart" viewBox="0 0 960 310" role="img" aria-label="Tren historis getaran. Satuan belum dikonfirmasi. Nilai negatif tetap ditampilkan.">
    {[0,1,2,3,4].map(i=>{const v=yMin+(yMax-yMin)*i/4;return <g key={i}><line x1="65" x2="930" y1={y(v)} y2={y(v)} stroke="#d6e0eb"/><text x="55" y={y(v)+4} textAnchor="end">{number(v)}</text></g>;})}
    {[0,1,2,3,4].map(i=>{const t=data.times[start]+(data.times[end]-data.times[start])*i/4;return <text key={i} x={65+i*865/4} y="287" textAnchor={i===0?'start':i===4?'end':'middle'}>{date(t).replace(/ 2026/,'')}</text>;})}
    {active.map(c=>{let pen=false;const path=chartPoints(data.times,c.values,start,end).map(p=>{if(!p){pen=false;return '';}const cmd=pen?'L':'M';pen=true;return `${cmd}${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`;}).join(' '); const j=columns.indexOf(c);return <path key={c.tag} d={path} fill="none" stroke={colors[j]} strokeWidth="2" strokeDasharray={j%2?'5 4':undefined}/>;})}
  </svg>;
}

export default function KarebbeMonitoring({units=DEFAULT_UNITS, selectedUnitId, onUnitChange}={}) {
  const options=units.length?units:DEFAULT_UNITS;
  const [localId,setLocalId]=useState(options[0][0]);
  const unit=options.find(u=>u[0]===(selectedUnitId??localId))??options[0];
  const [data,setData]=useState(session.data);
  const [mapping,setMapping]=useState(session.mapping);
  const [draft,setDraft]=useState(session.mapping);
  const [busy,setBusy]=useState(false); const [progress,setProgress]=useState(''); const [error,setError]=useState('');
  const [days,setDays]=useState(31); const [hidden,setHidden]=useState([]);
  const worker=useRef(null);
  useEffect(()=>()=>worker.current?.terminate(),[]);
  const karebbe=options.filter(u=>u[1].toLowerCase()==='karebbe');
  const group=Object.keys(mapping).find(k=>mapping[k]===unit[0]);
  const isKarebbe=unit[1].toLowerCase()==='karebbe';
  function select(id){setLocalId(id);onUnitChange?.(id);}
  function importFile(file){
    if(!file)return;
    if(file.size>100*1024*1024){setError('Ukuran maksimum 100 MB.');return;}
    setBusy(true);setError('');setProgress('Membaca file lokal…');
    worker.current?.terminate();
    try {
      const w=new Worker(new URL('./karebbe.worker.js', import.meta.url),{type:'module'});worker.current=w;
      const fail=message=>{setError(message);setBusy(false);setProgress('');w.terminate();worker.current=null;};
      w.onerror=()=>fail('Proses impor gagal. Pastikan seluruh file paket ada di folder components.');
      w.onmessage=({data: msg})=>{
        if(msg.type==='progress')setProgress(`${number(msg.count)} baris diproses…`);
        if(msg.type==='error')fail(msg.message);
        if(msg.type==='done'){
          const initial={KGS1:'',KGS2:''};
          setData(msg.result);setMapping(initial);setDraft(initial);session={data:msg.result,mapping:initial};
          setBusy(false);setProgress('');w.terminate();worker.current=null;
        }
      };w.postMessage(file);
    }catch(e){setError(e.message);setBusy(false);setProgress('');}
  }
  function applyMapping(){
    if(!draft.KGS1||!draft.KGS2||draft.KGS1===draft.KGS2){setError('Pilih dua unit Karebbe yang berbeda untuk KGS1 dan KGS2.');return;}
    setError('');setMapping({...draft});session={data,mapping:{...draft}};select(draft.KGS1);
  }
  function clear(){setData(null);setMapping({KGS1:'',KGS2:''});setDraft({KGS1:'',KGS2:''});session={data:null,mapping:{KGS1:'',KGS2:''}};setError('');}
  const end=data?data.count-1:0;
  const start=useMemo(()=>{if(!data)return 0;const cutoff=data.times[end]-days*86400000+60000;let a=0;while(a<end&&data.times[a]<cutoff)a++;return a;},[data,days,end]);
  const columns=useMemo(()=>data?.columns.filter(c=>c.group===group)??[],[data,group]);
  const vibration=useMemo(()=>columns.filter(c=>c.kind==='vibration').sort((a,b)=>a.tag.localeCompare(b.tag)),[columns]);
  const stats=useMemo(()=>columns.map(c=>({...c,stats:summarize(c,start,end)})),[columns,start,end]);
  const missing=stats.reduce((n,c)=>n+c.stats.missing,0), suspect=stats.reduce((n,c)=>n+c.stats.suspect,0);
  return <div className="kh">
    <section className="kh-import" aria-label="Impor historis Karebbe">
      <div><strong>Data historis Karebbe</strong><p>Impor lokal di browser · belum real-time · data hilang saat refresh/tab ditutup.</p></div>
      <label className="kh-upload">{busy?'Memproses…':'Pilih file Karebbe (.xls)'}<input type="file" accept=".xls,.html,.htm" disabled={busy} onChange={e=>{importFile(e.target.files?.[0]);e.target.value='';}}/></label>
      {data&&<button type="button" className="kh-secondary" disabled={busy} onClick={clear}>Lepas data</button>}
      {busy&&<span role="status">{progress}</span>}
      {error&&<p className="kh-error" role="alert">{error}</p>}
      {data&&<div className="kh-mapping">
        <p><b>{data.name}</b> · {number(data.count)} timestamp · {date(data.times[0])} sampai {date(data.times[end])}. Format sumber MM/DD/YYYY, timezone belum dikonfirmasi.</p>
        <div className="kh-controls"><span>Petakan tag sumber:</span>{['KGS1','KGS2'].map(g=><label key={g}>{g}<select aria-label={`Pemetaan ${g}`} value={draft[g]} onChange={e=>setDraft({...draft,[g]:e.target.value})}><option value="">Pilih unit tujuan</option>{karebbe.map(u=><option key={u[0]} value={u[0]}>{label(u)}</option>)}</select></label>)}<button type="button" onClick={applyMapping} disabled={busy}>Terapkan pemetaan</button></div>
        {data.gaps>0&&<p className="kh-error">Ada {number(data.gaps)} interval yang bukan 1 menit. Grafik tidak menyambungkan gap waktu.</p>}
      </div>}
    </section>
    {!isKarebbe?<><p className="kh-other">Historis Karebbe tersedia setelah impor dan pemetaan. Unit ini tetap menggunakan tampilan prototipe sebelumnya.</p><HydroMonitoring units={options} selectedUnitId={unit[0]} onUnitChange={select}/></>:<>
      <header className="kh-header"><img src={valeLogo} alt="PT Vale Indonesia"/><div><h1>{label(unit)}</h1><p>HISTORICAL MONITORING · BUKAN LIVE</p></div><label>Unit<select aria-label="Unit monitoring historis" value={unit[0]} onChange={e=>select(e.target.value)}>{options.map(u=><option key={u[0]} value={u[0]}>{label(u)}</option>)}</select></label></header>
      {!data||!group?<section className="kh-empty"><h2>{data?'Terapkan pemetaan unit':'Belum ada data historis'}</h2><p>Pilih file Karebbe, lalu petakan KGS1 dan KGS2 ke unit yang sesuai. Data demo tidak digunakan pada tampilan historis ini.</p></section>:<div className="kh-content">
        <div className="kh-controls"><label>Rentang sampai akhir file<select aria-label="Rentang historis" value={days} onChange={e=>setDays(Number(e.target.value))}><option value={1}>24 jam terakhir</option><option value={7}>7 hari terakhir</option><option value={31}>31 hari terakhir</option></select></label><span>{date(data.times[start])} — {date(data.times[end])}</span></div>
        <section className="kh-kpis"><article><span>Timestamp dalam rentang</span><strong>{number(end-start+1)}</strong><small>Waktu sumber, timezone belum dikonfirmasi</small></article><article><span>Kanal unit</span><strong>4 getaran · 5 temperatur</strong><small>{group} → {label(unit)}</small></article><article><span>Data hilang / tidak numerik</span><strong>{number(missing)} sel</strong><small>Ditampilkan sebagai kosong, bukan nol</small></article><article><span>Temperatur bernilai −200</span><strong>{number(suspect)} sel</strong><small>Ditandai meragukan; dikecualikan dari ringkasan</small></article></section>
        <section className="kh-panel"><h2>Tren getaran historis</h2><p>Nilai sumber · satuan dan jenis amplitudo belum dikonfirmasi · belum ada evaluasi alarm</p><div className="kh-legend">{vibration.map((c,j)=><button key={c.tag} type="button" aria-pressed={!hidden.includes(c.tag)} onClick={()=>setHidden(h=>h.includes(c.tag)?h.filter(x=>x!==c.tag):[...h,c.tag])}><i style={{borderColor:colors[j],borderTopStyle:j%2?'dashed':'solid'}}/>{shortTag(c.tag)}</button>)}</div><Plot data={data} columns={vibration} start={start} end={end} visible={vibration.filter(c=>!hidden.includes(c.tag)).map(c=>c.tag)}/><p className="kh-note">Grafik diringkas dengan min/max per kelompok titik untuk menjaga keterbacaan. Ringkasan tabel dihitung dari seluruh baris dalam rentang. Nilai negatif dipertahankan; gap data tidak diisi nol.</p></section>
        <section className="kh-panel"><h2>Nilai kanal dan kualitas data</h2><p>G = kode sumber I_G; T = kode sumber I_T. Lokasi sensor dan satuan belum dikonfirmasi. Tabel memakai nilai asli tanpa konversi.</p><div className="kh-table"><table><thead><tr><th>Tag sumber</th><th>Jenis</th><th>Nilai akhir file</th><th>Minimum*</th><th>Rata-rata*</th><th>Maksimum*</th><th>Hilang</th><th>−200 meragukan</th><th>Negatif numerik*</th></tr></thead><tbody>{stats.map(c=><tr key={c.tag}><td>{c.tag}</td><td>{c.kind==='vibration'?'Getaran':'Temperatur'}</td><td>{c.values[end]===-200&&c.kind==='temperature'?'−200 · meragukan':number(c.values[end])}</td><td>{number(c.stats.min)}</td><td>{number(c.stats.mean)}</td><td>{number(c.stats.max)}</td><td>{number(c.stats.missing)}</td><td>{number(c.stats.suspect)}</td><td>{number(c.stats.negative)}</td></tr>)}</tbody></table></div><p className="kh-note">* Berdasarkan rentang terpilih. N/A/non-numerik dan temperatur −200 dikecualikan. Nilai sumber −200 tetap disimpan di memori dan ditampilkan sebagai meragukan. Arti −200 perlu dikonfirmasi; bukan diagnosis sensor.</p></section>
        <section className="kh-panel"><h2>Integrasi berikutnya</h2><p>PD, air-gap, orbit waveform, status operasi, serta batas alarm belum tersedia dalam sumber ini. Data historis ini belum tersimpan ke MySQL dan belum tersambung ke halaman Historical Data lama.</p></section>
      </div>}
    </>}
  </div>;
}
