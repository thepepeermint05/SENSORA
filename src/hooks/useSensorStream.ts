import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl, isLocalToken, wsUrl } from '../lib/api';
import { localSaveReadings } from '../lib/localStore';
import { LiveSensorSample, PermissionState } from '../types/sensor';

interface WindowWithSensors extends Window {
  Accelerometer?: new (opts?: { frequency?: number }) => GenericSensorInstance;
  Gyroscope?: new (opts?: { frequency?: number }) => GenericSensorInstance;
  Magnetometer?: new (opts?: { frequency?: number }) => GenericSensorInstance;
  AbsoluteOrientationSensor?: new (opts?: { frequency?: number }) => GenericSensorInstance;
  AmbientLightSensor?: new (opts?: { frequency?: number }) => GenericSensorInstance;
  PressureSensor?: new (opts?: { frequency?: number }) => GenericSensorInstance;
  ProximitySensor?: new (opts?: { frequency?: number }) => GenericSensorInstance;
}

interface GenericSensorInstance extends EventTarget {
  x?: number;
  y?: number;
  z?: number;
  quaternion?: [number, number, number, number];
  illuminance?: number;
  pressure?: number;
  distance?: number;
  near?: boolean;
  start: () => void;
  stop: () => void;
}

interface DeviceMotionConstructor {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

interface NetworkInfoLike extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
}

export function useSensorStream(token: string | null) {
  const [wsConnected, setWsConnected] = useState(false);
  const [activeSample, setActiveSample] = useState<LiveSensorSample | null>(null);
  const [historyBuffer, setHistoryBuffer] = useState<LiveSensorSample[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const lastSavedAtRef = useRef<number>(0);
  const pendingQueueRef = useRef<Array<Record<string, unknown>>>([]);
  const stepStateRef = useRef<{ count: number; lastPeakAt: number; prevMag: number }>({
    count: 0,
    lastPeakAt: 0,
    prevMag: 9.81,
  });

  const deviceIdRef = useRef<string>(
    typeof navigator !== 'undefined'
      ? navigator.userAgent.includes('Android')
        ? 'android-handset'
        : 'web-client'
      : 'web-client'
  );

  // Connect WebSocket for real-time telemetry ingestion (server sessions only)
  useEffect(() => {
    if (!token || isLocalToken(token)) return;
    let closed = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(wsUrl(`/ws/telemetry?token=${encodeURIComponent(token)}`));
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        // Flush queued offline readings
        if (pendingQueueRef.current.length > 0) {
          const batch = pendingQueueRef.current.splice(0, 50);
          fetch(apiUrl('/api/sensors/readings'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ readings: batch }),
          }).catch(() => {
            pendingQueueRef.current.unshift(...batch);
          });
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as { type?: string };
          if (msg.type === 'reading:saved') {
            setSavedCount((c) => c + 1);
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (!closed) {
          reconnectTimer = window.setTimeout(connect, 2500);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [token]);

  const persistSample = useCallback(
    async (sample: LiveSensorSample) => {
      if (!token || sample.hardwareStatus !== 'streaming') return;
      const payload = {
        deviceId: deviceIdRef.current,
        sensorId: sample.sensorId,
        primaryValue: sample.primaryValue,
        unit: sample.unit,
        metrics: sample.metrics,
        recordedAt: sample.recordedAt,
      };

      if (isLocalToken(token)) {
        await localSaveReadings(token, [payload]);
        setSavedCount((c) => c + 1);
        return;
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'sensor:reading', payload }));
        return;
      }

      if (!navigator.onLine) {
        pendingQueueRef.current.push(payload);
        return;
      }

      try {
        const res = await fetch(apiUrl('/api/sensors/readings'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          setSavedCount((c) => c + 1);
        }
      } catch {
        pendingQueueRef.current.push(payload);
      }
    },
    [token]
  );

  const stopActiveSensor = useCallback(() => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    setCameraStream(null);
    setActiveSample(null);
    setHistoryBuffer([]);
  }, []);

  const requestHardwarePermission = useCallback(
    async (sensorId: string): Promise<PermissionState> => {
      try {
        if (sensorId === 'camera') {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false,
          });
          stream.getTracks().forEach((t) => t.stop());
          return 'granted';
        }

        if (sensorId === 'microphone') {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          stream.getTracks().forEach((t) => t.stop());
          return 'granted';
        }

        if (sensorId === 'geolocation') {
          await new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout: 10000,
            });
          });
          return 'granted';
        }

        if (
          sensorId === 'accelerometer' ||
          sensorId === 'gyroscope' ||
          sensorId === 'pedometer'
        ) {
          const dm = window.DeviceMotionEvent as unknown as DeviceMotionConstructor | undefined;
          if (dm && typeof dm.requestPermission === 'function') {
            const state = await dm.requestPermission();
            return state === 'granted' ? 'granted' : 'denied';
          }
          return 'granted';
        }

        if (sensorId === 'orientation' || sensorId === 'magnetometer') {
          const dor = window.DeviceOrientationEvent as unknown as DeviceMotionConstructor | undefined;
          if (dor && typeof dor.requestPermission === 'function') {
            const state = await dor.requestPermission();
            return state === 'granted' ? 'granted' : 'denied';
          }
          return 'granted';
        }

        if (sensorId === 'ambient_light' && navigator.permissions?.query) {
          try {
            const status = await navigator.permissions.query({
              name: 'ambient-light-sensor' as PermissionName,
            });
            if (status.state === 'denied') return 'denied';
          } catch {
            // Browser may not support ambient-light-sensor permission descriptor
          }
        }

        return 'granted';
      } catch {
        return 'denied';
      }
    },
    []
  );

  const startSensorStream = useCallback(
    async (
      sensorId: string,
      options: { autoSave: boolean; intervalMs: number; facingMode?: 'user' | 'environment' }
    ) => {
      stopActiveSensor();

      const pushSample = (sample: LiveSensorSample) => {
        setActiveSample(sample);
        setHistoryBuffer((prev) => [...prev.slice(-49), sample]);

        if (options.autoSave && sample.hardwareStatus === 'streaming') {
          const now = Date.now();
          if (now - lastSavedAtRef.current >= options.intervalMs) {
            lastSavedAtRef.current = now;
            void persistSample(sample);
          }
        }
      };

      const w = window as WindowWithSensors;

      // 1. Camera Optical Sensor (separate MediaStream)
      if (sensorId === 'camera') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: options.facingMode || 'environment',
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
          setCameraStream(stream);
          const track = stream.getVideoTracks()[0];
          const settings = track.getSettings();
          pushSample({
            sensorId: 'camera',
            primaryValue: null,
            unit: 'lum',
            metrics: {
              width: settings.width || 0,
              height: settings.height || 0,
              frameRate: settings.frameRate || 30,
              facingMode: options.facingMode || 'environment',
            },
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'streaming',
          });
          cleanupRef.current = () => {
            stream.getTracks().forEach((t) => t.stop());
          };
        } catch (err) {
          pushSample({
            sensorId: 'camera',
            primaryValue: null,
            unit: 'lum',
            metrics: {},
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'error',
            statusNote: err instanceof Error ? err.message : 'Camera access failed',
          });
        }
        return;
      }

      // 2. Microphone Acoustic Sensor
      if (sensorId === 'microphone') {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          const audioCtx = new AudioContext();
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);

          const timeData = new Uint8Array(analyser.fftSize);
          const freqData = new Uint8Array(analyser.frequencyBinCount);

          const timer = window.setInterval(() => {
            analyser.getByteTimeDomainData(timeData);
            analyser.getByteFrequencyData(freqData);
            let sumSq = 0;
            for (let i = 0; i < timeData.length; i++) {
              const norm = (timeData[i] - 128) / 128;
              sumSq += norm * norm;
            }
            const rms = Math.sqrt(sumSq / timeData.length);
            const dbfs = rms > 0.0001 ? Math.max(-96, Math.round(20 * Math.log10(rms) * 10) / 10) : -96;
            const estSpl = Math.round((dbfs + 96) * 10) / 10;

            let maxBin = 0;
            let maxAmp = 0;
            for (let i = 1; i < freqData.length; i++) {
              if (freqData[i] > maxAmp) {
                maxAmp = freqData[i];
                maxBin = i;
              }
            }
            const peakHz = Math.round((maxBin * audioCtx.sampleRate) / analyser.fftSize);

            pushSample({
              sensorId: 'microphone',
              primaryValue: dbfs,
              unit: 'dBFS',
              metrics: { dbfs, estSpl, peakHz },
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'streaming',
            });
          }, Math.max(200, options.intervalMs));

          cleanupRef.current = () => {
            window.clearInterval(timer);
            stream.getTracks().forEach((t) => t.stop());
            void audioCtx.close();
          };
        } catch (err) {
          pushSample({
            sensorId: 'microphone',
            primaryValue: null,
            unit: 'dBFS',
            metrics: {},
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'error',
            statusNote: err instanceof Error ? err.message : 'Microphone access denied',
          });
        }
        return;
      }

      // 3. GPS / Geolocation
      if (sensorId === 'geolocation') {
        if (!('geolocation' in navigator)) {
          pushSample({
            sensorId: 'geolocation',
            primaryValue: null,
            unit: 'm',
            metrics: {},
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'unavailable',
            statusNote: 'Geolocation API not supported in this browser.',
          });
          return;
        }
        const watchId = navigator.geolocation.watchPosition(
          (pos) => {
            pushSample({
              sensorId: 'geolocation',
              primaryValue: Math.round(pos.coords.accuracy * 10) / 10,
              unit: 'm',
              metrics: {
                latitude: Number(pos.coords.latitude.toFixed(6)),
                longitude: Number(pos.coords.longitude.toFixed(6)),
                altitude: pos.coords.altitude !== null ? Number(pos.coords.altitude.toFixed(1)) : null,
                speed: pos.coords.speed !== null ? Number(pos.coords.speed.toFixed(2)) : null,
                accuracy: Number(pos.coords.accuracy.toFixed(1)),
              },
              recordedAt: new Date(pos.timestamp).toISOString(),
              hardwareStatus: 'streaming',
            });
          },
          (err) => {
            pushSample({
              sensorId: 'geolocation',
              primaryValue: null,
              unit: 'm',
              metrics: {},
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'error',
              statusNote: err.message,
            });
          },
          { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
        );
        cleanupRef.current = () => navigator.geolocation.clearWatch(watchId);
        return;
      }

      // 4. Accelerometer & Pedometer (via Accelerometer Generic Sensor or DeviceMotionEvent)
      if (sensorId === 'accelerometer' || sensorId === 'pedometer') {
        let sensorObj: GenericSensorInstance | null = null;
        let receivedData = false;

        if (w.Accelerometer) {
          try {
            sensorObj = new w.Accelerometer({ frequency: 10 });
            sensorObj.addEventListener('error', () => {
              try {
                sensorObj?.stop();
              } catch {
                // ignore
              }
              sensorObj = null;
              window.addEventListener('devicemotion', handleMotion);
            });
            sensorObj.addEventListener('reading', () => {
              receivedData = true;
              const x = Number((sensorObj?.x ?? 0).toFixed(3));
              const y = Number((sensorObj?.y ?? 0).toFixed(3));
              const z = Number((sensorObj?.z ?? 0).toFixed(3));
              const mag = Number(Math.hypot(x, y, z).toFixed(3));

              if (sensorId === 'pedometer') {
                const now = Date.now();
                const delta = Math.abs(mag - stepStateRef.current.prevMag);
                stepStateRef.current.prevMag = mag;
                if (delta > 1.8 && now - stepStateRef.current.lastPeakAt > 320) {
                  stepStateRef.current.count += 1;
                  stepStateRef.current.lastPeakAt = now;
                }
                pushSample({
                  sensorId: 'pedometer',
                  primaryValue: stepStateRef.current.count,
                  unit: 'steps',
                  metrics: {
                    steps: stepStateRef.current.count,
                    deltaG: Number((delta / 9.81).toFixed(3)),
                    magnitude: mag,
                  },
                  recordedAt: new Date().toISOString(),
                  hardwareStatus: 'streaming',
                });
              } else {
                pushSample({
                  sensorId: 'accelerometer',
                  primaryValue: mag,
                  unit: 'm/s²',
                  metrics: { x, y, z, magnitude: mag },
                  recordedAt: new Date().toISOString(),
                  hardwareStatus: 'streaming',
                });
              }
            });
            sensorObj.start();
          } catch {
            sensorObj = null;
          }
        }

        const handleMotion = (e: DeviceMotionEvent) => {
          const acc = e.accelerationIncludingGravity || e.acceleration;
          if (!acc || (acc.x === null && acc.y === null && acc.z === null)) return;
          receivedData = true;
          const x = Number((acc.x ?? 0).toFixed(3));
          const y = Number((acc.y ?? 0).toFixed(3));
          const z = Number((acc.z ?? 0).toFixed(3));
          const mag = Number(Math.hypot(x, y, z).toFixed(3));

          if (sensorId === 'pedometer') {
            const now = Date.now();
            const delta = Math.abs(mag - stepStateRef.current.prevMag);
            stepStateRef.current.prevMag = mag;
            if (delta > 1.8 && now - stepStateRef.current.lastPeakAt > 320) {
              stepStateRef.current.count += 1;
              stepStateRef.current.lastPeakAt = now;
            }
            pushSample({
              sensorId: 'pedometer',
              primaryValue: stepStateRef.current.count,
              unit: 'steps',
              metrics: {
                steps: stepStateRef.current.count,
                deltaG: Number((delta / 9.81).toFixed(3)),
                magnitude: mag,
              },
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'streaming',
            });
          } else {
            pushSample({
              sensorId: 'accelerometer',
              primaryValue: mag,
              unit: 'm/s²',
              metrics: { x, y, z, magnitude: mag },
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'streaming',
            });
          }
        };

        if (!sensorObj) {
          window.addEventListener('devicemotion', handleMotion);
        }

        const checkTimer = window.setTimeout(() => {
          if (!receivedData) {
            pushSample({
              sensorId,
              primaryValue: null,
              unit: sensorId === 'pedometer' ? 'steps' : 'm/s²',
              metrics: {},
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'unavailable',
              statusNote:
                'Waiting for hardware accelerometer events. On desktop, open DevTools Sensors or test on an Android device / APK.',
            });
          }
        }, 1800);

        cleanupRef.current = () => {
          window.clearTimeout(checkTimer);
          try {
            sensorObj?.stop();
          } catch {
            // ignore
          }
          window.removeEventListener('devicemotion', handleMotion);
        };
        return;
      }

      // 5. Gyroscope
      if (sensorId === 'gyroscope') {
        let gyroObj: GenericSensorInstance | null = null;
        let received = false;

        if (w.Gyroscope) {
          try {
            gyroObj = new w.Gyroscope({ frequency: 10 });
            gyroObj.addEventListener('error', () => {
              try {
                gyroObj?.stop();
              } catch {
                // ignore
              }
              gyroObj = null;
              window.addEventListener('devicemotion', handleMotion);
            });
            gyroObj.addEventListener('reading', () => {
              received = true;
              const x = Number((((gyroObj?.x ?? 0) * 180) / Math.PI).toFixed(2));
              const y = Number((((gyroObj?.y ?? 0) * 180) / Math.PI).toFixed(2));
              const z = Number((((gyroObj?.z ?? 0) * 180) / Math.PI).toFixed(2));
              const mag = Number(Math.hypot(x, y, z).toFixed(2));
              pushSample({
                sensorId: 'gyroscope',
                primaryValue: mag,
                unit: 'deg/s',
                metrics: { alpha: z, beta: x, gamma: y, magnitude: mag },
                recordedAt: new Date().toISOString(),
                hardwareStatus: 'streaming',
              });
            });
            gyroObj.start();
          } catch {
            gyroObj = null;
          }
        }

        const handleMotion = (e: DeviceMotionEvent) => {
          const rot = e.rotationRate;
          if (!rot || (rot.alpha === null && rot.beta === null && rot.gamma === null)) return;
          received = true;
          const alpha = Number((rot.alpha ?? 0).toFixed(2));
          const beta = Number((rot.beta ?? 0).toFixed(2));
          const gamma = Number((rot.gamma ?? 0).toFixed(2));
          const mag = Number(Math.hypot(alpha, beta, gamma).toFixed(2));
          pushSample({
            sensorId: 'gyroscope',
            primaryValue: mag,
            unit: 'deg/s',
            metrics: { alpha, beta, gamma, magnitude: mag },
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'streaming',
          });
        };

        if (!gyroObj) window.addEventListener('devicemotion', handleMotion);
        const timer = window.setTimeout(() => {
          if (!received) {
            pushSample({
              sensorId: 'gyroscope',
              primaryValue: null,
              unit: 'deg/s',
              metrics: {},
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'unavailable',
              statusNote: 'No hardware gyroscope signal detected in this browser session.',
            });
          }
        }, 1800);

        cleanupRef.current = () => {
          window.clearTimeout(timer);
          try {
            gyroObj?.stop();
          } catch {
            // ignore
          }
          window.removeEventListener('devicemotion', handleMotion);
        };
        return;
      }

      // 6. Orientation & Magnetometer
      if (sensorId === 'orientation' || sensorId === 'magnetometer') {
        let magSensor: GenericSensorInstance | null = null;
        let received = false;

        if (sensorId === 'magnetometer' && w.Magnetometer) {
          try {
            magSensor = new w.Magnetometer({ frequency: 5 });
            magSensor.addEventListener('error', () => {
              try {
                magSensor?.stop();
              } catch {
                // ignore
              }
              magSensor = null;
              window.addEventListener('deviceorientation', handleOrient);
            });
            magSensor.addEventListener('reading', () => {
              received = true;
              const x = Number((magSensor?.x ?? 0).toFixed(2));
              const y = Number((magSensor?.y ?? 0).toFixed(2));
              const z = Number((magSensor?.z ?? 0).toFixed(2));
              const heading = Number((((Math.atan2(y, x) * 180) / Math.PI + 360) % 360).toFixed(1));
              pushSample({
                sensorId: 'magnetometer',
                primaryValue: heading,
                unit: '°',
                metrics: { heading, x, y, z, fluxUt: Number(Math.hypot(x, y, z).toFixed(2)) },
                recordedAt: new Date().toISOString(),
                hardwareStatus: 'streaming',
              });
            });
            magSensor.start();
          } catch {
            magSensor = null;
          }
        }

        const handleOrient = (e: DeviceOrientationEvent) => {
          if (e.alpha === null && e.beta === null && e.gamma === null) return;
          received = true;
          const alpha = Number((e.alpha ?? 0).toFixed(1));
          const beta = Number((e.beta ?? 0).toFixed(1));
          const gamma = Number((e.gamma ?? 0).toFixed(1));
          if (sensorId === 'magnetometer') {
            const compass = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
            const heading = Number((compass ?? (360 - alpha) % 360).toFixed(1));
            pushSample({
              sensorId: 'magnetometer',
              primaryValue: heading,
              unit: '°',
              metrics: { heading, alpha, beta, gamma },
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'streaming',
            });
          } else {
            pushSample({
              sensorId: 'orientation',
              primaryValue: beta,
              unit: '°',
              metrics: { yaw: alpha, pitch: beta, roll: gamma },
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'streaming',
            });
          }
        };

        if (!magSensor) window.addEventListener('deviceorientation', handleOrient);
        const timer = window.setTimeout(() => {
          if (!received) {
            pushSample({
              sensorId,
              primaryValue: null,
              unit: '°',
              metrics: {},
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'unavailable',
              statusNote: 'Hardware orientation/magnetometer stream unavailable on this host.',
            });
          }
        }, 1800);

        cleanupRef.current = () => {
          window.clearTimeout(timer);
          try {
            magSensor?.stop();
          } catch {
            // ignore
          }
          window.removeEventListener('deviceorientation', handleOrient);
        };
        return;
      }

      // 7. Ambient Light / Barometer / Proximity (Generic Sensor API)
      if (sensorId === 'ambient_light' || sensorId === 'barometer' || sensorId === 'proximity') {
        const Ctor =
          sensorId === 'ambient_light'
            ? w.AmbientLightSensor
            : sensorId === 'barometer'
              ? w.PressureSensor
              : w.ProximitySensor;

        const unit = sensorId === 'ambient_light' ? 'lx' : sensorId === 'barometer' ? 'hPa' : 'cm';

        if (!Ctor) {
          pushSample({
            sensorId,
            primaryValue: null,
            unit,
            metrics: {},
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'unavailable',
            statusNote:
              'W3C Generic Sensor API for this chip requires Android Chrome flags or the compiled Capacitor Android APK.',
          });
          return;
        }

        try {
          const instance = new Ctor({ frequency: 2 });
          let received = false;
          instance.addEventListener('error', () => {
            pushSample({
              sensorId,
              primaryValue: null,
              unit,
              metrics: {},
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'unavailable',
              statusNote:
                'Hardware sensor permission or W3C Generic Sensor API was blocked by this WebView/browser.',
            });
          });
          instance.addEventListener('reading', () => {
            received = true;
            const val =
              sensorId === 'ambient_light'
                ? instance.illuminance ?? 0
                : sensorId === 'barometer'
                  ? instance.pressure ?? 0
                  : instance.distance ?? 0;
            pushSample({
              sensorId,
              primaryValue: Number(val.toFixed(2)),
              unit,
              metrics:
                sensorId === 'proximity'
                  ? { distanceCm: val, near: Boolean(instance.near) }
                  : sensorId === 'barometer'
                    ? {
                        pressureHpa: val,
                        estAltitudeM: Number((44330 * (1 - Math.pow(val / 1013.25, 0.1903))).toFixed(1)),
                      }
                    : { illuminanceLx: val },
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'streaming',
            });
          });
          instance.start();
          const timer = window.setTimeout(() => {
            if (!received) {
              pushSample({
                sensorId,
                primaryValue: null,
                unit,
                metrics: {},
                recordedAt: new Date().toISOString(),
                hardwareStatus: 'unavailable',
                statusNote: 'No hardware events received from this sensor on the current host.',
              });
            }
          }, 2200);
          cleanupRef.current = () => {
            window.clearTimeout(timer);
            try {
              instance.stop();
            } catch {
              // ignore
            }
          };
        } catch (err) {
          pushSample({
            sensorId,
            primaryValue: null,
            unit,
            metrics: {},
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'unavailable',
            statusNote: err instanceof Error ? err.message : 'Sensor hardware unavailable.',
          });
        }
        return;
      }

      // 8. Battery Status API
      if (sensorId === 'battery') {
        const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
        if (!nav.getBattery) {
          pushSample({
            sensorId: 'battery',
            primaryValue: null,
            unit: '%',
            metrics: {},
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'unavailable',
            statusNote: 'Battery Status API is not exposed by this browser.',
          });
          return;
        }
        try {
          const battery = await nav.getBattery();
          const emit = () => {
            const pct = Math.round(battery.level * 100);
            pushSample({
              sensorId: 'battery',
              primaryValue: pct,
              unit: '%',
              metrics: {
                levelPct: pct,
                charging: battery.charging,
                chargingTimeSec: Number.isFinite(battery.chargingTime) ? battery.chargingTime : null,
                dischargingTimeSec: Number.isFinite(battery.dischargingTime) ? battery.dischargingTime : null,
              },
              recordedAt: new Date().toISOString(),
              hardwareStatus: 'streaming',
            });
          };
          emit();
          const timer = window.setInterval(emit, Math.max(2000, options.intervalMs));
          battery.addEventListener('levelchange', emit);
          battery.addEventListener('chargingchange', emit);
          cleanupRef.current = () => {
            window.clearInterval(timer);
            battery.removeEventListener('levelchange', emit);
            battery.removeEventListener('chargingchange', emit);
          };
        } catch {
          pushSample({
            sensorId: 'battery',
            primaryValue: null,
            unit: '%',
            metrics: {},
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'unavailable',
            statusNote: 'Unable to query system battery controller.',
          });
        }
        return;
      }

      // 9. RF & Network Information API
      if (sensorId === 'network') {
        const nav = navigator as Navigator & { connection?: NetworkInfoLike };
        const conn = nav.connection;
        if (!conn) {
          pushSample({
            sensorId: 'network',
            primaryValue: null,
            unit: 'Mbps',
            metrics: { online: navigator.onLine },
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'unavailable',
            statusNote: 'Network Information API is unavailable in this browser.',
          });
          return;
        }
        const emit = () => {
          const downlink = conn.downlink ?? 0;
          pushSample({
            sensorId: 'network',
            primaryValue: downlink,
            unit: 'Mbps',
            metrics: {
              downlinkMbps: downlink,
              rttMs: conn.rtt ?? 0,
              effectiveType: conn.effectiveType || 'unknown',
              saveData: Boolean(conn.saveData),
            },
            recordedAt: new Date().toISOString(),
            hardwareStatus: 'streaming',
          });
        };
        emit();
        const timer = window.setInterval(emit, Math.max(2000, options.intervalMs));
        conn.addEventListener('change', emit);
        cleanupRef.current = () => {
          window.clearInterval(timer);
          conn.removeEventListener('change', emit);
        };
        return;
      }

      // 10. Touch Digitizer & Pressure (interactive pointer pad)
      if (sensorId === 'touch_pressure') {
        pushSample({
          sensorId: 'touch_pressure',
          primaryValue: 0,
          unit: 'force',
          metrics: { pressure: 0, widthPx: 0, heightPx: 0, tiltX: 0, tiltY: 0, pointerType: 'waiting' },
          recordedAt: new Date().toISOString(),
          hardwareStatus: 'ready',
          statusNote: 'Touch or press the interactive digitizer surface below to stream contact telemetry.',
        });
        cleanupRef.current = () => {};
      }
    },
    [persistSample, stopActiveSensor]
  );

  const emitTouchSample = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, autoSave: boolean) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pressure = Number((e.pressure || (e.buttons > 0 ? 0.5 : 0)).toFixed(3));
      const sample: LiveSensorSample = {
        sensorId: 'touch_pressure',
        primaryValue: pressure,
        unit: 'force',
        metrics: {
          pressure,
          widthPx: Number(e.width.toFixed(1)),
          heightPx: Number(e.height.toFixed(1)),
          tiltX: e.tiltX,
          tiltY: e.tiltY,
          relX: Number(((e.clientX - rect.left) / rect.width).toFixed(3)),
          relY: Number(((e.clientY - rect.top) / rect.height).toFixed(3)),
          pointerType: e.pointerType,
        },
        recordedAt: new Date().toISOString(),
        hardwareStatus: 'streaming',
      };
      setActiveSample(sample);
      setHistoryBuffer((prev) => [...prev.slice(-49), sample]);
      if (autoSave) {
        const now = Date.now();
        if (now - lastSavedAtRef.current >= 400) {
          lastSavedAtRef.current = now;
          void persistSample(sample);
        }
      }
    },
    [persistSample]
  );

  return {
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
  };
}
