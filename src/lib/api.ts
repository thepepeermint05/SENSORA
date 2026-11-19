const DEFAULT_CLOUD_SERVER =
  import.meta.env.VITE_API_BASE_URL || '';

const memoryStore = new Map<string, string>();

export const safeStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return memoryStore.get(key) ?? null;
    }
  },
  setItem(key: string, value: string): void {
    memoryStore.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Fallback to in-memory store when storage is partitioned
    }
  },
  removeItem(key: string): void {
    memoryStore.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

export function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform?.()) return true;
  const proto = window.location.protocol;
  const host = window.location.hostname;
  const port = window.location.port;
  return (
    proto === 'capacitor:' ||
    proto === 'file:' ||
    (host === 'localhost' && (!port || port === '80' || port === '443'))
  );
}

export function getApiBaseUrl(): string {
  const override = safeStorage.getItem('sensora_api_base');
  if (override && override.startsWith('http')) {
    return override.replace(/\/$/, '');
  }
  if (isCapacitorNative() && DEFAULT_CLOUD_SERVER) {
    return DEFAULT_CLOUD_SERVER.replace(/\/$/, '');
  }
  return '';
}

export function setApiBaseUrl(url: string): void {
  const clean = url.trim().replace(/\/$/, '');
  if (clean && clean.startsWith('http')) {
    safeStorage.setItem('sensora_api_base', clean);
  } else {
    safeStorage.removeItem('sensora_api_base');
  }
}

export async function isRemoteServerAvailable(): Promise<boolean> {
  if (!isCapacitorNative()) return true;
  const base = getApiBaseUrl();
  if (!base) return false;
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${base}/api/health`, { signal: controller.signal });
    window.clearTimeout(timer);
    if (!res.ok) return false;
    const json = (await res.json()) as { ok?: boolean; service?: string };
    return Boolean(json.ok && json.service === 'sensora');
  } catch {
    return false;
  }
}

export function isLocalToken(token: string | null): boolean {
  return Boolean(token && token.startsWith('local_'));
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function wsUrl(path: string): string {
  const base = getApiBaseUrl();
  if (base) {
    const parsed = new URL(base);
    const proto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${parsed.host}${path}`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

export async function parseApiResponse<T = Record<string, unknown>>(
  res: Response
): Promise<{ data: T | null; rawText: string }> {
  const rawText = await res.text();
  try {
    return { data: JSON.parse(rawText) as T, rawText };
  } catch {
    return { data: null, rawText };
  }
}
