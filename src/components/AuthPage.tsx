import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Lock, Mail, ShieldCheck, User } from 'lucide-react';
import { AuthUser } from '../types/sensor';

type AuthMode = 'login' | 'register' | 'forgot';
type ForgotStep = 'email' | 'verify' | 'done';

interface AuthPageProps {
  onAuthenticated: (token: string, user: AuthUser) => void;
}

export const AuthPage: React.FC<AuthPageProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [forgotStep, setForgotStep] = useState<ForgotStep>('email');

  // Login / Register fields
  const [identifier, setIdentifier] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Forgot Password fields
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [previewCode, setPreviewCode] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  // Status & Google OAuth
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [googleStatus, setGoogleStatus] = useState<{ configured: boolean; callbackUrl: string } | null>(
    null
  );
  const [showGoogleConfigNote, setShowGoogleConfigNote] = useState(false);

  useEffect(() => {
    fetch('/api/auth/google/status')
      .then((r) => r.json())
      .then((data) => setGoogleStatus(data))
      .catch(() => {});

    const onMessage = async (event: MessageEvent) => {
      if (event.data?.type === 'GOOGLE_OAUTH_SUCCESS' && typeof event.data.token === 'string') {
        const token = event.data.token;
        try {
          const res = await fetch('/api/auth/me', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.ok) {
            const { user } = (await res.json()) as { user: AuthUser };
            onAuthenticated(token, user);
          }
        } catch {
          setError('Failed to verify Google session.');
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onAuthenticated]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Sign in failed.');
        return;
      }
      onAuthenticated(data.token, data.user);
    } catch {
      setError('Network error while signing in.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, displayName, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Registration failed.');
        return;
      }
      onAuthenticated(data.token, data.user);
    } catch {
      setError('Network error while creating account.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not initiate password reset.');
        return;
      }
      setPreviewCode(data.previewCode || null);
      setInfo(data.message);
      setForgotStep('verify');
    } catch {
      setError('Network error while requesting recovery code.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: resetEmail,
          code: resetCode,
          newPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Password reset failed.');
        return;
      }
      setForgotStep('done');
      setInfo(data.message);
      setPreviewCode(null);
    } catch {
      setError('Network error while resetting password.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    try {
      const res = await fetch('/api/auth/google/url');
      const data = await res.json();
      if (!res.ok) {
        setShowGoogleConfigNote(true);
        setError(data.error || 'Google Sign-In requires OAuth client configuration.');
        return;
      }
      const popup = window.open(data.url, 'sensora_google_oauth', 'width=540,height=660');
      if (!popup) {
        setError('Popup was blocked by your browser. Please allow popups to sign in with Google.');
      }
    } catch {
      setError('Unable to reach Google OAuth endpoint.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto grid min-h-screen max-w-6xl grid-cols-1 items-stretch lg:grid-cols-12">
        {/* Left Telemetry Summary Column */}
        <div className="flex flex-col justify-between border-b border-slate-200 bg-white px-6 py-10 lg:col-span-6 lg:border-r lg:border-b-0 lg:px-12 lg:py-16">
          <div>
            <div className="flex items-center gap-3">
              <img
                src="/icon.svg"
                alt="Sensora mark"
                className="h-9 w-9 rounded-xl"
                referrerPolicy="no-referrer"
              />
              <span className="text-xl font-bold tracking-tight text-slate-900">Sensora</span>
            </div>

            <h1 className="mt-10 max-w-md text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl [text-wrap:balance]">
              Hardware sensor telemetry with real-time cloud persistence.
            </h1>
            <p className="mt-4 max-w-md text-base leading-relaxed text-slate-600">
              Permission-gated access to all 14 Android device sensors, isolated optical camera media
              storage, and historical time-series analytics.
            </p>
          </div>

          <div className="mt-10 grid grid-cols-2 gap-6 border-t border-slate-200 pt-8">
            <div>
              <p className="text-xs font-medium text-slate-500">Hardware Matrix</p>
              <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">14</p>
              <p className="mt-1 text-xs text-slate-500">Motion · GNSS · Optical · RF</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500">Storage Separation</p>
              <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">2-Tier</p>
              <p className="mt-1 text-xs text-slate-500">SQLite Telemetry · Media Vault</p>
            </div>
          </div>
        </div>

        {/* Right Authentication Form Column */}
        <div className="flex flex-col justify-center px-6 py-10 sm:px-10 lg:col-span-6 lg:px-14">
          <div className="mx-auto w-full max-w-md">
            <div className="mb-6 flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                  setInfo(null);
                }}
                className={`flex-1 min-h-[40px] rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'login'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError(null);
                  setInfo(null);
                }}
                className={`flex-1 min-h-[40px] rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'register'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Create Account
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('forgot');
                  setForgotStep('email');
                  setError(null);
                  setInfo(null);
                }}
                className={`flex-1 min-h-[40px] rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'forgot'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Reset Password
              </button>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
              {error && (
                <div
                  role="alert"
                  className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-medium text-rose-800"
                >
                  {error}
                </div>
              )}

              {info && (
                <div
                  role="status"
                  className="mb-5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs font-medium text-sky-900"
                >
                  {info}
                </div>
              )}

              {mode === 'login' && (
                <form onSubmit={handleLogin} className="space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">Sign in to Sensora</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      Access your live device telemetry and cloud sensor archive.
                    </p>
                  </div>

                  <div>
                    <label htmlFor="login-identifier" className="block text-xs font-medium text-slate-700">
                      Username or Email
                    </label>
                    <div className="relative mt-1.5">
                      <User className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        id="login-identifier"
                        type="text"
                        required
                        autoComplete="username"
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        placeholder="engineer_01 or name@domain.com"
                        className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pr-4 pl-10 text-sm text-slate-900 outline-none transition focus:border-sky-600 focus:bg-white"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between">
                      <label htmlFor="login-password" className="block text-xs font-medium text-slate-700">
                        Password
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setMode('forgot');
                          setForgotStep('email');
                          setError(null);
                        }}
                        className="text-xs font-medium text-sky-700 hover:underline"
                      >
                        Forgot password?
                      </button>
                    </div>
                    <div className="relative mt-1.5">
                      <Lock className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        id="login-password"
                        type={showPassword ? 'text' : 'password'}
                        required
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter password"
                        className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pr-11 pl-10 text-sm text-slate-900 outline-none transition focus:border-sky-600 focus:bg-white"
                      />
                      <button
                        type="button"
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        onClick={() => setShowPassword((s) => !s)}
                        className="absolute top-1/2 right-2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-500 hover:text-slate-800"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="min-h-[44px] w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-60"
                  >
                    {loading ? 'Signing in...' : 'Sign In'}
                  </button>
                </form>
              )}

              {mode === 'register' && (
                <form onSubmit={handleRegister} className="space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">Create operator account</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      Passwords are salted and hashed with scrypt before persistence.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="reg-username" className="block text-xs font-medium text-slate-700">
                        Username
                      </label>
                      <input
                        id="reg-username"
                        type="text"
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="alex_sensors"
                        className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
                      />
                    </div>
                    <div>
                      <label htmlFor="reg-display" className="block text-xs font-medium text-slate-700">
                        Display Name
                      </label>
                      <input
                        id="reg-display"
                        type="text"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Alex Rivera"
                        className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="reg-email" className="block text-xs font-medium text-slate-700">
                      Email Address
                    </label>
                    <div className="relative mt-1.5">
                      <Mail className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        id="reg-email"
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pr-4 pl-10 text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="reg-password" className="block text-xs font-medium text-slate-700">
                      Password (min 8 characters)
                    </label>
                    <div className="relative mt-1.5">
                      <Lock className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        id="reg-password"
                        type={showPassword ? 'text' : 'password'}
                        required
                        minLength={8}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Minimum 8 characters"
                        className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pr-11 pl-10 text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((s) => !s)}
                        className="absolute top-1/2 right-2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-500"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="min-h-[44px] w-full rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-60"
                  >
                    {loading ? 'Creating account...' : 'Create Account'}
                  </button>
                </form>
              )}

              {mode === 'forgot' && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">Recover account password</h2>
                    <p className="mt-1 text-xs text-slate-500">
                      Generate a single-use 6-digit recovery code to reset your credentials.
                    </p>
                  </div>

                  {forgotStep === 'email' && (
                    <form onSubmit={handleForgotEmail} className="space-y-4">
                      <div>
                        <label htmlFor="reset-email" className="block text-xs font-medium text-slate-700">
                          Registered Email Address
                        </label>
                        <div className="relative mt-1.5">
                          <Mail className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
                          <input
                            id="reset-email"
                            type="email"
                            required
                            value={resetEmail}
                            onChange={(e) => setResetEmail(e.target.value)}
                            placeholder="you@example.com"
                            className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pr-4 pl-10 text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
                          />
                        </div>
                      </div>
                      <button
                        type="submit"
                        disabled={loading}
                        className="min-h-[44px] w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                      >
                        {loading ? 'Generating code...' : 'Send Verification Code'}
                      </button>
                    </form>
                  )}

                  {forgotStep === 'verify' && (
                    <form onSubmit={handleResetPassword} className="space-y-4">
                      {previewCode && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                          <span>Recovery code: </span>
                          <span className="font-mono font-semibold text-slate-900 tabular-nums">
                            {previewCode}
                          </span>
                        </div>
                      )}
                      <div>
                        <label htmlFor="reset-code" className="block text-xs font-medium text-slate-700">
                          6-Digit Verification Code
                        </label>
                        <div className="relative mt-1.5">
                          <KeyRound className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-400" />
                          <input
                            id="reset-code"
                            type="text"
                            required
                            pattern="\d{6}"
                            value={resetCode}
                            onChange={(e) => setResetCode(e.target.value)}
                            placeholder="123456"
                            className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pr-4 pl-10 font-mono text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
                          />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="reset-new-pw" className="block text-xs font-medium text-slate-700">
                          New Password
                        </label>
                        <input
                          id="reset-new-pw"
                          type="password"
                          required
                          minLength={8}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="Minimum 8 characters"
                          className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={loading}
                        className="min-h-[44px] w-full rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
                      >
                        {loading ? 'Updating password...' : 'Update Password'}
                      </button>
                    </form>
                  )}

                  {forgotStep === 'done' && (
                    <button
                      type="button"
                      onClick={() => {
                        setMode('login');
                        setInfo(null);
                      }}
                      className="min-h-[44px] w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      Return to Sign In
                    </button>
                  )}
                </div>
              )}

              {/* Divider + Google Sign-In */}
              <div className="my-6 flex items-center gap-3">
                <div className="h-px flex-1 bg-slate-200" />
                <span className="text-xs text-slate-400">or continue with</span>
                <div className="h-px flex-1 bg-slate-200" />
              </div>

              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="flex min-h-[44px] w-full items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
                  />
                </svg>
                Sign in with Google
              </button>

              {showGoogleConfigNote && googleStatus && !googleStatus.configured && (
                <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                  <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                    <ShieldCheck className="h-3.5 w-3.5 text-sky-600" />
                    <span>Google OAuth Setup Required</span>
                  </div>
                  <p className="mt-1">
                    Set <code className="font-mono text-slate-800">GOOGLE_CLIENT_ID</code> and{' '}
                    <code className="font-mono text-slate-800">GOOGLE_CLIENT_SECRET</code> in environment secrets,
                    and register this authorized redirect URI:
                  </p>
                  <p className="mt-1 break-all rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-800 border border-slate-200">
                    {googleStatus.callbackUrl}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
