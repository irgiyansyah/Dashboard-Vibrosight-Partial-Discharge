import { useEffect, useState } from 'react';

const API = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000')
  .replace(/\/+$/, '');

const IMPORT_TYPES = [
  ['generic', 'Format umum · TimeStamp dan tag'],
  ['tgb', 'Getaran TGB Larona'],
  ['voltage', 'Tegangan generator'],
  ['current', 'Arus generator'],
  ['wicket-gate', 'Wicket gate'],
  ['speed', 'Kecepatan generator'],
  ['power', 'Daya MW / MVAr'],
  ['temperature', 'Temperatur bearing dan oli'],
];

const prefixOf = (tag) => /^U-(KGS[12]|BGS[12]|LGS[123])(?:_|-)/.exec(tag)?.[1];
const count = (value) => value == null ? '—' : value.toLocaleString('id-ID');
const formatDate = new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeZone: 'UTC' });

async function sendImport(type, action, form) {
  const root = type === 'generic' ? '/api/imports' : `/api/imports/${type}`;
  let response;
  try {
    response = await fetch(`${API}${root}/${action}`, { method: 'POST', body: form });
  } catch {
    throw new Error(action === 'commit'
      ? 'Koneksi terputus. Cek data atau batch impor sebelum mencoba lagi.'
      : 'Backend belum bisa dihubungi. Periksa apakah FastAPI berjalan.');
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== 'ok' || !body.data) {
    const detail = typeof body?.detail === 'string' ? body.detail : '';
    throw new Error(detail || `Impor gagal (HTTP ${response.status}).`);
  }
  return body;
}

export default function DataTransfer({ units }) {
  const [type, setType] = useState('generic');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [unitMap, setUnitMap] = useState({});
  const [reviewTags, setReviewTags] = useState([]);
  const [vibrationTags, setVibrationTags] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmedCelsius, setConfirmedCelsius] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [exportPlant, setExportPlant] = useState('');
  const [exportUnit, setExportUnit] = useState('');
  const [exportLayout, setExportLayout] = useState('wide');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [exportPeriod, setExportPeriod] = useState(null);
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);

  const exportPlants = [...new Set(units.map((unit) => unit.plant))];
  const exportUnits = units.filter((unit) => unit.plant === exportPlant);

  useEffect(() => {
    if (!exportUnit) return;

    const controller = new AbortController();

    async function findLatestDate() {
      try {
        const response = await fetch(
          `${API}/api/units/${encodeURIComponent(exportUnit)}/parameters`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error('Tanggal pengukuran belum bisa dibaca.');
        const body = await response.json();
        if (!Array.isArray(body.data)) throw new Error('Daftar kanal belum bisa dibaca.');

        const latest = body.data.reduce((day, channel) => {
          const date = String(channel.latest_time ?? '').slice(0, 10);
          return /^\d{4}-\d{2}-\d{2}$/.test(date) && date > day ? date : day;
        }, '');

        if (controller.signal.aborted) return;
        setExportPeriod({
          unitId: exportUnit,
          note: latest
            ? `Data terbaru tersedia pada ${formatDate.format(new Date(latest))}.`
            : 'Belum ada pengukuran untuk unit ini.',
        });
        if (latest) {
          setStartDate((current) => current || latest);
          setEndDate((current) => current || latest);
        }
      } catch {
        if (!controller.signal.aborted) {
          setExportPeriod({
            unitId: exportUnit,
            note: 'Tanggal pengukuran belum bisa dibaca. Kamu bisa memilih tanggal secara manual.',
          });
        }
      }
    }

    void findLatestDate();
    return () => controller.abort();
  }, [exportUnit]);

  function changeExportUnit(unitId) {
    setExportUnit(unitId);
    setStartDate('');
    setEndDate('');
    setExportPeriod(null);
    setExportError('');
  }

  async function downloadCsv(event) {
    event.preventDefault();
    if (!exportUnit || !startDate || !endDate || exporting) return;

    setExportError('');
    setExporting(true);

    try {
      const url = new URL(`${API}/api/exports/measurements`, window.location.href);
      url.search = new URLSearchParams({
        unit_id: exportUnit,
        start_date: startDate,
        end_date: endDate,
        layout: exportLayout,
      }).toString();

      const check = new URL(url);
      check.searchParams.set('check_only', 'true');
      const response = await fetch(check, { cache: 'no-store' });
      const body = await response.json().catch(() => null);

      if (response.ok && body?.status === 'ok' && body.layout !== exportLayout) {
        throw new Error('Versi backend belum mendukung pilihan format ekspor ini.');
      }
      if (!response.ok || body?.status !== 'ok') {
        throw new Error(typeof body?.detail === 'string'
          ? body.detail
          : 'Ekspor belum bisa dimulai. Periksa backend.');
      }

      const link = document.createElement('a');
      link.href = url.toString();
      document.body.append(link);
      link.click();
      link.remove();
    } catch (failure) {
      setExportError(failure instanceof TypeError
        ? 'Backend belum bisa dihubungi. Periksa koneksi, lalu coba lagi.'
        : failure.message);
    } finally {
      setExporting(false);
    }
  }

  const generic = type === 'generic';
  const channels = preview?.channels ?? preview?.tables ?? [];
  const prefixes = [...new Set(channels.map(({ tag_name }) => prefixOf(tag_name)).filter(Boolean))];
  const mappedIds = prefixes.map((prefix) => unitMap[prefix]);
  const mappingValid = !generic || (
    channels.length > 0
    && channels.every(({ tag_name }) => prefixOf(tag_name))
    && mappedIds.every((id) => units.some((unit) => unit.id === id))
    && new Set(mappedIds).size === mappedIds.length
    && !preview?.duplicate_timestamps
  );

  function resetPreview() {
    setPreview(null);
    setResult(null);
    setError('');
    setUnitMap({});
    setReviewTags([]);
    setVibrationTags([]);
    setConfirmed(false);
    setConfirmedCelsius(false);
  }

  function updateTag(setter, tag, checked) {
    setter((current) => checked ? [...current, tag] : current.filter((item) => item !== tag));
    setConfirmed(false);
  }

  async function previewImport(event) {
    event.preventDefault();
    if (!file || busy) return;

    resetPreview();
    setBusy('Memeriksa file…');
    try {
      const form = new FormData();
      form.set('file', file);
      const body = await sendImport(type, 'preview', form);
      const data = body.data;
      if (body.database_written !== false || !/^[0-9a-f]{64}$/i.test(data.source_sha256)) {
        throw new Error('Respons preview tidak sesuai. Periksa konfigurasi backend.');
      }

      if (generic) {
        const suggested = {};
        for (const channel of data.channels ?? []) {
          const prefix = prefixOf(channel.tag_name);
          if (prefix && channel.suggested_unit_id) {
            suggested[prefix] = channel.suggested_unit_id;
          }
        }
        setUnitMap(suggested);
      }
      setPreview(data);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  async function commitImport() {
    if (!file || !preview || !mappingValid || !confirmed || busy || result) return;

    setError('');
    setBusy('Mengimpor ke database…');
    try {
      const form = new FormData();
      form.set('file', file);

      if (generic) {
        form.set('config_json', JSON.stringify({
          source_sha256: preview.source_sha256,
          mapping_confirmed: true,
          unit_map: Object.fromEntries(prefixes.map((prefix) => [prefix, unitMap[prefix]])),
          review_tags: reviewTags,
          vibration_tags: vibrationTags,
        }));
      } else {
        form.set('source_sha256', preview.source_sha256);
        form.set('mapping_confirmed', 'true');
        if (type === 'temperature' && confirmedCelsius) form.set('engineering_unit', '°C');
      }

      const body = await sendImport(type, 'commit', form);
      if (body.database_written !== true) {
        throw new Error('Status impor belum bisa dikonfirmasi. Periksa batch sebelum mencoba lagi.');
      }
      setResult(body.data);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="hdt">
      <style>{STYLES}</style>

      <div className="hdt-grid">
        <section className="panel hdt-card">
          <header>
            <h2>Impor ke database</h2>
            <p>Periksa pemetaan kanal sebelum menyimpan pengukuran.</p>
          </header>

          <form className="hdt-form" onSubmit={previewImport}>
            <label className="hdt-field">
              Jenis impor
              <select
                value={type}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  setType(event.target.value);
                  resetPreview();
                }}
              >
                {IMPORT_TYPES.map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </label>

            <label className="hdt-field">
              File pengukuran
              <input
                type="file"
                accept=".xls,.html,.htm"
                aria-describedby="hdt-file-formats"
                disabled={Boolean(busy)}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  resetPreview();
                }}
              />
            </label>

            <div className="hdt-actions">
              <small id="hdt-file-formats">.xls, .html, .htm</small>
              <button className="hdt-button" type="submit" disabled={!file || Boolean(busy)}>
                Pratinjau
              </button>
            </div>
          </form>

          {!preview && busy && <p className="hdt-notice" role="status">{busy}</p>}
          {!preview && error && <p className="hdt-notice hdt-error" role="alert">{error}</p>}
        </section>

        <section className="panel hdt-card">
          <header>
            <h2>Ekspor CSV</h2>
            <p>Unduh pengukuran menurut PLTA, unit, dan rentang tanggal.</p>
          </header>

          <form className="hdt-form" onSubmit={downloadCsv}>
            <div className="hdt-dates">
              <label className="hdt-field">
                PLTA
                <select
                  name="plant"
                  value={exportPlant}
                  disabled={exporting}
                  onChange={(event) => {
                    setExportPlant(event.target.value);
                    changeExportUnit('');
                  }}
                  required
                >
                  <option value="" disabled>Pilih PLTA</option>
                  {exportPlants.map((plant) => (
                    <option key={plant} value={plant}>{plant}</option>
                  ))}
                </select>
              </label>
              <label className="hdt-field">
                Unit
                <select
                  name="unit_id"
                  value={exportUnit}
                  onChange={(event) => changeExportUnit(event.target.value)}
                  disabled={!exportPlant || exporting}
                  required
                >
                  <option value="" disabled>Pilih unit</option>
                  {exportUnits.map((unit) => (
                    <option key={unit.id} value={unit.id}>{unit.id} · {unit.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="hdt-field">
              Format CSV
              <select
                name="layout"
                value={exportLayout}
                disabled={exporting}
                onChange={(event) => {
                  setExportLayout(event.target.value);
                  setExportError('');
                }}
              >
                <option value="wide">Per waktu · parameter sebagai kolom</option>
                <option value="detail">Detail · satu baris per kanal</option>
              </select>
            </label>

            <div className="hdt-dates">
              <label className="hdt-field">
                Tanggal awal
                <input
                  type="date"
                  name="start_date"
                  value={startDate}
                  disabled={exporting}
                  required
                  onChange={(event) => {
                    setStartDate(event.target.value);
                    setExportError('');
                  }}
                />
              </label>

              <label className="hdt-field">
                Tanggal akhir
                <input
                  type="date"
                  name="end_date"
                  value={endDate}
                  min={startDate || undefined}
                  disabled={exporting}
                  required
                  onChange={(event) => {
                    setEndDate(event.target.value);
                    setExportError('');
                  }}
                />
              </label>
            </div>

            <div className="hdt-actions">
              <small>Tanggal akhir ikut disertakan.</small>
              <button className="hdt-button" type="submit" disabled={!exportUnit || !startDate || !endDate || exporting}>
                {exporting ? 'Memeriksa data…' : 'Unduh CSV'}
              </button>
            </div>
          </form>

          {exportUnit && (
            <p className="hdt-notice" role="status">
              {exportPeriod?.unitId === exportUnit ? exportPeriod.note : 'Memeriksa tanggal pengukuran…'}
            </p>
          )}
          {exportError && <p className="hdt-notice hdt-error" role="alert">{exportError}</p>}
        </section>
      </div>

      {preview && (
        <section className="panel hdt-card hdt-preview">
          <header>
            <h2>Pratinjau impor</h2>
            <p>{preview.source_filename || file.name}</p>
          </header>

          <p className="hdt-summary">
            {preview.start_time} → {preview.end_time} · {count(preview.row_count)} baris ·{' '}
            {count(preview.channel_count)} kanal
          </p>

          {generic && prefixes.length > 0 && (
            <div className="hdt-mapping">
              {prefixes.map((prefix) => (
                <label key={prefix} className="hdt-field">
                  Unit untuk {prefix}
                  <select
                    value={unitMap[prefix] || ''}
                    disabled={Boolean(busy) || Boolean(result)}
                    onChange={(event) => {
                      setUnitMap({ ...unitMap, [prefix]: event.target.value });
                      setConfirmed(false);
                    }}
                  >
                    <option value="">Pilih unit</option>
                    {units.map((unit) => (
                      <option key={unit.id} value={unit.id}>{unit.id} · {unit.plant}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}

          <div className="hdt-table" role="region" aria-label="Pemetaan kanal pengukuran" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th>Kanal</th>
                  <th>Unit</th>
                  <th>Nilai kosong</th>
                  <th>Nilai invalid</th>
                  {generic && <><th>Tandai suspect</th><th>Kanal getaran</th></>}
                </tr>
              </thead>
              <tbody>
                {channels.map((channel, index) => {
                  const tag = channel.tag_name;
                  const unitId = generic
                    ? unitMap[prefixOf(tag)]
                    : channel.suggested_unit_id ?? channel.unit_id;

                  return (
                    <tr key={tag || index}>
                      <td>{tag || '—'}{channel.empty ? ' · tabel kosong' : ''}</td>
                      <td>{unitId || '—'}</td>
                      <td>{count(channel.missing_count)}</td>
                      <td>{count(channel.invalid_count)}</td>
                      {generic && (
                        <>
                          <td>
                            <input
                              type="checkbox" aria-label={`Tandai ${tag} suspect`}
                              checked={reviewTags.includes(tag)}
                              disabled={Boolean(busy) || Boolean(result)}
                              onChange={(event) => updateTag(setReviewTags, tag, event.target.checked)}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox" aria-label={`Kanal getaran ${tag}`}
                              checked={vibrationTags.includes(tag)}
                              disabled={Boolean(busy) || Boolean(result)}
                              onChange={(event) => updateTag(setVibrationTags, tag, event.target.checked)}
                            />
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {preview.review_note && <p className="hdt-notice">{preview.review_note}</p>}
          {preview.duplicate_policy && <p className="hdt-notice">{preview.duplicate_policy}</p>}
          {!mappingValid && (
            <p className="hdt-notice hdt-error" role="status">
              {preview.duplicate_timestamps
                ? 'Terdapat timestamp duplikat. Periksa file sumber.'
                : 'Setiap awalan tag harus didukung dan dipetakan ke unit yang berbeda.'}
            </p>
          )}

          {type === 'temperature' && (
            <label className="hdt-check">
              <input
                type="checkbox" checked={confirmedCelsius}
                disabled={Boolean(busy) || Boolean(result)}
                onChange={(event) => {
                  setConfirmedCelsius(event.target.checked);
                  setConfirmed(false);
                }}
              />
              Satuan °C sudah dikonfirmasi
            </label>
          )}

          {!result && (
            <div className="hdt-actions hdt-confirm">
              <label className="hdt-check">
                <input
                  type="checkbox" checked={confirmed}
                  disabled={!mappingValid || Boolean(busy)}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Saya sudah memeriksa pemetaan kanal.
              </label>
              <button
                className="hdt-button" type="button" onClick={commitImport}
                disabled={!confirmed || !mappingValid || Boolean(busy)}
              >
                Impor ke database
              </button>
            </div>
          )}

          {busy && <p className="hdt-notice" role="status">{busy}</p>}
          {error && <p className="hdt-notice hdt-error" role="alert">{error}</p>}
          {result && (
            <p className="hdt-notice hdt-success" role="status">
              Batch {result.import_batch_id ?? '—'} selesai.
              {' '}Ditambahkan {count(result.inserted_count)} · Dilewati {count(result.skipped_count)}
              {' '}· Ditandai {count(result.flagged_count)}.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

const STYLES = `
.hdt {
  --dt-navy: var(--mentor-navy, #14325c);
  --dt-border: #c7d6e5;
  --dt-muted: #536b85;
  display: grid;
  gap: 16px;
  margin-bottom: 16px;
}
.hdt-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 345px), 1fr));
  gap: 16px;
}
.hdt .hdt-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  padding: clamp(16px, 2.2vw, 26px);
  border: 1px solid var(--dt-border);
  border-radius: 12px;
  background: #fff;
  color: var(--dt-navy);
}
.hdt-card h2 { margin: 0; font-size: 19px; line-height: 1.35; }
.hdt-card header p {
  margin: 4px 0 0;
  color: var(--dt-muted);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.hdt-form { display: grid; flex: 1; gap: 14px; }
.hdt-dates, .hdt-mapping { display: grid; gap: 12px; min-width: 0; }
.hdt-dates { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.hdt-mapping {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr));
}
.hdt-field {
  display: grid;
  gap: 6px;
  align-content: start;
  min-width: 0;
  font-size: 13px;
  font-weight: 650;
}
.hdt .hdt-field > :is(select, input) {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--dt-border);
  border-radius: 8px;
  background-color: #f8fafc;
  color: var(--dt-navy);
  font: inherit;
  font-weight: 500;
}
.hdt .hdt-field > input[type="file"] {
  padding: 4px;
  cursor: pointer;
}
.hdt input[type="file"]::file-selector-button {
  height: 34px;
  padding: 0 12px;
  margin-right: 8px;
  border: 0;
  border-radius: 5px;
  background: #e3f1f8;
  color: #12476b;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
.hdt input[type="file"]:not(:disabled):hover::file-selector-button { background: #d4eaf5; }
.hdt .hdt-field > :is(select, input):focus-visible,
.hdt .hdt-button:focus-visible,
.hdt-table:focus-visible {
  outline: 2px solid #1782a9;
  outline-offset: 2px;
}
.hdt-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  align-self: end;
  padding-top: 12px;
  border-top: 1px solid #e4edf5;
}
.hdt-actions small { color: var(--dt-muted); font-size: 12px; }
.hdt .hdt-button {
  min-height: 42px;
  margin: 0;
  padding: 9px 16px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--dt-navy);
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.hdt .hdt-button:hover:not(:disabled) { background: #214a78; }
.hdt .hdt-button:disabled { background: #e4edf5; color: #617b96; opacity: 1; }
.hdt .hdt-summary {
  margin: 0;
  color: var(--dt-muted);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.hdt-table {
  max-height: 360px;
  overflow: auto;
  border: 1px solid #dbe6f1;
  border-radius: 8px;
}
.hdt .hdt-table :is(th, td) { padding: 10px 12px; font-size: 12px; }
.hdt .hdt-table th { position: sticky; top: 0; background: #edf4fa; }
.hdt-check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.hdt input[type="checkbox"] { accent-color: var(--dt-navy); width: 16px; height: 16px; }
.hdt-notice {
  margin: 0;
  padding: 10px 12px;
  border-radius: 7px;
  background: #edf4fa;
  color: #254b6e;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.hdt-error { background: #fff1ef; color: #9c2b26; }
.hdt-success { background: #eaf7ef; color: #195c38; }
@media (max-width: 480px) {
  .hdt-dates { grid-template-columns: 1fr; }
  .hdt .hdt-button { width: 100%; }
}
`;
