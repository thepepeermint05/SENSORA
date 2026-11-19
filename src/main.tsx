import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { isCapacitorNative } from './lib/api.ts';
import './index.css';

interface ErrorBoundaryState {
  error: Error | null;
}

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-900">
          <div className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
            <h1 className="text-base font-bold text-slate-900">Sensora Startup Error</h1>
            <p className="mt-2 text-xs leading-relaxed text-rose-700">
              {this.state.error.message || 'An unexpected rendering error occurred.'}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 min-h-[40px] rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  if (isCapacitorNative()) {
    // Ensure Capacitor APK WebView never serves stale cached Workbox bundles across APK updates
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((reg) => void reg.unregister());
    }).catch(() => {});
    if ('caches' in window) {
      caches.keys().then((keys) => {
        keys.forEach((k) => void caches.delete(k));
      }).catch(() => {});
    }
  } else if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    });
  }
}

createRoot(document.getElementById('root')!).render(
  <RootErrorBoundary>
    <App />
  </RootErrorBoundary>
);
