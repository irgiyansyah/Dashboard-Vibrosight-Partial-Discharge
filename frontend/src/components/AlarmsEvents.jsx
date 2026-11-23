import { useEffect, useRef, useState } from 'react';
import {
  classifyVibration,
  supportsVibrationThreshold,
  VIBRATION_EVENT_LEVELS,
  VIBRATION_STATUS,
} from './vibrationThresholds.js';

const API = (
  import.meta.env.VITE_API_BASE_URL ||
  'http://127.0.0.1:8000'
).replace(/\/+$/, '');

const STEP = 60_000;

const FORMAT = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 2,
});

const DEFAULT_UNITS = [
  ['LRN-01', 'Larona', 'Unit 1'],
  ['LRN-02', 'Larona', 'Unit 2'],
  ['LRN-03', 'Larona', 'Unit 3'],
  ['BLB-01', 'Balambano', 'Unit 1'],
  ['BLB-02', 'Balambano', 'Unit 2'],
  ['KRB-01', 'Karebbe', 'Unit 1'],
  ['KRB-02', 'Karebbe', 'Unit 2'],
].map(([id, plant, name]) => ({
  id,
  plant,
  name,
}));

const fmt = (value) =>
  Number.isFinite(value)
    ? FORMAT.format(value)
    : '—';

const stamp = (value) =>
  value
    ? String(value).replace('T', ' ').slice(0, 19)
    : '—';

function sourceMs(value) {
  const text = String(value || '').replace(' ', 'T');

  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(
      text,
    )
  ) {
    return NaN;
  }

  return Date.parse(`${text}Z`);
}

function dayRange(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return null;
  }

  const ms = Date.parse(`${day}T00:00:00Z`);

  if (
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== day
  ) {
    return null;
  }

  return {
    start: `${day}T00:00:00`,
    end: new Date(ms + 86400000)
      .toISOString()
      .slice(0, 19),
  };
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

function groupEvents(rows, channel) {
  const events = [];

  let open = null;
  let excluded = 0;

  const close = (reason) => {
    if (open) {
      events.push({
        ...open,
        reason,
      });
    }

    open = null;
  };

  for (const row of rows) {
    const ms = sourceMs(row.measured_at);

    const level =
      Number.isFinite(ms) && row.quality === 'unverified'
        ? classifyVibration(row.plot_value)
        : null;

    if (open && ms - open.lastMs !== STEP) {
      close('Jeda data');
    }

    if (level === null) {
      excluded += 1;
      close('Kualitas data');
      continue;
    }

    if (level === 'normal') {
      close('Kembali ke rentang normal');
      continue;
    }

    if (open && open.level !== level) {
      close('Perubahan tingkat');
    }

    if (!open) {
      open = {
        id:
          `${channel.unitId}:` +
          `${channel.channel_id}:` +
          `${row.measured_at}:${level}`,
        unitId: channel.unitId,
        plant: channel.plant,
        unitName: channel.unitName,
        channelId: channel.channel_id,
        tag: channel.tag_name,
        level,
        first: row.measured_at,
        last: row.measured_at,
        lastMs: ms,
        extreme: row.plot_value,
        count: 1,
      };
    } else {
      open.last = row.measured_at;
      open.lastMs = ms;
      open.extreme = level === 'fail'
        ? Math.min(open.extreme, row.plot_value)
        : Math.max(open.extreme, row.plot_value);
      open.count += 1;
    }
  }

  close('Batas data yang dibaca');

  return {
    events,
    excluded,
  };
}

async function jsonRequest(path, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();

  let timedOut = false;

  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener(
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
      `${API}${path}`,
      {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (timedOut) {
      throw new Error(
        'API tidak merespons dalam 30 detik',
      );
    }

    throw error;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function readHistory(
  channelId,
  range,
  signal,
) {
  const rows = [];

  let after = '';
  let expected = null;
  let previousMs = -Infinity;

  while (true) {
    if (signal.aborted) {
      throw new Error('Analisis dibatalkan');
    }

    const query = new URLSearchParams({
      ...range,
      limit: '5000',
      include_suspect: 'false',
    });

    if (after) {
      query.set('after', after);
    }

    const body = await jsonRequest(
      `/api/parameters/${channelId}/history?${query}`,
      signal,
    );

    if (
      body.status !== 'ok' ||
      !Array.isArray(body.data) ||
      typeof body.pagination?.has_more !== 'boolean' ||
      !body.analysis?.summary
    ) {
      throw new Error(
        'Format riwayat tidak sesuai',
      );
    }

    if (expected === null) {
      expected = Number(
        body.analysis.summary.total_count,
      );

      if (
        !Number.isSafeInteger(expected) ||
        expected < 0 ||
        expected > 50000
      ) {
        throw new Error(
          'Jumlah data di luar batas analisis satu hari',
        );
      }
    }

    for (const row of body.data) {
      const ms = sourceMs(row.measured_at);

      if (
        !Number.isFinite(ms) ||
        ms <= previousMs ||
        ms < sourceMs(range.start) ||
        ms >= sourceMs(range.end)
      ) {
        throw new Error(
          'Urutan atau rentang timestamp tidak sesuai',
        );
      }

      previousMs = ms;
      rows.push(row);

      if (rows.length > 50000) {
        throw new Error(
          'Terlalu banyak sampel per kanal',
        );
      }
    }

    if (!body.pagination.has_more) break;

    const next = body.pagination.next_after;

    if (
      !body.data.length ||
      typeof next !== 'string' ||
      next === after ||
      next !== body.data.at(-1).measured_at
    ) {
      throw new Error(
        'Cursor riwayat tidak valid',
      );
    }

    after = next;
  }

  if (rows.length !== expected) {
    throw new Error(
      'Riwayat belum lengkap; ulangi analisis',
    );
  }

  return rows;
}

async function queue(items, action, signal) {
  let index = 0;

  async function worker() {
    while (
      !signal.aborted &&
      index < items.length
    ) {
      await action(items[index++]);
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(2, items.length),
      },
      worker,
    ),
  );
}

export default function AlarmsEvents({
  units = DEFAULT_UNITS,
}) {
  const unitsKey = JSON.stringify(
    units.map(({ id, plant, name }) => ({
      id,
      plant,
      name,
    })),
  );

  const [revision, setRevision] = useState(0);
  const [chosenDay, setChosenDay] = useState('');
  const [plant, setPlant] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [page, setPage] = useState(1);

  const [metadata, setMetadata] = useState({
    key: '',
    channels: [],
    issues: [],
    latest: '',
  });

  const [run, setRun] = useState(null);
  const scanController = useRef(null);

  const metadataKey =
    `${unitsKey}|${revision}`;

  const ready =
    metadata.key === metadataKey;

  const day =
    chosenDay ||
    (
      ready
        ? metadata.latest.slice(0, 10)
        : ''
    );

  const range = dayRange(day);
  const runKey = `${metadataKey}|${day}`;

  const current =
    run?.key === runKey ? run : null;

  const loading = Boolean(current?.loading);

  useEffect(() => {
    const controller = new AbortController();

    let active = true;

    const channels = [];
    const issues = [];
    const times = [];

    async function load() {
      await queue(
        JSON.parse(unitsKey),
        async (unit) => {
          try {
            const body = await jsonRequest(
              `/api/units/${encodeURIComponent(
                unit.id,
              )}/parameters`,
              controller.signal,
            );

            if (
              body.status !== 'ok' ||
              !Array.isArray(body.data) ||
              body.unit?.id !== unit.id
            ) {
              throw new Error(
                'Respons unit tidak sesuai',
              );
            }

            const seen = new Set();

            for (const parameter of body.data) {
              if (
                !parameter ||
                parameter.unit_id !== unit.id ||
                !Number.isSafeInteger(
                  parameter.channel_id,
                ) ||
                parameter.channel_id < 1 ||
                seen.has(parameter.channel_id)
              ) {
                throw new Error(
                  'Metadata kanal tidak sesuai',
                );
              }

              seen.add(parameter.channel_id);
            }

            const vibrations =
              body.data.filter(isVibration);

            if (!vibrations.length) {
              issues.push(
                `${unit.plant} ${unit.name}: ` +
                'kanal getaran belum tersedia.',
              );
            }

            for (const parameter of vibrations) {
              if (
                Number.isFinite(
                  sourceMs(parameter.latest_time),
                )
              ) {
                times.push(parameter.latest_time);
              }

              if (!supportsVibrationThreshold(parameter)) {
                issues.push(
                  `${unit.id} · ${parameter.tag_name}: ` +
                  'satuan µm / definisi peak-to-peak belum sesuai.',
                );
                continue;
              }

              channels.push({
                ...parameter,
                unitId: unit.id,
                plant: unit.plant,
                unitName: unit.name,
              });
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              issues.push(
                `${unit.plant} ${unit.name}: ` +
                error.message,
              );
            }
          }
        },
        controller.signal,
      );

      if (active) {
        setMetadata({
          key: metadataKey,
          channels,
          issues,
          latest: times.sort().at(-1) || '',
        });
      }
    }

    void load();

    return () => {
      active = false;
      controller.abort();
    };
  }, [unitsKey, metadataKey]);

  useEffect(() => {
    setPage(1);

    return () => {
      scanController.current?.abort();
      scanController.current = null;
    };
  }, [runKey]);

  async function analyze() {
    if (
      !ready ||
      !range ||
      !metadata.channels.length ||
      loading
    ) {
      return;
    }

    scanController.current?.abort();

    const controller = new AbortController();
    scanController.current = controller;

    const events = [];
    const issues = [...metadata.issues];

    let done = 0;
    let successful = 0;
    let samples = 0;
    let excluded = 0;

    setPage(1);

    setRun({
      key: runKey,
      loading: true,
      done: 0,
      total: metadata.channels.length,
      events: [],
      issues: [],
    });

    await queue(
      metadata.channels,
      async (channel) => {
        try {
          const rows = await readHistory(
            channel.channel_id,
            range,
            controller.signal,
          );

          const result = groupEvents(
            rows,
            channel,
          );

          events.push(...result.events);
          samples += rows.length;
          excluded += result.excluded;
          successful += 1;

          if (!rows.length) {
            issues.push(
              `${channel.unitId} · ${channel.tag_name}: ` +
              'tidak ada data pada tanggal ini.',
            );
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            issues.push(
              `${channel.unitId} · ${channel.tag_name}: ` +
              error.message,
            );
          }
        }

        done += 1;

        if (
          scanController.current === controller &&
          !controller.signal.aborted
        ) {
          setRun((old) =>
            old?.key === runKey
              ? {
                  ...old,
                  done,
                }
              : old,
          );
        }
      },
      controller.signal,
    );

    if (
      scanController.current !== controller ||
      controller.signal.aborted
    ) {
      return;
    }

    events.sort(
      (a, b) =>
        sourceMs(b.first) - sourceMs(a.first) ||
        a.tag.localeCompare(b.tag),
    );

    setRun({
      key: runKey,
      loading: false,
      done,
      total: metadata.channels.length,
      successful,
      samples,
      excluded,
      events,
      issues,
    });

    scanController.current = null;
  }

  function cancel() {
    scanController.current?.abort();
    scanController.current = null;
    setRun(null);
  }

  const completed =
    current && !current.loading;

  const allEvents =
    completed ? current.events : [];

  const plantEvents = allEvents.filter(
    (event) =>
      plant === 'all' ||
      event.plant === plant,
  );

  const segmentCounts = { fail: 0, awareness: 0, trip: 0 };
  for (const event of plantEvents) {
    segmentCounts[event.level] += 1;
  }

  const filtered = plantEvents.filter(
    (event) =>
      severity === 'all' ||
      event.level === severity,
  );

  const pages = Math.max(
    1,
    Math.ceil(filtered.length / 25),
  );

  const safePage = Math.min(page, pages);

  const visible = filtered.slice(
    (safePage - 1) * 25,
    safePage * 25,
  );

  const issues = completed
    ? current.issues
    : ready
      ? metadata.issues
      : [];

  const plants = [
    ...new Set(
      units.map((unit) => unit.plant),
    ),
  ];

  return (
    <section
      className="ae-page"
      aria-busy={!ready || loading}
    >
      <style>{CSS}</style>

      <header className="ae-heading">
        <div>
          <span className="ae-eyebrow">
            HYDRO INSIGHT · HISTORIS
          </span>

          <h2>Alarms & Events</h2>

          <p>
            Segmen status getaran · Larona,
            Balambano, dan Karebbe
          </p>
        </div>

        <button
          type="button"
          disabled={!ready || loading}
          onClick={() =>
            setRevision((value) => value + 1)
          }
        >
          Muat ulang kanal
        </button>
      </header>

      <div className="ae-rule">
        <strong>
          Aturan getaran · µm p-p
        </strong>

        {Object.entries(VIBRATION_STATUS).map(([level, status]) => (
          <span key={level} className={`ae-${level}`}>
            {status.label}: {status.range}
          </span>
        ))}
      </div>

      <p className="ae-note">
        Ambang getaran mengikuti batas mentor.
        Status Trip di halaman ini dihitung dari pembacaan historis.
      </p>

      <div className="ae-toolbar">
        <label>
          Tanggal analisis

          <input
            type="date"
            value={day}
            disabled={loading || !ready}
            onChange={(event) =>
              setChosenDay(event.target.value)
            }
          />
        </label>

        <button
          className="ae-primary"
          type="button"
          disabled={
            !ready ||
            loading ||
            !range ||
            !metadata.channels.length
          }
          onClick={analyze}
        >
          Analisis tanggal
        </button>

        {loading && (
          <button
            type="button"
            onClick={cancel}
          >
            Batalkan
          </button>
        )}

        <label>
          PLTA

          <select
            value={plant}
            onChange={(event) => {
              setPlant(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">
              Semua PLTA
            </option>

            {plants.map((name) => (
              <option key={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Tingkat

          <select
            value={severity}
            onChange={(event) => {
              setSeverity(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">
              Semua tingkat
            </option>

            {VIBRATION_EVENT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {VIBRATION_STATUS[level].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="ae-note">
        {range
          ? `${stamp(range.start)} sampai sebelum ${stamp(
              range.end,
            )}.`
          : 'Pilih tanggal untuk mulai.'}
        {' '}Waktu mengikuti sumber. Filter PLTA dan
        tingkat berlaku pada hasil tabel; analisis
        mencakup seluruh kanal yang memenuhi
        metadata.
      </p>

      {!ready && (
        <p role="status">
          Memuat daftar kanal getaran…
        </p>
      )}

      {loading && (
        <p role="status">
          Menganalisis {current.done} dari{' '}
          {current.total} kanal…
        </p>
      )}

      <div className="ae-cards">
        {VIBRATION_EVENT_LEVELS.map((level) => (
          <article key={level}>
            <span>Segmen {VIBRATION_STATUS[level].label}</span>
            <strong>{completed ? segmentCounts[level] : '—'}</strong>
            <small>{VIBRATION_STATUS[level].range} µm p-p</small>
          </article>
        ))}

        <article>
          <span>
            Kanal berhasil dibaca
          </span>

          <strong>
            {completed
              ? `${current.successful}/${current.total}`
              : '—'}
          </strong>

          <small>
            Cakupan seluruh PLTA
          </small>
        </article>

        <article>
          <span>
            Sampel dikecualikan
          </span>

          <strong>
            {completed
              ? fmt(current.excluded)
              : '—'}
          </strong>

          <small>
            Kualitas atau nilai tidak memenuhi
            syarat
          </small>
        </article>
      </div>

      {completed && (
        <p className="ae-note">
          {fmt(current.samples)} sampel dibaca.
          {' '}
          {issues.length
            ? 'Cakupan memiliki catatan; segmen pada kanal yang gagal dibaca belum dapat dievaluasi.'
            : 'Hasil hanya mencakup sampel yang dikembalikan API.'}
        </p>
      )}

      {issues.length > 0 && (
        <details className="ae-issues">
          <summary>
            {issues.length} catatan cakupan /
            kualitas data
          </summary>

          <ul>
            {issues.map((issue, index) => (
              <li key={index}>
                {issue}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="ae-table-wrap">
        <table>
          <thead>
            <tr>
              <th>PLTA / unit</th>
              <th>Sensor</th>
              <th>Tingkat</th>
              <th>Awal teramati</th>
              <th>Akhir teramati</th>
              <th>Nilai ekstrem µm p-p</th>
              <th>Sampel</th>
              <th>Batas segmen</th>
            </tr>
          </thead>

          <tbody>
            {visible.map((event) => (
              <tr key={event.id}>
                <td>
                  <strong>
                    {event.plant}
                  </strong>

                  <small>
                    {event.unitName} ·{' '}
                    {event.unitId}
                  </small>
                </td>

                <td className="ae-tag">
                  {event.tag}
                </td>

                <td>
                  <span
                    className={`ae-badge ae-${event.level}`}
                  >
                    {VIBRATION_STATUS[event.level].label}
                  </span>
                </td>

                <td>
                  {stamp(event.first)}
                </td>

                <td>
                  {stamp(event.last)}
                </td>

                <td>
                  <strong>
                    {fmt(event.extreme)}
                  </strong>
                  <small>{event.level === 'fail' ? 'Minimum' : 'Maksimum'}</small>
                </td>

                <td>
                  {event.count}
                </td>

                <td>
                  {event.reason}
                </td>
              </tr>
            ))}

            {!visible.length && (
              <tr>
                <td
                  colSpan={8}
                  className="ae-empty"
                >
                  {loading
                    ? 'Analisis sedang berlangsung…'
                    : !completed
                      ? 'Pilih tanggal, lalu tekan Analisis tanggal.'
                      : 'Tidak ada segmen FAIL, Alert / Awareness, atau Trip pada hasil filter ini.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="ae-pagination">
        <span>
          {filtered.length} segmen · halaman{' '}
          {safePage}/{pages}
        </span>

        <button
          type="button"
          disabled={safePage <= 1}
          onClick={() =>
            setPage(safePage - 1)
          }
        >
          Sebelumnya
        </button>

        <button
          type="button"
          disabled={safePage >= pages}
          onClick={() =>
            setPage(safePage + 1)
          }
        >
          Berikutnya
        </button>
      </div>

      <p className="ae-note">
        Satu segmen berisi sampel bertingkat sama
        dengan jarak tepat 60 detik. Jeda, kualitas
        yang dikecualikan, atau perubahan tingkat
        memisahkan segmen. Awal/akhir teramati bukan
        waktu pasti awal/pulihnya alarm; data
        sebelum/sesudah rentang tidak diperiksa.
        Sampel unverified dapat dianalisis tetapi
        belum diverifikasi. Hasil dihitung saat
        diminta, belum disimpan sebagai log alarm
        permanen.
      </p>
    </section>
  );
}

const CSS = `
.ae-page {
  color: #16345b;
  font: 14px/1.5 system-ui, sans-serif;
  padding: 20px;
  background: #f3f6fa;
  border-radius: 12px;
}

.ae-page * {
  box-sizing: border-box;
}

.ae-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.ae-heading h2 {
  margin: 5px 0;
  font-size: 25px;
}

.ae-heading p {
  margin: 0;
  color: #526984;
}

.ae-eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .1em;
}

.ae-page button,
.ae-page input,
.ae-page select {
  font: inherit;
  color: #16345b;
  border: 1px solid #c9d8e8;
  border-radius: 7px;
  background: #fff;
  padding: 9px 12px;
}

.ae-page button {
  cursor: pointer;
}

.ae-page button:disabled {
  opacity: .5;
  cursor: not-allowed;
}

.ae-page button:focus-visible,
.ae-page input:focus-visible,
.ae-page select:focus-visible {
  outline: 3px solid #32b3df;
  outline-offset: 2px;
}

.ae-page .ae-primary {
  background: #1677a5;
  color: #fff;
  border-color: #1677a5;
}

.ae-rule {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 22px;
  background: #fff;
  border: 1px solid #d6e2ee;
  border-radius: 9px;
  padding: 14px;
}

.ae-rule > strong {
  margin-right: auto;
}

.ae-note {
  color: #526984;
  font-size: 12px;
  margin: 12px 0;
  line-height: 1.7;
}

.ae-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 12px;
  margin: 20px 0 10px;
}

.ae-toolbar label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
}

.ae-toolbar input,
.ae-toolbar select {
  min-height: 42px;
}

.ae-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  margin: 18px 0;
}

.ae-cards article {
  background: #fff;
  border: 1px solid #d6e2ee;
  border-radius: 9px;
  padding: 16px;
}

.ae-cards strong {
  display: block;
  font-size: 28px;
  margin: 8px 0;
  font-variant-numeric: tabular-nums;
}

.ae-cards small {
  color: #526984;
  display: block;
}

.ae-issues {
  background: #fff8e6;
  border: 1px solid #e8cd83;
  border-radius: 8px;
  padding: 12px;
  margin: 15px 0;
}

.ae-issues summary {
  cursor: pointer;
  font-weight: 600;
}

.ae-issues ul {
  max-height: 220px;
  overflow: auto;
  padding-left: 22px;
}

.ae-issues li {
  overflow-wrap: anywhere;
  margin: 7px 0;
}

.ae-table-wrap {
  overflow: auto;
  background: #fff;
  border: 1px solid #d6e2ee;
  border-radius: 9px;
}

.ae-page table {
  width: 100%;
  min-width: 1050px;
  border-collapse: collapse;
}

.ae-page th {
  background: #eaf1f8;
  text-align: left;
  font-size: 12px;
  padding: 13px;
  color: #16345b;
  white-space: nowrap;
}

.ae-page td {
  padding: 13px;
  border-bottom: 1px solid #e2eaf3;
  font-size: 12px;
  vertical-align: top;
  color: #16345b;
  background: #fff;
}

.ae-page tbody tr:nth-child(even) td {
  background: #f8fafd;
}

.ae-page td small {
  display: block;
  color: #526984;
}

.ae-tag {
  max-width: 250px;
  overflow-wrap: anywhere;
}

.ae-page .ae-fail {
  color: #7041a1;
}

.ae-page .ae-normal {
  color: #187348;
}

.ae-page .ae-awareness {
  color: #8a5900;
}

.ae-page .ae-trip {
  color: #b42332;
}

.ae-badge {
  display: inline-block;
  border-radius: 5px;
  padding: 4px 8px;
  font-weight: 700;
  white-space: nowrap;
}

.ae-badge.ae-fail {
  background: #efe4fb;
}

.ae-badge.ae-awareness {
  background: #fff0bf;
}

.ae-badge.ae-trip {
  background: #fde5e8;
}

.ae-page .ae-empty {
  text-align: center;
  padding: 30px;
  color: #526984;
}

.ae-pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  margin-top: 15px;
}

.ae-pagination span {
  margin-right: auto;
  font-size: 12px;
}

@media (max-width: 850px) {
  .ae-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .ae-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .ae-page {
    padding: 14px;
  }
}

@media (max-width: 480px) {
  .ae-cards {
    grid-template-columns: 1fr;
  }

  .ae-pagination {
    flex-wrap: wrap;
  }
}
`;