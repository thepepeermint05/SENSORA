import React, { useEffect, useState } from 'react';
import { Check, Copy, GitBranch, Package, Smartphone } from 'lucide-react';
import { DeploymentConfig } from '../types/sensor';
import { PWAInstallButton } from './PWAInstallButton';

interface DeploymentViewProps {
  token: string;
}

export const DeploymentView: React.FC<DeploymentViewProps> = ({ token }) => {
  const [config, setConfig] = useState<DeploymentConfig>({
    repoOwner: '',
    repoName: '',
    branch: 'main',
    packageId: 'com.sensora.telemetry',
    updatedAt: null,
  });
  const [workflowYaml, setWorkflowYaml] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/deployment/config', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data: { config?: DeploymentConfig; workflowYaml?: string }) => {
        if (data.config) setConfig(data.config);
        if (data.workflowYaml) setWorkflowYaml(data.workflowYaml);
      })
      .catch(() => {});
  }, [token]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedMsg(null);
    try {
      const res = await fetch('/api/deployment/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        const data = (await res.json()) as { config: DeploymentConfig };
        setConfig(data.config);
        setSavedMsg('Repository deployment configuration saved.');
      }
    } finally {
      setSaving(false);
    }
  };

  const copyText = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1800);
  };

  const repoSlug =
    config.repoOwner && config.repoName
      ? `${config.repoOwner}/${config.repoName}`
      : 'YOUR_GITHUB_USER/sensora-android';

  const gitCommands = `git init
git add .
git commit -m "Initialize Sensora Android sensor suite with Capacitor APK workflow"
git branch -M ${config.branch || 'main'}
git remote add origin https://github.com/${repoSlug}.git
git push -u origin ${config.branch || 'main'}`;

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-200 pb-6">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Android APK &amp; GitHub Deployment
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Install immediately on Android as a standalone PWA, or push to GitHub to automatically
          compile a signed Capacitor Android <code className="font-mono text-slate-900">.apk</code>{' '}
          via GitHub Actions.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Direct Android PWA Install Card */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 lg:col-span-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-700">
              <Smartphone className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">Instant Android Web App</h2>
              <p className="text-xs text-slate-500">Standalone installable PWA</p>
            </div>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-slate-600">
            Sensora ships with a configured Web App Manifest and Service Worker so Android Chrome
            can install it directly to your home screen with hardware sensor access.
          </p>

          <div className="mt-5 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div>
              <p className="text-xs font-semibold text-slate-900">Package Mode</p>
              <p className="font-mono text-xs text-slate-500">display: standalone</p>
            </div>
            <PWAInstallButton variant="card" />
          </div>

          <div className="mt-6 border-t border-slate-200 pt-5">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
              <Package className="h-4 w-4 text-sky-600" />
              <span>Included Native Android Artifacts</span>
            </div>
            <ul className="mt-3 space-y-2 font-mono text-xs text-slate-600">
              <li>capacitor.config.json ({config.packageId})</li>
              <li>android-native/AndroidManifest.permissions.xml</li>
              <li>.github/workflows/android-apk.yml</li>
            </ul>
          </div>
        </section>

        {/* GitHub Repository Connection Form */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 lg:col-span-7">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-800">
              <GitBranch className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                GitHub Repository &amp; APK CI Pipeline
              </h2>
              <p className="text-xs text-slate-500">
                Connect your repository to manage pushes and download Gradle APK artifacts
              </p>
            </div>
          </div>

          <form onSubmit={handleSave} className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="gh-owner" className="block text-xs font-medium text-slate-700">
                GitHub Username / Org
              </label>
              <input
                id="gh-owner"
                type="text"
                value={config.repoOwner}
                onChange={(e) => setConfig((c) => ({ ...c, repoOwner: e.target.value }))}
                placeholder="octocat"
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
              />
            </div>

            <div>
              <label htmlFor="gh-repo" className="block text-xs font-medium text-slate-700">
                Repository Name
              </label>
              <input
                id="gh-repo"
                type="text"
                value={config.repoName}
                onChange={(e) => setConfig((c) => ({ ...c, repoName: e.target.value }))}
                placeholder="sensora-android"
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
              />
            </div>

            <div>
              <label htmlFor="gh-branch" className="block text-xs font-medium text-slate-700">
                Deployment Branch
              </label>
              <input
                id="gh-branch"
                type="text"
                value={config.branch}
                onChange={(e) => setConfig((c) => ({ ...c, branch: e.target.value }))}
                placeholder="main"
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
              />
            </div>

            <div>
              <label htmlFor="apk-pkg" className="block text-xs font-medium text-slate-700">
                Android Application ID
              </label>
              <input
                id="apk-pkg"
                type="text"
                value={config.packageId}
                onChange={(e) => setConfig((c) => ({ ...c, packageId: e.target.value }))}
                placeholder="com.sensora.telemetry"
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 font-mono text-sm text-slate-900 outline-none focus:border-sky-600 focus:bg-white"
              />
            </div>

            <div className="flex items-center justify-between gap-3 sm:col-span-2">
              {savedMsg ? (
                <span className="text-xs font-medium text-emerald-700">{savedMsg}</span>
              ) : (
                <span className="text-xs text-slate-500">
                  Target: github.com/{repoSlug}
                </span>
              )}
              <button
                type="submit"
                disabled={saving}
                className="min-h-[44px] rounded-xl bg-slate-900 px-5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {saving ? 'Saving...' : 'Save Repository Config'}
              </button>
            </div>
          </form>

          {/* Push Commands */}
          <div className="mt-6 border-t border-slate-200 pt-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-800">
                1. Push Project to Trigger Automated APK Build
              </p>
              <button
                type="button"
                onClick={() => copyText('git', gitCommands)}
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                {copiedKey === 'git' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedKey === 'git' ? 'Copied' : 'Copy Commands'}
              </button>
            </div>
            <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100">
              {gitCommands}
            </pre>
            <p className="mt-2 text-xs text-slate-500">
              2. After pushing, open <strong>Actions &rarr; Build Android APK</strong> in your GitHub
              repository to download <code className="font-mono text-slate-800">sensora-android-apk</code>{' '}
              (<code className="font-mono text-slate-800">app-debug.apk</code>).
            </p>
          </div>
        </section>
      </div>

      {/* Workflow YAML Inspection */}
      {workflowYaml && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Included GitHub Actions APK Workflow (.github/workflows/android-apk.yml)
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Automatically installs Capacitor Android, injects all sensor permissions, and builds
                the APK with Gradle.
              </p>
            </div>
            <button
              type="button"
              onClick={() => copyText('yaml', workflowYaml)}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              {copiedKey === 'yaml' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedKey === 'yaml' ? 'Copied' : 'Copy YAML'}
            </button>
          </div>
          <pre className="mt-4 max-h-72 overflow-auto rounded-xl bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200">
            {workflowYaml}
          </pre>
        </section>
      )}
    </div>
  );
};
