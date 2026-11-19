import React, { useCallback, useEffect, useState } from 'react';
import { Camera, Download, Trash2 } from 'lucide-react';
import { apiUrl, isLocalToken } from '../lib/api';
import { localDeleteCapture, localGetCaptures } from '../lib/localStore';
import { CameraCaptureRecord } from '../types/sensor';

type CaptureViewItem = CameraCaptureRecord & { dataUrl?: string };

interface CameraVaultViewProps {
  token: string;
  onOpenCameraSensor: () => void;
  refreshSignal: number;
}

export const CameraVaultView: React.FC<CameraVaultViewProps> = ({
  token,
  onOpenCameraSensor,
  refreshSignal,
}) => {
  const [captures, setCaptures] = useState<CaptureViewItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadCaptures = useCallback(async () => {
    setLoading(true);
    try {
      if (isLocalToken(token)) {
        const localCaps = await localGetCaptures(token);
        setCaptures(localCaps);
        return;
      }
      const res = await fetch(apiUrl('/api/camera/captures'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { captures: CaptureViewItem[] };
        setCaptures(data.captures);
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadCaptures();
  }, [loadCaptures, refreshSignal]);

  const handleDelete = async (id: string) => {
    if (isLocalToken(token)) {
      await localDeleteCapture(token, id);
      setCaptures((prev) => prev.filter((c) => c.id !== id));
      return;
    }
    const res = await fetch(apiUrl(`/api/camera/captures/${id}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setCaptures((prev) => prev.filter((c) => c.id !== id));
    }
  };

  const totalBytes = captures.reduce((acc, c) => acc + c.fileSizeBytes, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Camera Optical Media Vault
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Optical frames are isolated from numeric time-series rows: raw JPEGs are written to
            encrypted disk storage while scene luminance and RGB metadata are indexed separately.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenCameraSensor}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 whitespace-nowrap shrink-0"
        >
          <Camera className="h-4 w-4" />
          Open Camera Sensor
        </button>
      </div>

      {/* Vault KPI Strip */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Stored Optical Frames</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {captures.length}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Disk Media Footprint</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {(totalBytes / 1024).toFixed(1)} <span className="text-xs text-slate-400">KB</span>
          </p>
        </div>
        <div className="col-span-2 rounded-2xl border border-slate-200 bg-white p-4 sm:col-span-1">
          <p className="text-xs font-medium text-slate-500">Storage Architecture</p>
          <p className="mt-1 font-mono text-sm font-semibold text-slate-900">
            Disk JPEG + camera_captures
          </p>
        </div>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          Loading optical vault records...
        </div>
      ) : captures.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
          <p className="text-sm font-semibold text-slate-900">No camera frames captured yet</p>
          <p className="mt-1 text-xs text-slate-500">
            Open the Camera Optical Sensor, grant camera permission, and capture a scene frame.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {captures.map((cap) => {
            const imgUrl =
              cap.dataUrl ||
              apiUrl(`/api/camera/files/${cap.id}?token=${encodeURIComponent(token)}`);
            return (
              <article
                key={cap.id}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-white"
              >
                <div className="aspect-video w-full bg-slate-100">
                  <img
                    src={imgUrl}
                    alt={`Optical capture ${cap.width}x${cap.height}`}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="p-4">
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="font-mono tabular-nums">
                      {cap.width}x{cap.height} &middot; {cap.facingMode}
                    </span>
                    <span className="font-mono tabular-nums">
                      {(cap.fileSizeBytes / 1024).toFixed(1)} KB
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-slate-50 px-2.5 py-2">
                      <span className="block text-[11px] text-slate-500">Luminance</span>
                      <span className="font-mono font-semibold text-slate-900 tabular-nums">
                        {cap.meanLuminance}
                      </span>
                    </div>
                    <div className="rounded-lg bg-slate-50 px-2.5 py-2">
                      <span className="block text-[11px] text-slate-500">Dominant RGB</span>
                      <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] font-semibold text-slate-900 truncate">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-slate-300"
                          style={{ backgroundColor: cap.dominantRgb }}
                        />
                        {cap.dominantRgb}
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                      {new Date(cap.capturedAt).toLocaleString()}
                    </span>
                    <div className="flex items-center gap-1">
                      <a
                        href={imgUrl}
                        download={cap.fileName}
                        aria-label="Download capture"
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                      >
                        <Download className="h-4 w-4" />
                      </a>
                      <button
                        type="button"
                        onClick={() => handleDelete(cap.id)}
                        aria-label="Delete capture"
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-rose-50 hover:text-rose-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
