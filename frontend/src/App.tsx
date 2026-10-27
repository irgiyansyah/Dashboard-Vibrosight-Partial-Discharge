import { useState } from 'react'
import { hydroUnits } from './data/units'
import type { HydroUnit, Plant } from './data/units'

import HistoricalData from './components/HistoricalData'
import type { MeasurementFile } from './components/HistoricalData'
import UnitTrend from './components/UnitTrend'
import HydroMonitoring from './components/HydroMonitoring.jsx'

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

const plants: Plant[] = ['Larona', 'Karebbe', 'Balambano']

const capacityReference: Record<Plant, string> = {
  Larona: '3 × 55 MW = 165 MW',
  Karebbe: '2 × 45 MW = 90 MW',
  Balambano: '2 × 55 MW = 110 MW',
}

function App() {
  const [page, setPage] = useState<Page>('Overview')
  const [plant, setPlant] = useState<PlantFilter>('all')
  const [unitId, setUnitId] = useState('all')
  const [datasets, setDatasets] = useState<MeasurementFile[]>([])

  const isHistoricalPage = page === 'Historical Data'
  const isMonitoringPage = page === 'Unit Monitoring'

  const availableUnits = hydroUnits.filter(
    (unit) => plant === 'all' || unit.plant === plant,
  )

  const visibleUnits = availableUnits.filter(
    (unit) => unitId === 'all' || unit.id === unitId,
  )

  const selectedUnit = hydroUnits.find((unit) => unit.id === unitId)

  const monitoringUnit =
    selectedUnit ?? availableUnits[0] ?? hydroUnits[0]

  const selectedUnitLabel = selectedUnit
    ? `${selectedUnit.plant} · ${selectedUnit.name}`
    : undefined

  const selectedDataset = datasets.find(
    (dataset) => dataset.unitId === unitId,
  )

  const visiblePlants = plants.filter((name) =>
    visibleUnits.some((unit) => unit.plant === name),
  )

  const loadedUnitIds = new Set(
    datasets
      .filter((dataset) => dataset.rows.length > 0)
      .map((dataset) => dataset.unitId),
  )

  const loadedVisibleUnits = visibleUnits.filter((unit) =>
    loadedUnitIds.has(unit.id),
  ).length

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

        <p className="brand-caption">Hydro Condition Monitoring</p>
        <p className="nav-caption">WORKSPACE</p>

        <nav aria-label="Navigasi dashboard">
          {menus.map((menu, index) => (
            <button
              key={menu}
              type="button"
              className={`nav-item ${page === menu ? 'active' : ''}`}
              aria-current={page === menu ? 'page' : undefined}
              onClick={() => setPage(menu)}
            >
              <span className="nav-index">
                {String(index + 1).padStart(2, '0')}
              </span>
              {menu}
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
              {isMonitoringPage
                ? 'Prototipe · bukan live'
                : loadedUnitIds.size > 0
                  ? 'Historical data'
                  : 'Belum terhubung'}
            </span>

            <div className="avatar">J</div>

            <div className="profile-text">
              <strong>Julio</strong>
              <small>Hydro assessment</small>
            </div>
          </div>
        </header>

        {!isHistoricalPage && !isMonitoringPage && (
          <section className="filterbar" aria-label="Filter monitoring">
            <label>
              <span>PLTA</span>

              <select
                value={plant}
                onChange={(event) =>
                  changePlant(event.target.value as PlantFilter)
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
                onChange={(event) => setUnitId(event.target.value)}
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

              {loadedVisibleUnits > 0
                ? `${loadedVisibleUnits} unit memiliki data historis`
                : 'Data pengukuran belum dimuat'}
            </div>
          </section>
        )}

        <main
          className={
            isMonitoringPage ? 'unit-monitoring-page' : undefined
          }
        >
          {!isMonitoringPage && (
            <div className="page-heading">
              <div>
                <h1>{page}</h1>

                <p>
                  {isHistoricalPage
                    ? 'Impor dan eksplorasi file pengukuran Hydro Operation.'
                    : selectedUnitLabel
                      ? selectedUnitLabel
                      : plant === 'all'
                        ? 'Armada hidro · Larona, Karebbe, dan Balambano'
                        : `Armada hidro · PLTA ${plant}`}
                </p>
              </div>

              <span className="badge neutral">
                {isHistoricalPage
                  ? `${loadedUnitIds.size} unit dengan data historis`
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
            <>
              <section
                className="kpi-grid"
                aria-label="Ringkasan monitoring"
              >
                <Kpi
                  title="Unit beroperasi"
                  value={`— / ${visibleUnits.length}`}
                  note="Status operasi belum tersedia"
                />

                <Kpi
                  title="Daya aktual"
                  value="— MW"
                  note="Menunggu data beban"
                />

                <Kpi
                  title="Perlu perhatian"
                  value="—"
                  note="Belum dapat dievaluasi"
                />

                <Kpi
                  title="Alarm aktif"
                  value="—"
                  note="Sumber alarm belum tersedia"
                />

                <Kpi
                  title="Data historis tersedia"
                  value={`${loadedVisibleUnits} / ${visibleUnits.length}`}
                  note="Unit dengan pengukuran dimuat"
                />
              </section>

              <section
                className="plant-grid"
                aria-label="Ringkasan PLTA"
              >
                {visiblePlants.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="plant-card"
                    onClick={() => changePlant(name)}
                  >
                    <div>
                      <strong>{name}</strong>
                      <small>
                        {capacityReference[name]} terpasang*
                      </small>
                    </div>

                    <div className="plant-value">
                      <strong>— MW</strong>
                      <small>Daya aktual belum tersedia</small>
                    </div>
                  </button>
                ))}
              </section>

              <div className="monitoring-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Matriks kondisi unit</h2>
                    <p>
                      Kondisi mesin dan ketersediaan data ditampilkan
                      terpisah.
                    </p>
                  </div>

                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>PLTA</th>
                          <th>Unit</th>
                          <th>Operasi</th>
                          <th>MW</th>
                          <th>Vibration</th>
                          <th>PD</th>
                          <th>Data</th>
                          <th>
                            <span className="sr-only">Detail</span>
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {visibleUnits.map((unit) => {
                          const dataset = datasets.find(
                            (item) => item.unitId === unit.id,
                          )

                          return (
                            <tr key={unit.id}>
                              <td>{unit.plant}</td>

                              <td>
                                <strong>{unit.name}</strong>
                              </td>

                              <td>Belum diketahui</td>
                              <td>—</td>

                              <td>
                                <span className="badge neutral">
                                  Belum dievaluasi
                                </span>
                              </td>

                              <td>
                                <span className="badge neutral">
                                  Belum dievaluasi
                                </span>
                              </td>

                              <td className="muted">
                                {dataset && dataset.rows.length > 0
                                  ? `Historis · ${dataset.tags.length} kanal`
                                  : 'Belum tersedia'}
                              </td>

                              <td>
                                <button
                                  type="button"
                                  className="row-action"
                                  aria-label={`Buka ${unit.plant} ${unit.name}`}
                                  onClick={() => openUnit(unit)}
                                >
                                  ↗
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="panel-footnote">
                    Data historis yang dimuat tidak menunjukkan koneksi
                    live. Status operasi dan kondisi mesin belum dapat
                    ditentukan.
                  </div>
                </section>

                <section className="panel review-panel">
                  <div className="panel-heading">
                    <h2>Perlu ditinjau</h2>
                  </div>

                  <div className="empty-content">
                    <span className="empty-icon">i</span>
                    <h3>Evaluasi belum tersedia</h3>

                    <p>
                      Metadata pengukuran dan batas alarm resmi
                      diperlukan untuk menentukan unit yang memerlukan
                      perhatian.
                    </p>

                    <button
                      type="button"
                      className="outline-button"
                      onClick={() => setPage('Data Sources')}
                    >
                      Lihat kebutuhan data
                    </button>
                  </div>
                </section>
              </div>

              <div className="bottom-grid">
                <UnitTrend
                  key={unitId}
                  dataset={selectedDataset}
                  unitLabel={selectedUnitLabel}
                  onOpenHistorical={openHistorical}
                />

                <section className="panel">
                  <div className="panel-heading">
                    <h2>Alarm terbaru</h2>
                    <p>Riwayat kejadian dari sistem sumber.</p>
                  </div>

                  <div className="alarm-placeholder">
                    Sumber alarm belum terhubung.

                    <small>
                      Data getaran yang telah dimuat belum memiliki
                      batas alarm resmi untuk menentukan status kondisi.
                    </small>
                  </div>
                </section>
              </div>

              <div className="information-bar">
                * Kapasitas terpasang merupakan referensi materi
                mentor, bukan daya aktual. Monitoring live belum
                terhubung.
              </div>
            </>
          ) : page === 'Historical Data' ? (
            <HistoricalData
              datasets={datasets}
              onChange={setDatasets}
            />
          ) : page === 'Vibration Analysis' ? (
            <UnitTrend
              key={unitId}
              dataset={selectedDataset}
              unitLabel={selectedUnitLabel}
              onOpenHistorical={openHistorical}
            />
          ) : page === 'Data Sources' ? (
            <section className="panel">
              <div className="panel-heading">
                <h2>Sumber data historis</h2>

                <p>
                  File yang dimuat tersedia selama sesi aplikasi.
                  Pemetaan unit mengikuti pilihan saat impor.
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
                          (item) => item.id === dataset.unitId,
                        )

                        return (
                          <tr key={dataset.unitId}>
                            <td>{unit?.plant ?? 'Belum dipetakan'}</td>
                            <td>{unit?.name ?? dataset.unitId}</td>
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
                  <p>Belum ada file pengukuran yang diimpor.</p>
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
                Metadata yang masih diperlukan: satuan per tag,
                definisi pengukuran, format tanggal, timezone,
                pemetaan sensor, dan batas alarm resmi. Data PD
                serta koneksi live belum tersedia.
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
              <span>PT Vale Indonesia · Hydro assessment dashboard</span>

              <span>
                {hydroUnits.length} unit terdaftar ·{' '}
                {loadedUnitIds.size} unit dengan data historis · Live
                belum terhubung
              </span>
            </footer>
          )}
        </main>
      </div>
    </div>
  )
}

function Kpi({
  title,
  value,
  note,
}: {
  title: string
  value: string
  note: string
}) {
  return (
    <article className="kpi-card">
      <p>{title}</p>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
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