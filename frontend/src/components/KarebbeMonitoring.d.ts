import type {ReactElement} from 'react';
export interface KarebbeMonitoringProps {
  units?: [id: string, plant: string, name: string | number][];
  selectedUnitId?: string;
  onUnitChange?: (unitId: string) => void;
}
export default function KarebbeMonitoring(props?: KarebbeMonitoringProps): ReactElement;
