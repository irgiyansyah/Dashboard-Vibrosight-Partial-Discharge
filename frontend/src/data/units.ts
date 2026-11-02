export type Plant = 'Larona' | 'Karebbe' | 'Balambano'

export type HydroUnit = {
  id: string
  plant: Plant
  name: string
}

// Daftar sementara untuk komponen lama yang masih mengimpor hydroUnits.
// Kode unit sudah disamakan dengan database.
// App.tsx akan mengambil daftar unit dari API.
export const hydroUnits: HydroUnit[] = [
  { id: 'LRN-01', plant: 'Larona', name: 'Unit 1' },
  { id: 'LRN-02', plant: 'Larona', name: 'Unit 2' },
  { id: 'LRN-03', plant: 'Larona', name: 'Unit 3' },

  { id: 'KRB-01', plant: 'Karebbe', name: 'Unit 1' },
  { id: 'KRB-02', plant: 'Karebbe', name: 'Unit 2' },

  { id: 'BLB-01', plant: 'Balambano', name: 'Unit 1' },
  { id: 'BLB-02', plant: 'Balambano', name: 'Unit 2' },
]

function isHydroUnit(value: unknown): value is HydroUnit {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const unit = value as Record<string, unknown>

  return (
    typeof unit.id === 'string' &&
    unit.id.trim().length > 0 &&
    typeof unit.name === 'string' &&
    unit.name.trim().length > 0 &&
    (
      unit.plant === 'Larona' ||
      unit.plant === 'Karebbe' ||
      unit.plant === 'Balambano'
    )
  )
}

export async function fetchHydroUnits(
  signal: AbortSignal,
): Promise<HydroUnit[]> {
  const response = await fetch(
    'http://127.0.0.1:8000/api/units',
    {
      signal,
      headers: {
        Accept: 'application/json',
      },
    },
  )

  if (!response.ok) {
    throw new Error(
      `Daftar unit gagal dimuat. Kode HTTP: ${response.status}.`,
    )
  }

  const payload: unknown = await response.json()

  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Format respons API tidak sesuai.')
  }

  const result = payload as Record<string, unknown>

  if (result.status !== 'ok' || !Array.isArray(result.data)) {
    throw new Error('Format daftar unit dari API tidak sesuai.')
  }

  const rows: unknown[] = result.data

  if (!rows.every(isHydroUnit)) {
    throw new Error('Ada data unit yang tidak lengkap atau tidak sesuai.')
  }

  if (new Set(rows.map((unit) => unit.id)).size !== rows.length) {
    throw new Error('API mengembalikan kode unit yang duplikat.')
  }

  return rows.map((unit) => ({
    id: unit.id,
    plant: unit.plant,
    name: unit.name,
  }))
}