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

import type { MeasurementFile } from './HistoricalData'

type Props = {
  dataset?: MeasurementFile
  unitLabel?: string
  onOpenHistorical: () => void
}

function formatValue(value: number) {
  return value.toLocaleString('id-ID', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export default function UnitTrend({
  dataset,
  unitLabel,
  onOpenHistorical,
}: Props) {
  const [selectedDate, setSelectedDate] = useState('')
  const [selectedTag, setSelectedTag] = useState('')

  const dates = dataset
    ? Array.from(
        new Set(
          dataset.rows.map((row) => row.timestamp.split(' ')[0]),
        ),
      )
    : []

  const activeDate = dates.includes(selectedDate)
    ? selectedDate
    : dates[0] ?? ''

  const activeTag =
    dataset?.tags.includes(selectedTag)
      ? selectedTag
      : dataset?.tags[0] ?? ''

  const tagIndex = dataset?.tags.indexOf(activeTag) ?? -1

  const chartData =
    dataset && tagIndex >= 0
      ? dataset.rows
          .filter(
            (row) => row.timestamp.split(' ')[0] === activeDate,
          )
          .map((row) => ({
            time: row.timestamp.split(' ')[1],
            value: row.values[tagIndex],
          }))
          .filter((row) => Number.isFinite(row.value))
          .sort((a, b) => a.time.localeCompare(b.time))
      : []

  const values = chartData.map((row) => row.value)

  const statistics =
    values.length > 0
      ? {
          min: values.reduce((a, b) => Math.min(a, b)),
          max: values.reduce((a, b) => Math.max(a, b)),
          average:
            values.reduce((total, value) => total + value, 0) /
            values.length,
          last: values[values.length - 1],
        }
      : null

  const lastTime = chartData[chartData.length - 1]?.time

  if (!unitLabel) {
    return (
      <section className="panel">
        <div className="panel-heading">
          <h2>Trend unit terpilih</h2>
          <p>Pilih satu unit pada filter atau matriks monitoring.</p>
        </div>

        <div className="empty-content">
          <span className="empty-icon">i</span>
          <h3>Belum ada unit yang dipilih</h3>
          <p>
            Grafik akan mengikuti pilihan PLTA dan unit di bagian atas.
          </p>
        </div>
      </section>
    )
  }

  if (!dataset || dataset.rows.length === 0) {
    return (
      <section className="panel">
        <div className="panel-heading">
          <h2>Trend · {unitLabel}</h2>
          <p>Data pengukuran unit ini belum dimuat.</p>
        </div>

        <div className="empty-content">
          <span className="empty-icon">i</span>
          <h3>Data historis belum tersedia</h3>

          <p>
            Buka Historical Data, pilih unit tujuan yang sesuai,
            kemudian impor file pengukuran.
          </p>

          <button
            className="outline-button"
            onClick={onOpenHistorical}
          >
            Buka Historical Data
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Trend · {unitLabel}</h2>
        <p>
          Data historis aktual · {dataset.tags.length} kanal tersedia
        </p>
      </div>

      <div className="trend-controls">
        <label>
          Tanggal sumber

          <select
            value={activeDate}
            onChange={(event) => setSelectedDate(event.target.value)}
          >
            {dates.map((date) => (
              <option key={date} value={date}>
                {date}
              </option>
            ))}
          </select>
        </label>

        <label className="trend-channel">
          Kanal pengukuran

          <select
            value={activeTag}
            onChange={(event) => setSelectedTag(event.target.value)}
          >
            {dataset.tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
        </label>
      </div>

      {statistics ? (
        <>
          <div className="trend-statistics">
            <div>
              <span>Terakhir pada tanggal terpilih</span>
              <strong>{formatValue(statistics.last)}</strong>
              <small>{lastTime} · waktu sumber</small>
            </div>

            <div>
              <span>Minimum</span>
              <strong>{formatValue(statistics.min)}</strong>
              <small>Nilai ekspor</small>
            </div>

            <div>
              <span>Maksimum</span>
              <strong>{formatValue(statistics.max)}</strong>
              <small>Nilai ekspor</small>
            </div>

            <div>
              <span>Rata-rata</span>
              <strong>{formatValue(statistics.average)}</strong>
              <small>Rata-rata nilai ekspor</small>
            </div>
          </div>

          <div className="trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{
                  top: 15,
                  right: 20,
                  bottom: 10,
                  left: 0,
                }}
              >
                <CartesianGrid
                  stroke="#e5edf0"
                  strokeDasharray="3 3"
                />

                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value: string) =>
                    value.slice(0, 5)
                  }
                  minTickGap={35}
                />

                <YAxis
                  width={60}
                  tick={{ fontSize: 10 }}
                />

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
        </>
      ) : (
        <div className="empty-content">
          <p>Tidak ada nilai valid pada pilihan ini.</p>
        </div>
      )}

      <div className="trend-disclaimer">
        Satuan, format tanggal, timezone, dan metode nilai ekspor
        belum dikonfirmasi. Grafik menunjukkan nilai historis;
        status normal atau alarm belum dievaluasi.
      </div>

      <div className="trend-source">
        <span>
          {dataset.source} · {chartData.length} titik pengukuran
        </span>

        <button
          className="text-button"
          onClick={onOpenHistorical}
        >
          Kelola data historis
        </button>
      </div>
    </section>
  )
}