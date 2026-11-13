import { useEffect, useState } from 'react';
import './PowerMetric.css';

const TAGS = {
  'LRN-01': [
    'U-LGS1-Active-Power-AI',
    'U-LGS1-Reactive-Power-AI',
  ],
  'LRN-02': [
    'U-LGS2-Active-Power-AI',
    'U-LGS2-Reactive-Power-AI',
  ],
  'LRN-03': [
    'U-LGS3_Active-Power-AI',
    'U-LGS3_Reactive-Power-AI',
  ],
  'BLB-01': [
    'U-BGS1-Power-AI',
    'U-BGS1-PowerReactive-Mvar-AI',
  ],
  'BLB-02': [
    'U-BGS2-Power-AI',
    'U-BGS2-PowerReactive-Mvar-AI',
  ],
  'KRB-01': [
    'U-KGS1-Active_Power_AI',
    'U-KGS1-Reactive_Power_AI',
  ],
  'KRB-02': [
    'U-KGS2-Active_Power_AI',
    'U-KGS2-Reactive_Power_AI',
  ],
};

const TYPES = {
  activePower: {
    index: 0,
    title: 'Daya aktif',
    unit: 'MW',
  },
  reactivePower: {
    index: 1,
    title: 'Daya reaktif',
    unit: 'MVAr',
  },
};

const FORMAT = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 2,
});

function readValue(value, quality, stamp) {
  const valid =
    Boolean(stamp) &&
    quality === 'unverified' &&
    Number.isFinite(value);

  return {
    value: valid ? value : null,
    stamp: stamp || '',
    note: valid
      ? ''
      : {
          missing: 'Pengukuran kosong',
          invalid: 'Data tidak valid',
          suspect: 'Perlu ditinjau',
        }[quality] || 'Nilai belum tersedia',
  };
}

function formatTime(value) {
  if (!value) return '';

  const text = String(value)
    .replace('T', ' ')
    .slice(0, 19);

  return (
    `${text.slice(8, 10)}/${text.slice(5, 7)}/` +
    `${text.slice(0, 4)} · ${text.slice(11)}`
  );
}

export default function PowerMetric({
  unitId,
  kind,
  parameters = [],
  start = '',
  end = '',
  revision = 0,
  loadHistory,
  variant = 'monitoring',
}) {
  const config = TYPES[kind];
  const tag = config
    ? TAGS[unitId]?.[config.index]
    : null;

  const matches = tag
    ? parameters.filter(
        (p) =>
          p.unit_id === unitId &&
          p.tag_name === tag,
      )
    : [];

  const parameter =
    matches.length === 1 ? matches[0] : null;

  const channelId = parameter?.channel_id;

  const metadataReady = Boolean(
    config &&
    parameter &&
    String(parameter.engineering_unit || '')
      .trim()
      .toLowerCase() === config.unit.toLowerCase(),
  );

  const historyMode =
    typeof loadHistory === 'function';

  const canLoad = Boolean(
    historyMode &&
    metadataReady &&
    Number.isSafeInteger(channelId) &&
    channelId > 0 &&
    start &&
    end &&
    start < end,
  );

  const key = JSON.stringify([
    unitId,
    kind,
    channelId,
    start,
    end,
    revision,
  ]);

  const [state, setState] = useState({
    key: '',
    result: null,
  });

  useEffect(() => {
    if (!canLoad) return;

    const controller = new AbortController();
    let active = true;
    let timedOut = false;

    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 120000);

    async function load() {
      try {
        const history = await loadHistory(
          channelId,
          start,
          end,
          controller.signal,
        );

        if (!Array.isArray(history?.rows)) {
          throw new Error(
            'Format riwayat tidak sesuai.',
          );
        }

        const row = history.rows.at(-1);

        const result = row
          ? readValue(
              row.plot_value,
              row.quality,
              row.measured_at,
            )
          : {
              value: null,
              stamp: '',
              note: 'Tidak ada data pada rentang ini',
            };

        if (active) {
          setState({ key, result });
        }
      } catch {
        if (active) {
          setState({
            key,
            result: {
              value: null,
              stamp: '',
              note: timedOut
                ? 'Waktu tunggu habis. Muat ulang data.'
                : 'Riwayat daya gagal dimuat.',
            },
          });
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
    channelId,
    start,
    end,
    key,
    loadHistory,
  ]);

  const loading =
    canLoad && state.key !== key;

  let result = {
    value: null,
    stamp: '',
    note: 'Data belum tersedia',
  };

  if (!config) {
    result.note = 'Jenis parameter belum dipetakan';
  } else if (matches.length > 1) {
    result.note = 'Pemetaan kanal ganda';
  } else if (parameter && !metadataReady) {
    result.note = 'Metadata satuan perlu diperiksa';
  } else if (parameter && !historyMode) {
    result = readValue(
      parameter.latest_plot_value,
      parameter.latest_quality,
      parameter.latest_time,
    );
  } else if (canLoad) {
    result = loading
      ? {
          value: null,
          stamp: '',
          note: 'Memuat…',
        }
      : state.result || result;
  } else if (parameter && historyMode) {
    result.note = 'Pilih rentang tanggal';
  }

  return (
    <article
      className={`${
        variant === 'overview'
          ? 'ho-parameter'
          : 'hml-metric'
      } power-metric`}
      aria-busy={loading}
      title={tag || 'Daya generator'}
    >
      <span className="power-title">
        {config?.title || 'Daya generator'}
      </span>

      <p className="power-reading">
        <strong>
          {Number.isFinite(result.value)
            ? FORMAT.format(result.value)
            : '—'}
        </strong>

        <span>{config?.unit || ''}</span>
      </p>

      {result.stamp && (
        <time className="power-time">
          {formatTime(result.stamp)}
        </time>
      )}

      {result.note && (
        <small
          className="power-note"
          role="status"
        >
          {result.note}
        </small>
      )}
    </article>
  );
}