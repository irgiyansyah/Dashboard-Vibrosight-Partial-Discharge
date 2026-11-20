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

const ALERT = 300;
const TRIP = 400;

const formatNumber = new Intl.NumberFormat('id-ID', {
  maximumFractionDigits: 2,
});

const number = (value) =>
  Number.isFinite(value)
    ? formatNumber.format(value)
    : '—';

function supportsThreshold(parameter) {
  const unit = String(parameter.engineering_unit || '')
    .trim()
    .replace(/μ/g, 'µ')
    .toLowerCase();

  const definition = String(
    parameter.measurement_definition || '',
  )
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

  return (
    ['µm', 'um'].includes(unit) &&
    definition === 'peak-to-peak'
  );
}

function level(value) {
  if (!Number.isFinite(value) || value < 0) {
    return 'excluded';
  }

  if (value >= TRIP) return 'trip';
  if (value >= ALERT) return 'alert';

  return 'below';
}

// Semua pembacaan dihitung.
// Penanda dibatasi agar grafik panjang tetap ringan.
function analyse(rows, series) {
  let alert = 0;
  let trip = 0;
  let evaluated = 0;
  let limited = false;

  const markers = {};

  for (const item of series) {
    const points = [];
    let peak = null;

    for (const row of rows) {
      const value = row[item.dataKey];
      const state = level(value);

      if (state === 'excluded') continue;

      evaluated += 1;

      if (state === 'alert') alert += 1;
      if (state === 'trip') trip += 1;

      if (state === 'alert' || state === 'trip') {
        points.push(row.axisTime);

        if (!peak || value > peak.value) {
          peak = {
            time: row.axisTime,
            value,
          };
        }
      }
    }

    const selected = new Set();

    if (points.length <= 120) {
      points.forEach((time) => selected.add(time));
    } else {
      limited = true;

      for (let i = 0; i < 119; i += 1) {
        const index = Math.round(
          (i * (points.length - 1)) / 118,
        );

        selected.add(points[index]);
      }

      if (peak) selected.add(peak.time);
    }

    markers[item.dataKey] = selected;
  }

  return {
    alert,
    trip,
    evaluated,
    limited,
    markers,
  };
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
    visibleSeries.every(supportsThreshold);

  const stats = useMemo(
    () =>
      analyse(
        chartRows,
        enabled ? visibleSeries : [],
      ),
    [chartRows, visibleSeries, enabled],
  );

  const statusText = (value) => {
    if (!enabled) return '';

    return {
      below: 'Di bawah alert',
      alert: 'Alert',
      trip: 'Ambang trip terlampaui',
      excluded: 'Tidak dievaluasi',
    }[level(value)];
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
          <>
            <strong style={{ color: '#996500' }}>
              Alert ≥ 300 µm p-p
            </strong>

            <strong style={{ color: '#c5283d' }}>
              Ambang trip ≥ 400 µm p-p
            </strong>
          </>
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
                            fill={
                              level(value) === 'trip'
                                ? '#d62f45'
                                : '#b77900'
                            }
                            stroke="#fff"
                            strokeWidth={1}
                          />
                        );
                      }
                    : false
                }
              />
            ))}

            {enabled && (
              <ReferenceLine
                y={ALERT}
                stroke="#b77900"
                strokeWidth={2}
                strokeDasharray="7 5"
                ifOverflow="extendDomain"
                label={{
                  value: 'Alert · 300 µm p-p',
                  position: 'insideTopRight',
                  fill: '#996500',
                  fontSize: 12,
                }}
              />
            )}

            {enabled && (
              <ReferenceLine
                y={TRIP}
                stroke="#d62f45"
                strokeWidth={2}
                strokeDasharray="7 5"
                ifOverflow="extendDomain"
                label={{
                  value: 'Ambang trip · 400 µm p-p',
                  position: 'insideTopRight',
                  fill: '#c5283d',
                  fontSize: 12,
                }}
              />
            )}
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
            fontSize: 13,
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

            <span style={{ color: '#996500' }}>
              Alert: {number(stats.alert)}
            </span>

            <span style={{ color: '#c5283d' }}>
              Ambang trip: {number(stats.trip)}
            </span>
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