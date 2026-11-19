export interface AuthUser {
  id: string;
  username: string;
  email: string;
  displayName: string;
  authProvider: string;
  avatarUrl: string | null;
  createdAt: string;
}

export type PermissionState = 'prompt' | 'granted' | 'denied';

export type SensorCategory =
  | 'motion'
  | 'position'
  | 'optical'
  | 'acoustic'
  | 'environment'
  | 'device';

export type StorageTarget = 'telemetry_db' | 'camera_vault';

export interface SensorDefinition {
  id: string;
  name: string;
  category: SensorCategory;
  unit: string;
  androidPermission: string;
  webApi: string;
  storageTarget: StorageTarget;
  description: string;
  axesLabels: string[];
}

export interface LiveSensorSample {
  sensorId: string;
  primaryValue: number | null;
  unit: string;
  metrics: Record<string, string | number | boolean | null>;
  recordedAt: string;
  hardwareStatus: 'streaming' | 'ready' | 'unavailable' | 'error';
  statusNote?: string;
}

export interface StoredSensorReading {
  id: number;
  deviceId: string;
  sensorId: string;
  primaryValue: number | null;
  unit: string;
  metrics: Record<string, string | number | boolean | null>;
  recordedAt: string;
}

export interface CameraCaptureRecord {
  id: string;
  deviceId: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  width: number;
  height: number;
  facingMode: string;
  meanLuminance: number;
  dominantRgb: string;
  fpsEstimate: number | null;
  capturedAt: string;
}

export interface SensorStats {
  count: number;
  minVal: number | null;
  maxVal: number | null;
  avgVal: number | null;
}

export interface DeploymentConfig {
  repoOwner: string;
  repoName: string;
  branch: string;
  packageId: string;
  updatedAt: string | null;
}
