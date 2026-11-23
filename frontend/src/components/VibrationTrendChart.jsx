import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  classifyVibration,
  supportsVibrationThreshold,
  VIBRATION_LIMITS,
  VIBRATION_STATUS,
} from './vibrationThresholds.js';

const LINE_STYLES = [
  {
    level: 'fail',
    threshold: VIBRATION_LIMITS.normal,
    stroke: '#8055b8',
    badgeWidth: 132,
    background: '#2b1d3c',
    color: '#dfc7ff',
    left: true,
    compactGap: 5,
  },
  {
    level: 'awareness',
    threshold: VIBRATION_LIMITS.awareness,
    stroke: '#b77900',
    badgeWidth: 192,
    background: '#322719',
    color: '#ffd179',
    below: true,
    compactGap: 27,
  },
  {
    level: 'trip',
    threshold: VIBRATION_LIMITS.trip,
    stroke: '#e84c68',
    badgeWidth: 128,
    background: '#2c1d2b',
    color: '#ff90a4',
    compactGap: 49,
  },
];

const formatNumber = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 2,
});

const number = (value) =>
  Number.isFinite(value)
    ? formatNumber.format(value)
    : '—';

function ThresholdLabel({
  viewBox,
  caption,
  badgeWidth,
  background,
  color,
  below = false,
  left = false,
  gap = 5,
}) {
  const inset = 10;
  const height = 21;

  if (!viewBox || viewBox.width < badgeWidth + inset * 2) {
    return null;
  }

  const x = left
    ? viewBox.x + inset
    : viewBox.x + viewBox.width - inset - badgeWidth;
  const y = below
    ? viewBox.y + gap
    : viewBox.y - height - gap;

  return (
    <g pointerEvents="none">
      <rect
        x={x}
        y={y}
        width={badgeWidth}
        height={height}
        rx={4}
        fill={background}
      />
      <text
        x={x + badgeWidth / 2}
        y={y + height / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={color}
        fontSize={11}
        fontWeight={600}
      >
        {caption}
      </text>
    </g>
  );
}

// Hitung semua pembacaan, dengan maksimal 120 penanda per kurva.
function analyse(rows, series) {
  const counts = { fail: 0, normal: 0, awareness: 0, trip: 0 };
  let evaluated = 0;
  let maxValue = 0;
  let limited = false;
  const markers = {};

  for (const item of series) {
    const points = [];
    let peak = null;
    let lowestFail = null;

    for (const row of rows) {
      const value = row[item.dataKey];
      const status = classifyVibration(value);
      if (status === null) continue;

      evaluated += 1;
      maxValue = Math.max(maxValue, value);
      counts[status] += 1;
      if (status === 'normal') continue;

      points.push(row.axisTime);
      if (!peak || value > peak.value) {
        peak = { time: row.axisTime, value };
      }
      if (status === 'fail' && (!lowestFail || value < lowestFail.value)) {
        lowestFail = { time: row.axisTime, value };
      }
    }

    const selected = new Set();
    if (points.length <= 120) {
      points.forEach((time) => selected.add(time));
    } else {
      limited = true;
      for (let i = 0; i < 118; i += 1) {
        const index = Math.round((i * (points.length - 1)) / 117);
        selected.add(points[index]);
      }
      if (peak) selected.add(peak.time);
      if (lowestFail) selected.add(lowestFail.time);
    }
    markers[item.dataKey] = selected;
  }

  return { counts, evaluated, limited, markers, maxValue };
}

export default function VibrationTrendChart({
  chartRows = [],
  visibleSeries = [],
  startMs,
  endMs,
  ticks,
  axisLabel,
  tooltipLabel,
  engineeringUnit = 'µm p-p',
}) {
  const enabled =
    visibleSeries.length > 0 &&
    visibleSeries.every(supportsVibrationThreshold);

  const stats = useMemo(
    () =>
      analyse(
        chartRows,
        enabled ? visibleSeries : [],
      ),
    [chartRows, visibleSeries, enabled],
  );

  const compactThresholds = stats.maxValue > 1000;

  const statusText = (value) => {
    if (!enabled) return '';

    const status = classifyVibration(value);
    return VIBRATION_STATUS[status]?.label ?? 'Tidak dievaluasi';
  };

  return (
    <section aria-label="Grafik getaran dan batas pemantauan">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 20px',
          marginBottom: 12,
          fontSize: 13,
          color: '#183958',
        }}
      >
        {enabled ? (
          Object.entries(VIBRATION_STATUS).map(([level, status]) => (
            <strong key={level} style={{ color: status.color }}>
              {status.label} · {status.range} µm p-p
            </strong>
          ))
        ) : (
          <span>
            Batas belum diterapkan: metadata kurva
            harus µm peak-to-peak.
          </span>
        )}
      </div>

      <div
        style={{
          width: '100%',
          height: 360,
          minWidth: 0,
        }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartRows}
            margin={{
              top: 24,
              right: 20,
              bottom: 8,
              left: 0,
            }}
          >
            <CartesianGrid
              stroke="#d6e0eb"
              strokeDasharray="3 3"
            />

            <XAxis
              dataKey="axisTime"
              type="number"
              domain={[startMs, endMs]}
              ticks={ticks}
              tickFormatter={axisLabel}
              minTickGap={20}
            />

            <YAxis
              width={65}
              tickFormatter={number}
              domain={
                enabled
                  ? [
                      0,
                      (dataMax) =>
                        Math.max(
                          450,
                          Math.ceil(
                            (dataMax * 1.08) / 50,
                          ) * 50,
                        ),
                    ]
                  : ['auto', 'auto']
              }
            />

            <Tooltip
              labelFormatter={tooltipLabel}
              contentStyle={{
                borderRadius: 8,
                borderColor: '#cbd9e8',
                fontSize: 12,
              }}
              formatter={(value, name) => [
                `${number(value)} ${engineeringUnit}${
                  enabled
                    ? ` · ${statusText(value)}`
                    : ''
                }`,
                name,
              ]}
            />

            {visibleSeries.map((item) => (
              <Line
                key={item.channel_id}
                type="linear"
                dataKey={item.dataKey}
                name={`${item.style.name} · ${item.tag_name}`}
                stroke={item.style.color}
                strokeDasharray={item.style.dash}
                strokeWidth={1.6}
                activeDot={{ r: 5 }}
                connectNulls={false}
                isAnimationActive={false}
                dot={
                  enabled
                    ? (props) => {
                        const value =
                          props.payload?.[item.dataKey];

                        const marked =
                          stats.markers[
                            item.dataKey
                          ]?.has(
                            props.payload?.axisTime,
                          );

                        if (
                          !marked ||
                          !Number.isFinite(props.cx) ||
                          !Number.isFinite(props.cy)
                        ) {
                          return null;
                        }

                        return (
                          <circle
                            key={`${item.channel_id}-${props.payload.axisTime}`}
                            cx={props.cx}
                            cy={props.cy}
                            r={3}
                            fill={VIBRATION_STATUS[classifyVibration(value)].color}
                            stroke="#fff"
                            strokeWidth={1}
                          />
                        );
                      }
                    : false
                }
              />
            ))}

            {enabled && LINE_STYLES.map((style) => (
              <ReferenceLine
                key={style.level}
                y={style.threshold}
                stroke={style.stroke}
                strokeWidth={2}
                strokeDasharray="8 5"
                ifOverflow="extendDomain"
                className={`vibration-threshold-${style.level}`}
                label={{
                  content: (
                    <ThresholdLabel
                      caption={`${VIBRATION_STATUS[style.level].label} · ${style.level === 'fail' ? '< ' : ''}${style.threshold} µm p-p`}
                      badgeWidth={style.badgeWidth}
                      background={style.background}
                      color={style.color}
                      below={style.below && !compactThresholds}
                      gap={compactThresholds ? style.compactGap : undefined}
                      left={style.left}
                    />
                  ),
                }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {enabled && (
        <div
          role="status"
          style={{
            marginTop: 12,
            padding: '12px 14px',
            borderRadius: 8,
            background: '#f3f7fb',
            border: '1px solid #d4e1ee',
            color: '#183958',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          <strong>
            Rentang historis · kurva yang ditampilkan
          </strong>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px 20px',
            }}
          >
            <span>
              {number(stats.evaluated)} pembacaan
              dievaluasi
            </span>

            {Object.entries(VIBRATION_STATUS).map(([level, status]) => (
              <span key={level} style={{ color: status.color }}>
                {status.label}: {number(stats.counts[level])}
              </span>
            ))}
          </div>

          <small>
            Jumlah pembacaan, bukan jumlah kejadian.
            Ambang trip bukan konfirmasi mesin trip.
            {stats.limited &&
              ' Penanda diringkas maksimal 120 per kurva; seluruh pembacaan tetap dihitung.'}
          </small>
        </div>
      )}
    </section>
  );
}