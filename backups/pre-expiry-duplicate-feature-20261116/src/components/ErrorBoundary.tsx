import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { getReadableFirestoreError } from '../utils/firestoreError';

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      const friendlyMessage = getReadableFirestoreError(this.state.error);
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-3 text-red-700">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h1 className="text-lg font-semibold text-slate-900">Terjadi Gangguan Aplikasi</h1>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">{friendlyMessage}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 transition-colors cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Muat Ulang Halaman</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
