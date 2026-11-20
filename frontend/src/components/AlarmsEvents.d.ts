import type { ComponentType } from 'react'
import type { HydroUnit } from '../data/units'

type AlarmsEventsProps = {
  units?: HydroUnit[]
}

declare const AlarmsEvents: ComponentType<AlarmsEventsProps>

export default AlarmsEvents