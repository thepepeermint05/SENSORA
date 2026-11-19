import React, { useState } from 'react';
import { ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { SensorDefinition } from '../types/sensor';

interface PermissionModalProps {
  sensor: SensorDefinition;
  onAllow: () => Promise<void>;
  onDeny: () => void;
  onClose: () => void;
}

export const PermissionModal: React.FC<PermissionModalProps> = ({
  sensor,
  onAllow,
  onDeny,
  onClose,
}) => {
  const [requesting, setRequesting] = useState(false);

  const handleAllow = async () => {
    setRequesting(true);
    try {
      await onAllow();
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="permission-dialog-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div className="w-full max-w-md rounded-t-3xl border border-slate-200 bg-white p-6 shadow-xl sm:rounded-2xl">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200 sm:hidden" />

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <h2 id="permission-dialog-title" className="text-base font-semibold text-slate-900">
                Allow {sensor.name} access?
              </h2>
              <p className="text-xs text-slate-500">
                Hardware permission required before reading telemetry
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close permission dialog"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-slate-600">{sensor.description}</p>

        <div className="mt-4 space-y-2.5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">Android Manifest</span>
            <span className="font-mono font-medium text-slate-800 truncate max-w-[220px]">
              {sensor.androidPermission}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">Hardware Interface</span>
            <span className="font-mono text-slate-800 truncate max-w-[220px]">
              {sensor.webApi}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">Cloud Storage Route</span>
            <span className="font-mono font-semibold text-sky-700">
              {sensor.storageTarget === 'camera_vault'
                ? 'Media Vault (Disk JPEG + Meta)'
                : 'Time-Series SQLite DB'}
            </span>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-2.5 sm:flex-row-reverse">
          <button
            type="button"
            disabled={requesting}
            onClick={handleAllow}
            className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-60"
          >
            <ShieldCheck className="h-4 w-4" />
            {requesting ? 'Requesting OS Permission...' : 'Grant Sensor Permission'}
          </button>
          <button
            type="button"
            disabled={requesting}
            onClick={onDeny}
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
};
