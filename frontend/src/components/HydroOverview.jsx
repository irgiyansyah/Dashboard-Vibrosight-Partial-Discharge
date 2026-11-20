import { useEffect, useState } from 'react';

import './HydroOverview.css';

import CurrentMetric from './CurrentMetric';
import WicketGateMetric from './WicketGateMetric';
import SpeedMetric from './SpeedMetric';
import PowerMetric from './PowerMetric';

import TemperaturePanel, {
  isTemperatureParameter,
} from './TemperaturePanel';

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ||
  'http://127.0.0.1:8000'
).replace(/\/+$/, '');

const PLANTS = [
  {
    id: 'LRN',
    name: 'Larona',
    units: ['LRN-01', 'LRN-02', 'LRN-03'],
  },
  {
    id: 'BLB',
    name: 'Balambano',
    units: ['BLB-01', 'BLB-02'],
  },
  {
    id: 'KRB',
    name: 'Karebbe',
    units: ['KRB-01', 'KRB-02'],
  },
];

const UNITS = PLANTS.flatMap((plant) =>
  plant.units.map((id, index) => ({
    id,
    plant: plant.name,
    plantId: plant.id,
    name: `Unit ${index + 1}`,
  })),
);

const VOLTAGE_TAGS = {
  'LRN-01': 'U-LAR1-EI_81104_AVE-AI',
  'LRN-02': 'U-LAR2-EI_81204_AVE-AI',
  'LRN-03': 'U-LAR3-EI_81302m-AI',
  'BLB-01': 'U-BGS1-I-G-VOLT-PH-1-AI',
  'BLB-02': 'U-BGS2-I-G-VOLT-PH-1-AI',
  'KRB-01': 'U-KGS1-SCADA-Gen-U1-Voltage-L1-AI',
  'KRB-02': 'U-KGS2-SCADA-Gen-U2-Voltage-L1-AI',
};

// Pemetaan tambahan hanya diisi setelah tag dikonfirmasi.
// Speed, daya, arus, dan wicket gate menggunakan komponen
// masing-masing yang memiliki pemetaan kanal tersendiri.
const OPERATION_TAGS = {};

const OPERATIONS = [
  ['activePower', 'Daya aktif', 'MW'],
  ['reactivePower', 'Daya reaktif', 'MVAr'],
  ['voltage', 'Voltage', ''],
  ['current', 'Arus', ''],
  ['gap', 'Air gap', ''],
  ['gate', 'Wicket gate', ''],
  ['speed', 'Speed', ''],
];

const FORMAT = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 2,
});

const EMPTY_ENTRIES = Object.fromEntries(
  UNITS.map((unit) => [
    unit.id,
    {
      stage: 'loading',
      parameters: [],
      error: '',
    },
  ]),
);

function number(value) {
  return Number.isFinite(value)
    ? FORMAT.format(value)
    : '—';
}

function stamp(value) {
  return value
    ? String(value).replace('T', ' ').slice(0, 19)
    : '—';
}

function sourceMs(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(
      String(value || ''),
    )
  ) {
    return NaN;
  }

  // UTC hanya digunakan untuk perhitungan kalender.
  // Waktu sumber tidak dikonversi ke zona waktu lain.
  return Date.parse(`${value}Z`);
}

function latestStamp(parameters) {
  return (
    parameters
      .map((parameter) => parameter.latest_time)
      .filter((value) =>
        Number.isFinite(sourceMs(value)),
      )
      .sort()
      .at(-1) || ''
  );
}

function latestSnapshot(entries) {
  const latest = latestStamp(
    Object.values(entries).flatMap(
      (entry) => entry.parameters,
    ),
  );

  return latest
    ? {
        day: latest.slice(0, 10),
        latest,
      }
    : null;
}

function isVibration(parameter) {
  return (
    parameter.measurement_type === 'vibration' ||
    (
      ['unknown', 'other', null, undefined].includes(
        parameter.measurement_type,
      ) &&
      /VIB/i.test(parameter.tag_name || '')
    )
  );
}

function isTemperature(parameter) {
  return isTemperatureParameter(parameter);
}

function latestReading(parameter) {
  if (!parameter) {
    return {
      value: null,
      note: 'Belum tersedia',
      time: '',
    };
  }

  const valid =
    Number.isFinite(sourceMs(parameter.latest_time)) &&
    parameter.latest_quality === 'unverified' &&
    Number.isFinite(parameter.latest_plot_value);

  const notes = {
    unverified: valid
      ? 'Belum diverifikasi'
      : 'Nilai belum tersedia',
    suspect: 'Perlu ditinjau',
    missing: 'Pengukuran kosong',
    invalid: 'Data tidak valid',
  };

  return {
    value: valid
      ? parameter.latest_plot_value
      : null,
    note:
      notes[parameter.latest_quality] ||
      'Belum ada pengukuran',
    time: parameter.latest_time || '',
  };
}

function seriesStyle(parameter) {
  const tag = String(
    parameter.tag_name || '',
  ).toUpperCase();

  const bearing = tag.match(
    /(?:^|[_-])(TGB|UGB|LGB)(?:[_-]|$)/,
  )?.[1];

  const legacy = tag.match(
    /(?:^|[_-])I_([GT])_VIB(?:[_-]|$)/,
  )?.[1];

  const axis =
    tag.match(
      /(?:^|[_-])([XYZ])(?:[_-]|$)/,
    )?.[1] || '';

  // GB-X tetap mengikuti nama sumber.
  // Tidak otomatis diubah menjadi LGB-X.
  const group =
    bearing ||
    legacy ||
    tag
      .replace(/^U-[^_-]+[_-]/, '')
      .replace(
        /[_-][XYZ](?:_AXIS)?(?=[_-]|$)/,
        '',
      )
      .replace(/[_-]AI$/, '');

  const known = {
    TGB: '#41dbb0',
    T: '#41dbb0',
    UGB: '#49c9f5',
    G: '#49c9f5',
    LGB: '#8b9dff',
  };

  let hash = 0;

  for (const character of group) {
    hash =
      (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  const colors = [
    '#c69dff',
    '#ffc16b',
    '#8bd8cf',
    '#e7a1c8',
  ];

  return {
    label: `${group || 'Getaran'} ${axis}`.trim(),
    color:
      known[group] ||
      colors[hash % colors.length],
    dash: axis === 'Y' ? '4 3' : undefined,
  };
}

function classifyOperation(parameters, unitId, key) {
  const tag =
    key === 'voltage'
      ? VOLTAGE_TAGS[unitId]
      : OPERATION_TAGS[unitId]?.[key];

  const found = tag
    ? parameters.filter(
        (parameter) =>
          parameter.tag_name === tag &&
          parameter.unit_id === unitId,
      )
    : [];

  return {
    parameter:
      found.length === 1 ? found[0] : null,
    ambiguous: found.length > 1,
  };
}

async function requestJson(path, parentSignal) {
  const controller = new AbortController();
  let timedOut = false;

  const abort = () => controller.abort();

  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener(
      'abort',
      abort,
      { once: true },
    );
  }

  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 30000);

  try {
    const response = await fetch(
      `${API_BASE}${path}`,
      {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `API merespons HTTP ${response.status}.`,
      );
    }

    return await response.json();
  } catch (error) {
    if (timedOut) {
      throw new Error(
        'Waktu tunggu API melebihi 30 detik.',
      );
    }

    throw error;
  } finally {
    window.clearTimeout(timer);

    parentSignal.removeEventListener(
      'abort',
      abort,
    );
  }
}

async function readParameters(unit, signal) {
  const body = await requestJson(
    `/api/units/${unit.id}/parameters`,
    signal,
  );

  if (
    body.status !== 'ok' ||
    body.unit?.id !== unit.id ||
    !Array.isArray(body.data)
  ) {
    throw new Error('Respons unit tidak sesuai.');
  }

  const seen = new Set();

  for (const parameter of body.data) {
    if (
      parameter.unit_id !== unit.id ||
      !Number.isSafeInteger(parameter.channel_id) ||
      parameter.channel_id <= 0 ||
      seen.has(parameter.channel_id) ||
      typeof parameter.tag_name !== 'string'
    ) {
      throw new Error(
        'Pemetaan pengukuran unit perlu diperiksa.',
      );
    }

    seen.add(parameter.channel_id);
  }

  return body.data;
}

async function runQueue(items, action, signal) {
  let cursor = 0;

  async function worker() {
    while (
      !signal.aborted &&
      cursor < items.length
    ) {
      const item = items[cursor++];
      await action(item);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(3, items.length) },
      () => worker(),
    ),
  );
}

function useOverview(revision) {
  const [state, setState] = useState({
    revision: -1,
    entries: EMPTY_ENTRIES,
    range: null,
    loading: true,
  });

  useEffect(() => {
    const controller = new AbortController();

    let active = true;
    let entries = { ...EMPTY_ENTRIES };
    let range = null;

    const publish = (loading = true) => {
      if (active) {
        setState({
          revision,
          entries: { ...entries },
          range,
          loading,
        });
      }
    };

    async function load() {
      await runQueue(
        UNITS,
        async (unit) => {
          try {
            const parameters = await readParameters(
              unit,
              controller.signal,
            );

            entries[unit.id] = {
              stage: 'ready',
              parameters,
              error: '',
            };
          } catch (error) {
            entries[unit.id] = {
              stage: 'error',
              parameters: [],
              error:
                error instanceof Error
                  ? error.message
                  : 'Gagal membaca data unit.',
            };
          }

          publish();
        },
        controller.signal,
      );

      if (!active) return;

      range = latestSnapshot(entries);
      publish(false);
    }

    void load();

    return () => {
      active = false;
      controller.abort();
    };
  }, [revision]);

  return state.revision === revision
    ? state
    : {
        entries: EMPTY_ENTRIES,
        range: null,
        loading: true,
      };
}

function Icon({ name, size = 20 }) {
  const shapes = {
    plant: (
      <>
        <path d="M3 21V9l6 3V6l6 3V3h6v18Z" />
        <path d="M7 17h1m4 0h1m4 0h1" />
      </>
    ),

    unit: (
      <>
        <rect
          x="3"
          y="3"
          width="7"
          height="7"
          rx="1"
        />
        <rect
          x="14"
          y="3"
          width="7"
          height="7"
          rx="1"
        />
        <rect
          x="3"
          y="14"
          width="7"
          height="7"
          rx="1"
        />
        <rect
          x="14"
          y="14"
          width="7"
          height="7"
          rx="1"
        />
      </>
    ),

    wave: (
      <path d="M2 12h4l3-8 5 16 3-8h5" />
    ),

    review: (
      <>
        <path d="m12 3 10 18H2Z" />
        <path d="M12 9v5m0 3v1" />
      </>
    ),

    refresh: (
      <path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6" />
    ),
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name] || shapes.wave}
    </svg>
  );
}

function OverviewMetric({
  label,
  value,
  detail,
  icon,
}) {
  return (
    <article className="ho-kpi">
      <span className="ho-kpi-icon">
        <Icon name={icon} />
      </span>

      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function ParameterMetric({
  unitId,
  parameters,
  field,
}) {
  if (field[0] === 'speed') {
    return (
      <SpeedMetric
        unitId={unitId}
        parameters={parameters}
        variant="overview"
      />
    );
  }

  if (
    field[0] === 'activePower' ||
    field[0] === 'reactivePower'
  ) {
    return (
      <PowerMetric
        unitId={unitId}
        kind={field[0]}
        parameters={parameters}
        variant="overview"
      />
    );
  }

  const [key, label, expectedUnit] = field;

  const { parameter, ambiguous } =
    classifyOperation(parameters, unitId, key);

  const reading = latestReading(parameter);
  const unit = parameter?.engineering_unit || '';

  return (
    <div
      className="ho-parameter"
      title={
        parameter
          ? `${parameter.tag_name}\n${stamp(
              reading.time,
            )}\n${reading.note}`
          : `${label}: tag belum tersedia / belum dipetakan`
      }
    >
      <span>
        {label}
        {!parameter && expectedUnit
          ? ` (${expectedUnit})`
          : ''}
      </span>

      <strong>
        {number(reading.value)}
        {unit && <small> {unit}</small>}
      </strong>

      <small>
        {ambiguous
          ? 'Pemetaan ganda'
          : reading.note}
      </small>

      {parameter && !unit && (
        <small>Satuan belum dikonfirmasi</small>
      )}

      {parameter && (
        <time>{stamp(reading.time)}</time>
      )}
    </div>
  );
}

// Acuan visual sementara.
// Tidak menetapkan status alarm atau trip.
const GAUGE_PREVIEW = {
  min: 0,
  yellow: 300,
  red: 400,
  max: 500,
};

const GAUGE_BANDS = [
  {
    id: 'green',
    label: 'Hijau',
    start: GAUGE_PREVIEW.min,
    end: GAUGE_PREVIEW.yellow,
  },
  {
    id: 'yellow',
    label: 'Kuning',
    start: GAUGE_PREVIEW.yellow,
    end: GAUGE_PREVIEW.red,
  },
  {
    id: 'red',
    label: 'Merah',
    start: GAUGE_PREVIEW.red,
    end: GAUGE_PREVIEW.max,
  },
];

function dialPoint(ratio, radius) {
  return {
    x: 100 - Math.cos(Math.PI * ratio) * radius,
    y: 88 - Math.sin(Math.PI * ratio) * radius,
  };
}

function gaugeArc(start, end) {
  const a = dialPoint(start, 72);
  const b = dialPoint(end, 72);

  return `M ${a.x} ${a.y} A 72 72 0 0 1 ${b.x} ${b.y}`;
}

// Opsional: skala tampilan tetap setelah ditinjau.
// Contoh: 'TAG_ASLI': { min: 0, max: 500 }.
const GAUGE_SCALES = {};

function gaugeScale(parameter, value) {
  const fixed =
    GAUGE_SCALES[parameter.tag_name];

  if (
    fixed &&
    Number.isFinite(fixed.min) &&
    Number.isFinite(fixed.max) &&
    fixed.max > fixed.min
  ) {
    return {
      ...fixed,
      automatic: false,
    };
  }

  if (!Number.isFinite(value)) return null;

  const target =
    Math.abs(value) === 0
      ? 1
      : Math.abs(value) * 1.2;

  const power =
    10 ** Math.floor(Math.log10(target));

  const step =
    [1, 2, 5, 10].find(
      (value) => value * power >= target,
    ) || 10;

  const extent = step * power;

  return {
    min: value < 0 ? -extent : 0,
    max: value < 0 ? 0 : extent,
    automatic: true,
  };
}

function VibrationGauge({ parameter }) {
  const reading = latestReading(parameter);
  const series = seriesStyle(parameter);
  const hasValue = Number.isFinite(reading.value);

  const unitKey = String(
    parameter.engineering_unit || '',
  )
    .trim()
    .replace(/μ/g, 'µ')
    .toLowerCase();

  const isMicrometer =
    ['µm', 'um'].includes(unitKey);

  const isPeakToPeak = /peak-to-peak/i.test(
    parameter.measurement_definition || '',
  );

  const showBands =
    hasValue &&
    reading.value >= 0 &&
    isMicrometer &&
    isPeakToPeak;

  const scale = showBands
    ? GAUGE_PREVIEW
    : gaugeScale(parameter, reading.value);

  const band = showBands
    ? GAUGE_BANDS.findLast(
        (item) => reading.value >= item.start,
      )
    : null;

  const bandLabel = band
    ? `Zona ${band.label.toLowerCase()} · acuan visual`
    : '';

  const outside =
    hasValue &&
    scale &&
    (
      reading.value < scale.min ||
      reading.value > scale.max
    );

  const toFraction = (value) =>
    (value - scale.min) /
    (scale.max - scale.min);

  const fraction =
    hasValue && scale
      ? Math.max(
          0,
          Math.min(
            1,
            toFraction(reading.value),
          ),
        )
      : null;

  const tip =
    fraction === null
      ? null
      : dialPoint(fraction, 57);

  const ticks = showBands
    ? [
        0,
        toFraction(GAUGE_PREVIEW.yellow),
        toFraction(GAUGE_PREVIEW.red),
        1,
      ]
    : [0, 0.25, 0.5, 0.75, 1];

  const unit =
    parameter.engineering_unit ||
    'Satuan belum dikonfirmasi';

  return (
    <article
      className="ho-gauge"
      data-channel={parameter.channel_id}
      data-band={band?.id}
    >
      <div
        className="ho-gauge-heading"
        title={parameter.tag_name}
      >
        <i
          style={{
            background: series.color,
          }}
        />
        <strong>{series.label}</strong>
      </div>

      <svg
        className="ho-gauge-dial"
        viewBox="0 0 200 112"
        role="img"
        aria-label={`${series.label}: ${number(
          reading.value,
        )}; ${unit}; ${reading.note}${
          scale
            ? `; skala ${number(
                scale.min,
              )} sampai ${number(scale.max)}`
            : ''
        }${bandLabel ? `; ${bandLabel}` : ''}`}
      >
        <title>
          {parameter.tag_name} ·{' '}
          {stamp(reading.time)}. Warna adalah acuan
          visual, bukan status alarm atau trip.
        </title>

        <path
          className="ho-gauge-track"
          d="M 28 88 A 72 72 0 0 1 172 88"
        />

        {showBands &&
          GAUGE_BANDS.map(
            ({ id, start, end }) => (
              <path
                key={id}
                className={`ho-gauge-arc ho-gauge-${id}`}
                d={gaugeArc(
                  toFraction(start),
                  toFraction(end),
                )}
              />
            ),
          )}

        {ticks.map((ratio) => {
          const a = dialPoint(ratio, 59);
          const b = dialPoint(ratio, 64);

          return (
            <line
              key={ratio}
              className="ho-gauge-tick"
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />
          );
        })}

        {tip && (
          <>
            <line
              className="ho-gauge-needle"
              x1="100"
              y1="88"
              x2={tip.x}
              y2={tip.y}
            />
            <circle
              className="ho-gauge-hub"
              cx="100"
              cy="88"
              r="5"
            />
          </>
        )}

        {!hasValue && (
          <text
            className="ho-gauge-unavailable"
            x="100"
            y="76"
            textAnchor="middle"
          >
            —
          </text>
        )}

        <text
          x="24"
          y="107"
          textAnchor="start"
        >
          {scale ? number(scale.min) : '—'}
        </text>

        <text
          x="176"
          y="107"
          textAnchor="end"
        >
          {scale ? number(scale.max) : '—'}
        </text>
      </svg>

      <strong className="ho-gauge-value">
        {number(reading.value)}
      </strong>

      <span className="ho-gauge-unit">
        {unit}
      </span>

      <span className="ho-gauge-scale">
        {bandLabel ||
          (
            scale
              ? 'Tanpa acuan warna'
              : 'Skala belum tersedia'
          )}
      </span>

      {outside && (
        <span className="ho-warning">
          Di luar skala tampilan
        </span>
      )}

      <span
        className={
          ['suspect', 'invalid', 'missing'].includes(
            parameter.latest_quality,
          )
            ? 'ho-gauge-quality ho-warning'
            : 'ho-gauge-quality'
        }
      >
        {reading.note}
      </span>

      <time>{stamp(reading.time)}</time>
    </article>
  );
}

function VibrationGauges({ parameters }) {
  if (!parameters.length) {
    return (
      <p className="ho-empty-inline">
        Data getaran belum tersedia.
      </p>
    );
  }

  return (
    <>
      <div className="ho-gauge-reference">
        <span>
          Acuan warna sementara · µm peak-to-peak
        </span>

        <ul>
          <li className="ho-gauge-green">
            <i /> Hijau &lt;{' '}
            {number(GAUGE_PREVIEW.yellow)}
          </li>

          <li className="ho-gauge-yellow">
            <i /> Kuning{' '}
            {number(GAUGE_PREVIEW.yellow)}
            –&lt;{number(GAUGE_PREVIEW.red)}
          </li>

          <li className="ho-gauge-red">
            <i /> Merah ≥{' '}
            {number(GAUGE_PREVIEW.red)}
          </li>
        </ul>

        <span>
          Belum divalidasi per sensor. Warna tidak
          menunjukkan status alarm atau trip.
        </span>
      </div>

      <div className="ho-gauge-grid">
        {parameters.map((parameter) => (
          <VibrationGauge
            key={parameter.channel_id}
            parameter={parameter}
          />
        ))}
      </div>

      <p className="ho-note">
        Tren lengkap tersedia di Vibration Analysis.
      </p>
    </>
  );
}

function LatestList({ parameters, kind }) {
  if (!parameters.length) {
    return (
      <p className="ho-empty-inline">
        Data belum tersedia.
      </p>
    );
  }

  return (
    <div className="ho-reading-list">
      {parameters.map((parameter) => {
        const reading = latestReading(parameter);
        const style = seriesStyle(parameter);

        const display =
          kind === 'vibration'
            ? style.label
            : parameter.display_name ||
              parameter.tag_name;

        return (
          <div
            className="ho-reading"
            key={parameter.channel_id}
            title={`${parameter.tag_name}\n${stamp(
              reading.time,
            )}\n${reading.note}`}
          >
            <span className="ho-reading-name">
              {kind === 'vibration' && (
                <i
                  style={{
                    background: style.color,
                  }}
                />
              )}
              {display}
            </span>

            <span className="ho-reading-number">
              {number(reading.value)}{' '}
              <small>
                {parameter.engineering_unit ||
                  'satuan ?'}
              </small>
            </span>

            <small
              className={
                reading.note === 'Perlu ditinjau' ||
                reading.note === 'Data tidak valid'
                  ? 'ho-warning'
                  : 'ho-reading-note'
              }
            >
              {reading.note} ·{' '}
              {stamp(reading.time)}
            </small>
          </div>
        );
      })}
    </div>
  );
}

function UnitCard({
  unit,
  entry,
  range,
  onOpenUnit,
}) {
  const parameters = entry.parameters;
  const vibrations = parameters.filter(isVibration);
  const temperatures = parameters.filter(isTemperature);

  const pd = parameters.filter(
    (parameter) =>
      parameter.measurement_type ===
      'partial_discharge',
  );

  const latest = latestStamp(parameters);

  const hasData = parameters.some(
    (parameter) =>
      Number.isFinite(
        sourceMs(parameter.latest_time),
      ),
  );

  const label =
    entry.stage === 'loading'
      ? 'Memuat'
      : entry.stage === 'error'
        ? 'Gagal membaca'
        : hasData
          ? 'Data historis'
          : 'Belum ada data';

  return (
    <article
      className="ho-unit"
      data-unit={unit.id}
    >
      <header className="ho-unit-head">
        <div>
          <span className="ho-unit-code">
            {unit.id}
          </span>
          <h3>{unit.name}</h3>
        </div>

        <span
          className={`ho-pill ${
            entry.stage === 'error'
              ? 'ho-pill-error'
              : ''
          }`}
        >
          {label}
        </span>
      </header>

      <p className="ho-unit-time">
        Pengukuran terbaru{' '}
        <time>{stamp(latest)}</time>
      </p>

      {range &&
        latest &&
        latest.slice(0, 10) !== range.day && (
          <p className="ho-warning">
            Tanggal terakhir unit berbeda dari tanggal
            data terbaru ({range.day}).
          </p>
        )}

      {entry.stage === 'error' ? (
        <div
          className="ho-unit-error"
          role="alert"
        >
          <Icon name="review" />
          <strong>
            Data unit belum dapat dibaca
          </strong>
          <span>{entry.error}</span>
        </div>
      ) : entry.stage === 'loading' ? (
        <div
          className="ho-unit-error"
          role="status"
        >
          <Icon name="wave" />
          <span>
            Membaca pengukuran {unit.plant}{' '}
            {unit.name}…
          </span>
        </div>
      ) : (
        <>
          <div className="ho-parameters">
            {OPERATIONS.map((field) =>
              field[0] === 'current' ? (
                <CurrentMetric
                  key={field[0]}
                  unitId={unit.id}
                  parameters={parameters}
                />
              ) : field[0] === 'gate' ? (
                <WicketGateMetric
                  key={field[0]}
                  unitId={unit.id}
                  parameters={parameters}
                  variant="overview"
                />
              ) : (
                <ParameterMetric
                  key={field[0]}
                  unitId={unit.id}
                  parameters={parameters}
                  field={field}
                />
              ),
            )}

            <div className="ho-parameter">
              <span>Temperatur bearing & oli</span>

              <strong>
                {temperatures.length
                  ? `${temperatures.length} titik`
                  : '—'}
              </strong>

              <small>
                Nilai tiap sensor di bawah
              </small>
            </div>
          </div>

          <section className="ho-section">
            <div className="ho-section-heading">
              <h4>Indikator getaran</h4>
              <span>
                Nilai terakhir tiap sensor
              </span>
            </div>

            <VibrationGauges
              parameters={vibrations}
            />
          </section>

          <TemperaturePanel
            unitId={unit.id}
            parameters={parameters}
            variant="overview"
          />

          <section className="ho-section ho-pd">
            <div className="ho-section-heading">
              <h4>Partial Discharge</h4>
              <span>
                {pd.length
                  ? 'Snapshot'
                  : 'Belum tersedia'}
              </span>
            </div>

            {pd.length > 0 && (
              <LatestList
                parameters={pd}
                kind="pd"
              />
            )}
          </section>
        </>
      )}

      {typeof onOpenUnit === 'function' && (
        <button
          type="button"
          className="ho-detail"
          onClick={() => onOpenUnit(unit.id)}
        >
          Buka detail {unit.plant} {unit.name}
          <span aria-hidden="true">↗</span>
        </button>
      )}
    </article>
  );
}

function UnitSummary({ entries }) {
  return (
    <section
      className="ho-unit-summary"
      aria-labelledby="ho-summary-title"
    >
      <div className="ho-summary-heading">
        <h2 id="ho-summary-title">
          Ringkasan seluruh unit
        </h2>

        <span>
          Snapshot terakhir tiap sensor · 7 unit
        </span>
      </div>

      <div className="ho-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">PLTA / unit</th>
              <th scope="col">Voltage</th>
              <th scope="col">Arus</th>
              <th scope="col">Getaran terakhir</th>
              <th scope="col">
                Temperatur bearing & oli
              </th>
              <th scope="col">Kualitas data</th>
              <th scope="col">
                Pengukuran terbaru
              </th>
            </tr>
          </thead>

          <tbody>
            {UNITS.map((unit) => {
              const entry = entries[unit.id];

              const { parameter } = classifyOperation(
                entry.parameters,
                unit.id,
                'voltage',
              );

              const voltage = latestReading(parameter);

              const vibrations =
                entry.parameters.filter(isVibration);

              const temperatures =
                entry.parameters.filter(isTemperature);

              const review = entry.parameters.filter(
                (item) =>
                  [
                    'suspect',
                    'invalid',
                    'missing',
                  ].includes(item.latest_quality),
              ).length;

              const overviewValues = (items, kind) =>
                items.length ? (
                  <div className="ho-table-values">
                    {items.map((item) => {
                      const reading =
                        latestReading(item);

                      return (
                        <span
                          key={item.channel_id}
                          title={`${item.tag_name} · ${
                            stamp(reading.time)
                          } · ${reading.note}`}
                        >
                          {kind === 'vibration' && (
                            <i
                              style={{
                                background:
                                  seriesStyle(item)
                                    .color,
                              }}
                            />
                          )}

                          {kind === 'vibration'
                            ? `${
                                seriesStyle(item).label
                              }: `
                            : ''}

                          <strong>
                            {number(reading.value)}
                          </strong>

                          {item.engineering_unit
                            ? ` ${item.engineering_unit}`
                            : ''}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  '—'
                );

              const qualityText =
                entry.stage === 'loading'
                  ? 'Memuat…'
                  : entry.stage === 'error'
                    ? 'Gagal dibaca'
                    : review
                      ? `${review} perlu ditinjau`
                      : entry.parameters.length
                        ? 'Belum diverifikasi'
                        : 'Belum tersedia';

              return (
                <tr
                  key={unit.id}
                  data-summary-unit={unit.id}
                >
                  <th scope="row">
                    <strong>
                      {unit.plant} · {unit.name}
                    </strong>
                    <small>{unit.id}</small>
                  </th>

                  <td>
                    <strong>
                      {number(voltage.value)}
                    </strong>

                    {parameter?.engineering_unit &&
                      ` ${parameter.engineering_unit}`}

                    <small>
                      {parameter &&
                      !parameter.engineering_unit
                        ? 'Satuan belum dikonfirmasi'
                        : voltage.note}
                    </small>
                  </td>

                  <td>
                    <CurrentMetric
                      unitId={unit.id}
                      parameters={entry.parameters}
                      variant="summary"
                    />
                  </td>

                  <td>
                    {overviewValues(
                      vibrations,
                      'vibration',
                    )}
                  </td>

                  <td>
                    {overviewValues(
                      temperatures,
                      'temperature',
                    )}
                  </td>

                  <td>
                    <span
                      className={
                        review ||
                        entry.stage === 'error'
                          ? 'ho-warning'
                          : ''
                      }
                    >
                      {qualityText}
                    </span>
                  </td>

                  <td>
                    <time>
                      {stamp(
                        latestStamp(entry.parameters),
                      )}
                    </time>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="ho-note">
        Satuan mengikuti metadata sumber. Angka tanpa
        satuan belum dikonfirmasi. Kualitas data tidak
        menyatakan kondisi normal, alarm, atau trip.
      </p>
    </section>
  );
}

export default function HydroOverview({
  onOpenUnit,
} = {}) {
  const [revision, setRevision] = useState(0);

  const {
    entries,
    range,
    loading,
  } = useOverview(revision);

  const ready = Object.values(entries).filter(
    (entry) => entry.stage === 'ready',
  );

  const withData = ready.filter(
    (entry) =>
      entry.parameters.some(
        (parameter) =>
          Number.isFinite(
            sourceMs(parameter.latest_time),
          ),
      ),
  ).length;

  const errors = Object.values(entries).filter(
    (entry) => entry.stage === 'error',
  ).length;

  const unsettled = Object.values(entries).some(
    (entry) => entry.stage === 'loading',
  );

  const reviewCount = ready
    .flatMap((entry) => entry.parameters)
    .filter((parameter) =>
      ['suspect', 'invalid', 'missing'].includes(
        parameter.latest_quality,
      ),
    ).length;

  return (
    <div className="ho-overview">
      <header className="ho-header">
        <div>
          <p className="ho-eyebrow">
            PT VALE INDONESIA TBK · HYDRO INSIGHT
          </p>

          <h1>Hydro Operations Overview</h1>

          <p className="ho-subtitle">
            Larona · Balambano · Karebbe
            <span>
              Seluruh 7 unit dalam satu halaman
            </span>
          </p>
        </div>

        <div className="ho-header-actions">
          <span className="ho-historical">
            <span /> HISTORIS · BUKAN LIVE
          </span>

          <button
            type="button"
            className="ho-refresh"
            onClick={() =>
              setRevision((value) => value + 1)
            }
            disabled={loading}
          >
            <Icon name="refresh" size={16} />
            {loading
              ? 'Memuat data…'
              : 'Muat ulang'}
          </button>
        </div>
      </header>

      <div className="ho-context">
        <span>
          <i /> VIBROSIGHT & PARAMETER OPERASI
        </span>

        <span>
          Data terbaru:{' '}
          <strong>
            {range
              ? stamp(range.latest)
              : 'Menunggu data'}
          </strong>
        </span>

        <span>
          Waktu mengikuti sumber · zona waktu belum
          dikonfirmasi
        </span>
      </div>

      <div className="ho-summary">
        <OverviewMetric
          label="PLTA dalam cakupan"
          value="3"
          detail="Larona, Balambano, Karebbe"
          icon="plant"
        />

        <OverviewMetric
          label="Unit ditampilkan"
          value="7"
          detail="3 Larona · 2 Balambano · 2 Karebbe"
          icon="unit"
        />

        <OverviewMetric
          label="Unit dengan pengukuran"
          value={
            unsettled
              ? `${withData}/7…`
              : `${withData}/7`
          }
          detail={
            errors
              ? `${errors} unit gagal dibaca`
              : unsettled
                ? 'Pembacaan masih berlangsung'
                : 'Ketersediaan data, bukan status mesin'
          }
          icon="wave"
        />

        <OverviewMetric
          label="Pengukuran perlu ditinjau"
          value={
            unsettled || errors
              ? `${reviewCount}*`
              : number(reviewCount)
          }
          detail={
            unsettled || errors
              ? 'Hitungan sementara; sebagian unit belum terbaca'
              : 'Snapshot suspect, invalid, atau missing'
          }
          icon="review"
        />
      </div>

      {errors > 0 && (
        <p
          className="ho-error-banner"
          role="alert"
        >
          {errors} unit belum dapat dibaca. Unit
          lainnya tetap ditampilkan. Periksa backend
          lalu tekan Muat ulang.
        </p>
      )}

      <UnitSummary entries={entries} />

      {PLANTS.map((plant) => (
        <section
          className="ho-plant"
          key={plant.id}
          aria-labelledby={`ho-plant-${plant.id}`}
        >
          <div className="ho-plant-heading">
            <div className="ho-plant-title">
              <span className="ho-plant-icon">
                <Icon name="plant" />
              </span>

              <div>
                <h2 id={`ho-plant-${plant.id}`}>
                  PLTA {plant.name}
                </h2>

                <p>
                  {plant.units.length} unit pembangkit
                  · seluruh unit ditampilkan
                </p>
              </div>
            </div>

            <span className="ho-plant-code">
              {plant.id}
            </span>
          </div>

          <div
            className={`ho-unit-grid ho-unit-grid-${plant.units.length}`}
          >
            {UNITS.filter(
              (unit) => unit.plantId === plant.id,
            ).map((unit) => (
              <UnitCard
                key={unit.id}
                unit={unit}
                entry={entries[unit.id]}
                range={range}
                onOpenUnit={onOpenUnit}
              />
            ))}
          </div>
        </section>
      ))}

      <section
        className="ho-readiness"
        aria-label="Kesiapan analisis"
      >
        <div>
          <strong>Alarm & trip</strong>
          <p>
            Menunggu validasi ambang, satuan, dan
            cakupan sensor. Belum digunakan untuk
            menetapkan kondisi mesin.
          </p>
        </div>

        <div>
          <strong>Orbit poros</strong>
          <p>
            Belum ditampilkan; data waveform X/Y
            tersinkron belum tersedia pada integrasi
            ini.
          </p>
        </div>

        <div>
          <strong>Partial Discharge</strong>
          <p>
            Analisis PD belum aktif. Pengukuran akan
            tampil jika sudah tersedia dan dipetakan
            pada API.
          </p>
        </div>
      </section>

      <div className="ho-footnote">
        <span>
          Snapshot memakai pengukuran terakhir tiap
          sensor; waktu pengukuran dapat berbeda.
          Nilai unverified belum diverifikasi.
          Nilai suspect, missing, dan invalid
          ditampilkan sebagai tanda — tanpa jarum.
        </span>

        <span>HYDRO INSIGHT · READ ONLY</span>
      </div>
    </div>
  );
}