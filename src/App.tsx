import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  Camera,
  ChevronRight,
  Compass,
  FolderGit2,
  Gauge,
  LogOut,
  MapPin,
  Mic,
  Radio,
  ShieldCheck,
  Smartphone,
  Sun,
} from 'lucide-react';
import { AnalyticsView } from './components/AnalyticsView';
import { AuthPage } from './components/AuthPage';
import { CameraVaultView } from './components/CameraVaultView';
import { DeploymentView } from './components/DeploymentView';
import { LiveSensorModal } from './components/LiveSensorModal';
import { PermissionModal } from './components/PermissionModal';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { useSensorStream } from './hooks/useSensorStream';
import { apiUrl, safeStorage } from './lib/api';
import { CATEGORY_LABELS, SENSOR_CATALOG } from './sensors/sensorCatalog';
import { AuthUser, PermissionState, SensorDefinition } from './types/sensor';

type AppTab = 'sensors' | 'camera' | 'analytics' | 'deploy';

function getSensorIcon(sensorId: string) {
  switch (sensorId) {
    case 'camera':
      return Camera;
    case 'microphone':
      return Mic;
    case 'geolocation':
      return MapPin;
    case 'magnetometer':
      return Compass;
    case 'ambient_light':
      return Sun;
    case 'network':
      return Radio;
    case 'barometer':
      return Gauge;
    case 'battery':
    case 'touch_pressure':
      return Smartphone;
    default:
      return Activity;
  }
}

export default function App() {
  const [token, setToken] = useState<string | null>(() =>
    typeof window !== 'undefined' ? safeStorage.getItem('sensora_token') : null
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);

  const [activeTab, setActiveTab] = useState<AppTab>('sensors');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [permissions, setPermissions] = useState<Record<string, PermissionState>>({});
  const [summaryCounts, setSummaryCounts] = useState<Record<string, number>>({});
  const [cameraVaultCount, setCameraVaultCount] = useState<number>(0);

  const [pendingPermissionSensor, setPendingPermissionSensor] = useState<SensorDefinition | null>(
    null
  );
  const [activeSensor, setActiveSensor] = useState<SensorDefinition | null>(null);
  const [autoSave, setAutoSave] = useState<boolean>(true);
  const [intervalMs, setIntervalMs] = useState<number>(1000);
  const [refreshSignal, setRefreshSignal] = useState<number>(0);

  const {
    wsConnected,
    activeSample,
    historyBuffer,
    savedCount,
    cameraStream,
    requestHardwarePermission,
    startSensorStream,
    stopActiveSensor,
    persistSample,
    emitTouchSample,
  } = useSensorStream(token);

  // Verify stored token on startup
  useEffect(() => {
    if (!token) {
      setAuthChecking(false);
      return;
    }
    fetch(apiUrl('/api/auth/me'), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Invalid session');
        const data = (await res.json()) as { user: AuthUser };
        setUser(data.user);
      })
      .catch(() => {
        safeStorage.removeItem('sensora_token');
        setToken(null);
        setUser(null);
      })
      .finally(() => setAuthChecking(false));
  }, [token]);

  const loadWorkspaceData = useCallback(async () => {
    if (!token) return;
    try {
      const [permRes, sumRes] = await Promise.all([
        fetch(apiUrl('/api/sensors/permissions'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/sensors/summary'), { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (permRes.ok) {
        const permData = (await permRes.json()) as {
          permissions: Record<string, { state: PermissionState }>;
        };
        const mapped: Record<string, PermissionState> = {};
        for (const [k, v] of Object.entries(permData.permissions)) {
          mapped[k] = v.state;
        }
        setPermissions(mapped);
      }
      if (sumRes.ok) {
        const sumData = (await sumRes.json()) as {
          telemetrySummary: Array<{ sensor_id: string; count: number }>;
          cameraVaultSummary: { count: number };
        };
        const counts: Record<string, number> = {};
        for (const item of sumData.telemetrySummary) {
          counts[item.sensor_id] = item.count;
        }
        setSummaryCounts(counts);
        setCameraVaultCount(sumData.cameraVaultSummary.count);
      }
    } catch {
      // ignore transient errors
    }
  }, [token]);

  useEffect(() => {
    if (user) {
      void loadWorkspaceData();
    }
  }, [user, loadWorkspaceData, savedCount, refreshSignal]);

  const handleAuthenticated = useCallback((newToken: string, authUser: AuthUser) => {
    safeStorage.setItem('sensora_token', newToken);
    setToken(newToken);
    setUser(authUser);
  }, []);

  const handleLogout = async () => {
    stopActiveSensor();
    if (token) {
      await fetch(apiUrl('/api/auth/logout'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    safeStorage.removeItem('sensora_token');
    setToken(null);
    setUser(null);
  };

  // Permission-first sensor click handler
  const handleSelectSensor = (sensor: SensorDefinition) => {
    const currentState = permissions[sensor.id] || 'prompt';
    if (currentState !== 'granted') {
      setPendingPermissionSensor(sensor);
      return;
    }
    setActiveSensor(sensor);
    void startSensorStream(sensor.id, { autoSave, intervalMs });
  };

  const handleGrantPermission = async () => {
    if (!pendingPermissionSensor || !token) return;
    const sensor = pendingPermissionSensor;
    const result = await requestHardwarePermission(sensor.id);

    setPermissions((prev) => ({ ...prev, [sensor.id]: result }));
    await fetch(apiUrl(`/api/sensors/permissions/${sensor.id}`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ state: result }),
    }).catch(() => {});

    setPendingPermissionSensor(null);
    if (result === 'granted') {
      setActiveSensor(sensor);
      void startSensorStream(sensor.id, { autoSave, intervalMs });
    }
  };

  const handleDenyPermission = async () => {
    if (!pendingPermissionSensor || !token) return;
    const sensor = pendingPermissionSensor;
    setPermissions((prev) => ({ ...prev, [sensor.id]: 'denied' }));
    await fetch(apiUrl(`/api/sensors/permissions/${sensor.id}`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ state: 'denied' }),
    }).catch(() => {});
    setPendingPermissionSensor(null);
  };

  const handleCaptureCamera = async (payload: {
    imageBase64: string;
    width: number;
    height: number;
    facingMode: string;
    meanLuminance: number;
    dominantRgb: string;
    fpsEstimate: number;
  }) => {
    if (!token) return;
    const res = await fetch(apiUrl('/api/camera/captures'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to store camera capture');
    setRefreshSignal((s) => s + 1);
  };

  const filteredSensors = useMemo(() => {
    if (categoryFilter === 'all') return SENSOR_CATALOG;
    return SENSOR_CATALOG.filter((s) => s.category === categoryFilter);
  }, [categoryFilter]);

  const totalTelemetryReadings = useMemo(
    () => Object.values(summaryCounts).reduce((a, b) => a + b, 0),
    [summaryCounts]
  );

  if (authChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Verifying session...
      </div>
    );
  }

  if (!user || !token) {
    return <AuthPage onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24 text-slate-900 md:pb-12">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-8 px-4 sm:px-6">
          {/* Zone 1: Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('sensors')}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            Sensora
          </button>

          {/* Zone 2: Concise Single-Line Navigation Links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <button
              type="button"
              onClick={() => setActiveTab('sensors')}
              className={`whitespace-nowrap shrink-0 transition-colors ${
                activeTab === 'sensors'
                  ? 'text-slate-900 underline underline-offset-8 decoration-sky-600 decoration-2'
                  : 'hover:text-slate-900'
              }`}
            >
              Sensors
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('camera')}
              className={`whitespace-nowrap shrink-0 transition-colors ${
                activeTab === 'camera'
                  ? 'text-slate-900 underline underline-offset-8 decoration-sky-600 decoration-2'
                  : 'hover:text-slate-900'
              }`}
            >
              Camera Vault
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('analytics')}
              className={`whitespace-nowrap shrink-0 transition-colors ${
                activeTab === 'analytics'
                  ? 'text-slate-900 underline underline-offset-8 decoration-sky-600 decoration-2'
                  : 'hover:text-slate-900'
              }`}
            >
              Analytics
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('deploy')}
              className={`whitespace-nowrap shrink-0 transition-colors ${
                activeTab === 'deploy'
                  ? 'text-slate-900 underline underline-offset-8 decoration-sky-600 decoration-2'
                  : 'hover:text-slate-900'
              }`}
            >
              APK &amp; GitHub
            </button>
          </nav>

          {/* Zone 3: Primary Session Action */}
          <div className="flex items-center gap-3 shrink-0">
            <PWAInstallButton variant="compact" />
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        {activeTab === 'sensors' && (
          <div className="space-y-6">
            {/* Workspace Overview Header */}
            <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-6 lg:flex-row lg:items-end">
              <div>
                <p className="text-xs font-medium text-slate-500">
                  Signed in as {user.displayName} &middot;{' '}
                  {wsConnected ? 'Real-time WebSocket stream connected' : 'REST sync ready'}
                </p>
                <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
                  Android Hardware Sensor Matrix
                </h1>
              </div>

              <div className="grid grid-cols-3 gap-4 sm:gap-6">
                <div>
                  <span className="block text-xs text-slate-500">Sensors</span>
                  <span className="font-mono text-xl font-semibold text-slate-900 tabular-nums">
                    {SENSOR_CATALOG.length}
                  </span>
                </div>
                <div>
                  <span className="block text-xs text-slate-500">Telemetry Rows</span>
                  <span className="font-mono text-xl font-semibold text-slate-900 tabular-nums">
                    {totalTelemetryReadings}
                  </span>
                </div>
                <div>
                  <span className="block text-xs text-slate-500">Optical Frames</span>
                  <span className="font-mono text-xl font-semibold text-slate-900 tabular-nums">
                    {cameraVaultCount}
                  </span>
                </div>
              </div>
            </div>

            {/* Category Filter Bar */}
            <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1">
              {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCategoryFilter(key)}
                  className={`min-h-[40px] rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    categoryFilter === key
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Sensor Grid */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredSensors.map((sensor) => {
                const Icon = getSensorIcon(sensor.id);
                const perm = permissions[sensor.id] || 'prompt';
                const storedCount =
                  sensor.storageTarget === 'camera_vault'
                    ? cameraVaultCount
                    : summaryCounts[sensor.id] || 0;

                return (
                  <button
                    key={sensor.id}
                    type="button"
                    onClick={() => handleSelectSensor(sensor)}
                    className="group flex min-h-[148px] flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 text-left transition-colors hover:border-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  >
                    <div className="flex w-full items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700 transition-colors group-hover:bg-sky-50 group-hover:text-sky-700">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div>
                          <h2 className="text-sm font-semibold text-slate-900">{sensor.name}</h2>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {CATEGORY_LABELS[sensor.category]} &middot;{' '}
                            <span className="font-mono">{sensor.unit}</span>
                          </p>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-sky-600" />
                    </div>

                    <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-slate-600">
                      {sensor.description}
                    </p>

                    <div className="mt-4 flex w-full items-center justify-between border-t border-slate-100 pt-3 text-xs">
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${
                          perm === 'granted'
                            ? 'text-emerald-700'
                            : perm === 'denied'
                              ? 'text-rose-700'
                              : 'text-slate-500'
                        }`}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {perm === 'granted'
                          ? 'Permission Granted'
                          : perm === 'denied'
                            ? 'Permission Denied'
                            : 'Tap to Request'}
                      </span>

                      <span className="font-mono text-slate-500 tabular-nums">
                        {storedCount}{' '}
                        {sensor.storageTarget === 'camera_vault' ? 'frames' : 'rows'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === 'camera' && (
          <CameraVaultView
            token={token}
            refreshSignal={refreshSignal}
            onOpenCameraSensor={() => {
              const cam = SENSOR_CATALOG.find((s) => s.id === 'camera');
              if (cam) handleSelectSensor(cam);
            }}
          />
        )}

        {activeTab === 'analytics' && (
          <AnalyticsView token={token} refreshSignal={refreshSignal} />
        )}

        {activeTab === 'deploy' && <DeploymentView token={token} />}
      </main>

      {/* Mobile Fixed Bottom Navigation Bar (<= 15% mobile viewport height) */}
      <nav
        aria-label="Mobile navigation"
        className="fixed right-0 bottom-0 left-0 z-40 grid h-16 grid-cols-4 items-center border-t border-slate-200 bg-white/95 backdrop-blur-md md:hidden"
      >
        <button
          type="button"
          onClick={() => setActiveTab('sensors')}
          className={`flex min-h-[44px] flex-col items-center justify-center ${
            activeTab === 'sensors' ? 'text-sky-600' : 'text-slate-500'
          }`}
        >
          <Activity className="h-5 w-5" />
          <span className="mt-1 text-[10px] font-medium">Sensors</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('camera')}
          className={`flex min-h-[44px] flex-col items-center justify-center ${
            activeTab === 'camera' ? 'text-sky-600' : 'text-slate-500'
          }`}
        >
          <Camera className="h-5 w-5" />
          <span className="mt-1 text-[10px] font-medium">Camera</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('analytics')}
          className={`flex min-h-[44px] flex-col items-center justify-center ${
            activeTab === 'analytics' ? 'text-sky-600' : 'text-slate-500'
          }`}
        >
          <BarChart3 className="h-5 w-5" />
          <span className="mt-1 text-[10px] font-medium">Analytics</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('deploy')}
          className={`flex min-h-[44px] flex-col items-center justify-center ${
            activeTab === 'deploy' ? 'text-sky-600' : 'text-slate-500'
          }`}
        >
          <FolderGit2 className="h-5 w-5" />
          <span className="mt-1 text-[10px] font-medium">APK &amp; Git</span>
        </button>
      </nav>

      {/* Permission Request Gate */}
      {pendingPermissionSensor && (
        <PermissionModal
          sensor={pendingPermissionSensor}
          onAllow={handleGrantPermission}
          onDeny={handleDenyPermission}
          onClose={() => setPendingPermissionSensor(null)}
        />
      )}

      {/* Live Sensor Streaming Panel */}
      {activeSensor && (
        <LiveSensorModal
          sensor={activeSensor}
          sample={activeSample}
          history={historyBuffer}
          cameraStream={cameraStream}
          autoSave={autoSave}
          intervalMs={intervalMs}
          onToggleAutoSave={(next) => {
            setAutoSave(next);
            void startSensorStream(activeSensor.id, { autoSave: next, intervalMs });
          }}
          onChangeInterval={(ms) => {
            setIntervalMs(ms);
            void startSensorStream(activeSensor.id, { autoSave, intervalMs: ms });
          }}
          onManualSave={async () => {
            if (activeSample) {
              await persistSample(activeSample);
              setRefreshSignal((s) => s + 1);
            }
          }}
          onSwitchCameraFacing={(facing) => {
            void startSensorStream('camera', {
              autoSave,
              intervalMs,
              facingMode: facing,
            });
          }}
          onCaptureCamera={handleCaptureCamera}
          onTouchPointer={(e) => emitTouchSample(e, autoSave)}
          onClose={() => {
            stopActiveSensor();
            setActiveSensor(null);
            setRefreshSignal((s) => s + 1);
          }}
        />
      )}

      <OfflineIndicator />
    </div>
  );
}
