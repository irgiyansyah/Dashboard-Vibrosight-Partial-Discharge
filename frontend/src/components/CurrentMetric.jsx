import { useEffect, useMemo, useState } from 'react';

const CURRENT_TAGS = {
  'BLB-01': [
    ['U-BGS1_I_G_CURR_PH_1-AI', 'Fasa 1'],
    ['U-BGS1_I_G_CURR_PH_2-AI', 'Fasa 2'],
    ['U-BGS1_I_G_CURR_PH_3-AI', 'Fasa 3'],
  ],
  'BLB-02': [
    ['U-BGS2_I_G_CURR_PH_1-AI', 'Fasa 1'],
    ['U-BGS2_I_G_CURR_PH_2-AI', 'Fasa 2'],
    ['U-BGS2_I_G_CURR_PH_3-AI', 'Fasa 3'],
  ],
  'KRB-01': [
    ['U-KGS1-Gen_Ampere_phase_A_AI', 'Fasa A'],
    ['U-KGS1-Gen_Ampere_phase_B_AI', 'Fasa B'],
    ['U-KGS1-Gen_Ampere_phase_C_AI', 'Fasa C'],
  ],
  'KRB-02': [
    ['U-KGS2-Gen_Ampere_phase_A_AI', 'Fasa A'],
    ['U-KGS2-Gen_Ampere_phase_B_AI', 'Fasa B'],
    ['U-KGS2-Gen_Ampere_phase_C_AI', 'Fasa C'],
  ],
  'LRN-01': [
    ['U-LGS1-II-81104D-AI', 'II-81104D'],
    ['U-LGS1-II_81152B_MV-AI', 'II_81152B_MV'],
    ['U-LGS1-II_81152C_MV-AI', 'II_81152C_MV'],
  ],
  'LRN-02': [
    ['U-LGS2-II-81204D-AI', 'II-81204D'],
    ['U-LGS2-II_81252B_MV-AI', 'II_81252B_MV'],
    ['U-LGS2-II_81252C_MV-AI', 'II_81252C_MV'],
  ],
  'LRN-03': [
    ['U-LGS3-II-81104D-AI', 'II-81104D'],
    ['U-LGS3_II_81304A_I_Eng-AI', 'II_81304A_I_Eng'],
    ['U-LGS3_II_81304B_I_Eng-AI', 'II_81304B_I_Eng'],
  ],
};

const FORMAT = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 2,
});

function time(value) {
  return value
    ? String(value).replace('T', ' ').slice(0, 19)
    : '';
}

function isChannel(parameter) {
  return (
    Number.isSafeInteger(parameter?.channel_id) &&
    parameter.channel_id > 0
  );
}

function reading(value, quality, stamp) {
  const visible =
    Boolean(stamp) &&
    quality === 'unverified' &&
    Number.isFinite(value);

  const notes = {
    unverified: visible
      ? 'Belum diverifikasi'
      : 'Nilai belum tersedia',
    missing: 'Pengukuran kosong',
    invalid: 'Data tidak valid',
    suspect: 'Perlu ditinjau',
  };

  return {
    value: visible ? value : null,
    stamp,
    note: notes[quality] || 'Belum ada pengukuran',
  };
}

export default function CurrentMetric({
  unitId,
  parameters,
  start = '',
  end = '',
  revision = 0,
  loadHistory,
  variant = 'overview',
}) {
  const channels = useMemo(
    () =>
      (CURRENT_TAGS[unitId] || []).map(([tag, label]) => {
        const matches = (parameters || []).filter(
          (parameter) =>
            parameter.unit_id === unitId &&
            parameter.tag_name === tag,
        );

        return {
          tag,
          label,
          parameter:
            matches.length === 1 ? matches[0] : null,
          ambiguous: matches.length > 1,
        };
      }),
    [unitId, parameters],
  );

  const historyMode = typeof loadHistory === 'function';

  const canLoad =
    historyMode &&
    start &&
    end &&
    start < end &&
    channels.some(({ parameter }) => isChannel(parameter));

  const key = JSON.stringify([
    unitId,
    start,
    end,
    revision,
    channels.map(({ parameter }) => parameter?.channel_id),
  ]);

  const [state, setState] = useState({
    key: '',
    values: [],
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
        const values = await Promise.all(
          channels.map(async ({ parameter }) => {
            if (!isChannel(parameter)) return null;

            try {
              const result = await loadHistory(
                parameter.channel_id,
                start,
                end,
                controller.signal,
              );

              if (!Array.isArray(result?.rows)) {
                throw new Error(
                  'Format riwayat tidak sesuai.',
                );
              }

              const row = result.rows.at(-1);

              return row
                ? reading(
                    row.plot_value,
                    row.quality,
                    row.measured_at,
                  )
                : {
                    value: null,
                    stamp: '',
                    note: 'Tidak ada data pada rentang ini',
                  };
            } catch (error) {
              return {
                value: null,
                stamp: '',
                note: timedOut
                  ? 'Waktu tunggu habis. Muat ulang data.'
                  : error instanceof Error
                    ? error.message
                    : 'Riwayat gagal dimuat',
              };
            }
          }),
        );

        if (active) {
          setState({ key, values });
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
    channels,
    end,
    key,
    loadHistory,
    start,
  ]);

  const loading = Boolean(
    canLoad && state.key !== key,
  );

  const rows = channels.map(
    ({ tag, label, parameter, ambiguous }, index) => {
      let result = {
        value: null,
        stamp: '',
        note: 'Kanal belum tersedia',
      };

      if (ambiguous) {
        result.note = 'Pemetaan ganda; periksa tag';
      } else if (parameter && !historyMode) {
        result = reading(
          parameter.latest_plot_value,
          parameter.latest_quality,
          parameter.latest_time,
        );
      } else if (parameter && historyMode) {
        result =
          (
            canLoad &&
            state.key === key &&
            state.values[index]
          ) || {
            value: null,
            stamp: '',
            note: loading
              ? 'Memuat…'
              : 'Rentang belum tersedia',
          };
      }

      return {
        tag,
        label,
        parameter,
        ...result,
      };
    },
  );

    const isLarona = unitId?.startsWith('LRN-');

  const availableTimes = rows
    .map((row) => time(row.stamp))
    .filter(Boolean);

  const commonTime =
    availableTimes.length === rows.length &&
    new Set(availableTimes).size === 1
      ? availableTimes[0]
      : '';

  function displayTime(value) {
    const normalized = time(value);

    if (!normalized) return 'Waktu belum tersedia';

    const [date, clock] = normalized.split(' ');
    const [year, month, day] = date.split('-');

    return `${day}/${month}/${year} · ${clock || ''}`;
  }

  const missingUnit = rows.some(
    ({ parameter }) =>
      parameter && !parameter.engineering_unit,
  );

  const hasData = rows.some(
    ({ value }) => Number.isFinite(value),
  );

  const displayRows = rows.map((row, index) => ({
    ...row,
    displayLabel: isLarona
      ? `Pembacaan ${index + 1}`
      : row.label,
  }));

  const readings = (
    <div className="current-clean-list">
      {displayRows.map((row) => (
        <div
          key={row.tag}
          className="current-clean-row"
        >
          <span className="current-clean-label">
            {row.displayLabel}
          </span>

          <div className="current-clean-reading">
            <strong>
              {Number.isFinite(row.value)
                ? FORMAT.format(row.value)
                : '—'}
            </strong>

            {Number.isFinite(row.value) &&
              row.parameter?.engineering_unit && (
                <span className="current-clean-unit">
                  {row.parameter.engineering_unit}
                </span>
              )}
          </div>

          {!Number.isFinite(row.value) && (
            <span className="current-clean-row-note">
              {loading ? 'Memuat data…' : row.note}
            </span>
          )}

          {!commonTime && row.stamp && (
            <span className="current-clean-row-note">
              {displayTime(row.stamp)}
            </span>
          )}
        </div>
      ))}
    </div>
  );

  if (variant === 'summary') {
    return (
      <div
        data-current="summary"
        className="current-clean-summary"
      >
        {readings}
      </div>
    );
  }

  return (
    <div
      className={`${
        variant === 'monitoring'
          ? 'hml-metric'
          : 'ho-parameter'
      } current-clean`}
      data-current={variant}
      aria-busy={loading}
    >
      <div className="current-clean-heading">
        <span className="current-clean-title">
          Arus generator
        </span>

        <span className="current-clean-badge">
          Historis
        </span>
      </div>

      <p className="current-clean-caption">
        {historyMode
          ? 'Pembacaan terakhir pada periode pilihan'
          : 'Pembacaan terakhir yang tersimpan'}
      </p>

      {commonTime && (
        <p className="current-clean-date">
          {displayTime(commonTime)}
        </p>
      )}

      {readings}

      {missingUnit && (
        <p className="current-clean-footnote">
          Satuan menunggu konfirmasi.
        </p>
      )}

      {!hasData && !loading && (
        <p className="current-clean-footnote">
          Belum ada nilai yang dapat ditampilkan.
        </p>
      )}

      
    </div>
  );
}