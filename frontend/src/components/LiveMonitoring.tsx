import { useEffect, useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { HydroUnit } from '../data/units'
import './LiveMonitoring.css'

const apiBase = (
  import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000'
).replace(/\/+$/, '')
const liveRefreshMs = 2_000
const alertsUrl = `${apiBase}/api/live/alerts/demo`
const demoActiveRefreshMs = 1_000
const demoIdleRefreshMs = 5_000
const maxTrendPoints = 25

// Urutan sesuai aliran kaskade: Larona -> Balambano -> Karebbe
const plantOrder = ['Larona', 'Balambano', 'Karebbe'] as const

const statusText = {
  loading: 'Memeriksa sumber',
  not_configured: 'Sumber live belum dikonfigurasi',
  unavailable: 'Sumber live tidak dapat dibaca',
  api_error: 'Layanan live tidak dapat diakses',
  no_data: 'Belum ada pembacaan untuk unit ini',
  live: 'Data langsung aktif',
  stale: 'Data melewati batas kesegaran',
  quality_issue: 'Kualitas data perlu diperiksa',
} as const

const qualityText = {
  good: 'Baik',
  uncertain: 'Meragukan',
  bad: 'Buruk',
  unknown: 'Belum diketahui',
} as const

type Status = keyof typeof statusText
type Reading = {
  channel: string
  value: number | null
  unit: string
  measured_at: string
  quality: keyof typeof qualityText
  fresh: boolean
}

type Snapshot = {
  status: Status
  simulated?: boolean
  readings: Reading[]
}

type UnitOps = {
  pa_mw: number
  pa_setpoint_mw: number
  pr_mvar: number
  penstock_flow: number
  efficiency: number
}

type OverviewUnit = {
  unit_id: string
  plant: string
  name: string
  status: Status
  ops?: UnitOps
  readings: Reading[]
}

type HydrologyData = {
  matano_level: number
  mahalona_level: number
  towuti_level: number
  batubesi_dam_level: number
  upper_canal_level: number
  canal_flow_rate: number
  lower_canal_level: number
  larona_tailrace_level: number
  balambano_dam_level: number
  balambano_tailrace_level: number
  balambano_outflow: number
  karebbe_dam_level: number
  karebbe_tailrace_level: number
  karebbe_outflow: number
  petea_gates: { gate: number; open: boolean }[]
  spillway_gates: { name: string; open_pct: number; flow_cumecs: number }[]
}

type OverviewResponse = {
  status: Status
  simulated?: boolean
  units: OverviewUnit[]
  hydrology?: HydrologyData | null
}

type TrendPoint = Record<string, string | number | null>

type DemoOverride = {
  unitId: string
  value: number
} | null

type Props = {
  units: HydroUnit[]
  initialUnitId?: string
  activePage?: string
  onSelectPage?: (page: string) => void
}

const levelText = {
  alert: 'Alert / Awareness',
  trip: 'Melewati Ambang Trip',
} as const

type DemoEvent = {
  id: string
  level: keyof typeof levelText
  threshold: number
  first_value: number
  peak_value: number
  last_value: number
  measured_at: string
  last_measured_at: string
  acknowledged_at: string | null
}

type DemoState = {
  enabled: true
  instance_id: string
  revision: number
  running: boolean
  history_unavailable: boolean
  run_failed: boolean
  unit_id: string
  channel: string
  unit: string
  reading: { value: number; measured_at: string } | null
  events: DemoEvent[]
  next_before: string | null
} | { enabled: false }

type DemoView = {
  cursor: string | null
  state: DemoState
}

const timeFormat = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Makassar',
  dateStyle: 'medium',
  timeStyle: 'medium',
})
const shortTimeFormat = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Makassar',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})
const numberFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 })
const emptySnapshot: Snapshot = { status: 'loading', simulated: false, readings: [] }

function isVibrationReading(reading: Reading): boolean {
  const unit = reading.unit.toLowerCase()
  return unit.includes('µm') || unit.includes('um')
}

function lineStyleForChannel(channel: string): { color: string; dashed: boolean } {
  const upper = channel.toUpperCase()
  const dashed = upper.endsWith(' Y') || upper.includes(' Y ') || upper.endsWith('_Y')
  if (upper.startsWith('LGB')) return { color: '#8b5cf6', dashed }
  if (upper.startsWith('TGB') || upper.startsWith('T ')) return { color: '#10b981', dashed }
  if (upper.startsWith('UGB') || upper.startsWith('G ')) return { color: '#0ea5e9', dashed }
  return { color: dashed ? '#143653' : '#0ea5e9', dashed }
}

function classifyLiveVibration(value: number | null): { label: string; tone: string } {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return { label: 'Tidak tersedia', tone: 'neutral' }
  }
  if (value < 50) return { label: 'FAIL', tone: 'fail' }
  if (value < 250) return { label: 'Normal', tone: 'normal' }
  if (value < 350) return { label: 'Alert / Awareness', tone: 'alert' }
  return { label: 'Melewati Ambang Trip', tone: 'trip' }
}

function unitPeakVibration(unit: OverviewUnit, demoOverride: DemoOverride): number | null {
  if (demoOverride && demoOverride.unitId === unit.unit_id) {
    return demoOverride.value
  }
  const vibVals = unit.readings
    .filter(isVibrationReading)
    .map((r) => r.value)
    .filter((v): v is number => v !== null)
  return vibVals.length > 0 ? Math.max(...vibVals) : null
}

function toneColor(tone: string): string {
  switch (tone) {
    case 'normal':
      return '#16a34a'
    case 'alert':
      return '#f59e0b'
    case 'trip':
      return '#dc2626'
    case 'fail':
      return '#8b5cf6'
    default:
      return '#94a3b8'
  }
}

function newestDemoView(current: DemoView, next: DemoView): DemoView {
  if (
    current.cursor === next.cursor &&
    current.state.enabled &&
    next.state.enabled &&
    current.state.instance_id === next.state.instance_id &&
    current.state.revision > next.state.revision
  ) {
    return current
  }
  return next
}

function buildCursorQuery(cursor: string | null): string {
  return cursor ? `?before=${encodeURIComponent(cursor)}` : ''
}

function gaugeArcPath(startVal: number, endVal: number, cx = 110, cy = 104, r = 78): string {
  const startAngle = Math.PI * (1 - startVal / 400)
  const endAngle = Math.PI * (1 - endVal / 400)
  const x1 = cx + r * Math.cos(startAngle)
  const y1 = cy - r * Math.sin(startAngle)
  const x2 = cx + r * Math.cos(endAngle)
  const y2 = cy - r * Math.sin(endAngle)
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
}

function PlantOpsTable({
  plantName,
  plantUnits,
  outflow,
  demoOverride,
  onOpenUnit,
}: {
  plantName: string
  plantUnits: OverviewUnit[]
  outflow?: number
  demoOverride: DemoOverride
  onOpenUnit: (unitId: string) => void
}) {
  const totalMw = plantUnits.reduce((sum, u) => sum + (u.ops?.pa_mw ?? 0), 0)

  return (
    <div className="hydro-ops-table-card">
      <div className="hydro-ops-table-title">
        <strong>{plantName.toUpperCase()}</strong>
        <span>Total: <b>{numberFormat.format(totalMw)} MW</b></span>
      </div>
      <div className="hydro-ops-table-scroll">
        <table className="hydro-ops-table">
          <thead>
            <tr>
              <th>Parameter</th>
              {plantUnits.map((u, idx) => {
                const peak = unitPeakVibration(u, demoOverride)
                const tone = classifyLiveVibration(peak).tone
                return (
                  <th key={u.unit_id}>
                    <button
                      type="button"
                      className={`hydro-ops-unit-pill tone-${tone}`}
                      onClick={() => onOpenUnit(u.unit_id)}
                    >
                      UNIT #{idx + 1}
                    </button>
                  </th>
                )
              })}
              <th>Satuan</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Pa</td>
              {plantUnits.map((u) => <td key={u.unit_id}>{u.ops ? numberFormat.format(u.ops.pa_mw) : '—'}</td>)}
              <td className="unit-col">MW</td>
            </tr>
            <tr>
              <td>Pa Setpoint</td>
              {plantUnits.map((u) => <td key={u.unit_id}>{u.ops ? numberFormat.format(u.ops.pa_setpoint_mw) : '—'}</td>)}
              <td className="unit-col">MW</td>
            </tr>
            <tr>
              <td>Pr</td>
              {plantUnits.map((u) => <td key={u.unit_id}>{u.ops ? numberFormat.format(u.ops.pr_mvar) : '—'}</td>)}
              <td className="unit-col">MVAr</td>
            </tr>
            <tr>
              <td>Penst Flow</td>
              {plantUnits.map((u) => <td key={u.unit_id}>{u.ops ? numberFormat.format(u.ops.penstock_flow) : '—'}</td>)}
              <td className="unit-col">m³/s</td>
            </tr>
            <tr>
              <td>Efficiency</td>
              {plantUnits.map((u) => <td key={u.unit_id}>{u.ops ? numberFormat.format(u.ops.efficiency) : '—'}</td>)}
              <td className="unit-col">MW/m³/s</td>
            </tr>
          </tbody>
        </table>
      </div>
      {outflow !== undefined && (
        <div className="hydro-ops-outflow">
          <span>Outflow {plantName}</span>
          <strong>{numberFormat.format(outflow)} Cumecs</strong>
        </div>
      )}
    </div>
  )
}

function HydroCascadeMap({
  units,
  hydrology,
  demoOverride,
  simulated,
  onOpenUnit,
}: {
  units: OverviewUnit[]
  hydrology?: HydrologyData | null
  demoOverride: DemoOverride
  simulated?: boolean
  onOpenUnit: (unitId: string) => void
}) {
  const unitMap = new Map(units.map((u) => [u.unit_id, u]))

  function renderUnitNode(unitId: string, shortLabel: string, cx: number, cy: number) {
    const unit = unitMap.get(unitId)
    const peak = unit ? unitPeakVibration(unit, demoOverride) : null
    const status = classifyLiveVibration(peak)
    const fill = toneColor(status.tone)
    const blinking = status.tone === 'trip' || status.tone === 'alert'

    return (
      <g
        key={unitId}
        className={`hydro-cascade-unit ${blinking ? `is-${status.tone}` : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`${unitId} status ${status.label}`}
        onClick={() => onOpenUnit(unitId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpenUnit(unitId)
          }
        }}
      >
        <title>
          {unitId} · {status.label}
          {peak !== null ? ` (${numberFormat.format(peak)} µm p-p)` : ''} — klik untuk buka detail
        </title>
        {blinking && (
          <circle
            cx={cx}
            cy={cy}
            r="22"
            fill={fill}
            opacity="0.28"
            className="hydro-cascade-halo"
          />
        )}
        <circle cx={cx} cy={cy} r="15" fill={fill} stroke="#ffffff" strokeWidth="2.5" />
        <text x={cx} y={cy + 4} textAnchor="middle" fill="#ffffff" fontSize="10" fontWeight="700">
          {shortLabel}
        </text>
      </g>
    )
  }

  const laronaUnits = units.filter((u) => u.plant === 'Larona')
  const balambanoUnits = units.filter((u) => u.plant === 'Balambano')
  const karebbeUnits = units.filter((u) => u.plant === 'Karebbe')

  return (
    <section className="hydro-cascade-card" aria-label="Skema aliran kaskade PLTA PT Vale">
      <div className="hydro-cascade-header">
        <div>
          <h2>Utilities Power Overview · Kaskade Matano hingga Karebbe</h2>
          <p>
            {simulated && <span className="hydro-live-demo-label">Data simulasi</span>}
            Aliran air, elevasi m(ASL), tabel operasi Pa/Pr/Penstock Flow/Efficiency, dan status 7 unit. Klik unit untuk buka detail.
          </p>
        </div>
        <div className="hydro-cascade-legend">
          <span><i style={{ background: '#16a34a' }} />Normal</span>
          <span><i style={{ background: '#f59e0b' }} />Alert</span>
          <span><i style={{ background: '#dc2626' }} />Trip</span>
          <span><i style={{ background: '#8b5cf6' }} />FAIL</span>
        </div>
      </div>

      {/* Baris atas: Hidrologi Hulu + 3 Tabel Operasi PLTA */}
      <div className="hydro-scada-top-grid">
        {hydrology && (
          <div className="hydro-hydrology-box">
            <div className="hydro-ops-table-title">
              <strong>HIDROLOGI &amp; KANAL</strong>
              <span>Hulu Larona</span>
            </div>
            <dl className="hydro-hydrology-list">
              <div>
                <dt>Batubesi Dam Level</dt>
                <dd>{numberFormat.format(hydrology.batubesi_dam_level)} m(ASL)</dd>
              </div>
              <div>
                <dt>Upper Canal Level</dt>
                <dd>{numberFormat.format(hydrology.upper_canal_level)} m(ASL)</dd>
              </div>
              <div>
                <dt>Canal Flow Rate</dt>
                <dd>{numberFormat.format(hydrology.canal_flow_rate)} Cumecs</dd>
              </div>
              <div>
                <dt>Lower Canal Level</dt>
                <dd>{numberFormat.format(hydrology.lower_canal_level)} m(ASL)</dd>
              </div>
              <div>
                <dt>Larona Tailrace</dt>
                <dd>{numberFormat.format(hydrology.larona_tailrace_level)} m(ASL)</dd>
              </div>
            </dl>

            <div className="hydro-petea-row">
              <span>Petea Gate Open</span>
              <div className="hydro-petea-gates">
                {hydrology.petea_gates.map((g) => (
                  <span
                    key={g.gate}
                    className={`hydro-gate-box ${g.open ? 'is-open' : 'is-closed'}`}
                    title={`Petea Gate ${g.gate}: ${g.open ? 'Terbuka' : 'Tertutup'}`}
                  >
                    {g.gate}
                  </span>
                ))}
              </div>
            </div>

            <div className="hydro-spg-grid">
              {hydrology.spillway_gates.map((spg) => (
                <div key={spg.name} className="hydro-spg-item">
                  <span>{spg.name}</span>
                  <strong>{numberFormat.format(spg.open_pct)}%</strong>
                  <small>{numberFormat.format(spg.flow_cumecs)} Cumecs</small>
                </div>
              ))}
            </div>
          </div>
        )}

        <PlantOpsTable
          plantName="Larona"
          plantUnits={laronaUnits}
          demoOverride={demoOverride}
          onOpenUnit={onOpenUnit}
        />
        <PlantOpsTable
          plantName="Balambano"
          plantUnits={balambanoUnits}
          outflow={hydrology?.balambano_outflow}
          demoOverride={demoOverride}
          onOpenUnit={onOpenUnit}
        />
        <PlantOpsTable
          plantName="Karebbe"
          plantUnits={karebbeUnits}
          outflow={hydrology?.karebbe_outflow}
          demoOverride={demoOverride}
          onOpenUnit={onOpenUnit}
        />
      </div>

      {/* Diagram kaskade SVG dengan elevasi m(ASL) & indikator G1-G3 */}
      <div className="hydro-cascade-svg-wrap">
        <svg viewBox="0 0 1120 330" role="img" aria-label="Diagram aliran air dan status 7 unit PLTA">
          <defs>
            <linearGradient id="hydroSky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f8fcff" />
              <stop offset="100%" stopColor="#edf5fa" />
            </linearGradient>
            <linearGradient id="hydroWater" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#0284c7" />
              <stop offset="50%" stopColor="#0ea5e9" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
          </defs>

          <rect x="0" y="0" width="1120" height="330" rx="10" fill="url(#hydroSky)" />

          {/* Badan air bertingkat: Matano -> Mahalona -> Towuti -> Larona -> Balambano -> Karebbe */}
          <path
            d="
              M 18 128 L 145 128 L 165 144 L 275 144 L 295 160 L 455 160
              L 470 218 L 690 218 L 710 246 L 895 246 L 915 274 L 1105 274
              L 1105 316 L 18 316 Z
            "
            fill="url(#hydroWater)"
            opacity="0.88"
          />

          {/* Garis animasi arus air mengalir */}
          <path
            d="
              M 28 142 L 140 142 L 168 158 L 272 158 L 298 174 L 448 174
              L 476 232 L 685 232 L 714 260 L 890 260 L 918 288 L 1098 288
            "
            fill="none"
            stroke="#e0f2fe"
            strokeWidth="3.5"
            strokeDasharray="12 10"
            className="hydro-cascade-flow"
          />

          {/* Kontur pemisah danau */}
          <polygon points="135,195 152,140 172,195" fill="#94a3b8" />
          <polygon points="268,210 284,156 304,210" fill="#94a3b8" />

          {/* Elevasi 3 Danau Hulu */}
          <g>
            <rect x="20" y="56" width="118" height="46" rx="6" fill="#ffffff" stroke="#cbd5e1" />
            <text x="79" y="74" textAnchor="middle" fill="#143653" fontSize="11" fontWeight="700">Matano Lake</text>
            <text x="79" y="92" textAnchor="middle" fill="#0369a1" fontSize="11" fontWeight="700">
              {hydrology ? `${numberFormat.format(hydrology.matano_level)} m(ASL)` : '—'}
            </text>
            <line x1="79" y1="102" x2="79" y2="128" stroke="#94a3b8" strokeDasharray="3 2" />

            <rect x="158" y="72" width="122" height="46" rx="6" fill="#ffffff" stroke="#cbd5e1" />
            <text x="219" y="90" textAnchor="middle" fill="#143653" fontSize="11" fontWeight="700">Mahalona Lake</text>
            <text x="219" y="108" textAnchor="middle" fill="#0369a1" fontSize="11" fontWeight="700">
              {hydrology ? `${numberFormat.format(hydrology.mahalona_level)} m(ASL)` : '—'}
            </text>
            <line x1="219" y1="118" x2="219" y2="144" stroke="#94a3b8" strokeDasharray="3 2" />

            <rect x="302" y="88" width="118" height="46" rx="6" fill="#ffffff" stroke="#cbd5e1" />
            <text x="361" y="106" textAnchor="middle" fill="#143653" fontSize="11" fontWeight="700">Towuti Lake</text>
            <text x="361" y="124" textAnchor="middle" fill="#0369a1" fontSize="11" fontWeight="700">
              {hydrology ? `${numberFormat.format(hydrology.towuti_level)} m(ASL)` : '—'}
            </text>
            <line x1="361" y1="134" x2="361" y2="160" stroke="#94a3b8" strokeDasharray="3 2" />
          </g>

          {/* ===== PLTA LARONA (G1, G2, G3) ===== */}
          <polygon points="442,146 472,146 485,228 434,228" fill="#475569" />
          <rect x="476" y="156" width="166" height="66" rx="8" fill="#1e3a5f" stroke="#0f172a" strokeWidth="1.5" />
          <text x="559" y="174" textAnchor="middle" fill="#e2e8f0" fontSize="10.5" fontWeight="700">
            PLTA LARONA
          </text>
          {renderUnitNode('LRN-01', 'G1', 511, 198)}
          {renderUnitNode('LRN-02', 'G2', 559, 198)}
          {renderUnitNode('LRN-03', 'G3', 607, 198)}

          {/* Elevasi Larona Tailrace & Balambano Dam */}
          {hydrology && (
            <g>
              <rect x="572" y="100" width="128" height="42" rx="6" fill="#ffffff" stroke="#cbd5e1" />
              <text x="636" y="116" textAnchor="middle" fill="#475569" fontSize="9.5" fontWeight="700">Larona Tailrace / BLB Dam</text>
              <text x="636" y="133" textAnchor="middle" fill="#0369a1" fontSize="10.5" fontWeight="700">
                {numberFormat.format(hydrology.larona_tailrace_level)} / {numberFormat.format(hydrology.balambano_dam_level)} m
              </text>
            </g>
          )}

          {/* ===== PLTA BALAMBANO (G1, G2) ===== */}
          <polygon points="684,202 714,202 726,256 676,256" fill="#475569" />
          <rect x="718" y="188" width="134" height="66" rx="8" fill="#1e3a5f" stroke="#0f172a" strokeWidth="1.5" />
          <text x="785" y="206" textAnchor="middle" fill="#e2e8f0" fontSize="10.5" fontWeight="700">
            PLTA BALAMBANO
          </text>
          {renderUnitNode('BLB-01', 'G1', 758, 230)}
          {renderUnitNode('BLB-02', 'G2', 812, 230)}

          {/* Elevasi Balambano Tailrace & Karebbe Dam */}
          {hydrology && (
            <g>
              <rect x="782" y="128" width="132" height="42" rx="6" fill="#ffffff" stroke="#cbd5e1" />
              <text x="848" y="144" textAnchor="middle" fill="#475569" fontSize="9.5" fontWeight="700">BLB Tailrace / KRB Dam</text>
              <text x="848" y="161" textAnchor="middle" fill="#0369a1" fontSize="10.5" fontWeight="700">
                {numberFormat.format(hydrology.balambano_tailrace_level)} / {numberFormat.format(hydrology.karebbe_dam_level)} m
              </text>
            </g>
          )}

          {/* ===== PLTA KAREBBE (G1, G2) ===== */}
          <polygon points="894,230 924,230 936,284 886,284" fill="#475569" />
          <rect x="928" y="216" width="134" height="66" rx="8" fill="#1e3a5f" stroke="#0f172a" strokeWidth="1.5" />
          <text x="995" y="234" textAnchor="middle" fill="#e2e8f0" fontSize="10.5" fontWeight="700">
            PLTA KAREBBE
          </text>
          {renderUnitNode('KRB-01', 'G1', 968, 258)}
          {renderUnitNode('KRB-02', 'G2', 1022, 258)}

          {/* Elevasi Karebbe Tailrace */}
          {hydrology && (
            <g>
              <rect x="962" y="156" width="134" height="42" rx="6" fill="#ffffff" stroke="#cbd5e1" />
              <text x="1029" y="172" textAnchor="middle" fill="#475569" fontSize="9.5" fontWeight="700">Karebbe Tailrace Wtr</text>
              <text x="1029" y="189" textAnchor="middle" fill="#0369a1" fontSize="10.5" fontWeight="700">
                {numberFormat.format(hydrology.karebbe_tailrace_level)} m(ASL)
              </text>
            </g>
          )}

          <text x="1096" y="308" textAnchor="end" fill="#0c4a6e" fontSize="10.5" fontWeight="700">
            Outflow Karebbe {hydrology ? `${numberFormat.format(hydrology.karebbe_outflow)} Cumecs` : ''} →
          </text>
        </svg>
      </div>
    </section>
  )
}

function LiveVibrationGauge({
  value,
  channelCount,
}: {
  value: number | null
  channelCount: number
}) {
  const clamped = value !== null && Number.isFinite(value) ? Math.max(0, Math.min(400, value)) : 0
  const needleDeg = -90 + (clamped / 400) * 180

  return (
    <div className="hydro-live-gauge" aria-label="Gauge getaran unit">
      <svg viewBox="0 0 220 128" role="img" aria-hidden="true">
        <path d={gaugeArcPath(0, 50)} fill="none" stroke="#8b5cf6" strokeWidth="14" strokeLinecap="butt" />
        <path d={gaugeArcPath(50, 250)} fill="none" stroke="#16a34a" strokeWidth="14" strokeLinecap="butt" />
        <path d={gaugeArcPath(250, 350)} fill="none" stroke="#f59e0b" strokeWidth="14" strokeLinecap="butt" />
        <path d={gaugeArcPath(350, 400)} fill="none" stroke="#dc2626" strokeWidth="14" strokeLinecap="butt" />

        <text x="20" y="114" fontSize="9.5" fill="#526980" textAnchor="middle">0</text>
        <text x="36" y="65" fontSize="9.5" fill="#6b21a8" textAnchor="middle">50</text>
        <text x="148" y="25" fontSize="9.5" fill="#b45309" textAnchor="middle">250</text>
        <text x="190" y="65" fontSize="9.5" fill="#b91c1c" textAnchor="middle">350</text>
        <text x="200" y="114" fontSize="9.5" fill="#526980" textAnchor="middle">400</text>

        <g
          className="hydro-live-gauge-needle"
          style={{
            transform: `rotate(${needleDeg}deg)`,
            transformOrigin: '110px 104px',
          }}
        >
          <polygon points="107,104 113,104 110,34" fill="#143653" />
        </g>
        <circle cx="110" cy="104" r="7" fill="#143653" />
        <circle cx="110" cy="104" r="3" fill="#fff" />
      </svg>

      <div className="hydro-live-gauge-readout">
        <strong>{value !== null ? numberFormat.format(value) : '—'}</strong>
        <span>µm p-p · puncak {channelCount} kanal</span>
      </div>
    </div>
  )
}

function LiveAlertDemo({
  onDemoReadingChange,
}: {
  onDemoReadingChange?: (override: DemoOverride) => void
}) {
  const [pageCursors, setPageCursors] = useState<(string | null)[]>([null])
  const [view, setView] = useState<DemoView>({ cursor: null, state: { enabled: false } })
  const [connectionError, setConnectionError] = useState(false)
  const [actionError, setActionError] = useState('')
  const [saving, setSaving] = useState(false)

  const currentCursor = pageCursors[pageCursors.length - 1] ?? null
  const demo = view.state

  useEffect(() => {
    if (!onDemoReadingChange) return
    if (demo.enabled && demo.reading) {
      onDemoReadingChange({ unitId: demo.unit_id, value: demo.reading.value })
    } else {
      onDemoReadingChange(null)
    }
  }, [demo, onDemoReadingChange])

  useEffect(() => {
    const session = new AbortController()
    let next: number | undefined

    async function refresh() {
      let refreshDelay: number | undefined = demoIdleRefreshMs
      try {
        const response = await fetch(`${alertsUrl}${buildCursorQuery(currentCursor)}`, {
          cache: 'no-store',
          signal: AbortSignal.any([session.signal, AbortSignal.timeout(5_000)]),
        })
        if (response.status === 404) {
          refreshDelay = undefined
          setView({ cursor: currentCursor, state: { enabled: false } })
          return
        }
        if (!response.ok) throw new Error('Live notification service unavailable')
        const data: DemoState = await response.json()
        if (session.signal.aborted) return
        setView((current) => newestDemoView(current, { cursor: currentCursor, state: data }))
        setConnectionError(false)
        if (data.enabled !== true) {
          refreshDelay = undefined
        } else {
          refreshDelay = data.running ? demoActiveRefreshMs : demoIdleRefreshMs
        }
      } catch {
        if (!session.signal.aborted) setConnectionError(true)
      } finally {
        if (!session.signal.aborted && refreshDelay !== undefined) {
          next = window.setTimeout(refresh, refreshDelay)
        }
      }
    }

    void refresh()
    return () => {
      session.abort()
      window.clearTimeout(next)
    }
  }, [currentCursor])

  async function runAction(suffix: string, targetCursor: string | null) {
    setSaving(true)
    setActionError('')
    try {
      const response = await fetch(`${alertsUrl}${suffix}${buildCursorQuery(targetCursor)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) {
        let message = 'Tindakan belum tersimpan. Coba lagi.'
        try {
          const body = await response.json()
          if (typeof body?.detail === 'string' && body.detail.trim()) {
            message = body.detail
          }
        } catch {
          // Gunakan pesan bawaan jika respons bukan JSON.
        }
        setActionError(message)
        return
      }
      const data: DemoState = await response.json()
      setView((current) => newestDemoView(current, { cursor: targetCursor, state: data }))
    } catch {
      setActionError('Tindakan belum tersimpan. Coba lagi.')
    } finally {
      setSaving(false)
    }
  }

  function handleStart() {
    setPageCursors([null])
    void runAction('/start', null)
  }

  function handleOlderPage() {
    if (!demo.enabled || !demo.next_before) return
    setActionError('')
    setPageCursors((prev) => [...prev, demo.next_before])
  }

  function handleNewerPage() {
    if (pageCursors.length <= 1) return
    setActionError('')
    setPageCursors((prev) => prev.slice(0, -1))
  }

  if (!demo.enabled) return null

  const unread = demo.events.filter((event) => !event.acknowledged_at).length
  const latestEvent = demo.events[0]
  const hasNewer = pageCursors.length > 1
  const hasOlder = demo.next_before !== null

  return (
    <section className="hydro-live-notifications" aria-labelledby="live-alerts-title">
      <div className="hydro-live-notifications-header">
        <div>
          <h2 id="live-alerts-title">Notifikasi getaran</h2>
          <p><span className="hydro-live-demo-label">Data simulasi</span> Larona Unit 2 ({demo.unit_id}) · {demo.channel}</p>
        </div>
        <button
          type="button"
          onClick={handleStart}
          disabled={saving || demo.running || demo.history_unavailable}
        >
          {demo.running ? 'Simulasi berjalan' : demo.reading ? 'Ulangi simulasi' : 'Jalankan simulasi'}
        </button>
      </div>

      <div className="hydro-live-notifications-summary">
        <span>Pembacaan simulasi <strong>{demo.reading ? `${numberFormat.format(demo.reading.value)} ${demo.unit}` : '—'}</strong></span>
        <span role="status">
          {unread} belum dilihat{latestEvent ? ` · Terakhir ${levelText[latestEvent.level]}` : ''}
        </span>
      </div>

      {demo.history_unavailable && (
        <p className="hydro-live-notifications-error" role="alert">
          Riwayat notifikasi tidak tersedia. Periksa koneksi MariaDB dan tabel live_alert_notifications.
        </p>
      )}
      {demo.run_failed && (
        <p className="hydro-live-notifications-error" role="alert">
          Simulasi berhenti karena penulisan riwayat ke database gagal.
        </p>
      )}
      {(connectionError || actionError) && (
        <p className="hydro-live-notifications-error" role="alert">
          {actionError || 'Layanan notifikasi tidak terhubung. Mencoba lagi…'}
        </p>
      )}

      {demo.events.length > 0 && (
        <ul className="hydro-live-events">
          {demo.events.map((event) => (
            <li key={event.id} data-level={event.level}>
              <div className="hydro-live-event-body">
                <h3>{levelText[event.level]}</h3>
                <p>
                  Puncak <strong>{numberFormat.format(event.peak_value)} {demo.unit}</strong> · Ambang {event.threshold} {demo.unit}
                </p>
                <p>
                  <time dateTime={event.measured_at}>{timeFormat.format(new Date(event.measured_at))} WITA</time>
                </p>
                <details className="hydro-live-event-details">
                  <summary>Detail pembacaan</summary>
                  <dl>
                    <div>
                      <dt>Pemicu awal</dt>
                      <dd>{numberFormat.format(event.first_value)} {demo.unit}</dd>
                    </div>
                    <div>
                      <dt>Nilai terakhir</dt>
                      <dd>
                        {numberFormat.format(event.last_value)} {demo.unit} ({timeFormat.format(new Date(event.last_measured_at))} WITA)
                      </dd>
                    </div>
                    <div>
                      <dt>Waktu dilihat</dt>
                      <dd>
                        {event.acknowledged_at
                          ? `${timeFormat.format(new Date(event.acknowledged_at))} WITA`
                          : 'Belum dilihat'}
                      </dd>
                    </div>
                    <div>
                      <dt>ID notifikasi</dt>
                      <dd><code>{event.id}</code></dd>
                    </div>
                  </dl>
                </details>
              </div>
              {event.acknowledged_at ? (
                <span className="hydro-live-alert-viewed">Sudah dilihat</span>
              ) : (
                <button
                  type="button"
                  disabled={saving || demo.history_unavailable}
                  onClick={() => void runAction(`/${event.id}/ack`, currentCursor)}
                >
                  Tandai sudah dilihat
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {(hasNewer || hasOlder) && (
        <div className="hydro-live-pagination">
          <button type="button" disabled={!hasNewer || saving} onClick={handleNewerPage}>
            Lebih baru
          </button>
          <button type="button" disabled={!hasOlder || saving} onClick={handleOlderPage}>
            Lebih lama
          </button>
        </div>
      )}
    </section>
  )
}

function LiveVibrationChart({
  unitLabel,
  channels,
  points,
  simulated,
}: {
  unitLabel: string
  channels: string[]
  points: TrendPoint[]
  simulated?: boolean
}) {
  const latest = points[points.length - 1]
  const latestValues = channels
    .map((ch) => (latest && typeof latest[ch] === 'number' ? (latest[ch] as number) : null))
    .filter((v): v is number => v !== null)
  const latestPeak = latestValues.length > 0 ? Math.max(...latestValues) : null
  const vibStatus = classifyLiveVibration(latestPeak)

  return (
    <section className="hydro-live-chart-panel" aria-label="Grafik getaran real-time">
      <div className="hydro-live-chart-header">
        <div>
          <h2>Tren getaran real-time · {unitLabel} ({channels.length} kanal)</h2>
          <p>
            {simulated && <span className="hydro-live-demo-label">Data simulasi</span>}
            Pembaruan otomatis tiap 2 detik · X garis utuh, Y garis putus-putus · Batas 50 / 250 / 350 µm p-p
          </p>
        </div>
        <div className="hydro-live-chart-badges">
          <span className="hydro-live-pulse-badge">
            <span className="hydro-live-pulse-dot" />
            Bergerak langsung
          </span>
          <span className="hydro-live-vib-badge" data-tone={vibStatus.tone}>
            {vibStatus.label}
            {latestPeak !== null ? ` · Puncak ${numberFormat.format(latestPeak)} µm p-p` : ''}
          </span>
        </div>
      </div>

      <div className="hydro-live-chart-wrap">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={points} margin={{ top: 14, right: 24, left: 4, bottom: 6 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#d8e3eb" />
            <XAxis dataKey="timeLabel" tick={{ fontSize: 11, fill: '#526980' }} minTickGap={20} />
            <YAxis
              domain={[0, 400]}
              tick={{ fontSize: 11, fill: '#526980' }}
              unit=" µm"
            />
            <Tooltip
              formatter={(value) => [`${numberFormat.format(Number(value ?? 0))} µm p-p`]}
            />
            <Legend />
            <ReferenceLine
              y={50}
              stroke="#7c3aed"
              strokeDasharray="5 5"
              label={{ value: 'FAIL 50', position: 'insideTopRight', fill: '#7c3aed', fontSize: 11 }}
            />
            <ReferenceLine
              y={250}
              stroke="#d97706"
              strokeDasharray="5 5"
              label={{ value: 'Alert 250', position: 'insideTopRight', fill: '#b45309', fontSize: 11 }}
            />
            <ReferenceLine
              y={350}
              stroke="#dc2626"
              strokeDasharray="5 5"
              label={{ value: 'Trip 350', position: 'insideTopRight', fill: '#b91c1c', fontSize: 11 }}
            />
            {channels.map((channel) => {
              const style = lineStyleForChannel(channel)
              return (
                <Line
                  key={channel}
                  type="monotone"
                  dataKey={channel}
                  name={channel}
                  stroke={style.color}
                  strokeWidth={style.dashed ? 2 : 2.4}
                  strokeDasharray={style.dashed ? '5 4' : undefined}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4.5 }}
                  isAnimationActive={true}
                  animationDuration={450}
                />
              )
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}

export default function LiveMonitoring({
  units,
  initialUnitId,
  activePage = 'Overview',
  onSelectPage,
}: Props) {
  const initialUnit = units.find((unit) => unit.id === initialUnitId) ?? units[0]
  const [plant, setPlant] = useState(initialUnit.plant)
  const [unitId, setUnitId] = useState(initialUnit.id)
  const [result, setResult] = useState<(Snapshot & { unitId: string }) | null>(null)
  const [trendMap, setTrendMap] = useState<Record<string, TrendPoint[]>>({})
  const [channelMap, setChannelMap] = useState<Record<string, string[]>>({})
  const [demoOverride, setDemoOverride] = useState<DemoOverride>(null)
  const [overview, setOverview] = useState<OverviewResponse>({
    status: 'loading',
    simulated: false,
    units: [],
    hydrology: null,
  })

  const snapshot = result?.unitId === unitId ? result : emptySnapshot
  const currentTrend = trendMap[unitId] ?? []
  const currentVibChannels = channelMap[unitId] ?? []
  const plants = [...new Set(units.map((unit) => unit.plant))]
  const plantUnits = units.filter((unit) => unit.plant === plant)
  const currentUnitObj = units.find((u) => u.id === unitId) ?? initialUnit

  const isPartialDischarge = activePage === 'Partial Discharge'
  const isOverview = activePage === 'Overview'
  const isVibrationAnalysis = activePage === 'Vibration Analysis'
  const isAlarms = activePage === 'Alarms & Events'

  // Polling seluruh 7 unit + hidrologi saat halaman Overview Live terbuka
  useEffect(() => {
    if (!isOverview) return
    const session = new AbortController()
    let next: number | undefined

    async function refreshOverview() {
      try {
        const response = await fetch(`${apiBase}/api/live/overview`, {
          signal: AbortSignal.any([session.signal, AbortSignal.timeout(8_000)]),
          cache: 'no-store',
        })
        if (!response.ok) throw new Error('Live overview unavailable')
        const data: OverviewResponse = await response.json()
        if (!session.signal.aborted) setOverview(data)
      } catch {
        if (!session.signal.aborted) {
          setOverview({ status: 'api_error', simulated: false, units: [], hydrology: null })
        }
      } finally {
        if (!session.signal.aborted) {
          next = window.setTimeout(refreshOverview, liveRefreshMs)
        }
      }
    }

    void refreshOverview()
    return () => {
      session.abort()
      window.clearTimeout(next)
    }
  }, [isOverview])

  // Polling per unit + menyusun titik grafik animasi getaran sesuai kanal unit
  useEffect(() => {
    if (isPartialDischarge || isOverview) return
    const session = new AbortController()
    let next: number | undefined

    async function refreshUnit() {
      try {
        const response = await fetch(
          `${apiBase}/api/live/units/${encodeURIComponent(unitId)}`,
          {
            signal: AbortSignal.any([session.signal, AbortSignal.timeout(8_000)]),
            cache: 'no-store',
          },
        )
        if (!response.ok) throw new Error('Live service unavailable')
        const data: Snapshot = await response.json()
        if (session.signal.aborted) return
        setResult({ ...data, unitId })

        const vibReadings = data.readings.filter(isVibrationReading)
        const sampleTime = vibReadings[0]?.measured_at ?? data.readings[0]?.measured_at
        if (sampleTime && vibReadings.length > 0) {
          const names = vibReadings.map((r) => r.channel)
          setChannelMap((prev) => ({ ...prev, [unitId]: names }))

          const point: TrendPoint = {
            timeLabel: shortTimeFormat.format(new Date(sampleTime)),
          }
          for (const reading of vibReadings) {
            point[reading.channel] = reading.quality !== 'bad' ? reading.value : null
          }
          setTrendMap((prev) => {
            const existing = prev[unitId] ?? []
            const updated = [...existing, point].slice(-maxTrendPoints)
            return { ...prev, [unitId]: updated }
          })
        }
      } catch {
        if (!session.signal.aborted) {
          setResult({ status: 'api_error', simulated: false, readings: [], unitId })
        }
      } finally {
        if (!session.signal.aborted) {
          next = window.setTimeout(refreshUnit, liveRefreshMs)
        }
      }
    }

    void refreshUnit()
    return () => {
      session.abort()
      window.clearTimeout(next)
    }
  }, [unitId, isPartialDischarge, isOverview])

  function selectPlant(nextPlant: HydroUnit['plant']) {
    const firstUnit = units.find((unit) => unit.plant === nextPlant)
    if (!firstUnit) return
    setPlant(nextPlant)
    setUnitId(firstUnit.id)
    setResult(null)
  }

  function openLiveUnit(targetUnitId: string, targetPage: string) {
    const found = units.find((u) => u.id === targetUnitId)
    if (found) {
      setPlant(found.plant)
      setUnitId(found.id)
    }
    onSelectPage?.(targetPage)
  }

  if (isPartialDischarge) {
    return (
      <main className="hydro-live">
        <div className="hydro-live-header">
          <div>
            <h1>Partial Discharge · Real-time</h1>
            <p>Pemantauan langsung Partial Discharge belum tersedia.</p>
          </div>
          <span className="hydro-live-status" data-status="not_configured">
            Menunggu arahan mentor
          </span>
        </div>
        <section className="hydro-live-pd-empty">
          <h2>Belum diaktifkan pada mode Real-time</h2>
          <p>
            Data instrumen, definisi kanal, dan skenario analisis Partial Discharge masih menunggu arahan mentor serta ketersediaan sumber data resmi PT Vale Indonesia Tbk.
          </p>
        </section>
      </main>
    )
  }

  const pageTitle = isOverview
    ? 'Overview Armada · Real-time (Live)'
    : isVibrationAnalysis
      ? 'Vibration Analysis · Real-time (Live)'
      : isAlarms
        ? 'Alarms & Events · Real-time (Live)'
        : 'Unit Monitoring · Real-time (Live)'

  const pageSubtitle = isOverview
    ? 'Pemantauan menyeluruh 3 PLTA (Larona, Balambano, Karebbe) · 7 unit dengan skema kaskade, hidrologi, & gauge jarum langsung.'
    : isVibrationAnalysis
      ? 'Animasi grafik tren getaran bergerak otomatis mengikuti jumlah kanal tiap PLTA.'
      : isAlarms
        ? 'Notifikasi pelampauan ambang Alert dan Trip yang tersimpan di database lokal.'
        : 'Pembacaan langsung seluruh parameter operasi pada unit yang dipilih.'

  const headerStatus = isOverview ? overview.status : snapshot.status
  const isSimulated = isOverview ? overview.simulated : snapshot.simulated

  const totalFleetMw = overview.units.reduce((sum, u) => {
    const mw = u.readings.find((r) => r.channel === 'Daya Aktif')?.value ?? 0
    return sum + (mw ?? 0)
  }, 0)

  const fleetCounts = overview.units.reduce(
    (acc, u) => {
      const peak = unitPeakVibration(u, demoOverride)
      const tone = classifyLiveVibration(peak).tone
      if (tone === 'normal') acc.normal += 1
      else if (tone === 'alert') acc.alert += 1
      else if (tone === 'trip' || tone === 'fail') acc.critical += 1
      return acc
    },
    { normal: 0, alert: 0, critical: 0 },
  )

  return (
    <main className="hydro-live">
      <div className="hydro-live-header">
        <div>
          <h1>{pageTitle}</h1>
          <p>{pageSubtitle}</p>
        </div>
        <span className="hydro-live-status" data-status={headerStatus} role="status">
          {isSimulated && headerStatus === 'live' ? 'Live · Data simulasi' : statusText[headerStatus]}
        </span>
      </div>

      {isOverview ? (
        <>
          {overview.units.length > 0 && (
            <>
              <section className="hydro-live-fleet-bar" aria-label="Ringkasan armada PLTA">
                <div className="hydro-live-fleet-kpi">
                  <span>Total Unit Aktif</span>
                  <strong>{overview.units.length} / 7 Unit</strong>
                </div>
                <div className="hydro-live-fleet-kpi">
                  <span>Total Daya Aktif (3 PLTA)</span>
                  <strong>{numberFormat.format(totalFleetMw)} MW</strong>
                </div>
                <div className="hydro-live-fleet-kpi">
                  <span>Status Getaran Armada</span>
                  <strong>
                    {fleetCounts.normal} Normal · {fleetCounts.alert} Alert · {fleetCounts.critical} Kritis
                  </strong>
                </div>
                <div className="hydro-live-fleet-kpi">
                  <span>Pembaruan</span>
                  <strong className="hydro-live-pulse-inline">
                    <span className="hydro-live-pulse-dot" />
                    Tiap 2 detik
                  </strong>
                </div>
              </section>

              <HydroCascadeMap
                units={overview.units}
                hydrology={overview.hydrology}
                demoOverride={demoOverride}
                simulated={overview.simulated}
                onOpenUnit={(id) => openLiveUnit(id, 'Unit Monitoring')}
              />

              <div className="hydro-live-plants-stack">
                {plantOrder.map((plantName) => {
                  const groupUnits = overview.units.filter((u) => u.plant === plantName)
                  if (groupUnits.length === 0) return null
                  const plantMw = groupUnits.reduce((sum, u) => {
                    const mw = u.readings.find((r) => r.channel === 'Daya Aktif')?.value ?? 0
                    return sum + (mw ?? 0)
                  }, 0)

                  return (
                    <section key={plantName} className="hydro-live-plant-section">
                      <div className="hydro-live-plant-heading">
                        <h2>PLTA {plantName}</h2>
                        <span>
                          {groupUnits.length} unit · Total daya <strong>{numberFormat.format(plantMw)} MW</strong>
                        </span>
                      </div>

                      <div className="hydro-live-plant-grid">
                        {groupUnits.map((u) => {
                          const vibList = u.readings.filter(isVibrationReading)
                          const peakVib = unitPeakVibration(u, demoOverride)
                          const vibStatus = classifyLiveVibration(peakVib)

                          const mw = u.readings.find((r) => r.channel === 'Daya Aktif')?.value ?? null
                          const mvar = u.readings.find((r) => r.channel === 'Daya Reaktif')?.value ?? null
                          const kv = u.readings.find((r) => r.channel === 'Tegangan')?.value ?? null
                          const amp = u.readings.find((r) => r.channel === 'Arus')?.value ?? null
                          const rpm = u.readings.find((r) => r.channel === 'Kecepatan Putaran')?.value ?? null
                          const gate = u.readings.find((r) => r.channel === 'Bukaan Wicket Gate')?.value ?? null
                          const temp = u.readings.find((r) => r.channel === 'Temperatur Bearing')?.value ?? null

                          return (
                            <article key={u.unit_id} className="hydro-live-unit-card">
                              <div className="hydro-live-unit-card-top">
                                <div>
                                  <small>PLTA {u.plant}</small>
                                  <h3>{u.unit_id} · {u.name}</h3>
                                </div>
                                <span className="hydro-live-vib-badge" data-tone={vibStatus.tone}>
                                  {vibStatus.label}
                                </span>
                              </div>

                              <LiveVibrationGauge value={peakVib} channelCount={vibList.length} />

                              <div className="hydro-live-unit-mini-grid">
                                <div>
                                  <span>Daya</span>
                                  <strong>{mw !== null ? `${numberFormat.format(mw)} MW` : '—'}</strong>
                                </div>
                                <div>
                                  <span>Reaktif</span>
                                  <strong>{mvar !== null ? `${numberFormat.format(mvar)} MVAr` : '—'}</strong>
                                </div>
                                <div>
                                  <span>Tegangan</span>
                                  <strong>{kv !== null ? `${numberFormat.format(kv)} kV` : '—'}</strong>
                                </div>
                                <div>
                                  <span>Arus</span>
                                  <strong>{amp !== null ? `${numberFormat.format(amp)} A` : '—'}</strong>
                                </div>
                                <div>
                                  <span>Putaran</span>
                                  <strong>{rpm !== null ? `${numberFormat.format(rpm)} rpm` : '—'}</strong>
                                </div>
                                <div>
                                  <span>Gate / Suhu</span>
                                  <strong>
                                    {gate !== null ? `${numberFormat.format(gate)}%` : '—'} · {temp !== null ? `${numberFormat.format(temp)}°C` : '—'}
                                  </strong>
                                </div>
                              </div>

                              <div className="hydro-live-unit-actions">
                                <button
                                  type="button"
                                  onClick={() => openLiveUnit(u.unit_id, 'Unit Monitoring')}
                                >
                                  Detail Unit
                                </button>
                                <button
                                  type="button"
                                  className="primary"
                                  onClick={() => openLiveUnit(u.unit_id, 'Vibration Analysis')}
                                >
                                  Tren Getaran
                                </button>
                              </div>
                            </article>
                          )
                        })}
                      </div>
                    </section>
                  )
                })}
              </div>
            </>
          )}
          <LiveAlertDemo onDemoReadingChange={setDemoOverride} />
        </>
      ) : (
        <>
          {!isAlarms && (
            <div className="hydro-live-filters">
              <label>
                PLTA
                <select
                  value={plant}
                  onChange={(event) => selectPlant(event.target.value as HydroUnit['plant'])}
                >
                  {plants.map((name) => <option key={name}>{name}</option>)}
                </select>
              </label>
              <label>
                Unit
                <select
                  value={unitId}
                  onChange={(event) => {
                    setUnitId(event.target.value)
                    setResult(null)
                  }}
                >
                  {plantUnits.map((unit) => (
                    <option key={unit.id} value={unit.id}>{unit.id} · {unit.name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {(isVibrationAnalysis || !isAlarms) && currentTrend.length > 0 && currentVibChannels.length > 0 && (
            <LiveVibrationChart
              unitLabel={`${currentUnitObj.plant} · ${currentUnitObj.id}`}
              channels={currentVibChannels}
              points={currentTrend}
              simulated={snapshot.simulated}
            />
          )}

          {isAlarms && <LiveAlertDemo />}

          {!isAlarms && !isVibrationAnalysis && snapshot.readings.length > 0 && (
            <div className="hydro-live-cards">
              {snapshot.readings.map((reading) => (
                <article key={reading.channel}>
                  <h2>{reading.channel}</h2>
                  <div className="hydro-live-value">
                    {reading.value !== null && reading.quality !== 'bad'
                      ? numberFormat.format(reading.value)
                      : '—'}
                    {reading.unit && <span> {reading.unit}</span>}
                  </div>
                  <dl>
                    <div>
                      <dt>Waktu pengukuran</dt>
                      <dd>{timeFormat.format(new Date(reading.measured_at))} WITA</dd>
                    </div>
                    <div>
                      <dt>Kualitas</dt>
                      <dd>{qualityText[reading.quality]}{reading.fresh ? '' : ' · Periksa waktu data'}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          )}

          {isVibrationAnalysis && <LiveAlertDemo />}
        </>
      )}
    </main>
  )
}