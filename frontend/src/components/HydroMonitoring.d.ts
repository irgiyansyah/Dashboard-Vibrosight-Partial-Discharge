import type { ReactElement } from 'react';

export type MonitoringUnitOption = [
  id: string,
  plant: string,
  name: string | number
];

export interface HydroMonitoringProps {
  units?: MonitoringUnitOption[];
  selectedUnitId?: string;
  onUnitChange?: (unitId: string) => void;
}

export default function HydroMonitoring(
  props: HydroMonitoringProps
): ReactElement;