import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import './HydroMonitoring.css';

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'
).replace(/\/$/, '');

const UNITS = [
  ['LRN-01', 'Larona', 1],
  ['LRN-02', 'Larona', 2],
  ['LRN-03', 'Larona', 3],
  ['KRB-01', 'Karebbe', 1],
  ['KRB-02', 'Karebbe', 2],
  ['BLB-01', 'Balambano', 1],
  ['BLB-02', 'Balambano', 2],
];

const PENDING_PARAMETERS = [
  ['Daya aktif', 'MW'],
  ['Daya reaktif', 'MVAr'],
  ['Voltage', 'Tegangan'],
  ['Current / Arus', 'Arus generator'],
  ['Gap', 'Definisi gap perlu dikonfirmasi'],
  ['Wicket Gate Position', 'Posisi bukaan'],
];

function number(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('id-ID', {
        maximumFractionDigits: 2,
      }).format(value)
    : '—';
}

function time(value) {
  return value
    ? String(value).replace('T', ' ').slice(0, 19)
    : '—';
}

function unitName(unit) {
  return typeof unit[2] === 'number'
    ? `Unit ${unit[2]}`
    : unit[2];
}

function label(parameter) {
  return parameter.display_name || parameter.tag_name;
}

// Pengelompokan sementara berdasarkan tag.
// Ini bukan verifikasi satuan atau lokasi sensor.
function category(parameter) {
  if (parameter.measurement_type === 'vibration') {
    return 'vibration';
  }

  if (parameter.measurement_type === 'temperature') {
    return 'temperature';
  }

  const tag = parameter.tag_name || '';

  if (/VIB/i.test(tag)) return 'vibration';
  if (/TEMP|TMP|TGB-Pad|_TE_/i.test(tag)) return 'temperature';
  if (/SPEED/i.test(tag)) return 'speed';

  return 'other';
}

function nextDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';

  // UTC hanya untuk menghitung tanggal berikutnya.
  // Waktu pengukuran tidak dikonversi.
  const date = new Date(`${day}T00:00:00Z`);

  if (!Number.isFinite(date.getTime())) return '';

  date.setUTCDate(date.getUTCDate() + 1);

  return date.toISOString().slice(0, 10);
}

function secondsOfDay(value) {
  const parts = String(value)
    .slice(11)
    .split(':')
    .map(Number);

  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function clock(value) {
  const seconds = Math.max(0, Math.floor(Number(value)));

  const hours = String(
    Math.floor(seconds / 3600),
  ).padStart(2, '0');

  const minutes = String(
    Math.floor((seconds % 3600) / 60),
  ).padStart(2, '0');

  return `${hours}:${minutes}`;
}

function useApi(path, revision = 0) {
  const key = `${path}|${revision}`;

  const [state, setState] = useState({
    key: '',
    value: null,
    error: '',
  });

  useEffect(() => {
    if (!path) return;

    const controller = new AbortController();
    let active = true;
    let timedOut = false;

    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20000);

    async function load() {
      try {
        const response = await fetch(`${API_BASE}${path}`, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(
            `API merespons HTTP ${response.status}.`,
          );
        }

        const value = await response.json();

        if (
          value.status !== 'ok' ||
          !Array.isArray(value.data)
        ) {
          throw new Error('Format respons API tidak sesuai.');
        }

        if (active) {
          setState({
            key,
            value,
            error: '',
          });
        }
      } catch (error) {
        if (!active) return;

        setState({
          key,
          value: null,
          error: timedOut
            ? 'Permintaan melebihi 20 detik. Coba muat ulang.'
            : error instanceof Error
              ? error.message
              : 'Gagal membaca API.',
        });
      } finally {
        window.clearTimeout(timer);
      }
    }

    void load();

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [path, key]);

  const current = state.key === key;

  return {
    loading: Boolean(path) && !current,
    value: current ? state.value : null,
    error: current ? state.error : '',
  };
}

function Metric({ title, value, detail }) {
  return (
    <article className="hml-metric">
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function Reading({ parameter, onSelect, selected }) {
  const value =
    parameter.latest_quality === 'unverified'
      ? parameter.latest_plot_value
      : null;

  const quality =
    {
      unverified: 'Belum diverifikasi',
      suspect: 'Perlu ditinjau',
      missing: 'Data kosong',
      invalid: 'Data tidak valid',
    }[parameter.latest_quality] || 'Belum ada data';

  return (
    <article
      className={`hml-reading ${
        selected ? 'is-selected' : ''
      }`}
    >
      <div className="hml-reading-head">
        <strong>{label(parameter)}</strong>

        {onSelect && (
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
          >
            Lihat tren
          </button>
        )}
      </div>

      <p className="hml-reading-value">
        {number(value)}
      </p>

      <small>
        {parameter.engineering_unit ||
          'Satuan belum dikonfirmasi'}
      </small>

      <p className="hml-muted">
        {quality} · {time(parameter.latest_time)}
      </p>
    </article>
  );
}

function History({ parameter, revision }) {
  const [chosenDay, setChosenDay] = useState('');
  const [retry, setRetry] = useState(0);

  const day =
    chosenDay ||
    parameter.latest_time?.slice(0, 10) ||
    '';

  const end = nextDay(day);

  const query = new URLSearchParams({
    start: `${day}T00:00:00`,
    end: `${end}T00:00:00`,
    limit: '5000',
    include_suspect: 'false',
  });

  const path =
    day && end
      ? `/api/parameters/${parameter.channel_id}/history?${query}`
      : '';

  const { loading, value, error } = useApi(
    path,
    `${revision}:${retry}`,
  );

  const summary = value?.analysis?.summary;
  const truncated = value?.pagination?.has_more === true;

  const rows = (value?.data || []).map((row) => ({
    ...row,
    clock: secondsOfDay(row.measured_at),
    plotted:
      row.quality === 'unverified' &&
      Number.isFinite(row.plot_value)
        ? row.plot_value
        : null,
  }));

  const hasPlot = rows.some(
    (row) => row.plotted !== null,
  );

  const engineeringUnit =
    parameter.engineering_unit ||
    'satuan belum dikonfirmasi';

  return (
    <section className="hml-panel hml-history">
      <div className="hml-section-head">
        <div>
          <h2>Tren & analisis getaran</h2>
          <p>{label(parameter)}</p>
        </div>

        <label className="hml-field">
          Tanggal data

          <input
            type="date"
            value={day}
            onChange={(event) =>
              setChosenDay(event.target.value)
            }
          />
        </label>
      </div>

      <p className="hml-note">
        Rentang satu hari, pukul 00:00 sampai sebelum
        00:00 hari berikutnya. Waktu mengikuti file
        sumber; zona waktu belum dikonfirmasi.
      </p>

      {loading && (
        <p className="hml-message" role="status">
          Memuat riwayat pengukuran…
        </p>
      )}

      {error && (
        <div className="hml-message" role="alert">
          <p>{error}</p>

          <button
            type="button"
            onClick={() =>
              setRetry((value) => value + 1)
            }
          >
            Coba lagi
          </button>
        </div>
      )}

      {!path && (
        <p className="hml-message">
          Belum ada tanggal pengukuran untuk parameter ini.
        </p>
      )}

      {value && !summary && (
        <p role="alert">
          Ringkasan analisis tidak ditemukan pada respons API.
        </p>
      )}

      {summary && (
        <>
          <div className="hml-stats">
            <Metric
              title="Minimum"
              value={number(summary.minimum)}
              detail={time(summary.minimum_time)}
            />

            <Metric
              title="Maksimum"
              value={number(summary.maximum)}
              detail={time(summary.maximum_time)}
            />

            <Metric
              title="Rata-rata"
              value={number(summary.average)}
              detail={engineeringUnit}
            />
          </div>

          <p className="hml-note">
            Nilai pengukuran · {engineeringUnit}
          </p>

          {truncated ? (
            <p className="hml-message">
              Riwayat melebihi 5.000 titik. Grafik tidak
              ditampilkan agar tidak memberi kesan seluruh
              hari sudah tergambar. Ringkasan di atas tetap
              mencakup seluruh hari dari API.
            </p>
          ) : hasPlot ? (
            <div
              className="hml-chart"
              role="img"
              aria-label={`Grafik harian ${label(parameter)}`}
            >
              <ResponsiveContainer
                width="100%"
                height="100%"
              >
                <LineChart
                  data={rows}
                  margin={{
                    top: 16,
                    right: 20,
                    bottom: 8,
                    left: 0,
                  }}
                >
                  <CartesianGrid
                    stroke="#d6e0eb"
                    strokeDasharray="3 3"
                  />

                  <XAxis
                    dataKey="clock"
                    type="number"
                    domain={[0, 86400]}
                    ticks={[
                      0,
                      21600,
                      43200,
                      64800,
                      86400,
                    ]}
                    tickFormatter={clock}
                  />

                  <YAxis
                    domain={['auto', 'auto']}
                    width={65}
                    tickFormatter={number}
                  />

                  <Tooltip
                    labelFormatter={clock}
                    formatter={(value) => [
                      number(value),
                      'Nilai pengukuran',
                    ]}
                  />

                  <Line
                    type="linear"
                    dataKey="plotted"
                    stroke="#147ba5"
                    strokeWidth={1.7}
                    dot={false}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="hml-message">
              {summary.total_count === 0
                ? 'Tidak ada pengukuran pada tanggal ini.'
                : 'Tidak ada nilai yang dapat diplot setelah penyaringan kualitas.'}
            </p>
          )}

          <p className="hml-note">
            Dianalisis: {number(summary.analyzed_count)} dari{' '}
            {number(summary.total_count)} pengukuran.
            {' '}Dikecualikan: {number(summary.excluded_count)}.
            {' '}Data berstatus unverified masih memerlukan
            verifikasi.
          </p>

          <div className="hml-notice">
            Batas kondisi belum ditetapkan. Nilai 300 / 400
            dan rentang 50–200 belum digunakan untuk penilaian
            sampai satuan, definisi amplitudo, serta cakupan
            parameternya dikonfirmasi mentor.
          </div>
        </>
      )}
    </section>
  );
}

function UnitData({ unitId }) {
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState(null);

  const { loading, value, error } = useApi(
    `/api/units/${encodeURIComponent(unitId)}/parameters`,
    revision,
  );

  const parameters = value?.data || [];

  const vibrations = parameters.filter(
    (item) => category(item) === 'vibration',
  );

  const temperatures = parameters.filter(
    (item) => category(item) === 'temperature',
  );

  const speeds = parameters.filter(
    (item) => category(item) === 'speed',
  );

  const selected =
    vibrations.find(
      (item) => item.channel_id === selectedId,
    ) || vibrations[0];

  const latest = parameters
    .map((item) => item.latest_time)
    .filter(Boolean)
    .sort()
    .at(-1);

  return (
    <div className="hml-body">
      <div className="hml-statusbar">
        <span className="hml-badge">
          HISTORIS · BUKAN LIVE
        </span>

        <span>
          Waktu data terakhir: {time(latest)}
        </span>

        <button
          type="button"
          onClick={() =>
            setRevision((value) => value + 1)
          }
          disabled={loading}
        >
          Muat ulang data
        </button>
      </div>

      {loading && (
        <p className="hml-message" role="status">
          Membaca data unit dari database…
        </p>
      )}

      {error && (
        <p className="hml-message" role="alert">
          {error} Periksa backend dan layanan database.
        </p>
      )}

      {value && (
        <>
          {!value.has_data && (
            <p className="hml-message">
              Belum ada pengukuran tersimpan untuk unit ini.
            </p>
          )}

          <section
            className="hml-operations"
            aria-label="Parameter operasi"
          >
            {PENDING_PARAMETERS.map(([title, detail]) => (
              <Metric
                key={title}
                title={title}
                value="—"
                detail={`${detail} · belum tersedia`}
              />
            ))}
          </section>

          <div className="hml-layout">
            <section className="hml-panel">
              <h2>Getaran terakhir</h2>

              <p className="hml-note">
                Pilih pengukuran untuk melihat tren hariannya.
              </p>

              <div className="hml-readings">
                {vibrations.map((item) => (
                  <Reading
                    key={item.channel_id}
                    parameter={item}
                    selected={
                      selected?.channel_id === item.channel_id
                    }
                    onSelect={() =>
                      setSelectedId(item.channel_id)
                    }
                  />
                ))}

                {!vibrations.length && (
                  <p className="hml-message">
                    Data getaran belum tersedia.
                  </p>
                )}
              </div>
            </section>

            {selected ? (
              <History
                key={selected.channel_id}
                parameter={selected}
                revision={revision}
              />
            ) : (
              <section className="hml-panel">
                <h2>Tren & analisis getaran</h2>

                <p className="hml-message">
                  Menunggu data pengukuran unit ini.
                </p>
              </section>
            )}
          </div>

          <div className="hml-bottom">
            <section className="hml-panel">
              <h2>Temperatur bantalan & oli</h2>

              <div className="hml-temperature-grid">
                {temperatures.map((item) => (
                  <Reading
                    key={item.channel_id}
                    parameter={item}
                  />
                ))}
              </div>

              {!temperatures.length && (
                <p className="hml-message">
                  Data temperatur belum tersedia.
                </p>
              )}
            </section>

            <section className="hml-panel">
              <h2>Speed</h2>

              {speeds.map((item) => (
                <Reading
                  key={item.channel_id}
                  parameter={item}
                />
              ))}

              {!speeds.length && (
                <p className="hml-message">
                  Data speed belum tersedia.
                </p>
              )}

              <p className="hml-note">
                Satuan mengikuti metadata sumber,
                setelah dikonfirmasi.
              </p>
            </section>
          </div>

          <p className="hml-note">
            Pengelompokan berdasarkan nama tag masih
            sementara. Nilai suspect, missing, dan invalid
            tidak ditampilkan sebagai angka operasi.
            Koneksi live server Vale dan analisis Partial
            Discharge belum aktif.
          </p>
        </>
      )}
    </div>
  );
}

export default function HydroMonitoring({
  units = UNITS,
  selectedUnitId,
  onUnitChange,
} = {}) {
  const [localId, setLocalId] = useState('KRB-01');

  const active =
    units.find(
      (item) =>
        item[0] === (selectedUnitId ?? localId),
    ) || units[0];

  const plants = [
    ...new Set(units.map((item) => item[1])),
  ];

  if (!active) {
    return (
      <div className="hm-app hm-live">
        <p className="hml-message">
          Daftar unit belum tersedia.
        </p>
      </div>
    );
  }

  return (
    <div className="hm-app hm-live">
      <header className="hml-header">
        <div>
          <span className="hml-eyebrow">
            PT VALE INDONESIA TBK · HYDRO INSIGHT
          </span>

          <h1>
            {active[1]} · {unitName(active)}
          </h1>

          <p>VibroSight monitoring & analysis</p>
        </div>

        <label className="hml-field">
          Pilih unit

          <select
            value={active[0]}
            onChange={(event) => {
              setLocalId(event.target.value);
              onUnitChange?.(event.target.value);
            }}
          >
            {plants.map((plant) => (
              <optgroup key={plant} label={plant}>
                {units
                  .filter((item) => item[1] === plant)
                  .map((item) => (
                    <option
                      key={item[0]}
                      value={item[0]}
                    >
                      {item[1]} · {unitName(item)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </header>

      <UnitData
        key={active[0]}
        unitId={active[0]}
      />
    </div>
  );
}