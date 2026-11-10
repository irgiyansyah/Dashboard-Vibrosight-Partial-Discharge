import { useEffect, useMemo, useState } from 'react';

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
import VoltageMetric from './VoltageMetric';

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'
).replace(/\/+$/, '');

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

const RANGE_OPTIONS = [
  { hours: 1, label: '1 H' },
  { hours: 6, label: '6 H' },
  { hours: 24, label: '24 H' },
  { hours: 168, label: '7 D' },
];

const NUMBER_FORMAT = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 2,
});

function number(value) {
  return Number.isFinite(value)
    ? NUMBER_FORMAT.format(value)
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

// Pengelompokan sementara, bukan verifikasi lokasi sensor.
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

  const date = new Date(`${day}T00:00:00Z`);

  if (!Number.isFinite(date.getTime())) return '';
  if (date.toISOString().slice(0, 10) !== day) return '';

  date.setUTCDate(date.getUTCDate() + 1);

  return date.toISOString().slice(0, 10);
}

// UTC hanya digunakan untuk koordinat kalender.
// Jam pengukuran sumber tidak dikonversi.
function sourceTimeMs(value) {
  const source = String(value || '');

  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(
      source,
    )
  ) {
    return NaN;
  }

  return Date.parse(`${source}Z`);
}

function metadataKey(parameter) {
  return JSON.stringify([
    String(parameter.engineering_unit || '').trim(),
    String(parameter.measurement_definition || '').trim(),
  ]);
}

function vibrationStyle(parameter) {
  const tag = String(parameter.tag_name || '').toUpperCase();

  const axis = tag.match(
    /(?:^|[_-])([XYZ])(?:[_-]|$)/,
  )?.[1];

  const bearing = tag.match(
    /(?:^|[_-])(TGB|UGB|LGB)(?:[_-]|$)/,
  )?.[1];

  const sourceGroup = tag.match(
    /(?:^|[_-])I_([GT])_VIB(?:[_-]|$)/,
  )?.[1];

  const fallbackGroup = tag
    .replace(/^U-[^_-]+[_-]/, '')
    .replace(/[_-][XYZ](?:_AXIS)?(?=[_-]|$)/, '')
    .replace(/[_-]AI$/, '');

  const group =
    bearing ||
    sourceGroup ||
    fallbackGroup ||
    `Pengukuran ${parameter.channel_id}`;

  const colors = {
    TGB: '#10b981',
    T: '#10b981',
    UGB: '#0ea5e9',
    G: '#0ea5e9',
    LGB: '#6366f1',
  };

  const fallbackColors = [
    '#8b5cf6',
    '#d97706',
    '#0891b2',
    '#a855f7',
    '#64748b',
  ];

  let hash = 0;

  for (const character of group) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return {
    name: axis ? `${group} ${axis}` : group,
    color: colors[group] || fallbackColors[hash % fallbackColors.length],
    dash: axis === 'Y' ? '5 4' : axis === 'Z' ? '2 4' : undefined,
  };
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
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`API merespons HTTP ${response.status}.`);
        }

        const value = await response.json();

        if (value.status !== 'ok' || !Array.isArray(value.data)) {
          throw new Error('Format respons API tidak sesuai.');
        }

        if (active) {
          setState({ key, value, error: '' });
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

function Reading({
  parameter,
  onSelect,
  selected,
  message = '',
}) {
  const value =
    !message && parameter.latest_quality === 'unverified'
      ? parameter.latest_plot_value
      : null;

  const quality =
    {
      unverified: 'Belum diverifikasi',
      suspect: 'Perlu ditinjau — nilai tidak ditampilkan',
      missing: 'Data kosong',
      invalid: 'Data tidak valid',
    }[parameter.latest_quality] || 'Belum ada data';

  return (
    <article
      className={`hml-reading ${selected ? 'is-selected' : ''}`}
    >
      <div className="hml-reading-head">
        <strong>{label(parameter)}</strong>

        {onSelect && (
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={Boolean(selected)}
          >
            Lihat statistik
          </button>
        )}
      </div>

      <p className="hml-reading-value">{number(value)}</p>

      <small>
        {parameter.engineering_unit || 'Satuan belum dikonfirmasi'}
      </small>

      <p className="hml-muted">
        {message || `${quality} · ${time(parameter.latest_time)}`}
      </p>
    </article>
  );
}

function resolveReading(
  parameter,
  { mode, ready, hasRange, result, error },
) {
  if (mode !== 'analysis') {
    return { parameter, message: '' };
  }

  const empty = {
    ...parameter,
    latest_time: null,
    latest_quality: null,
    latest_value: null,
    latest_plot_value: null,
    latest_raw_value: null,
  };

  if (!hasRange) {
    return {
      parameter: empty,
      message: 'Pilih tanggal analisis.',
    };
  }

  if (!ready) {
    return {
      parameter: empty,
      message: 'Memuat data rentang pilihan…',
    };
  }

  if (error) {
    return {
      parameter: empty,
      message: `Gagal memuat: ${error}`,
    };
  }

  if (!result) {
    return {
      parameter: empty,
      message: 'Riwayat belum tersedia.',
    };
  }

  const last = result.rows.at(-1);

  if (!last) {
    return {
      parameter: empty,
      message: 'Tidak ada data pada rentang ini.',
    };
  }

  return {
    parameter: {
      ...parameter,
      latest_time: last.measured_at,
      latest_quality: last.quality,
      latest_value: last.measured_value,
      latest_raw_value: last.raw_value,
      latest_plot_value:
        last.quality === 'unverified' &&
        Number.isFinite(last.plot_value)
          ? last.plot_value
          : null,
    },
    message: '',
  };
}

function HistoryReadings({
  parameters,
  selectedId,
  onSelect,
  mode,
  ready,
  start,
  end,
  results,
  errors,
}) {
  const isAnalysis = mode === 'analysis';

  return (
    <section className="hml-panel">
      <h2>
        {isAnalysis
          ? 'Nilai terakhir dalam rentang pilihan'
          : 'Getaran terakhir'}
      </h2>

      {!isAnalysis && (
        <p className="hml-note">
          Nilai terbaru yang tersimpan di database.
          Filter tanggal berlaku pada grafik riwayat.
        </p>
      )}

      {isAnalysis && start && end && (
        <p className="hml-note">
          {time(start)} sampai sebelum {time(end)}.
        </p>
      )}

      <div className="hml-readings">
        {parameters.map((item) => {
          const reading = resolveReading(item, {
            mode,
            ready,
            hasRange: Boolean(start && end),
            result: results[item.channel_id],
            error: errors[item.channel_id],
          });

          return (
            <Reading
              key={item.channel_id}
              parameter={reading.parameter}
              message={reading.message}
              selected={selectedId === item.channel_id}
              onSelect={() => onSelect(item.channel_id)}
            />
          );
        })}

        {!parameters.length && (
          <p className="hml-message">
            Data getaran belum tersedia.
          </p>
        )}
      </div>
    </section>
  );
}

async function fetchHistory(channelId, start, end, signal) {
  let firstPage = null;
  let after = null;

  const rows = [];
  const startMs = sourceTimeMs(start);
  const endMs = sourceTimeMs(end);

  while (true) {
    const query = new URLSearchParams({
      start,
      end,
      limit: '5000',
      include_suspect: 'false',
    });

    if (after) query.set('after', after);

    const response = await fetch(
      `${API_BASE}/api/parameters/${channelId}/history?${query}`,
      {
        signal,
        headers: { Accept: 'application/json' },
      },
    );

    if (!response.ok) {
      throw new Error(`API merespons HTTP ${response.status}.`);
    }

    const page = await response.json();

    if (
      page.status !== 'ok' ||
      !Array.isArray(page.data) ||
      !page.analysis?.summary ||
      typeof page.pagination?.has_more !== 'boolean'
    ) {
      throw new Error('Format respons riwayat tidak sesuai.');
    }

    if (!firstPage) firstPage = page;

    for (const row of page.data) {
      const previous = rows[rows.length - 1];
      const timestamp = sourceTimeMs(row.measured_at);

      if (
        !Number.isFinite(timestamp) ||
        timestamp < startMs ||
        timestamp >= endMs ||
        (previous && row.measured_at <= previous.measured_at)
      ) {
        throw new Error(
          'Urutan atau rentang waktu data tidak sesuai. Muat ulang.',
        );
      }

      rows.push(row);
    }

    if (rows.length > 50000) {
      throw new Error(
        'Lebih dari 50.000 titik per pengukuran. Pilih rentang lebih pendek.',
      );
    }

    if (!page.pagination.has_more) break;

    const next = page.pagination.next_after;
    const last = page.data[page.data.length - 1];

    if (
      !last ||
      typeof next !== 'string' ||
      next !== last.measured_at ||
      (after && next <= after)
    ) {
      throw new Error('Halaman lanjutan data tidak valid.');
    }

    after = next;
  }

  if (
    rows.length !== Number(firstPage.analysis.summary.total_count)
  ) {
    throw new Error(
      'Jumlah data berubah atau belum lengkap. Muat ulang riwayat.',
    );
  }

  return {
    summary: firstPage.analysis.summary,
    rows,
  };
}

function buildTimeRange(chosenDay, hours, endHour, latest) {
  const day = chosenDay || latest?.slice(0, 10) || '';
  const endDay = nextDay(day);

  const endMs = endDay
    ? Date.parse(`${endDay}T00:00:00Z`) -
      (24 - endHour) * 3600000
    : NaN;

  const latestDay = latest?.slice(0, 10) || '';
  const latestEndDay = nextDay(latestDay);

  const latestEndMs = latestEndDay
    ? Date.parse(`${latestEndDay}T00:00:00Z`)
    : NaN;

  const startMs = endMs - hours * 3600000;

  const start = Number.isFinite(startMs)
    ? new Date(startMs).toISOString().slice(0, 19)
    : '';

  const end = Number.isFinite(endMs)
    ? new Date(endMs).toISOString().slice(0, 19)
    : '';

  return { day, hours, start, end, startMs, endMs, latestEndMs };
}

function History({
  parameter,
  parameters = [],
  revision,
  mode = 'monitoring',
  onSelect,
  range,
  setChosenDay,
  setHours,
  setEndHour,
}) {
  const [retry, setRetry] = useState(0);
  const [hiddenIds, setHiddenIds] = useState([]);

  const [state, setState] = useState({
    key: '',
    results: {},
    errors: {},
  });

  const selectedMetadata = metadataKey(parameter);

  const series = useMemo(() => {
    const source = parameters.length ? parameters : [parameter];

    return source
      .filter((item) => metadataKey(item) === selectedMetadata)
      .map((item) => ({
        ...item,
        style: vibrationStyle(item),
        dataKey: `channel_${item.channel_id}`,
      }));
  }, [parameters, parameter, selectedMetadata]);

  const readingParameters = parameters.length
    ? parameters
    : [parameter];

  const idsKey = readingParameters
    .map((item) => item.channel_id)
    .sort((a, b) => a - b)
    .join(',');

  const { day, hours, start, end, startMs, endMs, latestEndMs } = range;

  const key = `${idsKey}|${start}|${end}|${revision}|${retry}`;

  useEffect(() => {
    if (!idsKey || !start || !end) return;

    const controller = new AbortController();
    let active = true;
    let timedOut = false;

    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 120000);

    async function load() {
      const ids = idsKey.split(',').map(Number);
      const results = {};
      const errors = {};
      let nextIndex = 0;

      async function worker() {
        while (active && nextIndex < ids.length) {
          const id = ids[nextIndex];
          nextIndex += 1;

          try {
            results[id] = await fetchHistory(
              id,
              start,
              end,
              controller.signal,
            );
          } catch (error) {
            if (!active) return;

            errors[id] = timedOut
              ? 'Pengambilan data melebihi 120 detik.'
              : error instanceof Error
                ? error.message
                : 'Gagal membaca riwayat.';
          }
        }
      }

      try {
        await Promise.all(
          Array.from(
            { length: Math.min(2, ids.length) },
            () => worker(),
          ),
        );

        if (active) {
          setState({ key, results, errors });
        }
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
  }, [idsKey, start, end, key]);

  const current = state.key === key;
  const loading = Boolean(start && end && idsKey) && !current;

  const chartRows = useMemo(() => {
    if (!current) return [];

    const byTime = new Map();

    for (const item of series) {
      const history = state.results[item.channel_id];

      for (const row of history?.rows || []) {
        const timestamp = row.measured_at;

        if (!byTime.has(timestamp)) {
          const point = {
            axisTime: sourceTimeMs(timestamp),
          };

          for (const other of series) {
            point[other.dataKey] = null;
          }

          byTime.set(timestamp, point);
        }

        byTime.get(timestamp)[item.dataKey] =
          row.quality === 'unverified' &&
          Number.isFinite(row.plot_value)
            ? row.plot_value
            : null;
      }
    }

    return [...byTime.values()].sort(
      (a, b) => a.axisTime - b.axisTime,
    );
  }, [current, series, state.results]);

  const visibleSeries = series.filter(
    (item) => !hiddenIds.includes(item.channel_id),
  );

  const hasPlot = chartRows.some((row) =>
    visibleSeries.some((item) =>
      Number.isFinite(row[item.dataKey]),
    ),
  );

  const failedSeries = current
    ? series.filter((item) => state.errors[item.channel_id])
    : [];

  const summary = current
    ? state.results[parameter.channel_id]?.summary
    : null;

  const engineeringUnit =
    parameter.engineering_unit || 'satuan belum dikonfirmasi';

  const metadataUnconfirmed =
    !parameter.engineering_unit ||
    !parameter.measurement_definition;

  const differentMetadataCount = Math.max(
    0,
    parameters.length - series.length,
  );

  const rangeLabel = hours === 168 ? '7 hari' : `${hours} jam`;

  const ticks = Number.isFinite(startMs)
    ? Array.from(
        { length: hours === 168 ? 8 : 5 },
        (_, index) =>
          startMs +
          (index / (hours === 168 ? 7 : 4)) *
            (endMs - startMs),
      )
    : [];

  function axisLabel(tick) {
    const tickMs = Number(tick);

    if (!Number.isFinite(tickMs)) return '';

    const iso = new Date(tickMs).toISOString();
    const clockText = iso.slice(11, 16);

    if (hours === 168) {
      return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
    }

    if (tickMs === endMs && clockText === '00:00') {
      return '24:00';
    }

    return clockText;
  }

  function tooltipLabel(tick) {
    if (!Number.isFinite(Number(tick))) return '';

    return time(new Date(Number(tick)).toISOString());
  }

  function toggleSeries(channelId) {
    setHiddenIds((previous) =>
      previous.includes(channelId)
        ? previous.filter((id) => id !== channelId)
        : [...previous, channelId],
    );
  }

  function applyWindowEnd(targetEndMs) {
    if (!Number.isFinite(targetEndMs)) return;

    const endDate = new Date(targetEndMs);

    const displayDay = new Date(targetEndMs - 1)
      .toISOString()
      .slice(0, 10);

    const displayHour = endDate.getUTCHours() || 24;

    setChosenDay(displayDay);
    setEndHour(displayHour);
  }

  function moveWindow(direction) {
    if (!Number.isFinite(endMs)) return;

    let targetEndMs =
      endMs + direction * hours * 3600000;

    if (direction > 0) {
      if (
        !Number.isFinite(latestEndMs) ||
        endMs >= latestEndMs
      ) {
        return;
      }

      targetEndMs = Math.min(targetEndMs, latestEndMs);
    }

    applyWindowEnd(targetEndMs);
  }

  function goToLatestWindow() {
    applyWindowEnd(latestEndMs);
  }

  const canMoveForward =
    Number.isFinite(endMs) &&
    Number.isFinite(latestEndMs) &&
    endMs < latestEndMs;

  const atLatestWindow =
    Number.isFinite(endMs) &&
    Number.isFinite(latestEndMs) &&
    endMs === latestEndMs;

  return (
    <div className="hml-layout">
      <HistoryReadings
        parameters={readingParameters}
        selectedId={parameter.channel_id}
        onSelect={onSelect}
        mode={mode}
        ready={current}
        start={start}
        end={end}
        results={state.results}
        errors={state.errors}
      />

      <section className="hml-panel hml-history">
        <div className="hml-section-head">
          <div>
            <h2>Vibration Trend · {rangeLabel}</h2>
            <p>
              {series.length} pengukuran · X garis utuh · Y putus-putus
            </p>
          </div>

          <label className="hml-field">
            Tanggal akhir data

            <input
              type="date"
              value={day}
              onChange={(event) => {
                setChosenDay(event.target.value);
                setEndHour(24);
              }}
            />
          </label>
        </div>

        <div className="hml-range-toolbar">
          <div
            className="hml-range-buttons"
            role="group"
            aria-label="Rentang waktu grafik"
          >
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.hours}
                type="button"
                className={
                  hours === option.hours ? 'is-active' : ''
                }
                aria-pressed={hours === option.hours}
                onClick={() => setHours(option.hours)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <span>Data Historical</span>
        </div>

        <p className="hml-note">
          {start && end
            ? `${time(start)} sampai sebelum ${time(end)}.`
            : 'Pilih tanggal data.'}
          {' '}Gunakan tombol di bawah grafik untuk menggeser rentang.
          Memilih tanggal secara manual mengatur akhir rentang ke 24:00.
          Waktu mengikuti sumber; zona waktu belum dikonfirmasi.
        </p>

        <div
          className="hml-curve-legend"
          role="group"
          aria-label="Tampilkan atau sembunyikan kurva"
        >
          {series.map((item) => {
            const hidden = hiddenIds.includes(item.channel_id);

            return (
              <button
                key={item.channel_id}
                type="button"
                className={hidden ? 'is-hidden' : ''}
                aria-pressed={!hidden}
                title={`${item.tag_name} — ${
                  hidden ? 'Tampilkan' : 'Sembunyikan'
                } kurva`}
                onClick={() => toggleSeries(item.channel_id)}
              >
                <svg width="30" height="12" aria-hidden="true">
                  <line
                    x1="1"
                    y1="6"
                    x2="29"
                    y2="6"
                    stroke={item.style.color}
                    strokeWidth="2.5"
                    strokeDasharray={item.style.dash}
                  />
                </svg>

                <span>{item.style.name}</span>
              </button>
            );
          })}
        </div>

        <p className="hml-note">
          Klik legenda untuk menampilkan atau menyembunyikan kurva.
          Nama singkat mengikuti tag sumber.
        </p>

        {metadataUnconfirmed && (
          <p className="hml-notice">
            Satuan atau definisi amplitudo belum lengkap.
            Perbandingan antarkurva masih sementara sampai metadata
            setiap pengukuran dikonfirmasi.
          </p>
        )}

        {differentMetadataCount > 0 && (
          <p className="hml-note">
            {differentMetadataCount} pengukuran memiliki metadata
            satuan atau definisi amplitudo berbeda. Pilih pengukurannya
            di sebelah kiri untuk melihat kelompok tersebut.
          </p>
        )}

        {loading && (
          <p className="hml-message" role="status">
            Memuat seluruh kurva untuk rentang {rangeLabel}…
          </p>
        )}

        {!start && (
          <p className="hml-message">
            Belum ada tanggal pengukuran untuk kelompok ini.
          </p>
        )}

        {failedSeries.length > 0 && (
          <div className="hml-message" role="alert">
            <p>
              Sebagian kurva gagal dimuat. Kurva yang berhasil tetap
              ditampilkan.
            </p>

            <ul>
              {failedSeries.map((item) => (
                <li key={item.channel_id}>
                  {item.tag_name}: {state.errors[item.channel_id]}
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Coba lagi
            </button>
          </div>
        )}

        {current && (
          <>
            <p className="hml-note">
              Nilai pengukuran · {engineeringUnit}
            </p>

            {hasPlot ? (
              <div
                className="hml-chart"
                role="img"
                aria-label={`Grafik getaran ${rangeLabel} dengan ${
                  visibleSeries.length
                } kurva dipilih`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartRows}
                    margin={{
                      top: 16,
                      right: 24,
                      bottom: 8,
                      left: 0,
                    }}
                  >
                    <CartesianGrid
                      stroke="#d6e0eb"
                      strokeDasharray="3 3"
                    />

                    <XAxis
                      dataKey="axisTime"
                      type="number"
                      domain={[startMs, endMs]}
                      ticks={ticks}
                      tickFormatter={axisLabel}
                      minTickGap={20}
                    />

                    <YAxis
                      domain={['auto', 'auto']}
                      width={65}
                      tickFormatter={number}
                    />

                    <Tooltip
                      labelFormatter={tooltipLabel}
                      formatter={(value, name) => [
                        number(value),
                        name,
                      ]}
                    />

                    {visibleSeries.map((item) => (
                      <Line
                        key={item.channel_id}
                        type="linear"
                        dataKey={item.dataKey}
                        name={`${item.style.name} · ${item.tag_name}`}
                        stroke={item.style.color}
                        strokeDasharray={item.style.dash}
                        strokeWidth={1.6}
                        dot={false}
                        activeDot={{ r: 4 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="hml-message">
                {visibleSeries.length === 0
                  ? 'Semua kurva disembunyikan. Klik legenda untuk menampilkan.'
                  : failedSeries.length === series.length
                    ? 'Riwayat belum dapat dimuat.'
                    : 'Tidak ada nilai yang dapat diplot untuk kurva dan rentang ini.'}
              </p>
            )}
          </>
        )}

        {/* Navigasi berada setelah grafik dan sebelum statistik. */}
        <div
          className="hml-time-navigation"
          role="group"
          aria-label="Navigasi waktu grafik getaran"
        >
          <div className="hml-navigation-actions">
            <button
              type="button"
              disabled={loading || !Number.isFinite(endMs)}
              onClick={() => moveWindow(-1)}
              aria-label={`Mundur ${rangeLabel}`}
            >
              <span aria-hidden="true">←</span>
              Mundur {rangeLabel}
            </button>

            <button
              type="button"
              disabled={loading || !canMoveForward}
              onClick={() => moveWindow(1)}
              aria-label={`Maju ${rangeLabel}`}
            >
              Maju {rangeLabel}
              <span aria-hidden="true">→</span>
            </button>

            <button
              type="button"
              className="hml-latest-button"
              disabled={
                loading ||
                !Number.isFinite(latestEndMs) ||
                atLatestWindow
              }
              onClick={goToLatestWindow}
            >
              Ke data terbaru
            </button>
          </div>

          <div
            className="hml-navigation-period"
            aria-live="polite"
          >
            <span>
              {start && end
                ? `${time(start)} → ${time(end)}`
                : 'Pilih tanggal data'}
            </span>

            <small>
              Waktu akhir tidak termasuk dalam rentang.
            </small>
          </div>
        </div>

        {summary && (
          <>
            <div className="hml-stat-heading">
              <strong>
                Statistik pengukuran: {vibrationStyle(parameter).name}
              </strong>

              <small>{label(parameter)}</small>

              {hiddenIds.includes(parameter.channel_id) && (
                <small>
                  Kurva ini disembunyikan; statistik tetap ditampilkan.
                </small>
              )}
            </div>

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
              Dianalisis: {number(summary.analyzed_count)} dari{' '}
              {number(summary.total_count)} pengukuran.
              {' '}Dikecualikan: {number(summary.excluded_count)}.
              {' '}Statistik hanya untuk pengukuran terpilih selama
              seluruh rentang.
            </p>

            <p className="hml-note">
              Cakupan timestamp pengukuran terpilih:{' '}
              {time(summary.first_time)} — {time(summary.last_time)}.
              {' '}Rentang pilihan dapat mencakup tanggal yang belum
              memiliki data.
            </p>
          </>
        )}

        <p className="hml-note">
          Nilai suspect, missing, dan invalid tidak diplot.
          Data unverified masih memerlukan verifikasi.
          Batas normal, alarm, dan trip belum diterapkan.
        </p>
      </section>
    </div>
  );
}

function UnitData({ unitId, mode = 'monitoring' }) {
  const [chosenDay, setChosenDay] = useState('');
  const [hours, setHours] = useState(24);
  const [endHour, setEndHour] = useState(24);
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
    vibrations.find((item) => item.channel_id === selectedId) ||
    vibrations[0];

  const latest = parameters
    .map((item) => item.latest_time)
    .filter(Boolean)
    .sort()
    .at(-1);

  // Use the same endpoint as the vibration graph; fall back to other data
  // when this unit does not yet have vibration measurements.
  const latestVibration = vibrations
    .map((item) => item.latest_time)
    .filter(Boolean)
    .sort()
    .at(-1);
  const range = buildTimeRange(
    chosenDay, hours, endHour, latestVibration || latest,
  );

  const isAnalysis = mode === 'analysis';

  return (
    <div className="hml-body">
      <div className="hml-statusbar">
        <span className="hml-badge">
          HISTORIS MODE
        </span>

        <span>
          Data terbaru di database: {time(latest)}
        </span>

        <button
          type="button"
          onClick={() => setRevision((value) => value + 1)}
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

          {!isAnalysis && !selected && (
            <label className="hml-field">
              Tanggal data voltage (24 jam)
              <input
                type="date"
                value={range.day}
                onChange={(event) => {
                  setChosenDay(event.target.value);
                  setHours(24);
                  setEndHour(24);
                }}
              />
            </label>
          )}

          {!isAnalysis && (
            <section
              className="hml-operations"
              aria-label="Parameter operasi"
            >
              {PENDING_PARAMETERS.map(([title, detail]) =>
                  title === 'Voltage' ? (
                    <VoltageMetric
                      key={title}
                      unitId={unitId}
                      parameters={parameters}
                      start={range.start}
                      end={range.end}
                      revision={revision}
                      loadHistory={fetchHistory}
                    />
                  ) : (
                    <Metric
                      key={title}
                      title={title}
                      value="—"
                      detail={`${detail} · belum tersedia`}
                    />
                  ),
                )}
            </section>
          )}

          {selected ? (
            <History
              key={unitId}
              parameter={selected}
              parameters={vibrations}
              revision={revision}
              mode={mode}
              onSelect={setSelectedId}
              range={range}
              setChosenDay={setChosenDay}
              setHours={setHours}
              setEndHour={setEndHour}
            />
          ) : (
            <section className="hml-panel">
              <h2>Tren & analisis getaran</h2>

              <p className="hml-message">
                Data getaran belum tersedia untuk unit ini.
              </p>
            </section>
          )}

          {!isAnalysis && (
            <div className="hml-bottom">
              <section className="hml-panel">
                <h2>Temperature Bearing & oil</h2>

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
                  Satuan mengikuti metadata sumber setelah
                  dikonfirmasi.
                </p>
              </section>
            </div>
          )}

          <p className="hml-note">
            Pengelompokan berdasarkan nama tag masih sementara.
            Nilai suspect, missing, dan invalid tidak ditampilkan
            sebagai angka operasi. Koneksi live server Vale dan
            analisis Partial Discharge belum aktif.
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
  mode = 'monitoring',
} = {}) {
  const [localId, setLocalId] = useState('KRB-01');

  const active =
    units.find(
      (item) => item[0] === (selectedUnitId ?? localId),
    ) || units[0];

  const plants = [...new Set(units.map((item) => item[1]))];

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
            PT VALE INDONESIA TBK HYDRO INSIGHT
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
                    <option key={item[0]} value={item[0]}>
                      {item[1]} · {unitName(item)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </header>

      <UnitData
        key={`${active[0]}:${mode}`}
        unitId={active[0]}
        mode={mode}
      />
    </div>
  );
}