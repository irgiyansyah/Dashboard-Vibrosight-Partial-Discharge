import { useEffect, useState } from 'react';

const TAGS = {
  'LRN-01': [
    ['U-LGS1-ZT-81101-AI', 'ZT-81101'],
  ],
  'LRN-02': [
    ['U-LGS2-ZT-81201-AI', 'ZT-81201'],
  ],
  'LRN-03': [
    ['U-LGS3_ZT_81301-AI', 'ZT-81301'],
    ['U-LAR3-Program:Gov_App.WG_PV-AI', 'WG_PV'],
  ],
  'BLB-01': [
    ['U-BGS1_WICKET_GATE_POS-AI', 'Wicket Gate'],
  ],
  'BLB-02': [
    ['U-BGS2_WICKET_GATE_POS-AI', 'Wicket Gate'],
  ],
  'KRB-01': [
    ['U-KGS1-Turb_Gov_Turb_Wicket_Gate_Pos-AI', 'Wicket Gate'],
  ],
  'KRB-02': [
    ['U-KGS2-Turb_Gov_Turb_Wicket_Gate_Pos-AI', 'Wicket Gate'],
  ],
};

const FORMAT = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatTime(value) {
  if (!value) return '';

  const source = String(value).replace('T', ' ').slice(0, 19);
  const [date, clock] = source.split(' ');
  const [year, month, day] = date.split('-');

  return `${day}/${month}/${year} · ${clock || ''}`;
}

function parseReading(row) {
  if (!row) {
    return {
      value: null,
      stamp: '',
      note: 'Tidak ada data pada periode ini',
    };
  }

  const valid =
    row.quality === 'unverified' &&
    Boolean(row.measured_at) &&
    Number.isFinite(row.plot_value) &&
    row.plot_value >= 0 &&
    row.plot_value <= 100;

  return {
    value: valid ? row.plot_value : null,
    stamp: row.measured_at || '',
    note: valid
      ? ''
      : row.quality === 'missing'
        ? 'Pembacaan kosong'
        : 'Pembacaan perlu ditinjau',
  };
}

export default function WicketGateMetric({
  unitId,
  parameters = [],
  start = '',
  end = '',
  revision = 0,
  loadHistory,
  variant = 'monitoring',
}) {
  const definitions = TAGS[unitId] || [];

  const channels = definitions.map(([tag, label]) => {
    const matches = parameters.filter(
      (item) => item.unit_id === unitId && item.tag_name === tag,
    );

    return {
      tag,
      label,
      parameter: matches.length === 1 ? matches[0] : null,
      ambiguous: matches.length > 1,
    };
  });

  const idsKey = JSON.stringify(
    channels.map(({ parameter }) => parameter?.channel_id ?? null),
  );

  const historyMode = typeof loadHistory === 'function';
  const validRange = Boolean(start && end && start < end);

  const canLoad =
    historyMode &&
    validRange &&
    channels.some(
      ({ parameter }) =>
        Number.isSafeInteger(parameter?.channel_id) &&
        parameter.channel_id > 0,
    );

  const requestKey = JSON.stringify([
    unitId, idsKey, start, end, revision,
  ]);

  const [state, setState] = useState({
    key: '',
    readings: [],
  });

  useEffect(() => {
    if (!canLoad) return;

    let active = true;
    let timedOut = false;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 120000);

    async function load() {
      try {
        const ids = JSON.parse(idsKey);

        const readings = await Promise.all(
          ids.map(async (id) => {
            if (!Number.isSafeInteger(id) || id <= 0) {
              return null;
            }

            try {
              const result = await loadHistory(
                id, start, end, controller.signal,
              );

              if (!Array.isArray(result?.rows)) {
                throw new Error('Format riwayat tidak sesuai.');
              }

              return parseReading(result.rows.at(-1));
            } catch (error) {
              return {
                value: null,
                stamp: '',
                note: timedOut
                  ? 'Waktu tunggu habis. Muat ulang data.'
                  : error instanceof Error
                    ? error.message
                    : 'Gagal membaca data',
              };
            }
          }),
        );

        if (active) {
          setState({ key: requestKey, readings });
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
  }, [
    canLoad,
    idsKey,
    start,
    end,
    requestKey,
    loadHistory,
  ]);

  const loading = Boolean(canLoad && state.key !== requestKey);

  const rows = channels.map((channel, index) => {
    const parameter = channel.parameter;

    let reading = {
      value: null,
      stamp: '',
      note: channel.ambiguous
        ? 'Pemetaan kanal perlu ditinjau'
        : 'Data belum tersedia',
    };

    if (parameter && !historyMode) {
      reading = parseReading({
        plot_value: parameter.latest_plot_value,
        quality: parameter.latest_quality,
        measured_at: parameter.latest_time,
      });
    } else if (parameter && historyMode) {
      reading =
        (
          canLoad &&
          state.key === requestKey &&
          state.readings[index]
        ) || {
          value: null,
          stamp: '',
          note: loading ? 'Memuat…' : 'Pilih periode data',
        };
    }

    return { ...channel, ...reading };
  });

  return (
    <article
      className={`${
        variant === 'overview' ? 'ho-parameter' : 'hml-metric'
      } wg-metric`}
      aria-busy={loading}
    >
      <span>Wicket Gate</span>

      <div className="wg-readings">
        {rows.map((row) => (
          <div
            key={row.tag}
            className="wg-reading"
            title={row.tag}
          >
            {rows.length > 1 && (
              <span className="wg-label">{row.label}</span>
            )}

            <strong className="wg-value">
              {Number.isFinite(row.value)
                ? FORMAT.format(row.value)
                : '—'}

              <span className="wg-unit">%</span>
            </strong>

            {row.stamp && (
              <small>{formatTime(row.stamp)}</small>
            )}

            {row.note && (
              <small role="status">{row.note}</small>
            )}
          </div>
        ))}
      </div>

      {rows.length > 1 && (
        <small className="wg-note">
          Dua kanal sumber · acuan utama belum ditetapkan
        </small>
      )}
    </article>
  );
}