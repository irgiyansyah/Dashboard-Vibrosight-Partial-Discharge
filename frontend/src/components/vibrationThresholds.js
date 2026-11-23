export const VIBRATION_LIMITS = {
  normal: 50,
  awareness: 250,
  trip: 350,
};

export const VIBRATION_STATUS = {
  fail: {
    label: 'FAIL',
    range: `< ${VIBRATION_LIMITS.normal}`,
    color: '#7041a1',
  },
  normal: {
    label: 'Normal',
    range: `${VIBRATION_LIMITS.normal} – < ${VIBRATION_LIMITS.awareness}`,
    color: '#187348',
  },
  awareness: {
    label: 'Alert / Awareness',
    range: `${VIBRATION_LIMITS.awareness} – < ${VIBRATION_LIMITS.trip}`,
    color: '#8a5900',
  },
  trip: {
    label: 'Trip',
    range: `≥ ${VIBRATION_LIMITS.trip}`,
    color: '#c5283d',
  },
};

export const VIBRATION_EVENT_LEVELS = ['fail', 'awareness', 'trip'];

export function supportsVibrationThreshold(parameter) {
  const unit = String(parameter.engineering_unit || '')
    .trim()
    .replace(/μ/g, 'µ')
    .toLowerCase();

  const definition = String(parameter.measurement_definition || '');

  return (
    ['µm', 'um'].includes(unit) &&
    /\bpeak[\s_-]*to[\s_-]*peak\b/i.test(definition)
  );
}

export function classifyVibration(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < VIBRATION_LIMITS.normal) return 'fail';
  if (value < VIBRATION_LIMITS.awareness) return 'normal';
  if (value < VIBRATION_LIMITS.trip) return 'awareness';
  return 'trip';
}