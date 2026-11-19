import React, { useEffect, useRef, useState } from 'react';
import { Camera, Check, RefreshCw, Save, X } from 'lucide-react';
import { LiveSensorSample, SensorDefinition } from '../types/sensor';

interface LiveSensorModalProps {
  sensor: SensorDefinition;
  sample: LiveSensorSample | null;
  history: LiveSensorSample[];
  cameraStream: MediaStream | null;
  autoSave: boolean;
  intervalMs: number;
  onToggleAutoSave: (next: boolean) => void;
  onChangeInterval: (ms: number) => void;
  onManualSave: () => Promise<void>;
  onSwitchCameraFacing: (facing: 'user' | 'environment') => void;
  onCaptureCamera: (payload: {
    imageBase64: string;
    width: number;
    height: number;
    facingMode: string;
    meanLuminance: number;
    dominantRgb: string;
    fpsEstimate: number;
  }) => Promise<void>;
  onTouchPointer: (e: React.PointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
}

export const LiveSensorModal: React.FC<LiveSensorModalProps> = ({
  sensor,
  sample,
  history,
  cameraStream,
  autoSave,
  intervalMs,
  onToggleAutoSave,
  onChangeInterval,
  onManualSave,
  onSwitchCameraFacing,
  onCaptureCamera,
  onTouchPointer,
  onClose,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [opticalStats, setOpticalStats] = useState({
    meanLuminance: 0,
    dominantRgb: 'rgb(0, 0, 0)',
    width: 0,
    height: 0,
  });
  const [capturing, setCapturing] = useState(false);
  const [captureFeedback, setCaptureFeedback] = useState<string | null>(null);
  const [manualSavedFeedback, setManualSavedFeedback] = useState(false);

  // Attach camera MediaStream to <video> and run live pixel luminance analyzer
  useEffect(() => {
    if (sensor.id !== 'camera' || !cameraStream || !videoRef.current) return;
    const video = videoRef.current;
    video.srcObject = cameraStream;
    void video.play().catch(() => {});

    const interval = window.setInterval(() => {
      if (!video.videoWidth || !video.videoHeight || !canvasRef.current) return;
      const canvas = canvasRef.current;
      canvas.width = 64;
      canvas.height = 48;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, 64, 48);
      const data = ctx.getImageData(0, 0, 64, 48).data;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let lumSum = 0;
      const pixels = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        rSum += r;
        gSum += g;
        bSum += b;
        lumSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      setOpticalStats({
        meanLuminance: Math.round((lumSum / pixels) * 10) / 10,
        dominantRgb: `rgb(${Math.round(rSum / pixels)}, ${Math.round(gSum / pixels)}, ${Math.round(
          bSum / pixels
        )})`,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    }, 350);

    return () => window.clearInterval(interval);
  }, [sensor.id, cameraStream]);

  const handleCaptureFrame = async () => {
    if (!videoRef.current || !videoRef.current.videoWidth) return;
    setCapturing(true);
    setCaptureFeedback(null);
    try {
      const video = videoRef.current;
      const captureCanvas = document.createElement('canvas');
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
      const ctx = captureCanvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
      const imageBase64 = captureCanvas.toDataURL('image/jpeg', 0.84);

      await onCaptureCamera({
        imageBase64,
        width: video.videoWidth,
        height: video.videoHeight,
        facingMode,
        meanLuminance: opticalStats.meanLuminance,
        dominantRgb: opticalStats.dominantRgb,
        fpsEstimate: Number(sample?.metrics?.frameRate) || 30,
      });
      setCaptureFeedback('Optical frame stored to separate Media Vault.');
    } catch {
      setCaptureFeedback('Failed to store optical frame.');
    } finally {
      setCapturing(false);
    }
  };

  const handleSnapshotSave = async () => {
    await onManualSave();
    setManualSavedFeedback(true);
    window.setTimeout(() => setManualSavedFeedback(false), 1800);
  };

  // Build SVG sparkline path from numeric history
  const numericPoints = history
    .map((h) => h.primaryValue)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  let sparkPath = '';
  if (numericPoints.length > 1) {
    const min = Math.min(...numericPoints);
    const max = Math.max(...numericPoints);
    const span = max - min || 1;
    sparkPath = numericPoints
      .map((v, idx) => {
        const x = (idx / (numericPoints.length - 1)) * 320;
        const y = 72 - ((v - min) / span) * 60 - 6;
        return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="live-sensor-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-slate-200 bg-white p-6 shadow-xl sm:rounded-2xl">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 sm:hidden" />

        <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>{sensor.webApi}</span>
              <span aria-hidden="true">&middot;</span>
              <span>
                {sensor.storageTarget === 'camera_vault' ? 'Separate Media Vault' : 'Cloud Time-Series DB'}
              </span>
            </div>
            <h2 id="live-sensor-title" className="mt-1 text-xl font-bold text-slate-900">
              {sensor.name}
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close live sensor"
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Status Note / Hardware Unavailable Notice */}
        {sample?.statusNote && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900">
            {sample.statusNote}
          </div>
        )}

        {/* Camera Optical Viewfinder Mode */}
        {sensor.id === 'camera' ? (
          <div className="mt-5 space-y-4">
            <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
              <video
                ref={videoRef}
                playsInline
                muted
                className="aspect-video w-full object-cover"
              />
              <canvas ref={canvasRef} className="hidden" />
              <div className="absolute right-3 bottom-3 left-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-950/80 px-3.5 py-2 text-xs text-slate-100 backdrop-blur-sm">
                <div className="flex items-center gap-3 font-mono tabular-nums">
                  <span>
                    {opticalStats.width}x{opticalStats.height}
                  </span>
                  <span>Lum {opticalStats.meanLuminance}</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block h-3 w-3 rounded-sm border border-white/40"
                      style={{ backgroundColor: opticalStats.dominantRgb }}
                    />
                    {opticalStats.dominantRgb}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const next = facingMode === 'environment' ? 'user' : 'environment';
                    setFacingMode(next);
                    onSwitchCameraFacing(next);
                  }}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1 text-xs font-medium text-white hover:bg-white/25"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {facingMode === 'environment' ? 'Rear' : 'Front'}
                </button>
              </div>
            </div>

            {captureFeedback && (
              <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-medium text-emerald-800">
                {captureFeedback}
              </p>
            )}

            <button
              type="button"
              disabled={capturing || !cameraStream}
              onClick={handleCaptureFrame}
              className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-50"
            >
              <Camera className="h-4 w-4" />
              {capturing ? 'Encoding & Storing JPEG...' : 'Capture & Store to Media Vault'}
            </button>
          </div>
        ) : (
          <>
            {/* Primary Value & Live Sparkline */}
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-12">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:col-span-5">
                <p className="text-xs font-medium text-slate-500">Primary Reading</p>
                <div className="mt-2 flex items-baseline">
                  <span className="font-mono text-3xl font-semibold text-slate-900 tabular-nums">
                    {sample?.primaryValue !== null && sample?.primaryValue !== undefined
                      ? sample.primaryValue
                      : '—'}
                  </span>
                  <span className="ml-1.5 font-mono text-xs uppercase text-slate-500">
                    {sensor.unit}
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  {sample?.hardwareStatus === 'streaming'
                    ? 'Live hardware stream active'
                    : sample?.hardwareStatus === 'ready'
                      ? 'Awaiting touch input'
                      : 'Sensor standby'}
                </p>
              </div>

              <div className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 sm:col-span-7">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>Live Waveform ({numericPoints.length} samples)</span>
                  <span className="font-mono tabular-nums">{sensor.unit}</span>
                </div>
                <svg
                  viewBox="0 0 320 76"
                  className="mt-2 h-20 w-full overflow-visible"
                  aria-label="Live sensor waveform"
                >
                  <line x1="0" y1="38" x2="320" y2="38" stroke="#E2E8F0" strokeDasharray="3 3" />
                  {sparkPath ? (
                    <path
                      d={sparkPath}
                      fill="none"
                      stroke="#0284C7"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  ) : (
                    <text x="160" y="42" textAnchor="middle" className="fill-slate-400 text-[11px]">
                      Collecting samples...
                    </text>
                  )}
                </svg>
              </div>
            </div>

            {/* Interactive Touch Digitizer Pad */}
            {sensor.id === 'touch_pressure' && (
              <div
                onPointerDown={onTouchPointer}
                onPointerMove={(e) => {
                  if (e.buttons > 0 || e.pointerType === 'touch') onTouchPointer(e);
                }}
                onPointerUp={onTouchPointer}
                className="mt-4 flex h-40 touch-none select-none flex-col items-center justify-center rounded-2xl border border-dashed border-sky-300 bg-sky-50/60 p-4 text-center cursor-crosshair"
              >
                <p className="text-sm font-semibold text-sky-900">Touch &amp; Pressure Digitizer Pad</p>
                <p className="mt-1 text-xs text-sky-700">
                  Press or drag with finger or stylus to capture contact force and tilt
                </p>
              </div>
            )}

            {/* Multi-Axis Telemetry Breakdown */}
            {sample && Object.keys(sample.metrics).length > 0 && (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {Object.entries(sample.metrics).map(([key, val]) => (
                  <div
                    key={key}
                    className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5"
                  >
                    <p className="text-[11px] font-medium text-slate-500">{key}</p>
                    <p className="mt-1 font-mono text-sm font-semibold text-slate-900 tabular-nums truncate">
                      {val === null ? '—' : String(val)}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Cloud Persistence Controls */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={autoSave}
                    onChange={(e) => onToggleAutoSave(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-600"
                  />
                  Auto-save to Cloud DB
                </label>

                <select
                  aria-label="Cloud sampling interval"
                  value={intervalMs}
                  onChange={(e) => onChangeInterval(Number(e.target.value))}
                  className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700"
                >
                  <option value={250}>4 Hz (250ms)</option>
                  <option value={1000}>1 Hz (1s)</option>
                  <option value={2000}>0.5 Hz (2s)</option>
                  <option value={5000}>0.2 Hz (5s)</option>
                </select>
              </div>

              <button
                type="button"
                disabled={sample?.hardwareStatus !== 'streaming'}
                onClick={handleSnapshotSave}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
              >
                {manualSavedFeedback ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-400" />
                    Saved Snapshot
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    Record Snapshot
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
