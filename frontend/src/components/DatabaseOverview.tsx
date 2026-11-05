import { useEffect, useState } from 'react'
import type { HydroUnit } from '../data/units'
import './DatabaseOverview.css'

type Props = {
  units: HydroUnit[]
  onOpenUnit: (unit: HydroUnit) => void
}

type Reading = {
  latest_time: string | null
  latest_quality: string | null
}

type Result = {
  id: string
  error: string | null
  hasData: boolean
  latest: string | null
  quality: string
  needsReview: boolean
}

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ||
  'http://127.0.0.1:8000'
).replace(/\/$/, '')

function timestamp(value: string | null) {
  return value
    ? value.replace('T', ' ').slice(0, 19)
    : '—'
}

export default function DatabaseOverview({
  units,
  onOpenUnit,
}: Props) {
  const ids = units.map((unit) => unit.id).join('|')
  const [revision, setRevision] = useState(0)

  const key = `${ids}:${revision}`

  const [state, setState] = useState<{
    key: string
    rows: Result[]
  }>({
    key: '',
    rows: [],
  })

  useEffect(() => {
    if (!ids) return

    let active = true
    const controller = new AbortController()

    const timer = window.setTimeout(
      () => controller.abort(),
      20000,
    )

    async function readUnit(id: string): Promise<Result> {
      try {
        const response = await fetch(
          `${API_BASE}/api/units/${encodeURIComponent(id)}/parameters`,
          {
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
            },
          },
        )

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const payload = await response.json()

        if (
          payload.status !== 'ok' ||
          !Array.isArray(payload.data)
        ) {
          throw new Error('Format respons tidak sesuai')
        }

        const readings: Reading[] = payload.data

        const valid = readings.every(
          (item) =>
            item &&
            (
              item.latest_time === null ||
              typeof item.latest_time === 'string'
            ) &&
            (
              item.latest_quality === null ||
              typeof item.latest_quality === 'string'
            ),
        )

        if (!valid) {
          throw new Error(
            'Metadata pengukuran tidak sesuai',
          )
        }

        const times = readings
          .map((item) => item.latest_time)
          .filter(
            (value): value is string => Boolean(value),
          )
          .sort()

        const latest = times.at(-1) ?? null

        const needsReview = readings.some(
          (item) =>
            item.latest_quality === 'suspect' ||
            item.latest_quality === 'invalid',
        )

        const hasMissing = readings.some(
          (item) => item.latest_quality === 'missing',
        )

        return {
          id,
          error: null,
          hasData: latest !== null,
          latest,
          needsReview,
          quality: !latest
            ? '—'
            : needsReview
              ? 'Perlu ditinjau'
              : hasMissing
                ? 'Ada nilai kosong'
                : 'Belum diverifikasi',
        }
      } catch (error) {
        return {
          id,
          hasData: false,
          latest: null,
          quality: '—',
          needsReview: false,
          error: controller.signal.aborted
            ? 'Waktu tunggu habis'
            : error instanceof Error
              ? error.message
              : 'Gagal membaca API',
        }
      }
    }

    async function load() {
      const rows = await Promise.all(
        ids.split('|').map(readUnit),
      )

      window.clearTimeout(timer)

      if (active) {
        setState({ key, rows })
      }
    }

    void load()

    return () => {
      active = false
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [ids, key])

  const loading = Boolean(ids) && state.key !== key
  const rows = state.key === key ? state.rows : []

  const available = rows.filter(
    (row) => !row.error && row.hasData,
  ).length

  const empty = rows.filter(
    (row) => !row.error && !row.hasData,
  ).length

  const failed = rows.filter(
    (row) => row.error,
  ).length

  const cards = [
    [
      'Unit dalam filter',
      units.length,
      'Mengikuti pilihan PLTA dan unit',
    ],
    [
      'Memiliki data',
      loading ? '—' : available,
      'Pengukuran tersimpan di database',
    ],
    [
      'Belum ada data',
      loading ? '—' : empty,
      'API berhasil dibaca, pengukuran kosong',
    ],
    [
      'Gagal dibaca',
      loading ? '—' : failed,
      'Tidak dihitung sebagai data kosong',
    ],
  ]

  return (
    <section
      className="db-overview"
      aria-busy={loading}
    >
      <div className="dbo-toolbar">
        <span className="dbo-badge">
          HISTORIS MODE
        </span>

        <button
          type="button"
          disabled={loading || !ids}
          onClick={() =>
            setRevision((value) => value + 1)
          }
        >
          {loading
            ? 'Memuat…'
            : 'Muat ulang ringkasan'}
        </button>
      </div>

      <div className="dbo-kpis">
        {cards.map(([title, count, note]) => (
          <article
            className="dbo-card"
            key={String(title)}
          >
            <span>{title}</span>
            <strong>{count}</strong>
            <small>{note}</small>
          </article>
        ))}
      </div>

      <section className="dbo-panel">
        <h2>Ringkasan unit pembangkit</h2>

        <p>
          Ketersediaan data tidak menunjukkan status
          operasi atau kondisi mesin.
        </p>

        {loading && (
          <p role="status">
            Membaca ringkasan unit…
          </p>
        )}

        {failed > 0 && (
          <p role="alert">
            Sebagian data gagal dibaca. Periksa backend,
            lalu muat ulang ringkasan.
          </p>
        )}

        <div className="dbo-scroll">
          <table>
            <thead>
              <tr>
                <th>PLTA</th>
                <th>Unit</th>
                <th>Data historis</th>
                <th>Waktu data terakhir</th>
                <th>Kualitas data terakhir</th>
                <th>Aksi</th>
              </tr>
            </thead>

            <tbody>
              {units.map((unit) => {
                const row = rows.find(
                  (item) => item.id === unit.id,
                )

                return (
                  <tr key={unit.id}>
                    <td>{unit.plant}</td>
                    <td>{unit.name}</td>

                    <td>
                      {loading || !row
                        ? 'Memuat…'
                        : row.error
                          ? `Gagal: ${row.error}`
                          : row.hasData
                            ? 'Tersedia'
                            : 'Belum tersedia'}
                    </td>

                    <td>
                      {timestamp(row?.latest ?? null)}
                    </td>

                    <td>
                      <span
                        className={
                          row?.needsReview
                            ? 'dbo-review'
                            : 'dbo-quality'
                        }
                      >
                        {row?.quality ?? '—'}
                      </span>
                    </td>

                    <td>
                      <button
                        type="button"
                        onClick={() => onOpenUnit(unit)}
                        aria-label={
                          `Buka monitoring ${unit.plant} ${unit.name}`
                        }
                      >
                        Buka monitoring
                      </button>
                    </td>
                  </tr>
                )
              })}

              {!units.length && (
                <tr>
                  <td colSpan={6}>
                    Tidak ada unit dalam filter ini.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="dbo-note">
          Waktu mengikuti sumber, tanpa konversi zona
          waktu. Kualitas diringkas dari pengukuran
          terakhir setiap parameter, bukan seluruh
          riwayat. “Perlu ditinjau” menandai kualitas
          data suspect atau invalid, bukan alarm mesin.
        </p>
      </section>
    </section>
  )
}