export type Plant = 'Larona' | 'Karebbe' | 'Balambano'

export type HydroUnit = {
  id: string
  plant: Plant
  name: string
}

export const hydroUnits: HydroUnit[] = [
  { id: 'LAR-U1', plant: 'Larona', name: 'Unit 1' },
  { id: 'LAR-U2', plant: 'Larona', name: 'Unit 2' },
  { id: 'LAR-U3', plant: 'Larona', name: 'Unit 3' },

  { id: 'KRB-U1', plant: 'Karebbe', name: 'Unit 1' },
  { id: 'KRB-U2', plant: 'Karebbe', name: 'Unit 2' },

  { id: 'BLM-U1', plant: 'Balambano', name: 'Unit 1' },
  { id: 'BLM-U2', plant: 'Balambano', name: 'Unit 2' },
]