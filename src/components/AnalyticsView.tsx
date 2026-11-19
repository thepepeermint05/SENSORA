import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { SENSOR_CATALOG } from '../sensors/sensorCatalog';
import { SensorStats, StoredSensorReading } from '../types/sensor';

interface AnalyticsViewProps {
  token: string;
  refreshSignal: number;
}

type RangeKey = '15m' | '1h' | '24h' | 'all';

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({ token, refreshSignal }) => {
  const numericSensors = useMemo(
    () => SENSOR_CATALOG.filter((s) => s.storageTarget === 'telemetry_db'),
    []
  );

  const [selectedSensor, setSelectedSensor] = useState<string>('all');
  const [range, setRange] = useState<RangeKey>('all');
  const [readings, setReadings] = useState<StoredSensorReading[]>([]);
  const [stats, setStats] = useState<SensorStats>({
    count: 0,
    minVal: null,
    maxVal: null,
    avgVal: null,
  });
  const [loading, setLoading] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        sensorId: selectedSensor,
        limit: '250',
      });
      if (range !== 'all') {
        const ms =
          range === '15m' ? 15 * 60_000 : range === '1h' ? 60 * 60_000 : 24 * 60 * 60_000;
        params.set('from', new Date(Date.now() - ms).toISOString());
      }
      const res = await fetch(apiUrl(`/api/sensors/readings?${params.toString()}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          readings: StoredSensorReading[];
          stats: SensorStats;
        };
        setReadings(data.readings);
        setStats(data.stats);
      }
    } finally {
      setLoading(false);
    }
  }, [token, selectedSensor, range]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, refreshSignal]);

  // Chronological ascending series for SVG chart
  const chartPoints = useMemo(() => {
    return [...readings]
      .filter((r) => typeof r.primaryValue === 'number' && Number.isFinite(r.primaryValue))
      .reverse();
  }, [readings]);

  const chartGeometry = useMemo(() => {
    if (chartPoints.length < 2) return null;
    const width = 760;
    const height = 220;
    const padX = 16;
    const padY = 20;
    const vals = chartPoints.map((p) => p.primaryValue as number);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;

    const coords = chartPoints.map((p, i) => {
      const x = padX + (i / (chartPoints.length - 1)) * (width - padX * 2);
      const y = height - padY - (((p.primaryValue as number) - min) / span) * (height - padY * 2);
      return { x, y, point: p };
    });

    const path = coords
      .map((c, idx) => `${idx === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(' ');
    const areaPath = `${path} L${coords[coords.length - 1].x.toFixed(1)},${height - padY} L${coords[0].x.toFixed(1)},${height - padY} Z`;

    return { width, height, min, max, coords, path, areaPath };
  }, [chartPoints]);

  const activeHover =
    hoverIdx !== null && chartGeometry?.coords[hoverIdx] ? chartGeometry.coords[hoverIdx] : null;

  const exportUrl = (format: 'csv' | 'json') =>
    apiUrl(`/api/sensors/export?sensorId=${encodeURIComponent(selectedSensor)}&format=${format}&token=${encodeURIComponent(token)}`);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Historical Telemetry &amp; Analytics
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Long-term SQLite cloud time-series review across all numeric hardware sensors.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <a
            href={exportUrl('csv')}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </a>
          <a
            href={exportUrl('json')}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap"
          >
            <Download className="h-4 w-4" />
            Export JSON
          </a>
        </div>
      </div>

      {/* Filter Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <label htmlFor="sensor-filter" className="text-xs font-medium text-slate-600">
            Sensor Channel
          </label>
          <select
            id="sensor-filter"
            value={selectedSensor}
            onChange={(e) => setSelectedSensor(e.target.value)}
            className="min-h-[44px] rounded-xl border border-slate-200 bg-white px-3.5 text-sm font-medium text-slate-900"
          >
            <option value="all">All Telemetry Sensors</option>
            {numericSensors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.unit})
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1">
          {(['15m', '1h', '24h', 'all'] as RangeKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setRange(key)}
              className={`min-h-[36px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                range === key
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {key === 'all' ? 'All Time' : key}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Stored Samples</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {stats.count}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Minimum</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {stats.minVal !== null ? stats.minVal.toFixed(2) : '—'}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Mean Average</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {stats.avgVal !== null ? stats.avgVal.toFixed(2) : '—'}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Maximum</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {stats.maxVal !== null ? stats.maxVal.toFixed(2) : '—'}
          </p>
        </div>
      </div>

      {/* Interactive Time-Series Chart */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Time-Series Curve</h2>
          {activeHover ? (
            <div className="font-mono text-xs text-slate-700 tabular-nums">
              {activeHover.point.sensorId} &middot;{' '}
              <strong className="text-sky-700">
                {activeHover.point.primaryValue} {activeHover.point.unit}
              </strong>{' '}
              &middot; {new Date(activeHover.point.recordedAt).toLocaleTimeString()}
            </div>
          ) : (
            <span className="font-mono text-xs text-slate-400">
              Hover chart points for exact sample coordinates
            </span>
          )}
        </div>

        {chartGeometry ? (
          <div className="mt-4 overflow-x-auto">
            <svg
              viewBox={`0 0 ${chartGeometry.width} ${chartGeometry.height}`}
              className="h-56 w-full min-w-[480px] cursor-crosshair"
              onMouseLeave={() => setHoverIdx(null)}
            >
              <defs>
                <linearGradient id="sensoraChartFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0284C7" stopOpacity="0.18" />
                  <stop offset="100%" stopColor="#0284C7" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <line
                x1="16"
                y1="20"
                x2="744"
                y2="20"
                stroke="#E2E8F0"
                strokeDasharray="3 3"
              />
              <line
                x1="16"
                y1="110"
                x2="744"
                y2="110"
                stroke="#E2E8F0"
                strokeDasharray="3 3"
              />
              <line
                x1="16"
                y1="200"
                x2="744"
                y2="200"
                stroke="#E2E8F0"
              />
              <path d={chartGeometry.areaPath} fill="url(#sensoraChartFill)" />
              <path
                d={chartGeometry.path}
                fill="none"
                stroke="#0284C7"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              {activeHover && (
                <>
                  <line
                    x1={activeHover.x}
                    y1="20"
                    x2={activeHover.x}
                    y2="200"
                    stroke="#0F172A"
                    strokeWidth="1"
                    strokeDasharray="2 2"
                  />
                  <circle cx={activeHover.x} cy={activeHover.y} r="4.5" fill="#0284C7" />
                </>
              )}
              {chartGeometry.coords.map((c, idx) => (
                <rect
                  key={c.point.id}
                  x={c.x - 4}
                  y={0}
                  width={8}
                  height={chartGeometry.height}
                  fill="transparent"
                  onMouseEnter={() => setHoverIdx(idx)}
                />
              ))}
            </svg>
          </div>
        ) : (
          <div className="mt-4 flex h-44 items-center justify-center rounded-xl bg-slate-50 text-xs text-slate-500">
            {loading
              ? 'Loading time-series readings...'
              : 'Record at least 2 readings for this channel to plot a time-series curve.'}
          </div>
        )}
      </section>

      {/* Historical Ledger Table */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-900">Recorded Telemetry Ledger</h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-3 font-semibold">Timestamp</th>
                <th className="px-4 py-3 font-semibold">Sensor</th>
                <th className="px-4 py-3 font-semibold">Primary Value</th>
                <th className="px-4 py-3 font-semibold">Payload Axes</th>
                <th className="px-4 py-3 font-semibold">Device</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {readings.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    No telemetry records found for this filter. Activate a sensor to stream readings.
                  </td>
                </tr>
              ) : (
                readings.slice(0, 50).map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                      {new Date(row.recordedAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">
                      {row.sensorId}
                    </td>
                    <td className="px-4 py-3 font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      {row.primaryValue !== null ? `${row.primaryValue} ${row.unit}` : '—'}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 font-mono text-slate-500">
                      {JSON.stringify(row.metrics)}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-500 whitespace-nowrap">
                      {row.deviceId}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
