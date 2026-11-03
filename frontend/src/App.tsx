import { useEffect, useState } from 'react'
import { fetchHydroUnits } from './data/units'
import type { HydroUnit, Plant } from './data/units'

import HistoricalData from './components/HistoricalData'
import type { MeasurementFile } from './components/HistoricalData'
import HydroMonitoring from './components/HydroMonitoring.jsx'
import DatabaseOverview from './components/DatabaseOverview'

import valeLogo from './assets/vale-logo.png'

import './App.css'
import './UnitMonitoring.integration.css'
import './MentorTheme.css'

const menus = [
  'Overview',
  'Unit Monitoring',
  'Vibration Analysis',
  'Partial Discharge',
  'Alarms & Events',
  'Historical Data',
  'Reports',
  'Data Sources',
] as const

type Page = (typeof menus)[number]
type PlantFilter = Plant | 'all'

const plantOrder: Plant[] = [
  'Larona',
  'Karebbe',
  'Balambano',
]

function MenuIcon({ page }: { page: Page }) {
  const icons = {
    Overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),

    'Unit Monitoring': (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
        <path d="M6 11h3l2-4 3 7 2-3h2" />
      </>
    ),

    'Vibration Analysis': (
      <path d="M2 12h3l3-8 4 16 4-12 3 4h3" />
    ),

    'Partial Discharge': (
      <path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z" />
    ),

    'Alarms & Events': (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
        <path d="M10 21h4M12 2V1" />
      </>
    ),

    'Historical Data': (
      <>
        <path d="M3 11a9 9 0 1 1 2.6 7.4" />
        <path d="M3 4v7h7" />
        <path d="M12 7v5l3 2" />
      </>
    ),

    Reports: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
        <path d="M14 3v6h6" />
        <path d="M8 17v-3M12 17v-5M16 17v-2" />
      </>
    ),

    'Data Sources': (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
      </>
    ),
  }

  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icons[page]}
    </svg>
  )
}

function App() {
  const [page, setPage] = useState<Page>('Overview')
  const [plant, setPlant] = useState<PlantFilter>('all')
  const [unitId, setUnitId] = useState('all')

  // File yang dibuka melalui Historical Data disimpan
  // selama sesi React.
  // Overview dan Unit Monitoring membaca pengukuran
  // melalui API database.
  const [datasets, setDatasets] = useState<MeasurementFile[]>([])

  const [hydroUnits, setHydroUnits] = useState<HydroUnit[]>([])
  const [unitsLoading, setUnitsLoading] = useState(true)
  const [unitsError, setUnitsError] = useState<string | null>(null)
  const [unitsRequest, setUnitsRequest] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let timedOut = false

    const timeoutId = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 10000)

    async function loadUnits() {
      try {
        const units = await fetchHydroUnits(controller.signal)

        if (!active) return

        setHydroUnits(units)
      } catch (error: unknown) {
        if (!active) return

        setHydroUnits([])

        const message = timedOut
          ? 'Backend tidak merespons dalam 10 detik. Periksa terminal backend.'
          : error instanceof TypeError
            ? 'API tidak dapat diakses. Periksa backend dan pengaturan CORS.'
            : error instanceof Error
              ? error.message
              : 'Terjadi kesalahan saat mengambil daftar unit.'

        setUnitsError(message)
      } finally {
        window.clearTimeout(timeoutId)

        if (active) {
          setUnitsLoading(false)
        }
      }
    }

    void loadUnits()

    return () => {
      active = false
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [unitsRequest])

  const plants = plantOrder.filter((name) =>
    hydroUnits.some((unit) => unit.plant === name),
  )

  const isHistoricalPage = page === 'Historical Data'
  const isMonitoringPage =
    page === 'Unit Monitoring' ||
    page === 'Vibration Analysis'

  const availableUnits = hydroUnits.filter(
    (unit) => plant === 'all' || unit.plant === plant,
  )

  const visibleUnits = availableUnits.filter(
    (unit) => unitId === 'all' || unit.id === unitId,
  )

  const selectedUnit = hydroUnits.find(
    (unit) => unit.id === unitId,
  )

  const monitoringUnit =
    selectedUnit ?? availableUnits[0] ?? hydroUnits[0]

  const selectedUnitLabel = selectedUnit
    ? `${selectedUnit.plant} · ${selectedUnit.name}`
    : undefined


  const loadedUnitIds = new Set(
    datasets
      .filter((dataset) => dataset.rows.length > 0)
      .map((dataset) => dataset.unitId),
  )

  function changeMonitoringUnit(id: string) {
    const unit = hydroUnits.find((item) => item.id === id)

    if (!unit) return

    setPlant(unit.plant)
    setUnitId(unit.id)
  }

  function changePlant(value: PlantFilter) {
    setPlant(value)
    setUnitId('all')
  }

  function openUnit(unit: HydroUnit) {
    setPlant(unit.plant)
    setUnitId(unit.id)
    setPage('Unit Monitoring')
  }

  function resetFilters() {
    setPlant('all')
    setUnitId('all')
  }

  function openHistorical() {
    setPage('Historical Data')
  }

  function retryLoadUnits() {
    setUnitsLoading(true)
    setUnitsError(null)
    setUnitsRequest((value) => value + 1)
  }

  if (unitsLoading) {
    return (
      <div className="dashboard">
        <section
          className="panel page-placeholder"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <h2>Memuat daftar unit</h2>
          <p>Mengambil data PLTA dan unit dari backend.</p>
        </section>
      </div>
    )
  }

  if (unitsError) {
    return (
      <div className="dashboard">
        <section
          className="panel page-placeholder"
          role="alert"
        >
          <h2>Daftar unit belum dapat dimuat</h2>
          <p>{unitsError}</p>

          <button
            type="button"
            className="outline-button"
            onClick={retryLoadUnits}
          >
            Coba lagi
          </button>
        </section>
      </div>
    )
  }

  if (hydroUnits.length === 0) {
    return (
      <div className="dashboard">
        <section className="panel page-placeholder">
          <h2>Belum ada unit terdaftar</h2>

          <p>
            API berhasil diakses, tetapi daftar unit kosong.
            Periksa tabel plants dan units di database
            hydro_insight.
          </p>

          <button
            type="button"
            className="outline-button"
            onClick={retryLoadUnits}
          >
            Muat ulang
          </button>
        </section>
      </div>
    )
  }

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <a
          href="#"
          className="brand vale-brand"
          aria-label="PT Vale Indonesia — kembali ke Overview"
          onClick={(event) => {
            event.preventDefault()
            setPage('Overview')
          }}
        >
          <span className="vale-logo-plate">
            <img
              src={valeLogo}
              alt="PT Vale Indonesia"
              className="vale-logo"
            />
          </span>
        </a>

        <p className="brand-caption">
          Hydro Condition Monitoring
        </p>

        <p className="nav-caption">WORKSPACE</p>

        <nav aria-label="Navigasi dashboard">
          {menus.map((menu) => (
            <button
              key={menu}
              type="button"
              className={`nav-item ${
                page === menu ? 'active' : ''
              }`}
              aria-current={
                page === menu ? 'page' : undefined
              }
              onClick={() => setPage(menu)}
            >
              <MenuIcon page={menu} />
              <span className="nav-label">{menu}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="workspace-note">
            <strong>Assessment workspace</strong>
            <p>Vibration & Partial Discharge</p>
          </div>

          <small>Monitoring · read-only</small>
        </div>
      </aside>

      <div className="main-layout">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>{page}</strong>
          </div>

          <div className="profile">
            <span className="badge neutral">
              Historis · bukan live
            </span>

            <div className="avatar">J</div>

            <div className="profile-text">
              <strong>Julio</strong>
              <small>Hydro assessment</small>
            </div>
          </div>
        </header>

        {!isHistoricalPage && !isMonitoringPage && (
          <section
            className="filterbar"
            aria-label="Filter monitoring"
          >
            <label>
              <span>PLTA</span>

              <select
                value={plant}
                onChange={(event) =>
                  changePlant(
                    event.target.value as PlantFilter,
                  )
                }
              >
                <option value="all">Semua PLTA</option>

                {plants.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Unit</span>

              <select
                value={unitId}
                onChange={(event) =>
                  setUnitId(event.target.value)
                }
              >
                <option value="all">Semua unit</option>

                {availableUnits.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.plant} · {unit.name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="text-button"
              onClick={resetFilters}
            >
              Reset filter
            </button>

            <div className="connection-status">
              <span className="status-dot" />
              Data historis · live belum terhubung
            </div>
          </section>
        )}

                <main
          className={
            isMonitoringPage
              ? `unit-monitoring-page${
                  page === 'Vibration Analysis'
                    ? ' vibration-analysis-page'
                    : ''
                }`
              : undefined
          }
        >
          {!isMonitoringPage && (
            <div className="page-heading">
              <div>
                <h1>{page}</h1>

                <p>
                  {isHistoricalPage
                    ? 'Eksplorasi file pengukuran dalam sesi browser.'
                    : selectedUnitLabel
                      ? selectedUnitLabel
                      : plant === 'all'
                        ? 'Armada hidro · Larona, Karebbe, dan Balambano'
                        : `Armada hidro · PLTA ${plant}`}
                </p>
              </div>

              <span className="badge neutral">
                {isHistoricalPage
                  ? `${loadedUnitIds.size} unit dengan file dalam sesi`
                  : `${visibleUnits.length} dari ${hydroUnits.length} unit`}
              </span>
            </div>
          )}

          {isMonitoringPage ? (
            <HydroMonitoring
              units={hydroUnits.map(
                (unit): [string, string, string] => [
                  unit.id,
                  unit.plant,
                  unit.name,
                ],
              )}
              selectedUnitId={monitoringUnit?.id}
              onUnitChange={changeMonitoringUnit}
            />
          ) : page === 'Overview' ? (
            <DatabaseOverview
              units={visibleUnits}
              onOpenUnit={openUnit}
            />
                    ) : page === 'Historical Data' ? (
            <HistoricalData
              datasets={datasets}
              onChange={setDatasets}
            />
          ) : page === 'Data Sources' ? (
            
            <section className="panel">
              <div className="panel-heading">
                <h2>File dalam sesi browser</h2>

                <p>
                  Overview dan Unit Monitoring membaca data
                  dari database. Daftar di bawah hanya
                  menunjukkan file yang dibuka melalui
                  Historical Data dalam sesi browser ini.
                </p>
              </div>

              {datasets.length > 0 ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>PLTA</th>
                        <th>Unit</th>
                        <th>File sumber</th>
                        <th>Kanal</th>
                        <th>Timestamp</th>
                      </tr>
                    </thead>

                    <tbody>
                      {datasets.map((dataset) => {
                        const unit = hydroUnits.find(
                          (item) =>
                            item.id === dataset.unitId,
                        )

                        return (
                          <tr key={dataset.unitId}>
                            <td>
                              {unit?.plant ??
                                'Belum dipetakan'}
                            </td>

                            <td>
                              {unit?.name ??
                                dataset.unitId}
                            </td>

                            <td>{dataset.source}</td>
                            <td>{dataset.tags.length}</td>
                            <td>{dataset.rows.length}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-content">
                  <p>
                    Belum ada file yang dibuka dalam sesi
                    browser ini. Data di database tetap
                    dapat dilihat melalui Overview dan
                    Unit Monitoring.
                  </p>
                </div>
              )}

              <div className="empty-content">
                <button
                  type="button"
                  className="outline-button"
                  onClick={openHistorical}
                >
                  Impor atau kelola data historis
                </button>
              </div>

              <div className="panel-footnote">
                Metadata yang masih diperlukan: satuan per
                tag, definisi pengukuran, format tanggal,
                timezone, pemetaan sensor, dan batas alarm
                resmi. Data PD serta koneksi live belum
                tersedia.
              </div>
            </section>
          ) : (
            <section className="panel page-placeholder">
              <span className="empty-icon">i</span>
              <h2>{page}</h2>
              <p>{pageDescription(page)}</p>

              <button
                type="button"
                className="outline-button"
                onClick={() => setPage('Overview')}
              >
                Kembali ke Overview
              </button>
            </section>
          )}

          {!isMonitoringPage && (
            <footer>
              <span>
                PT Vale Indonesia · Hydro assessment
                dashboard
              </span>

              <span>
                {hydroUnits.length} unit dari database ·{' '}
                Data historis · Live belum terhubung
              </span>
            </footer>
          )}
        </main>
      </div>
    </div>
  )
}

function pageDescription(page: Page) {
  switch (page) {
    case 'Partial Discharge':
      return 'Data instrumen partial discharge belum tersedia.'

    case 'Alarms & Events':
      return 'Riwayat kejadian dan konfigurasi batas alarm belum tersedia.'

    case 'Reports':
      return 'Fitur laporan akan ditambahkan setelah alur impor dan peninjauan data selesai.'

    default:
      return ''
  }
}

export default App