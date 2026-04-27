/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import JSZip from 'jszip';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Download, 
  Upload, 
  FileArchive, 
  CheckCircle, 
  AlertCircle, 
  Loader2, 
  LogOut, 
  ExternalLink,
  ShieldCheck,
  Video
} from 'lucide-react';

// Google Drive API Scopes
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

// Types
declare const google: any;

interface Status {
  type: 'idle' | 'loading' | 'success' | 'error';
  message: string;
}

export default function App() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [manualClientId, setManualClientId] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [status, setStatus] = useState<Status>({ type: 'idle', message: '' });
  const [progress, setProgress] = useState(0);
  const [isClientLoaded, setIsClientLoaded] = useState(false);
  const tokenClientRef = useRef<any>(null);

  const envClientId = (import.meta as any).env.VITE_GOOGLE_CLIENT_ID;
  const CLIENT_ID = manualClientId || envClientId;

  const saveManualId = () => {
    if (manualClientId) {
      setStatus({ type: 'success', message: 'Client ID saved for this session!' });
      setTimeout(() => setStatus({ type: 'idle', message: '' }), 2000);
    }
  };

  useEffect(() => {
    // Check if Google script is loaded
    const checkGoogle = setInterval(() => {
      if (typeof google !== 'undefined') {
        setIsClientLoaded(true);
        clearInterval(checkGoogle);
      }
    }, 500);

    // Initial backend health check
    axios.get('/api/health')
      .then(res => console.log('Backend status:', res.data))
      .catch(err => console.error('Backend unreachable:', err));

    return () => clearInterval(checkGoogle);
  }, []);

  const handleLogin = () => {
    if (!CLIENT_ID) {
      setStatus({ 
        type: 'error', 
        message: 'Please configure VITE_GOOGLE_CLIENT_ID in the box below.' 
      });
      return;
    }

    try {
      if (!tokenClientRef.current) {
        tokenClientRef.current = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPES,
          callback: (response: any) => {
            if (response.access_token) {
              setAccessToken(response.access_token);
              setStatus({ type: 'success', message: 'Connected to Google Drive!' });
              setTimeout(() => setStatus({ type: 'idle', message: '' }), 3000);
            } else {
              setStatus({ type: 'error', message: 'Failed to get access token from Google.' });
            }
          },
        });
      }
      tokenClientRef.current.requestAccessToken();
    } catch (error) {
      console.error(error);
      setStatus({ type: 'error', message: 'Failed to initialize Google Login.' });
    }
  };

  const handleLogout = () => {
    setAccessToken(null);
    setStatus({ type: 'idle', message: 'Logged out successfully.' });
  };

  const processVideo = async () => {
    if (!videoUrl) {
      setStatus({ type: 'error', message: 'Please enter a video URL.' });
      return;
    }

    if (!accessToken) {
      setStatus({ type: 'error', message: 'Please connect your Google Drive first.' });
      return;
    }

    try {
      setStatus({ type: 'loading', message: 'Task submitted. Initiating server-side processing...' });
      setProgress(5);

      // Using a long timeout for the server-side process
      const startRes = await axios.post('/api/process-video', {
        videoUrl,
        accessToken,
      });

      if (!startRes.data.success || !startRes.data.jobId) {
        throw new Error('Failed to start processing job.');
      }

      const jobId = startRes.data.jobId;
      console.log('Started job:', jobId);

      // Start polling
      let retryCount = 0;
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await axios.get(`/api/job-status/${jobId}`);
          const job = statusRes.data;
          retryCount = 0; // Reset on success

          if (job.status === 'success') {
            clearInterval(pollInterval);
            setStatus({ type: 'success', message: `Successfully processed! File ID: ${job.fileId}` });
            setProgress(100);
            setVideoUrl('');
          } else if (job.status === 'error') {
            clearInterval(pollInterval);
            setStatus({ type: 'error', message: `${job.message} ${job.details || ''}` });
            setProgress(0);
          } else {
            // Update progress and message
            setStatus({ type: 'loading', message: job.message });
            setProgress(job.progress);
          }
        } catch (pollError) {
          console.error('Polling error:', pollError);
          retryCount++;
          if (retryCount > 10) {
            clearInterval(pollInterval);
            setStatus({ type: 'error', message: 'Connection lost with server. Please refresh or try again.' });
          }
        }
      }, 3000);

      // Cleanup polling after 30 minutes just in case
      setTimeout(() => clearInterval(pollInterval), 1800000);

    } catch (error: any) {
      console.error('Frontend processing error:', error);
      let errorMsg = 'An error occurred during processing.';
      
      if (error.code === 'ECONNABORTED') {
        errorMsg = 'Processing took too long and timed out. Check your Google Drive in a few minutes, it might still finish.';
      } else if (error.message === 'Network Error') {
        errorMsg = 'Network Error: Cannot reach the server. Please check your internet or try refreshing the page.';
      } else if (error.response?.status === 400) {
        const details = error.response.data.details || '';
        if (details.includes('Regional Block') || details.includes('suspended access') || details.includes('Extraction Failure')) {
          errorMsg = `Server Restricted: ${details}. This site is actively blocking our server IP/Region. Try using a mirror link (like rt.pornhub.com) or copy a direct link from a downloader site.`;
        } else {
          errorMsg = details || 'The source site blocked the server from downloading. This often happens with protected or expired links.';
        }
      } else if (error.response?.data?.details) {
        errorMsg = `Server Error: ${error.response.data.details}`;
      } else {
        errorMsg = `Error: ${error.message}`;
      }
      
      setStatus({ type: 'error', message: errorMsg });
      setProgress(0);
    }
  };

  return (
    <div className="relative min-h-screen bg-surface-900 text-slate-200 font-sans overflow-hidden">
      {/* Animated Background */}
      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-brand-primary/20 blur-[120px] animate-mesh" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-brand-secondary/20 blur-[120px] animate-mesh" style={{ animationDelay: '-5s' }} />
        <div className="absolute top-[20%] right-[10%] w-[30%] h-[30%] rounded-full bg-indigo-500/10 blur-[100px] animate-mesh" style={{ animationDelay: '-10s' }} />
      </div>

      <div className="relative z-10 max-w-3xl mx-auto px-6 py-12 md:py-20">
        {/* Header */}
        <header className="mb-12 text-center">
          <motion.div 
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className="inline-flex items-center justify-center w-20 h-20 bg-slate-800 border border-slate-700/50 rounded-3xl shadow-2xl mb-8 group"
          >
            <FileArchive className="w-10 h-10 text-brand-primary group-hover:scale-110 transition-transform duration-500" />
          </motion.div>
          <motion.h1 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-5xl font-extrabold tracking-tight mb-4 bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400"
          >
            Drive Video Zipper
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-slate-400 max-w-lg mx-auto text-lg"
          >
            Professional high-speed video processing. Pure simplicity.
          </motion.p>
        </header>

        {/* Main Card */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-slate-800/40 backdrop-blur-xl border border-white/10 rounded-[2.5rem] shadow-2xl overflow-hidden"
        >
          {/* Auth Section */}
          <div className="p-8 border-b border-white/5 bg-white/5">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <div className={`w-3 h-3 rounded-full ${accessToken ? 'bg-green-400' : 'bg-slate-600'}`} />
                  {accessToken && <div className="absolute inset-0 w-3 h-3 rounded-full bg-green-400 animate-ping opacity-75" />}
                </div>
                <span className="text-sm font-semibold tracking-wide text-slate-300">
                  {accessToken ? 'GOOGLE DRIVE ACTIVE' : 'GOOGLE DRIVE DISCONNECTED'}
                </span>
              </div>
              
              {!accessToken ? (
                <button 
                  onClick={handleLogin}
                  disabled={!isClientLoaded}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-2.5 bg-white text-surface-900 rounded-xl text-sm font-bold hover:bg-slate-200 transition-all active:scale-95 disabled:opacity-50"
                >
                  <img src="https://www.google.com/favicon.ico" alt="Google" className="w-4 h-4" />
                  Connect Drive
                </button>
              ) : (
                <button 
                  onClick={handleLogout}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-2.5 bg-white/10 border border-white/10 text-slate-300 hover:bg-white/15 rounded-xl text-sm font-bold transition-all"
                >
                  <LogOut className="w-4 h-4" />
                  Disconnect
                </button>
              )}
            </div>
          </div>

          {/* Process Section */}
          <div className="p-8 md:p-12">
            <div className="space-y-8">
              <div>
                <label htmlFor="video-url" className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">
                  Video URL
                </label>
                <div className="relative group">
                  <input
                    type="url"
                    id="video-url"
                    placeholder="Enter link to video or page..."
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    className="w-full px-5 py-4 bg-slate-900/50 border border-white/10 rounded-2xl text-white placeholder:text-slate-600 focus:ring-2 focus:ring-brand-primary/50 focus:border-brand-primary transition-all outline-none"
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-600 group-focus-within:text-brand-primary transition-colors">
                    <Video className="w-6 h-6" />
                  </div>
                </div>
                
                <div className="mt-4 p-4 bg-brand-primary/10 rounded-2xl border border-brand-primary/20">
                  <p className="text-xs text-indigo-300 leading-relaxed">
                    <span className="font-bold text-indigo-200 uppercase mr-1">Pro Tip:</span> 
                    If smart extraction fails due to site blocks, use a downloader tool (like <strong>savethevideo.com</strong> or <strong>keepv.id</strong>) to get a direct <strong>.mp4</strong> link. Paste that link here and our server will handle the transfer to Drive!
                  </p>
                </div>
              </div>

              <button
                onClick={processVideo}
                disabled={status.type === 'loading' || !accessToken}
                className="relative w-full overflow-hidden group"
              >
                <div className={`absolute inset-0 bg-gradient-to-r from-brand-primary to-brand-secondary transition-transform duration-500 group-hover:scale-105 ${status.type === 'loading' && 'animate-pulse'}`} />
                <div className="relative flex items-center justify-center gap-3 px-8 py-5 text-white font-bold text-lg active:scale-[0.98] transition-transform">
                  {status.type === 'loading' ? (
                    <Loader2 className="w-7 h-7 animate-spin" />
                  ) : (
                    <>
                      <span>Burn into Drive</span>
                      <Upload className="w-5 h-5 group-hover:-translate-y-1 transition-transform" />
                    </>
                  )}
                </div>
              </button>

              {/* Progress Bar */}
              <AnimatePresence>
                {status.type === 'loading' && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-3 pt-2"
                  >
                    <div className="flex justify-between text-xs font-bold tracking-wider">
                      <span className="text-slate-400 uppercase">{status.message}</span>
                      <span className="text-brand-primary">{progress}%</span>
                    </div>
                    <div className="h-2 w-full bg-slate-900 rounded-full overflow-hidden border border-white/5">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                        className="h-full bg-gradient-to-r from-brand-primary to-brand-secondary shadow-[0_0_15px_rgba(99,102,241,0.5)]"
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Status Message */}
              <AnimatePresence>
                {status.message && status.type !== 'loading' && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className={`flex items-start gap-4 p-5 rounded-2xl border ${
                      status.type === 'success' 
                        ? 'bg-green-500/10 border-green-500/20 text-green-300' 
                        : 'bg-red-500/10 border-red-500/20 text-red-300'
                    }`}
                  >
                    <div className="mt-1">
                      {status.type === 'success' ? (
                        <CheckCircle className="w-6 h-6" />
                      ) : (
                        <AlertCircle className="w-6 h-6" />
                      )}
                    </div>
                    <div>
                      <p className="font-bold text-sm uppercase tracking-widest mb-1">
                        {status.type === 'success' ? 'Task Completed' : 'Process Error'}
                      </p>
                      <p className="text-sm opacity-90 leading-relaxed">{status.message}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Footer Info */}
          <div className="px-10 py-8 bg-slate-900/30 border-t border-white/5 flex flex-col md:flex-row items-center justify-between gap-4 text-xs font-mono text-slate-500 uppercase tracking-widest">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-5 h-5 text-slate-600" />
              <span>Secure End-to-End processing</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-50">v1.2.0</span>
              <span className="w-1 h-1 bg-slate-700 rounded-full" />
              <span>GDRIVE_API_v3</span>
            </div>
          </div>
        </motion.div>

        {/* Configuration Guide */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mt-12 p-8 bg-slate-800/20 backdrop-blur-sm border border-white/5 rounded-[2rem]"
        >
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-slate-700/50 rounded-xl flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-indigo-400" />
            </div>
            <h3 className="text-lg font-bold text-slate-200">
              API Configuration
            </h3>
          </div>
          
          <div className="space-y-6">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">
                Client ID
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  placeholder="Paste OAuth Client ID..."
                  value={manualClientId}
                  onChange={(e) => setManualClientId(e.target.value)}
                  className="flex-1 px-4 py-3 bg-slate-900/50 border border-white/10 rounded-xl text-sm focus:ring-2 focus:ring-brand-primary outline-none transition-all placeholder:text-slate-700"
                />
                <button 
                  onClick={saveManualId}
                  className="px-8 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl text-sm font-bold transition-all active:scale-95 shadow-lg"
                >
                  Sync
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/5">
              <div className="space-y-3">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Setup Steps</p>
                <ol className="text-xs text-slate-500 space-y-2 list-decimal list-inside opacity-80">
                  <li>Visit <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">Google Console</a></li>
                  <li>Enable <span className="text-slate-400">Google Drive API</span></li>
                  <li>Create <span className="text-slate-400">OAuth 2.0 Web Client</span></li>
                </ol>
              </div>
              <div className="space-y-3">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Origins</p>
                <div className="bg-slate-900 p-3 rounded-lg border border-white/5 group">
                  <code className="text-[10px] text-indigo-400 break-all">{window.location.origin}</code>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        <footer className="mt-16 text-center">
          <p className="text-xs font-mono text-slate-600 uppercase tracking-[0.2em] mb-2 font-bold">
            © 2026 Drive Video Zipper
          </p>
          <div className="w-12 h-1 bg-gradient-to-r from-brand-primary to-brand-secondary mx-auto rounded-full opacity-50" />
        </footer>
      </div>
    </div>
  );
}
