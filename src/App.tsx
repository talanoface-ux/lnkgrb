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
  zipPassword?: string;
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
      setStatus({ type: 'success', message: 'کد کلاینت ذخیره شد!' });
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
        message: 'لطفاً کد کلاینت گوگل را در کادر پایین وارد کنید.' 
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
              setStatus({ type: 'success', message: 'با موفقیت به گوگل درایو متصل شد!' });
              setTimeout(() => setStatus({ type: 'idle', message: '' }), 3000);
            } else {
              setStatus({ type: 'error', message: 'خطا در دریافت توکن از گوگل.' });
            }
          },
        });
      }
      tokenClientRef.current.requestAccessToken();
    } catch (error) {
      console.error(error);
      setStatus({ type: 'error', message: 'خطا در راه‌اندازی ورود گوگل.' });
    }
  };

  const handleLogout = () => {
    setAccessToken(null);
    setStatus({ type: 'idle', message: 'با موفقیت خارج شدید.' });
  };

  const processVideo = async () => {
    if (!videoUrl) {
      setStatus({ type: 'error', message: 'لطفاً لینک ویدیو را وارد کنید.' });
      return;
    }

    if (!accessToken) {
      setStatus({ type: 'error', message: 'ابتدا به گوگل درایو متصل شوید.' });
      return;
    }

    try {
      setStatus({ type: 'loading', message: 'درخواست ثبت شد. شروع پردازش در سرور...' });
      setProgress(5);

      const startRes = await axios.post('/api/process-video', {
        videoUrl,
        accessToken,
      });

      if (!startRes.data.success || !startRes.data.jobId) {
        throw new Error('خطا در شروع عملیات.');
      }

      const jobId = startRes.data.jobId;
      console.log('Started job:', jobId);

      let retryCount = 0;
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await axios.get(`/api/job-status/${jobId}`);
          const job = statusRes.data;
          retryCount = 0;

          if (job.status === 'success') {
            clearInterval(pollInterval);
            setStatus({ 
              type: 'success', 
              message: `عملیات با موفقیت انجام شد! فایل در درایو آپلود شد.`,
              zipPassword: job.zipPassword
            });
            setProgress(100);
            setVideoUrl('');
          } else if (job.status === 'error') {
            clearInterval(pollInterval);
            // Translate some common error messages if needed
            let msg = job.message;
            if (msg === 'Failed to process video.') msg = 'پردازش ویدیو ناموفق بود.';
            setStatus({ type: 'error', message: `${msg} ${job.details || ''}` });
            setProgress(0);
          } else {
            // Update messages to Persian if possible or just use them
            let displayMsg = job.message;
            if (displayMsg.includes('Analyzing source')) displayMsg = 'در حال تحلیل منبع...';
            if (displayMsg.includes('Initializing ZIP')) displayMsg = 'در حال آماده‌سازی فشرده‌سازی...';
            if (displayMsg.includes('Zipping & Transferring')) displayMsg = 'در حال زیپ کردن و انتقال... ' + displayMsg.split(':')[1];
            if (displayMsg.includes('Transfer active')) displayMsg = 'انتقال فعال است...';

            setStatus({ type: 'loading', message: displayMsg });
            setProgress(job.progress);
          }
        } catch (pollError) {
          console.error('Polling error:', pollError);
          retryCount++;
          if (retryCount > 10) {
            clearInterval(pollInterval);
            setStatus({ type: 'error', message: 'ارتباط با سرور قطع شد. لطفاً دوباره تلاش کنید.' });
          }
        }
      }, 3000);

      setTimeout(() => clearInterval(pollInterval), 1800000);

    } catch (error: any) {
      console.error('Frontend processing error:', error);
      let errorMsg = 'خطایی در پردازش رخ داد.';
      
      if (error.code === 'ECONNABORTED') {
        errorMsg = 'زمان پردازش طولانی شد. تا چند دقیقه دیگر گوگل درایو خود را چک کنید.';
      } else if (error.message === 'Network Error') {
        errorMsg = 'خطای شبکه: امکان اتصال به سرور نیست.';
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
            className="text-5xl font-display mb-4 bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400"
          >
            زیپ‌کن برقی ⚡️
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-slate-400 max-w-lg mx-auto text-lg"
          >
            ویدیوها رو بفرست به درایو، زیپ شده و با رمز خفن! 🚀
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
                  {accessToken ? 'اتصال به درایو برقراره ✅' : 'گوگل درایوت وصل نیست! 👇'}
                </span>
              </div>
              
              {!accessToken ? (
                <button 
                  onClick={handleLogin}
                  disabled={!isClientLoaded}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-2.5 bg-white text-surface-900 rounded-xl text-sm font-bold hover:bg-slate-200 transition-all active:scale-95 disabled:opacity-50"
                >
                  <img src="https://www.google.com/favicon.ico" alt="Google" className="w-4 h-4" />
                  بزن بریم (ورود با گوگل)
                </button>
              ) : (
                <button 
                  onClick={handleLogout}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-2.5 bg-white/10 border border-white/10 text-slate-300 hover:bg-white/15 rounded-xl text-sm font-bold transition-all"
                >
                  <LogOut className="w-4 h-4" />
                  خروج از حساب
                </button>
              )}
            </div>
          </div>

          {/* Process Section */}
          <div className="p-8 md:p-12">
            <div className="space-y-8">
              <div>
                <label htmlFor="video-url" className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">
                  لینک ویدیو رو اینجا بچسبون 🔗
                </label>
                <div className="relative group">
                  <input
                    type="url"
                    id="video-url"
                    dir="ltr"
                    placeholder="https://site.com/video.mp4"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    className="w-full px-5 py-4 bg-slate-900/50 border border-white/10 rounded-2xl text-white placeholder:text-slate-700 focus:ring-2 focus:ring-brand-primary/50 focus:border-brand-primary transition-all outline-none"
                  />
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-700 group-focus-within:text-brand-primary transition-colors">
                    <Video className="w-6 h-6" />
                  </div>
                </div>
                
                <div className="mt-4 p-4 bg-brand-primary/10 rounded-2xl border border-brand-primary/20">
                  <p className="text-xs text-indigo-300 leading-relaxed">
                    <span className="font-bold text-indigo-200 uppercase ml-1">فوت کوزه‌گری:</span> 
                    اگه استخراج اتوماتیک پرید، از سایت‌های کمکی استفاده کن و <strong>لینک مستقیم mp4</strong> رو اینجا بذار. اینجوری هیچ‌کی نمیتونه جلوتو بگیره! 😎
                  </p>
                </div>
              </div>

              <button
                onClick={processVideo}
                disabled={status.type === 'loading' || !accessToken}
                className="relative w-full overflow-hidden group"
              >
                <div className={`absolute inset-0 bg-gradient-to-r from-brand-primary to-brand-secondary transition-transform duration-500 group-hover:scale-105 ${status.type === 'loading' && 'animate-pulse'}`} />
                <div className="relative flex items-center justify-center gap-3 px-8 py-5 text-white font-display text-2xl active:scale-[0.98] transition-transform">
                  {status.type === 'loading' ? (
                    <Loader2 className="w-7 h-7 animate-spin" />
                  ) : (
                    <>
                      <span>بفرست بره تو درایو! 🚀</span>
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
                    className={`flex flex-col gap-4 p-5 rounded-2xl border ${
                      status.type === 'success' 
                        ? 'bg-green-500/10 border-green-500/20 text-green-300' 
                        : 'bg-red-500/10 border-red-500/20 text-red-300'
                    }`}
                  >
                    <div className="flex items-start gap-4">
                      <div className="mt-1">
                        {status.type === 'success' ? (
                          <CheckCircle className="w-6 h-6" />
                        ) : (
                          <AlertCircle className="w-6 h-6" />
                        )}
                      </div>
                      <div>
                        <p className="font-bold text-sm uppercase tracking-widest mb-1">
                          {status.type === 'success' ? 'عملیات با موفقیت پایان یافت' : 'خطا در پردازش'}
                        </p>
                        <p className="text-sm opacity-90 leading-relaxed">{status.message}</p>
                      </div>
                    </div>

                    {status.type === 'success' && status.zipPassword && (
                      <div className="mt-4 p-6 bg-slate-900/80 rounded-2xl border border-white/10 space-y-4">
                        <div>
                          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">رمز عبور فایل زیپ (بسیار مهم):</p>
                          <div className="flex items-center gap-3 bg-slate-800 p-4 rounded-xl border border-white/5 group">
                            <code className="text-lg font-mono text-brand-secondary break-all flex-1 underline decoration-brand-secondary/30">{status.zipPassword}</code>
                            <button 
                              onClick={() => navigator.clipboard.writeText(status.zipPassword!)}
                              className="p-2 hover:bg-white/10 rounded-lg transition-colors text-slate-400 hover:text-white"
                              title="کپی رمز عبور"
                            >
                              <CheckCircle className="w-5 h-5" />
                            </button>
                          </div>
                        </div>
                        <div className="bg-orange-500/10 border border-orange-500/20 p-4 rounded-xl flex items-start gap-3">
                          <AlertCircle className="w-5 h-5 text-orange-400 mt-0.5" />
                          <p className="text-xs text-orange-200/80 leading-relaxed">
                            <span className="font-bold text-orange-300">هشدار امنیتی:</span> این رمز عبور در هیچ کجا ذخیره نمی‌شود. لطفاً همین الان آن را در جایی امن یادداشت یا ذخیره کنید. بدون این رمز، باز کردن فایل زیپ غیرممکن خواهد بود.
                          </p>
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Footer Info */}
          <div className="px-10 py-8 bg-slate-900/30 border-t border-white/5 flex flex-col md:flex-row items-center justify-between gap-4 text-xs font-mono text-slate-500 uppercase tracking-widest">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-5 h-5 text-slate-600" />
              <span>پردازش امن و رمزنگاری شده</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-50" dir="ltr">v1.2.0</span>
              <span className="w-1 h-1 bg-slate-700 rounded-full" />
              <span dir="ltr">GDRIVE_API_v3</span>
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
              تنظیمات API
            </h3>
          </div>
          
          <div className="space-y-6">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3 text-right">
                Client ID (کد کلاینت)
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  dir="ltr"
                  placeholder="Paste OAuth Client ID..."
                  value={manualClientId}
                  onChange={(e) => setManualClientId(e.target.value)}
                  className="flex-1 px-4 py-3 bg-slate-900/50 border border-white/10 rounded-xl text-sm focus:ring-2 focus:ring-brand-primary outline-none transition-all placeholder:text-slate-700 text-left"
                />
                <button 
                  onClick={saveManualId}
                  className="px-8 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-xl text-sm font-bold transition-all active:scale-95 shadow-lg"
                >
                  ذخیره
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/5">
              <div className="space-y-3">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">مراحل راه‌اندازی</p>
                <ol className="text-xs text-slate-500 space-y-2 list-decimal list-inside opacity-80 pr-4">
                  <li>به <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">کنسول گوگل</a> بروید</li>
                  <li>سرویس <span className="text-slate-400">Google Drive API</span> را فعال کنید</li>
                  <li>یک <span className="text-slate-400">OAuth 2.0 Web Client</span> بسازید</li>
                </ol>
              </div>
              <div className="space-y-3">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Origins (آدرس مجاز)</p>
                <div className="bg-slate-900 p-3 rounded-lg border border-white/5 group">
                  <code className="text-[10px] text-indigo-400 break-all" dir="ltr">{window.location.origin}</code>
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        <footer className="mt-16 text-center">
          <p className="text-xs font-mono text-slate-600 uppercase tracking-[0.2em] mb-2 font-bold" dir="ltr">
            © 2026 Drive Video Zipper
          </p>
          <div className="w-12 h-1 bg-gradient-to-r from-brand-primary to-brand-secondary mx-auto rounded-full opacity-50" />
        </footer>
      </div>
    </div>
  );
}
