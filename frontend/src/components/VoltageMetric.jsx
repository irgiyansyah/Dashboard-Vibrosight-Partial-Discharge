import { useEffect, useState } from 'react';

const VOLTAGE_TAGS = {
  'LRN-01': 'U-LAR1-EI_81104_AVE-AI',
  'LRN-02': 'U-LAR2-EI_81204_AVE-AI',
  'LRN-03': 'U-LAR3-EI_81302m-AI',
  'BLB-01': 'U-BGS1-I-G-VOLT-PH-1-AI',
  'BLB-02': 'U-BGS2-I-G-VOLT-PH-1-AI',
  'KRB-01': 'U-KGS1-SCADA-Gen-U1-Voltage-L1-AI',
  'KRB-02': 'U-KGS2-SCADA-Gen-U2-Voltage-L1-AI',
};

const FORMAT = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function voltageReading(row) {
  if (!row) {
    return { value: null, status: 'Data tidak tersedia pada rentang ini', stamp: '' };
  }
  const canShow = Boolean(row.measured_at) &&
    row.quality === 'unverified' && Number.isFinite(row.plot_value);
  const statuses = {
    unverified: canShow ? 'Belum diverifikasi' : 'Nilai terakhir belum tersedia',
    suspect: 'Perlu ditinjau; angka tidak ditampilkan',
    missing: 'Pengukuran terakhir kosong',
    invalid: 'Pengukuran terakhir tidak valid',
  };
  return {
    value: canShow ? row.plot_value : null,
    status: statuses[row.quality] || 'Kualitas data belum tersedia',
    stamp: row.measured_at ? String(row.measured_at).replace('T', ' ').slice(0, 19) : '',
  };
}

function displayTime(value) {
  return value ? String(value).replace('T', ' ').slice(0, 19) : '—';
}

export default function VoltageMetric({
  unitId,
  parameters = [],
  start = '',
  end = '',
  revision = 0,
  loadHistory,
}) {
  const expectedTag = VOLTAGE_TAGS[unitId];
  const matches = (Array.isArray(parameters) ? parameters : []).filter(
    (item) => expectedTag && item.unit_id === unitId && item.tag_name === expectedTag,
  );
  const parameter = matches.length === 1 ? matches[0] : null;
  const channelId = parameter?.channel_id;
  const canLoad = Number.isSafeInteger(channelId) && channelId > 0 &&
    Boolean(start && end && start < end) && typeof loadHistory === 'function';
  const key = JSON.stringify([unitId, channelId, start, end, revision]);
  const [state, setState] = useState({ key: '', row: null, error: '' });

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
        // Existing paginated history loader validates order, range and row count.
        // Select the actual last row, even if it is missing/suspect/invalid.
        const result = await loadHistory(channelId, start, end, controller.signal);
        if (!result || !Array.isArray(result.rows)) {
          throw new Error('Format riwayat voltage tidak sesuai.');
        }
        if (active) {
          setState({ key, row: result.rows.at(-1) || null, error: '' });
        }
      } catch (error) {
        if (active) {
          setState({
            key,
            row: null,
            error: timedOut
              ? 'Pengambilan data melebihi 120 detik. Tekan Muat ulang data.'
              : error instanceof Error ? error.message : 'Gagal membaca riwayat voltage.',
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
  }, [canLoad, channelId, start, end, key, loadHistory]);

  const current = state.key === key;
  const loading = canLoad && !current;
  let reading = { value: null, status: '', stamp: '' };
  if (!parameter) {
    reading.status = matches.length > 1
      ? 'Pemetaan voltage perlu ditinjau' : 'Data voltage belum tersedia untuk unit ini';
  } else if (!canLoad) {
    reading.status = 'Pilih rentang tanggal yang tersedia.';
  } else if (loading) {
    reading.status = 'Memuat voltage pada rentang pilihan…';
  } else if (state.error) {
    reading.status = `Gagal memuat: ${state.error}`;
  } else {
    reading = voltageReading(state.row);
  }

    return (
    <article
      className="hml-metric voltage-compact"
      title={expectedTag || ''}
      aria-busy={loading}
    >
      <span>Voltage</span>

      <strong className="voltage-compact-value">
        {Number.isFinite(reading.value)
          ? FORMAT.format(reading.value)
          : '—'}

        {parameter?.engineering_unit && (
          <span className="voltage-compact-unit">
            {parameter.engineering_unit}
          </span>
        )}
      </strong>

      {reading.stamp && (
        <small>
          {displayTime(reading.stamp)}
        </small>
      )}

      {!Number.isFinite(reading.value) && (
        <small role="status">
          {reading.status}
        </small>
      )}
    </article>
  );
}

