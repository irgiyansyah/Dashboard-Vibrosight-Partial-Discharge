import { useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { hydroUnits } from '../data/units'

export type MeasurementFile = {
  unitId: string
  source: string
  tags: string[]
  rows: {
    timestamp: string
    values: number[]
  }[]
}

type Props = {
  datasets: MeasurementFile[]
  onChange: (datasets: MeasurementFile[]) => void
}

function parseFile(
  content: string,
  unitId: string,
  source: string,
): MeasurementFile {
  const document = new DOMParser().parseFromString(content, 'text/html')

  const tables = Array.from(document.querySelectorAll('table'))

  const table = tables.find((item) => {
    const firstCell = item.querySelector('tr th, tr td')
    return firstCell?.textContent?.trim().toLowerCase() === 'timestamp'
  })

  if (!table) {
    throw new Error(
      'Tabel TimeStamp tidak ditemukan. Gunakan file ekspor HTML .xls seperti contoh Hydro Operation.',
    )
  }

  const tableRows = Array.from(table.querySelectorAll('tr'))
    .map((row) =>
      Array.from(row.querySelectorAll('th, td')).map(
        (cell) => cell.textContent?.trim() ?? '',
      ),
    )
    .filter((row) => row.length > 0)

  const [header, ...body] = tableRows

  if (!header || header.length < 2 || body.length === 0) {
    throw new Error('File tidak memiliki kolom dan baris pengukuran yang cukup.')
  }

  const tags = header.slice(1)

  if (tags.some((tag) => !tag) || new Set(tags).size !== tags.length) {
    throw new Error('Nama tag kosong atau berulang.')
  }

  const seen = new Set<string>()

  const rows = body.map((row, index) => {
    if (row.length !== header.length) {
      throw new Error(`Jumlah kolom pada baris ${index + 2} tidak sesuai.`)
    }

    const timestamp = row[0]

    // Format kalender belum ditafsirkan sebagai DD/MM atau MM/DD.
    // Waktu asli dipertahankan sampai dikonfirmasi tim.
    const pattern =
      /^\d{2}\/\d{2}\/\d{4} ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/

    if (!pattern.test(timestamp)) {
      throw new Error(`Format timestamp tidak sesuai pada baris ${index + 2}.`)
    }

    if (seen.has(timestamp)) {
      throw new Error(`Timestamp berulang: ${timestamp}.`)
    }

    seen.add(timestamp)

    const rawValues = row.slice(1)

    // Menolak sel kosong dan angka dengan format yang belum didukung.
    const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

    if (
      rawValues.some(
        (value) => !numberPattern.test(value) || !Number.isFinite(Number(value)),
      )
    ) {
      throw new Error(
        `Ada nilai kosong atau bukan angka pada baris ${index + 2}.`,
      )
    }

    return {
      timestamp,
      values: rawValues.map(Number),
    }
  })

  return { unitId, source, tags, rows }
}

function formatNumber(value: number) {
  return value.toLocaleString('id-ID', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export default function HistoricalData({ datasets, onChange }: Props) {
  const [targetUnit, setTargetUnit] = useState('LAR-U1')
  const [selectedUnit, setSelectedUnit] = useState('LAR-U1')
  const [selectedDate, setSelectedDate] = useState('')
  const [selectedTag, setSelectedTag] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const dataset = datasets.find((item) => item.unitId === selectedUnit)

  const dates = dataset
    ? Array.from(new Set(dataset.rows.map((row) => row.timestamp.split(' ')[0])))
    : []

  const activeDate = dates.includes(selectedDate)
    ? selectedDate
    : dates[0] ?? ''

  const activeTag =
    dataset && dataset.tags.includes(selectedTag)
      ? selectedTag
      : dataset?.tags[0] ?? ''

  const tagIndex = dataset?.tags.indexOf(activeTag) ?? -1

  // Urutkan jam dalam satu tanggal tanpa menebak format kalender.
  const filteredRows = (dataset?.rows ?? [])
    .filter((row) => row.timestamp.split(' ')[0] === activeDate)
    .sort((a, b) =>
      a.timestamp.split(' ')[1].localeCompare(b.timestamp.split(' ')[1]),
    )

  const chartData = filteredRows.map((row) => ({
    time: row.timestamp.split(' ')[1],
    value: row.values[tagIndex],
  }))

  const values = chartData.map((row) => row.value)

  const statistics =
    values.length > 0
      ? {
          min: values.reduce((a, b) => Math.min(a, b)),
          max: values.reduce((a, b) => Math.max(a, b)),
          mean: values.reduce((total, value) => total + value, 0) / values.length,
          last: values[values.length - 1],
        }
      : null

  async function importFile(file: File) {
    setError('')
    setMessage('')

    if (file.size > 10 * 1024 * 1024) {
      setError('Untuk tahap awal, gunakan file berukuran maksimal 10 MB.')
      return
    }

    setBusy(true)

    try {
      const parsed = parseFile(await file.text(), targetUnit, file.name)

      const existing = datasets.find((item) => item.unitId === targetUnit)

      if (existing) {
        const identical =
          JSON.stringify(existing.tags) === JSON.stringify(parsed.tags) &&
          JSON.stringify(existing.rows) === JSON.stringify(parsed.rows)

        if (identical) {
          setSelectedUnit(targetUnit)
          setMessage('Data identik sudah dimuat. Tidak ditambahkan dua kali.')
          return
        }

        throw new Error(
          'Unit ini sudah memiliki dataset berbeda. Hapus dataset unit tersebut sebelum menggantinya. Penggabungan periode akan kita tambahkan kemudian.',
        )
      }

      onChange([...datasets, parsed])
      setSelectedUnit(targetUnit)
      setSelectedDate('')
      setSelectedTag('')

      setMessage(
        `${file.name}: ${parsed.rows.length} timestamp dan ${parsed.tags.length} kanal berhasil dimuat.`,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'File gagal dibaca.')
    } finally {
      setBusy(false)
    }
  }

  function removeDataset() {
    if (!dataset) return

    const accepted = window.confirm(
      `Hapus data ${selectedUnit} dari sesi ini? File asli tidak berubah.`,
    )

    if (!accepted) return

    onChange(datasets.filter((item) => item.unitId !== selectedUnit))
    setMessage('Dataset dihapus dari sesi. File asli tetap tersimpan.')
    setError('')
  }

  return (
    <div className="historical-workspace">
      <section className="panel">
        <div className="panel-heading">
          <h2>Impor data Hydro Operation</h2>
          <p>
            Pilih unit tujuan, kemudian unggah file ekspor. Pemetaan unit
            ditentukan oleh pilihan Anda.
          </p>
        </div>

        <div className="history-controls">
          <label>
            Unit tujuan impor
            <select
              value={targetUnit}
              disabled={busy}
              onChange={(event) => setTargetUnit(event.target.value)}
            >
              {hydroUnits.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.plant} · {unit.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            File pengukuran
            <input
              type="file"
              accept=".xls,.html,.htm"
              disabled={busy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (file) void importFile(file)
              }}
            />
          </label>
        </div>

        <p className="history-note">
          Format yang didukung: tabel HTML berekstensi .xls seperti file
          contoh Anda. Data tersimpan selama sesi aplikasi.
        </p>

        {busy && <p className="history-message">Membaca file…</p>}
        {message && (
          <p className="history-message" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="history-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Eksplorasi pengukuran historis</h2>
          <p>
            Filter di bagian ini hanya mengatur data historis yang sedang
            ditinjau.
          </p>
        </div>

        <div className="history-controls">
          <label>
            Unit yang ditinjau
            <select
              value={selectedUnit}
              onChange={(event) => {
                setSelectedUnit(event.target.value)
                setSelectedDate('')
                setSelectedTag('')
              }}
            >
              {hydroUnits.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.plant} · {unit.name}
                  {datasets.some((item) => item.unitId === unit.id)
                    ? ' — data dimuat'
                    : ' — belum ada data'}
                </option>
              ))}
            </select>
          </label>

          <label>
            Tanggal sumber
            <select
              value={activeDate}
              disabled={!dataset}
              onChange={(event) => setSelectedDate(event.target.value)}
            >
              {!dataset && <option value="">Belum tersedia</option>}
              {dates.map((date) => (
                <option key={date} value={date}>
                  {date}
                </option>
              ))}
            </select>
          </label>

          <label className="tag-selector">
            Kanal pengukuran
            <select
              value={activeTag}
              disabled={!dataset}
              onChange={(event) => setSelectedTag(event.target.value)}
            >
              {!dataset && <option value="">Belum tersedia</option>}
              {dataset?.tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
        </div>

        {dataset && statistics ? (
          <>
            <div className="history-stats">
              {[
                ['Minimum', statistics.min],
                ['Maksimum', statistics.max],
                ['Rata-rata', statistics.mean],
                ['Terakhir pada tanggal terpilih', statistics.last],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <span>{label}</span>
                  <strong>{formatNumber(Number(value))}</strong>
                  <small>Nilai sumber</small>
                </div>
              ))}
            </div>

            <div className="history-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 15, right: 25, bottom: 15, left: 5 }}
                >
                  <CartesianGrid stroke="#e4ecef" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 10 }}
                    tickFormatter={(value: string) => value.slice(0, 5)}
                    minTickGap={35}
                  />
                  <YAxis tick={{ fontSize: 10 }} width={55} />
                  <Tooltip />
                  <Line
                    name="Nilai sumber"
                    type="linear"
                    dataKey="value"
                    stroke="#16816d"
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="history-warning">
              Satuan, format kalender, timezone, dan definisi nilai per jam
              belum dikonfirmasi. Grafik ini tidak menentukan status
              normal atau alarm mesin.
            </div>

            <div className="table-scroll history-table">
              <table>
                <thead>
                  <tr>
                    <th>Timestamp sumber</th>
                    <th>Nilai</th>
                    <th>Satuan</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={row.timestamp}>
                      <td>{row.timestamp}</td>
                      <td>{formatNumber(row.values[tagIndex])}</td>
                      <td>Belum dikonfirmasi</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="history-source">
              <span>
                Sumber: {dataset.source} · {filteredRows.length} timestamp
              </span>
              <button className="text-button" onClick={removeDataset}>
                Hapus dataset dari sesi
              </button>
            </div>
          </>
        ) : (
          <div className="empty-content">
            <h3>Data unit ini belum tersedia</h3>
            <p>
              Pilih unit tujuan dan impor file untuk menampilkan trend
              serta statistik pengukurannya.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}