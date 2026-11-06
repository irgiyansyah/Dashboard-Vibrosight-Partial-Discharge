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

function voltageState(unitId, parameters) {
  const expectedTag = VOLTAGE_TAGS[unitId];
  const matches = (Array.isArray(parameters) ? parameters : []).filter(
    (item) => expectedTag && item.unit_id === unitId && item.tag_name === expectedTag,
  );
  if (matches.length !== 1) {
    return {
      value: null,
      unit: 'Satuan belum dikonfirmasi',
      status: matches.length > 1 ? 'Pemetaan voltage perlu ditinjau' : 'Data voltage belum tersedia',
      stamp: '',
      tag: expectedTag || '',
    };
  }
  const parameter = matches[0];
  const rawNumber = parameter.latest_plot_value;
  const canShow = Boolean(parameter.latest_time) &&
    parameter.latest_quality === 'unverified' && Number.isFinite(rawNumber);
  const statuses = {
    unverified: canShow ? 'Belum diverifikasi' : 'Nilai terbaru belum tersedia',
    suspect: 'Perlu ditinjau; angka tidak ditampilkan',
    missing: 'Data terbaru kosong',
    invalid: 'Data terbaru tidak valid',
  };
  return {
    value: canShow ? rawNumber : null,
    unit: parameter.engineering_unit || 'Satuan belum dikonfirmasi',
    status: statuses[parameter.latest_quality] || 'Kualitas data belum tersedia',
    stamp: parameter.latest_time ? String(parameter.latest_time).replace('T', ' ').slice(0, 19) : '',
    tag: expectedTag,
  };
}

export default function VoltageMetric({ unitId, parameters = [] }) {
  const reading = voltageState(unitId, parameters);
  return (
    <article className="hml-metric" title={reading.tag}>
      <span>Voltage</span>
      <strong>{Number.isFinite(reading.value) ? FORMAT.format(reading.value) : '—'}</strong>
      <small>{reading.unit}</small>
      <small>{reading.status}</small>
      <small>
        {reading.stamp ? `Terbaru di database: ${reading.stamp}` : 'Belum ada waktu pengukuran'}
      </small>
    </article>
  );
}
