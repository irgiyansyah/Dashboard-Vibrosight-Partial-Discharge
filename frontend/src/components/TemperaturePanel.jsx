import { useEffect, useMemo, useState } from 'react';
import './TemperaturePanel.css';

const CATALOG = {};

function add(tag, unitId, group, label) {
  CATALOG[tag] = { unitId, group, label };
}

for (const n of [1, 2]) {
  const k = `KRB-0${n}`;

  for (const pad of [1, 2, 3]) {
    add(
      `U-KGS${n}-TGB-Pad${pad}-AI`,
      k,
      'bearing',
      `TGB · Pad ${pad}`,
    );
  }

  add(
    `U-KGS${n}-TGB-oil-temp-AI`,
    k,
    'oil',
    'TGB · Oli',
  );

  add(
    `U-KGS${n}-Turb_Guide_Bear_Oil_Temp-AI`,
    k,
    'oil',
    'Turb. guide bearing · Oli',
  );

  const b = `BLB-0${n}`;

  for (const sensor of [1, 2]) {
    add(
      `U-BGS${n}_I_TE_TB_TMP_${sensor}-AI`,
      b,
      'bearing',
      `TB · Sensor ${sensor}`,
    );

    add(
      `U-BGS${n}_I_TE_GEN_GB_T_${sensor}-AI`,
      b,
      'bearing',
      `GEN GB · Sensor ${sensor}`,
    );

    add(
      `U-BGS${n}_I_TE_T_GB_TMP_${sensor}-AI`,
      b,
      'bearing',
      `T GB · Sensor ${sensor}`,
    );
  }

  add(
    `U-BGS${n}_COMBINED_BEARG_OIL_TEMP_1-AI`,
    b,
    'oil',
    'Combined bearing · Oli 1',
  );

  add(
    `U-BGS${n}-CB-OILTMP-AI`,
    b,
    'oil',
    'CB · Oil temp',
  );
}

for (const n of [1, 2, 3]) {
  const suffixes = n === 3
    ? ['H', 'I', 'J']
    : ['H', 'I', 'J', 'K'];

  for (const suffix of suffixes) {
    const id = `81${n}04${suffix}`;

    const tag = n === 3
      ? `U-LGS3_TI_${id}-AI`
      : `U-LGS${n}-TI-${id}-AI`;

    add(
      tag,
      `LRN-0${n}`,
      'oil',
      `TI-${id}`,
    );
  }
}

// Titik sumber yang perlu ditinjau.
// Ini bukan batas normal, alarm, atau trip.
const REVIEW = {
  'U-BGS1_I_TE_GEN_GB_T_1-AI': [
    '07', '08', '09', '10', '12', '13',
  ].map((m) => `2026-01-09 16:${m}:00`),

  'U-BGS1_I_TE_TB_TMP_1-AI': [
    '13', '16', '17', '19', '20',
  ].map((m) => `2026-01-09 16:${m}:00`),

  'U-BGS1_COMBINED_BEARG_OIL_TEMP_1-AI': [
    '21', '23', '24',
  ].map((m) => `2026-01-09 16:${m}:00`),

  'U-LGS2-TI-81204H-AI': [
    ...['57', '58', '59'].map(
      (m) => `2026-01-17 22:${m}:00`,
    ),
    ...['00', '01', '02', '03', '04', '05'].map(
      (m) => `2026-01-17 23:${m}:00`,
    ),
  ],
};

const FORMAT = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 2,
});

const GROUPS = [
  ['bearing', 'Bearing'],
  ['oil', 'Oli bearing'],
  ['other', 'Sensor lainnya'],
];

const stampText = (value) => String(value || '')
  .replace('T', ' ')
  .slice(0, 19);

export function isTemperatureParameter(parameter) {
  return Boolean(CATALOG[parameter.tag_name])
    || parameter.measurement_type === 'temperature'
    || /TEMP|TMP|TGB-Pad|_TE_/i.test(
      parameter.tag_name || '',
    );
}

function describe(parameter) {
  return CATALOG[parameter.tag_name] || {
    unitId: parameter.unit_id,
    group: 'other',
    label: parameter.display_name || parameter.tag_name,
  };
}

function readSample(parameter, row, historical) {
  if (!row) {
    return {
      value: null,
      stamp: '',
      note: 'Tidak ada data pada rentang ini',
    };
  }

  const stamp = stampText(
    historical ? row.measured_at : row.latest_time,
  );

  const value = historical
    ? row.plot_value
    : row.latest_plot_value;

  const quality = historical
    ? row.quality
    : row.latest_quality;

  if (REVIEW[parameter.tag_name]?.includes(stamp)) {
    return {
      value: null,
      stamp,
      note: 'Perlu ditinjau',
    };
  }

  const valid = Boolean(stamp)
    && quality === 'unverified'
    && Number.isFinite(value);

  const note = {
    suspect: 'Perlu ditinjau',
    missing: 'Data kosong',
    invalid: 'Data tidak valid',
  }[quality] || 'Data belum tersedia';

  return {
    value: valid ? value : null,
    stamp,
    note: valid ? '' : note,
  };
}

export default function TemperaturePanel({
  unitId,
  parameters = [],
  start = '',
  end = '',
  revision = 0,
  loadHistory,
  variant = 'monitoring',
}) {
  const requestSpec = JSON.stringify(
    parameters
      .filter(
        (parameter) =>
          parameter.unit_id === unitId
          && isTemperatureParameter(parameter)
          && describe(parameter).unitId === unitId,
      )
      .map((parameter) => ({
        channel_id: parameter.channel_id,
        tag_name: parameter.tag_name,
      }))
      .sort((a, b) => a.channel_id - b.channel_id),
  );

  const requests = useMemo(
    () => JSON.parse(requestSpec),
    [requestSpec],
  );

  const items = requests.map((request) =>
    parameters.find(
      (parameter) =>
        parameter.channel_id === request.channel_id,
    ),
  );

  const historyMode = typeof loadHistory === 'function';

  const canLoad = historyMode
    && Boolean(start && end && start < end)
    && requests.length > 0;

  const key = JSON.stringify([
    unitId,
    requestSpec,
    start,
    end,
    revision,
  ]);

  const [state, setState] = useState({
    key: '',
    readings: {},
  });

  useEffect(() => {
    if (!canLoad) return;

    const controller = new AbortController();

    let active = true;
    let next = 0;
    let timedOut = false;

    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 120000);

    async function worker() {
      while (active && next < requests.length) {
        const parameter = requests[next++];
        let result;

        try {
          if (
            !Number.isSafeInteger(parameter.channel_id)
            || parameter.channel_id < 1
          ) {
            throw new Error('Invalid channel');
          }

          if (controller.signal.aborted) {
            throw new Error('Aborted');
          }

          const history = await loadHistory(
            parameter.channel_id,
            start,
            end,
            controller.signal,
          );

          if (!Array.isArray(history?.rows)) {
            throw new Error('Invalid history');
          }

          result = readSample(
            parameter,
            history.rows.at(-1),
            true,
          );
        } catch {
          result = {
            value: null,
            stamp: '',
            note: timedOut
              ? 'Waktu tunggu habis'
              : 'Gagal memuat data',
          };
        }

        if (active) {
          setState((previous) => ({
            key,
            readings: {
              ...(
                previous.key === key
                  ? previous.readings
                  : {}
              ),
              [parameter.channel_id]: result,
            },
          }));
        }
      }
    }

    void Promise.all([
      worker(),
      worker(),
    ]).finally(() => {
      window.clearTimeout(timer);
    });

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    canLoad,
    requests,
    start,
    end,
    key,
    loadHistory,
  ]);

  const loading = canLoad && (
    state.key !== key
    || requests.some(
      (parameter) =>
        !state.readings[parameter.channel_id],
    )
  );

  const hasUnknownUnit = items.some(
    (parameter) =>
      !String(parameter.engineering_unit || '').trim(),
  );

  return (
    <section
      className={`temperature-panel ${
        variant === 'overview'
          ? 'ho-section'
          : 'hml-panel'
      }`}
      aria-busy={loading}
    >
      <header className="temperature-heading">
        <h3>Temperatur bearing & oli</h3>

        <span>
          {historyMode
            ? 'Rentang pilihan'
            : 'Snapshot terakhir'}
        </span>
      </header>

      {!items.length && (
        <p className="temperature-empty">
          Data temperatur belum tersedia.
        </p>
      )}

      <div className="temperature-groups">
        {GROUPS.map(([group, title]) => {
          const groupItems = items.filter(
            (parameter) =>
              describe(parameter).group === group,
          );

          if (!groupItems.length) return null;

          return (
            <div
              className="temperature-group"
              key={group}
            >
              <h4>{title}</h4>

              {groupItems.map((parameter) => {
                const result = !historyMode
                  ? readSample(parameter, parameter, false)
                  : !canLoad
                    ? {
                        value: null,
                        stamp: '',
                        note: 'Pilih rentang tanggal',
                      }
                    : state.key === key
                        && state.readings[parameter.channel_id]
                      ? state.readings[parameter.channel_id]
                      : {
                          value: null,
                          stamp: '',
                          note: 'Memuat…',
                        };

                return (
                  <div
                    className="temperature-row"
                    key={parameter.channel_id}
                    title={parameter.tag_name}
                  >
                    <span className="temperature-label">
                      {describe(parameter).label}
                    </span>

                    <div className="temperature-value">
                      <strong>
                        {result.value === null
                          ? '—'
                          : FORMAT.format(result.value)}
                      </strong>

                      <span>
                        {parameter.engineering_unit || ''}
                      </span>
                    </div>

                    {result.stamp && (
                      <time className="temperature-time">
                        {result.stamp}
                      </time>
                    )}

                    {result.note && (
                      <small className="temperature-note">
                        {result.note}
                      </small>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {items.length > 0 && (
        <p className="temperature-footnote">
          {hasUnknownUnit
            ? 'Satuan sebagian sensor belum dikonfirmasi. '
            : ''}
          Nilai belum diverifikasi; batas alarm temperatur
          belum diterapkan.
        </p>
      )}
    </section>
  );
}