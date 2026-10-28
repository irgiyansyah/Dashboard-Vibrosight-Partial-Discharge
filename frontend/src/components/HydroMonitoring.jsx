import React, { useMemo, useState } from 'react';
import valeLogo from '../assets/vale-logo.png';
import './HydroMonitoring.css';

const UNITS = [
  ['LRN-01', 'Larona', 1],
  ['LRN-02', 'Larona', 2],
  ['LRN-03', 'Larona', 3],
  ['KRB-01', 'Karebbe', 1],
  ['KRB-02', 'Karebbe', 2],
  ['BLB-01', 'Balambano', 1],
  ['BLB-02', 'Balambano', 2],
];

const CHANNELS = [
  {
    id: 'TGB-X',
    label: 'TGB X',
    color: '#14325c',
    base: 48,
  },
  {
    id: 'TGB-Y',
    label: 'TGB Y',
    color: '#14325c',
    base: 41,
    dashed: true,
  },
  {
    id: 'UGB-X',
    label: 'UGB X',
    color: '#147ba5',
    base: 36,
  },
  {
    id: 'UGB-Y',
    label: 'UGB Y',
    color: '#147ba5',
    base: 30,
    dashed: true,
  },
  {
    id: 'LGB-X',
    label: 'LGB X',
    color: '#555555',
    base: 27,
  },
  {
    id: 'LGB-Y',
    label: 'LGB Y',
    color: '#555555',
    base: 23,
    dashed: true,
  },
];

const BEARINGS = [
  'Turbine Guide Bearing',
  'Upper Guide Bearing',
  'Lower Guide Bearing',
];

// Data sintetis untuk pengembangan UI.
// Tidak menggunakan data perusahaan atau koneksi live.
const DEMO_END = Date.parse('2026-10-25T14:30:00+08:00');

function formatTime(timestamp, withDate = false) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Makassar',
    ...(withDate
      ? {
          day: '2-digit',
          month: 'short',
        }
      : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatValue(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

function getUnitLabel(unit) {
  return typeof unit[2] === 'number'
    ? `Unit ${unit[2]}`
    : unit[2];
}

function createDemoData(unitIndex) {
  return Array.from({ length: 289 }, (_, index) => ({
    timestamp: DEMO_END - (288 - index) * 300000,
    values: Object.fromEntries(
      CHANNELS.map((channel, channelIndex) => [
        channel.id,
        channel.base +
          unitIndex * 1.7 +
          4 * Math.sin(index / 13 + channelIndex) +
          1.8 * Math.sin(index * 1.3 + channelIndex) +
          11 * Math.exp(-(((index - 218) / 11) ** 2)),
      ]),
    ),
  }));
}

function Tag({ children, tone = '' }) {
  return (
    <span className={`hm-tag ${tone}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

function Empty({ title, children }) {
  return (
    <div className="hm-empty">
      <span aria-hidden="true">—</span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

function Gauge({
  channel,
  value,
  second,
  index,
  hasData,
}) {
  const arcLength = Math.PI * 82;

  const ratio =
    hasData && Number.isFinite(value)
      ? Math.max(0, Math.min(value / 100, 1))
      : 0;

  return (
    <section className="hm-panel hm-bearing">
      <div className="hm-bearing-title">
        <h2>
          {BEARINGS[index]}{' '}
          <span>({channel.label.slice(0, 3)})</span>
        </h2>

        <i
          aria-hidden="true"
          style={{ background: channel.color }}
        />
      </div>

      <svg
        viewBox="0 0 210 124"
        role="img"
        aria-label={`${channel.label}: ${formatValue(
          value,
        )} mikrometer peak-to-peak, ${
          hasData ? 'data demo' : 'belum ada data'
        }`}
      >
        <path
          d="M23 101 A82 82 0 0 1 187 101"
          fill="none"
          stroke="#d6e0eb"
          strokeWidth="8"
        />

        {hasData && (
          <path
            d="M23 101 A82 82 0 0 1 187 101"
            fill="none"
            stroke={channel.color}
            strokeWidth="8"
            pathLength={arcLength}
            strokeDasharray={`${arcLength * ratio} ${arcLength}`}
          />
        )}

        <text
          x="105"
          y="82"
          textAnchor="middle"
          className="hm-gauge-value"
        >
          {formatValue(value)}
        </text>

        <text
          x="105"
          y="101"
          textAnchor="middle"
          className="hm-svg-label"
        >
          µm p-p · X
        </text>

        <text x="20" y="122" className="hm-svg-label">
          0
        </text>

        <text x="177" y="122" className="hm-svg-label">
          100
        </text>
      </svg>

      <div className="hm-bearing-bottom">
        <span>
          Y <b>{formatValue(second)}</b> µm p-p
        </span>
        <span>Skala demo</span>
      </div>

      <p className="hm-threshold-note">
        Batas kondisi belum dikonfigurasi
      </p>
    </section>
  );
}

function Trend({ rows, visible }) {
  if (!rows.length) {
    return (
      <Empty title="Belum ada data pengukuran">
        Koneksi VibroSight belum tersedia.
      </Empty>
    );
  }

  const width = 840;
  const height = 310;
  const left = 42;
  const right = 18;
  const top = 16;
  const bottom = 34;
  const lastRow = rows[rows.length - 1];

  const x = (index) =>
    left +
    (index / Math.max(1, rows.length - 1)) *
      (width - left - right);

  const y = (value) =>
    top + (1 - value / 100) * (height - top - bottom);

  return (
    <svg
      className="hm-trend-svg"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Tren getaran sintetis dalam mikrometer peak-to-peak. Gunakan legenda untuk memilih kanal."
    >
      {[0, 25, 50, 75, 100].map((value) => (
        <g key={value}>
          <line
            x1={left}
            x2={width - right}
            y1={y(value)}
            y2={y(value)}
            stroke="#d6e0eb"
          />

          <text
            x={left - 9}
            y={y(value) + 4}
            textAnchor="end"
            className="hm-svg-label"
          >
            {value}
          </text>
        </g>
      ))}

      {[0, 1, 2, 3, 4, 5, 6].map((tick) => {
        const index = Math.round(
          ((rows.length - 1) * tick) / 6,
        );

        return (
          <g key={tick}>
            <line
              x1={x(index)}
              x2={x(index)}
              y1={top}
              y2={height - bottom}
              stroke="#d6e0eb"
            />

            <text
              x={x(index)}
              y={height - 10}
              textAnchor={
                tick === 0
                  ? 'start'
                  : tick === 6
                    ? 'end'
                    : 'middle'
              }
              className="hm-svg-label"
            >
              {formatTime(rows[index].timestamp)}
            </text>
          </g>
        );
      })}

      {CHANNELS.filter((channel) =>
        visible.includes(channel.id),
      ).map((channel) => (
        <g key={channel.id}>
          <polyline
            points={rows
              .map(
                (row, index) =>
                  `${x(index)},${y(row.values[channel.id])}`,
              )
              .join(' ')}
            fill="none"
            stroke={channel.color}
            strokeWidth="2"
            strokeDasharray={
              channel.dashed ? '4 4' : undefined
            }
          />

          <circle
            cx={x(rows.length - 1)}
            cy={y(lastRow.values[channel.id])}
            r="3.5"
            fill={channel.color}
          >
            <title>
              {channel.label}:{' '}
              {formatValue(lastRow.values[channel.id])} µm p-p
            </title>
          </circle>
        </g>
      ))}
    </svg>
  );
}

export default function HydroMonitoring({
  units = UNITS,
  selectedUnitId,
  onUnitChange,
} = {}) {
  const options = units.length > 0 ? units : UNITS;

  const [localUnitId, setLocalUnitId] = useState(
    options[0][0],
  );
  const [hours, setHours] = useState(24);
  const [demo, setDemo] = useState(true);
  const [visible, setVisible] = useState(
    CHANNELS.map((channel) => channel.id),
  );
  const [expanded, setExpanded] = useState(false);

  const requestedUnitId = selectedUnitId ?? localUnitId;

  const unitIndex = Math.max(
    0,
    options.findIndex((item) => item[0] === requestedUnitId),
  );

  const unit = options[unitIndex];
  const unitId = unit[0];
  const unitLabel = getUnitLabel(unit);
  const plantNames = [...new Set(options.map((item) => item[1]))];

  function changeUnit(id) {
    setLocalUnitId(id);
    onUnitChange?.(id);
  }

  function toggleChannel(id) {
    setVisible((current) =>
      current.includes(id)
        ? current.filter((channelId) => channelId !== id)
        : [...current, id],
    );
  }

  const rows = useMemo(() => {
    if (!demo) return [];

    return createDemoData(unitIndex).filter(
      (row) =>
        row.timestamp >= DEMO_END - hours * 3600000,
    );
  }, [demo, hours, unitIndex]);

  const last = rows[rows.length - 1];

  const peaks = Object.fromEntries(
    CHANNELS.map((channel) => [
      channel.id,
      rows.length
        ? Math.max(
            ...rows.map((row) => row.values[channel.id]),
          )
        : null,
    ]),
  );

  const maxValue = rows.length
    ? Math.max(...Object.values(peaks))
    : null;

  const peakChannel = rows.length
    ? CHANNELS.find(
        (channel) => peaks[channel.id] === maxValue,
      )?.label
    : '—';

  return (
    <div className="hm-app">
      <header className="hm-header hm-vale-header">
        <a
          className="hm-brand vale-brand"
          href="#monitoring"
          aria-label="PT Vale Indonesia — monitoring unit"
        >
          <span className="vale-brand-copy">
            <strong>HYDRO MONITORING</strong>
            <small>PT Vale Indonesia Tbk</small>
          </span>
        </a>

        <div className="hm-title">
          <h1>
            {unit[1]} {unitLabel}
          </h1>
          <p>VIBROSIGHT & PARTIAL DISCHARGE MONITORING</p>
        </div>

        <div className="hm-header-controls">
          <label>
            UNIT SELECTION

            <select
              value={unitId}
              onChange={(event) =>
                changeUnit(event.target.value)
              }
            >
              {plantNames.map((plant) => (
                <optgroup key={plant} label={plant}>
                  {options
                    .filter((item) => item[1] === plant)
                    .map((item) => (
                      <option key={item[0]} value={item[0]}>
                        {item[1]} · {getUnitLabel(item)}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>

          <div className="hm-time">
            WAKTU DATA DEMO
            <strong>
              {last
                ? `${formatTime(last.timestamp, true)} WITA`
                : '—'}
            </strong>
          </div>
        </div>
      </header>

      <div className="hm-toolbar">
        <Tag tone="amber">
          {demo ? 'DEMO · DATA SINTETIS' : 'TANPA DATA'}
        </Tag>

        <span className="hm-coverage">
          {plantNames.length} PLTA
          <i />
          {options.length} unit
          <i />
          {unitId}
        </span>

        <span className="hm-connection">
          <i />
          VibroSight belum terhubung
        </span>

        <label className="hm-demo-toggle">
          <input
            type="checkbox"
            checked={demo}
            onChange={(event) =>
              setDemo(event.target.checked)
            }
          />
          Tampilkan demo
        </label>
      </div>

      {/* App.tsx sudah memiliki elemen main. */}
      <div id="monitoring" className="hm-main">
        <section
          className="hm-kpis"
          aria-label="Ringkasan unit"
        >
          <article className="hm-panel hm-kpi">
            <div>
              <span>Vibration data</span>
              <small>MECHANICAL</small>
            </div>
            <strong>
              {demo ? '6 kanal demo' : 'Belum tersedia'}
            </strong>
            <p>TGB, UGB, LGB · sumbu X & Y</p>
          </article>

          <article className="hm-panel hm-kpi">
            <div>
              <span>Generator air-gap</span>
              <small>GENERATOR</small>
            </div>
            <strong className="hm-dim">—</strong>
            <p>Menunggu sumber data air-gap</p>
          </article>

          <article className="hm-panel hm-kpi">
            <div>
              <span>Max vibration · {hours} jam</span>
              <small>DEMO</small>
            </div>
            <strong>
              {formatValue(maxValue)} <em>µm p-p</em>
            </strong>
            <p>
              {peakChannel} · maksimum seluruh 6 kanal
            </p>
          </article>

          <article className="hm-panel hm-kpi">
            <div>
              <span>Partial discharge</span>
              <small>ELECTRICAL</small>
            </div>
            <strong className="hm-dim">—</strong>
            <p>Integrasi PD pada tahap berikutnya</p>
          </article>
        </section>

        <div
          className={`hm-monitoring ${
            expanded ? 'hm-expanded' : ''
          }`}
        >
          <aside
            className="hm-bearings"
            aria-label="Pengukuran bantalan"
          >
            {[0, 1, 2].map((index) => (
              <Gauge
                key={index}
                index={index}
                channel={CHANNELS[index * 2]}
                value={
                  last?.values[CHANNELS[index * 2].id]
                }
                second={
                  last?.values[CHANNELS[index * 2 + 1].id]
                }
                hasData={Boolean(last)}
              />
            ))}
          </aside>

          <section className="hm-panel hm-trend">
            <div className="hm-panel-head">
              <div>
                <h2>Vibration trend</h2>
                <p>
                  Radial shaft displacement · data sintetis ·
                  interval 5 menit
                </p>
              </div>

              <button
                type="button"
                className="hm-expand"
                onClick={() =>
                  setExpanded((current) => !current)
                }
                aria-label={
                  expanded
                    ? 'Kembalikan susunan panel'
                    : 'Perbesar panel grafik'
                }
                aria-pressed={expanded}
              >
                {expanded ? '↙' : '↗'}
              </button>
            </div>

            <div className="hm-chart-tools">
              <div
                className="hm-periods"
                aria-label="Rentang waktu"
              >
                {[1, 6, 24].map((period) => (
                  <button
                    key={period}
                    type="button"
                    className={
                      period === hours ? 'is-active' : ''
                    }
                    onClick={() => setHours(period)}
                    aria-pressed={period === hours}
                  >
                    {period} H
                  </button>
                ))}
              </div>

              <span>
                {rows.length
                  ? `${formatTime(
                      rows[0].timestamp,
                      true,
                    )} — ${formatTime(
                      last.timestamp,
                      true,
                    )} WITA`
                  : 'Menunggu data'}
              </span>
            </div>

            <div
              className="hm-legend"
              aria-label="Kanal grafik"
            >
              {CHANNELS.map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  aria-pressed={visible.includes(channel.id)}
                  className={
                    visible.includes(channel.id)
                      ? ''
                      : 'is-hidden'
                  }
                  onClick={() => toggleChannel(channel.id)}
                >
                  <i
                    style={{
                      borderColor: channel.color,
                      borderStyle: channel.dashed
                        ? 'dashed'
                        : 'solid',
                    }}
                  />
                  {channel.label}
                </button>
              ))}
            </div>

            <p className="hm-axis-caption">
              Amplitude (peak-to-peak) · µm
            </p>

            <div className="hm-chart-wrap">
              <Trend rows={rows} visible={visible} />

              {rows.length > 0 && visible.length === 0 && (
                <div className="hm-chart-message">
                  Pilih kanal melalui legenda untuk
                  menampilkan tren.
                </div>
              )}
            </div>

            <div className="hm-snapshot-heading">
              <span>CHANNEL SNAPSHOT</span>
              <span>
                TERAKHIR / MAX {hours} JAM · µm p-p
              </span>
            </div>

            <div className="hm-snapshots">
              {CHANNELS.map((channel) => (
                <div key={channel.id}>
                  <span style={{ color: channel.color }}>
                    {channel.label}
                  </span>

                  <p>
                    {formatValue(last?.values[channel.id])}{' '}
                    <small>
                      / {formatValue(peaks[channel.id])}
                    </small>
                  </p>
                </div>
              ))}
            </div>

            <p className="hm-chart-note">
              Nilai ilustrasi untuk pengembangan tampilan.
              Tidak ada penilaian kondisi atau batas alarm
              operasional.
            </p>
          </section>

          <aside className="hm-analysis">
            <section className="hm-panel hm-orbit">
              <div className="hm-panel-head">
                <div>
                  <h2>Shaft orbit · X vs Y</h2>
                  <p>TGB · pasangan sinyal tersinkronisasi</p>
                </div>

                <Tag>Belum tersedia</Tag>
              </div>

              <div className="hm-orbit-body">
                <div
                  className="hm-orbit-grid"
                  aria-hidden="true"
                >
                  <span>Y</span>
                  <span>X</span>
                </div>

                <div>
                  <strong>Menunggu waveform</strong>
                  <p>
                    Orbit memerlukan sinyal X/Y
                    tersinkronisasi. Nilai ringkasan tidak
                    digunakan untuk membentuk orbit.
                  </p>
                </div>
              </div>
            </section>

            <section className="hm-panel hm-pd">
              <div className="hm-panel-head">
                <div>
                  <h2>Partial discharge analysis</h2>
                  <p>Electrical monitoring</p>
                </div>
              </div>

              <Empty title="Integrasi pada tahap berikutnya">
                Fokus saat ini adalah koneksi real-time
                VibroSight. Data dan satuan PD belum
                dikonfigurasi.
              </Empty>

              <div className="hm-pd-footer">
                <span>
                  Phase A <b>—</b>
                </span>
                <span>
                  Phase B <b>—</b>
                </span>
                <span>
                  Phase C <b>—</b>
                </span>
              </div>
            </section>
          </aside>
        </div>

        <section className="hm-panel hm-activity">
          <div className="hm-activity-title">
            <h2>Monitoring activity</h2>
            <span>STATUS PROTOTIPE</span>
            <Tag tone="amber">Alarm belum terintegrasi</Tag>
          </div>

          <div className="hm-activity-grid">
            <div>
              <i className="hm-event-dot" />
              <strong>
                {unit[1]} {unitLabel} dipilih
              </strong>
              <p>
                {demo
                  ? 'Dataset sintetis tersedia untuk 6 kanal'
                  : 'Data demo dinonaktifkan'}
              </p>
            </div>

            <div>
              <i className="hm-event-dot amber" />
              <strong>Koneksi sumber belum tersedia</strong>
              <p>
                Waktu penerimaan dan latensi belum terukur
              </p>
            </div>

            <div>
              <i className="hm-event-dot blue" />
              <strong>Metadata perlu dikonfirmasi</strong>
              <p>
                Satuan, jenis amplitudo, dan batas kondisi
              </p>
            </div>

            <div className="hm-quality">
              <strong>
                {demo ? 'DEMO / BUKAN LIVE' : 'NO DATA'}
              </strong>
              <p>Riwayat kejadian sumber belum tersedia</p>
            </div>
          </div>
        </section>

        <footer className="hm-footer">
          <span>
            PROTOTIPE · Seluruh nilai getaran sintetis.
            Tidak untuk keputusan operasi.
          </span>

          <span>{unitId} / UNIT MONITORING</span>
        </footer>
      </div>
    </div>
  );
}