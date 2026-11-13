import { useEffect, useState } from 'react';
import './SpeedMetric.css';

const SPEED_TAGS = {
  'LRN-01': 'U-LGS1-SI-81101-AI',
  'LRN-02': 'U-LGS2-SI-81201-AI',
  'LRN-03': 'U-LGS3_SI_81301_I_Eng-AI',
  'BLB-01': 'U-BGS1_I_T_SPEED-AI',
  'BLB-02': 'U-BGS2_I_T_SPEED-AI',
  'KRB-01': 'U-KAR1-T1001-11-1-AI',
  'KRB-02': 'U-KGS2-Turb_Gov_Turb_Speed-AI',
};

const FORMAT = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 2,
});

function readValue(value, quality, stamp) {
  const valid =
    Boolean(stamp) &&
    quality === 'unverified' &&
    Number.isFinite(value) &&
    value >= 0;

  return {
    value: valid ? value : null,
    stamp: stamp || '',
    note: valid
      ? ''
      : ({
          missing: 'Pengukuran kosong',
          invalid: 'Data tidak valid',
          suspect: 'Perlu ditinjau',
        }[quality] || 'Nilai belum tersedia'),
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

export default function SpeedMetric({
  unitId,
  parameters = [],
  start = '',
  end = '',
  revision = 0,
  loadHistory,
  variant = 'overview',
}) {
  const tag = SPEED_TAGS[unitId];

  const matches = tag
    ? parameters.filter(
        (p) => p.unit_id === unitId && p.tag_name === tag,
      )
    : [];

  const parameter = matches.length === 1
    ? matches[0]
    : null;

  const channelId = parameter?.channel_id;

  const metadataReady = String(
    parameter?.engineering_unit || '',
  ).trim().toLowerCase() === 'rpm';

  const historyMode = typeof loadHistory === 'function';

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
          throw new Error('Format riwayat tidak sesuai.');
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

        if (active) setState({ key, result });
      } catch {
        if (active) {
          setState({
            key,
            result: {
              value: null,
              stamp: '',
              note: timedOut
                ? 'Waktu tunggu habis. Muat ulang data.'
                : 'Riwayat Speed gagal dimuat.',
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

  const loading = canLoad && state.key !== key;

  let result = {
    value: null,
    stamp: '',
    note: 'Data belum tersedia',
  };

  if (matches.length > 1) {
    result.note = 'Pemetaan kanal ganda';
  } else if (parameter && !metadataReady) {
    result.note = 'Metadata satuan Speed perlu diperiksa';
  } else if (parameter && !historyMode) {
    result = readValue(
      parameter.latest_plot_value,
      parameter.latest_quality,
      parameter.latest_time,
    );
  } else if (parameter && canLoad) {
    result = loading
      ? { value: null, stamp: '', note: 'Memuat…' }
      : state.result;
  } else if (parameter && historyMode) {
    result.note = 'Pilih rentang tanggal';
  }

  const panel = variant === 'panel';
  const Container = panel ? 'section' : 'article';
  const Heading = panel ? 'h2' : 'span';

  return (
    <Container
      className={`${
        panel ? 'hml-panel' : 'ho-parameter'
      } speed-metric`}
      aria-busy={loading}
      title={tag || 'Speed'}
    >
      <Heading className="speed-title">Speed</Heading>

      <p className="speed-reading">
        <strong>
          {Number.isFinite(result.value)
            ? FORMAT.format(result.value)
            : '—'}
        </strong>
        <span>rpm</span>
      </p>

      {result.stamp && (
        <time className="speed-time">
          {formatTime(result.stamp)}
        </time>
      )}

      {result.note && (
        <small className="speed-note" role="status">
          {result.note}
        </small>
      )}
    </Container>
  );
}