/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
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
  Video,
  XCircle,
  ArrowUpRight,
  Flame,
  Skull
} from 'lucide-react';

// Google Drive API Scopes
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

// Types
declare const google: any;

interface JobStatus {
  id: string;
  url: string;
  status: 'loading' | 'success' | 'resumed' | 'error' | 'idle' | 'paused';
  message: string;
  progress: number;
  details?: string;
  speed?: string;
  remainingTime?: string;
}

export default function App() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [manualClientId, setManualClientId] = useState('');
  const [videoUrls, setVideoUrls] = useState<string[]>(['']);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isClientLoaded, setIsClientLoaded] = useState(false);
  const tokenClientRef = useRef<any>(null);

  const CLIENT_ID = manualClientId;

  const saveManualId = () => {
    if (manualClientId) {
      alert('کد کلاینت ذخیره شد!');
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
      alert('لطفاً کد کلاینت گوگل را در کادر پایین وارد کنید.');
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
              alert('با موفقیت به گوگل درایو متصل شد!');
            } else {
              alert('خطا در دریافت توکن از گوگل.');
            }
          },
        });
      }
      tokenClientRef.current.requestAccessToken();
    } catch (error) {
      console.error(error);
      alert('خطا در راه‌اندازی ورود گوگل.');
    }
  };

  const handleLogout = () => {
    setAccessToken(null);
    alert('با موفقیت خارج شدید.');
  };

  const addUrlField = () => setVideoUrls([...videoUrls, '']);
  const removeUrlField = (index: number) => {
    const newUrls = [...videoUrls];
    newUrls.splice(index, 1);
    setVideoUrls(newUrls.length > 0 ? newUrls : ['']);
  };
  const updateUrlField = (index: number, value: string) => {
    const newUrls = [...videoUrls];
    newUrls[index] = value;
    setVideoUrls(newUrls);
  };

  const processVideos = async () => {
    const urlsToProcess = videoUrls.map(u => u.trim()).filter(u => u.length > 0);
    
    if (urlsToProcess.length === 0) {
      alert('لطفاً حداقل یک لینک معتبر وارد کنید.');
      return;
    }

    if (!accessToken) {
      alert('ابتدا به گوگل درایو متصل شوید.');
      return;
    }

    const currentUrls = [...urlsToProcess];
    setVideoUrls(['']); // Clear inputs
    setIsSubmitting(true);

    try {
      for (const url of currentUrls) {
        try {
          const startRes = await axios.post('/api/process-video', {
            videoUrl: url,
            accessToken,
          });

          if (startRes.data.success && startRes.data.jobId) {
            const jobId = startRes.data.jobId;
            const newJob: JobStatus = {
              id: jobId,
              url: url,
              status: 'loading',
              message: 'در حال شروع...',
              progress: 5
            };
            
            setJobs(prev => [newJob, ...prev]);
            startPolling(jobId);
          }
        } catch (error) {
          console.error('Submit error for individual URL:', error);
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const startPolling = (jobId: string) => {
    let retryCount = 0;
    const interval = setInterval(async () => {
      try {
        const res = await axios.get(`/api/job-status/${jobId}`);
        const data = res.data;
        retryCount = 0;

        setJobs(prev => prev.map(job => {
          if (job.id === jobId) {
            let displayMsg = data.message;
            if (displayMsg.includes('Analyzing source')) displayMsg = 'در حال تحلیل منبع...';
            if (displayMsg.includes('Initializing ZIP')) displayMsg = 'در حال آماده‌سازی فشرده‌سازی...';
            if (displayMsg.includes('Zipping & Transferring')) displayMsg = 'در حال زیپ کردن و انتقال... ' + displayMsg.split(':')[1];
            if (displayMsg.includes('Transfer active')) displayMsg = 'انتقال فعال است...';

            return {
              ...job,
              status: data.status,
              progress: data.progress,
              message: displayMsg,
              details: data.details,
              speed: data.speed,
              remainingTime: data.remainingTime
            };
          }
          return job;
        }));

        if (data.status === 'success' || data.status === 'error') {
          clearInterval(interval);
        }
      } catch (err) {
        retryCount++;
        if (retryCount > 10) {
          clearInterval(interval);
          setJobs(prev => prev.map(job => 
            job.id === jobId ? { ...job, status: 'error', message: 'قطع ارتباط با سرور' } : job
          ));
        }
      }
    }, 3000);
  };

  const handleJobControl = async (jobId: string, action: 'pause' | 'resume' | 'cancel') => {
    try {
      // Optimistic update
      setJobs(prev => prev.map(job => {
        if (job.id === jobId) {
          if (action === 'pause') return { ...job, status: 'paused', message: 'در حال متوقف کردن...' };
          if (action === 'resume') return { ...job, status: 'loading', message: 'در حال ادامه...' };
          if (action === 'cancel') return { ...job, status: 'error', message: 'در حال لغو...' };
        }
        return job;
      }));

      await axios.post(`/api/job-control/${jobId}`, { action });
    } catch (error) {
      console.error(`Error controlling job ${jobId}:`, error);
    }
  };


  return (
    <div className="relative min-h-screen bg-surface-900 text-slate-300 font-sans overflow-hidden">
      {/* Animated Background - Devil Inferno */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-15%] left-[-10%] w-[60%] h-[60%] rounded-full bg-brand-primary/10 blur-[150px] animate-inferno" />
        <div className="absolute bottom-[-15%] right-[-10%] w-[60%] h-[60%] rounded-full bg-brand-secondary/15 blur-[150px] animate-inferno" style={{ animationDelay: '-7s' }} />
        <div className="absolute top-[20%] right-[10%] w-[40%] h-[40%] rounded-full bg-brand-primary/5 blur-[120px] animate-inferno" style={{ animationDelay: '-12s' }} />
        
        {/* Subtle red sparks/particles could be added here if needed, but keeping it clean as requested */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(0,0,0,0.4)_100%)]" />
      </div>

      <div className="relative z-10 max-w-3xl mx-auto px-6 py-12 md:py-16">
        {/* Header - Devil Logo with Horns */}
        <header className="mb-10 text-center flex flex-col items-center">
          <motion.div 
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            className="relative group cursor-default"
          >
            {/* Horns SVG */}
            <svg 
              viewBox="0 0 100 100" 
              className="absolute -top-12 left-1/2 -translate-x-1/2 w-28 h-28 text-brand-primary drop-shadow-[0_0_15px_rgba(220,38,38,0.8)] fill-current z-0 opacity-80"
            >
              <path d="M30,50 C20,30 10,20 5,10 C15,20 25,35 30,50 Z M70,50 C80,30 90,20 95,10 C85,20 75,35 70,50 Z" />
            </svg>

            {/* Glow effect */}
            <div className="absolute inset-0 bg-brand-primary/30 blur-3xl group-hover:bg-brand-primary/50 transition-colors duration-700" />
            
            <div className="relative flex items-center justify-center w-28 h-28 bg-black border border-brand-primary/20 rounded-[2.5rem] shadow-[0_0_50px_rgba(220,38,38,0.2)] group-hover:border-brand-primary/50 transition-all duration-700 overflow-hidden">
              {/* Inner hell gradient */}
              <div className="absolute inset-0 bg-gradient-to-br from-brand-primary/20 via-transparent to-black opacity-40 group-hover:opacity-100 transition-opacity duration-700" />
              
              <div className="relative flex flex-col items-center">
                <Skull className="w-12 h-12 text-brand-primary drop-shadow-[0_0_10px_rgba(220,38,38,0.5)] transform group-hover:scale-110 transition-transform duration-700" />
                <div className="absolute -bottom-2">
                  <Flame className="w-6 h-6 text-orange-500 animate-pulse" />
                </div>
              </div>
            </div>

            <motion.h1 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 }}
              className="mt-6 text-5xl font-display text-brand-primary tracking-widest drop-shadow-[0_0_15px_rgba(220,38,38,0.5)] uppercase"
            >
              DEVIL
            </motion.h1>

            {/* Accent lines */}
            <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-24 h-[2px] bg-gradient-to-r from-transparent via-brand-primary to-transparent rounded-full opacity-60" />
          </motion.div>
        </header>

        {/* Main Card */}
        <motion.div 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, type: "spring", stiffness: 50 }}
          className="bg-black/60 backdrop-blur-2xl border border-white/5 rounded-[3rem] shadow-[0_30px_100px_rgba(0,0,0,0.8)] overflow-hidden"
        >
          {/* Auth Section */}
          <div className="p-8 border-b border-white/5 bg-brand-primary/5">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="relative">
                  <div className={`w-3 h-3 rounded-full ${accessToken ? 'bg-red-500' : 'bg-slate-700'}`} />
                  {accessToken && <div className="absolute inset-0 w-3 h-3 rounded-full bg-red-500 animate-ping opacity-75" />}
                </div>
                <span className="text-sm font-semibold tracking-wide text-slate-400">
                  {accessToken ? 'اتصال به گوگل درایو برقرار است' : 'گوگل درایو متصل نیست'}
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
              <div className="pt-4 border-t border-white/5 space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-brand-primary shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
                  <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">ابزارهای کمکی برای استخراج لینک مستقیم</h3>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <a 
                    href="https://www.savethevideo.com/" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-3 bg-slate-900/50 border border-white/5 rounded-xl hover:border-brand-primary/30 hover:bg-slate-800/80 transition-all group"
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-slate-800 rounded-lg group-hover:scale-110 transition-transform">
                        <Video className="w-4 h-4 text-brand-primary" />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[11px] font-bold text-slate-300">SaveTheVideo</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[9px] text-slate-500">استخراج لینک از بیشتر سایت‌ها</span>
                          <span className="w-1.5 h-1.5 rounded-full bg-red-600 shadow-[0_0_5px_rgba(220,38,38,0.5)]" />
                          <span className="text-[9px] text-red-500/70 font-medium">قدرتمند</span>
                        </div>
                      </div>
                    </div>
                    <ArrowUpRight className="w-3 h-3 text-slate-700 group-hover:text-brand-primary transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
                  </a>

                  <a 
                    href="https://pornhubfans.com/" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-3 bg-black/40 border border-white/5 rounded-xl hover:border-brand-primary/30 hover:bg-black/60 transition-all group"
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-brand-primary/10 rounded-lg group-hover:scale-110 transition-transform">
                        <Flame className="w-4 h-4 text-brand-primary" />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[11px] font-bold text-slate-300">PornhubFans</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[9px] text-slate-500">استخراج از پورن‌هاب</span>
                          <span className="w-1.5 h-1.5 rounded-full bg-red-600 shadow-[0_0_5px_rgba(220,38,38,0.5)]" />
                          <span className="text-[9px] text-red-500/70 font-medium">سریع</span>
                        </div>
                      </div>
                    </div>
                    <ArrowUpRight className="w-3 h-3 text-slate-700 group-hover:text-brand-primary transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
                  </a>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-4 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <Flame className="w-3 h-3 text-brand-primary" />
                    <span>لینک‌های ویدیو 🔗</span>
                  </div>
                  <button 
                    onClick={addUrlField}
                    className="text-[10px] bg-brand-primary/10 hover:bg-brand-primary/20 text-brand-primary px-3 py-1 rounded-lg border border-brand-primary/20 transition-colors"
                  >
                    + افزودن لینک جدید
                  </button>
                </label>
                
                <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                  <AnimatePresence mode="popLayout">
                    {videoUrls.map((url, index) => (
                      <motion.div 
                        key={index}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="relative group"
                      >
                        <textarea
                          dir="ltr"
                          rows={2}
                          placeholder="https://site.com/video-url..."
                          value={url}
                          onChange={(e) => updateUrlField(index, e.target.value)}
                          className="w-full px-12 py-4 bg-slate-900/50 border border-white/10 rounded-2xl text-white placeholder:text-slate-700 focus:ring-2 focus:ring-brand-primary/50 focus:border-brand-primary transition-all outline-none resize-none text-sm"
                        />
                        <div className="absolute left-4 top-4 text-slate-700 group-focus-within:text-brand-primary transition-colors">
                          <Video className="w-5 h-5" />
                        </div>
                        {videoUrls.length > 1 && (
                          <button 
                            onClick={() => removeUrlField(index)}
                            className="absolute right-4 top-4 text-slate-700 hover:text-red-400 transition-colors p-1"
                          >
                            <XCircle className="w-5 h-5" />
                          </button>
                        )}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>

                <div className="mt-4 p-4 bg-brand-primary/5 rounded-2xl border border-brand-primary/10">
                  <p className="text-xs text-brand-primary/70 leading-relaxed text-center font-medium">
                    تمامی ویدیوها مستقیماً و با بالاترین سرعت ممکن به گوگل درایو شما منتقل می‌شوند.
                  </p>
                </div>
              </div>

              <button
                onClick={processVideos}
                disabled={!accessToken || !videoUrls.some(u => u.trim()) || isSubmitting}
                className="relative w-full overflow-hidden group"
              >
                <div className={`absolute inset-0 bg-gradient-to-r from-brand-primary to-brand-secondary transition-transform duration-500 group-hover:scale-105 ${isSubmitting ? 'animate-pulse' : ''}`} />
                <div className="relative flex items-center justify-center gap-3 px-8 py-5 text-white font-display text-2xl active:scale-[0.98] transition-transform">
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-7 h-7 animate-spin" />
                      <span>در حال ثبت...</span>
                    </>
                  ) : (
                    <>
                      <span>بفرست بره تو درایو!</span>
                      <Upload className="w-5 h-5 group-hover:-translate-y-1 transition-transform" />
                    </>
                  )}
                </div>
              </button>

              {/* Jobs List */}
              <div className="space-y-6">
                {jobs.length > 0 && (
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">لیست فایل‌های پردازشی</h3>
                  </div>
                )}
                
                <AnimatePresence mode="popLayout">
                  {jobs.map((job) => (
                    <motion.div
                      key={job.id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className={`p-5 rounded-[1.5rem] border ${
                        job.status === 'success' ? 'bg-green-500/5 border-green-500/20' :
                        job.status === 'error' ? 'bg-red-500/5 border-red-500/20' :
                        'bg-slate-900/40 border-white/5'
                      }`}
                    >
                      <div className="flex flex-col gap-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] font-mono text-slate-500 truncate mb-1" dir="ltr">{job.status !== 'loading' ? job.url : 'درحال پردازش...'}</p>
                            <p className="text-xs font-bold text-slate-200">{job.message}</p>
                          </div>
                          <div className="shrink-0">
                            {job.status === 'loading' && <Loader2 className="w-5 h-5 animate-spin text-brand-primary" />}
                            {job.status === 'success' && <CheckCircle className="w-5 h-5 text-green-400" />}
                            {job.status === 'error' && <AlertCircle className="w-5 h-5 text-red-400" />}
                          </div>
                        </div>

                        {(job.status === 'loading' || job.status === 'paused') && (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                              <span>وضعیت: {job.message}</span>
                              <div className="flex gap-2">
                                {job.status === 'loading' && (
                                  <button
                                    onClick={() => handleJobControl(job.id, 'pause')}
                                    className="hover:text-white transition-colors underline"
                                  >
                                    توقف
                                  </button>
                                )}
                                {job.status === 'paused' && (
                                  <button
                                    onClick={() => handleJobControl(job.id, 'resume')}
                                    className="hover:text-white transition-colors underline"
                                  >
                                    ادامه
                                  </button>
                                )}
                                <button
                                  onClick={() => handleJobControl(job.id, 'cancel')}
                                  className="hover:text-red-400 transition-colors underline"
                                >
                                  لغو
                                </button>
                              </div>
                            </div>
                            <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden border border-white/5">
                              <motion.div 
                                initial={{ width: 0 }}
                                animate={{ width: `${job.progress}%` }}
                                className="h-full bg-gradient-to-r from-brand-primary to-brand-secondary"
                              />
                            </div>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                {job.speed && (
                                  <span className="text-[10px] font-mono text-brand-primary bg-brand-primary/10 px-2 py-0.5 rounded-lg border border-brand-primary/20">
                                    {job.speed}
                                  </span>
                                )}
                                {job.remainingTime && (
                                  <span className="text-[10px] font-mono text-slate-400 bg-white/5 px-2 py-0.5 rounded-lg border border-white/5">
                                    {job.remainingTime} باقی‌مانده
                                  </span>
                                )}
                              </div>
                              <span className="text-[10px] font-mono text-slate-300 font-bold">{job.progress}%</span>
                            </div>
                          </div>
                        )}


                        {job.status === 'error' && (
                          <p className="text-[10px] text-red-400/80 bg-red-400/5 p-2 rounded-lg border border-red-400/10 underline decoration-red-400/20">
                            {job.details || 'خطای نامشخص در سیستم'}
                          </p>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          </div>

          {/* Footer Info */}
          <div className="px-10 py-8 bg-black/60 border-t border-white/5 flex flex-col md:flex-row items-center justify-between gap-4 text-xs font-mono text-slate-600 uppercase tracking-widest">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-5 h-5 text-brand-primary/50" />
              <span>پردازش امن و رمزنگاری شده</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-40" dir="ltr">v1.2.0</span>
            </div>
          </div>
        </motion.div>

        {/* Configuration Guide */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mt-12 p-8 bg-black/40 backdrop-blur-sm border border-brand-primary/10 rounded-[2.5rem]"
        >
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-brand-primary/10 rounded-xl flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-brand-primary" />
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
          <p className="text-xs font-mono text-brand-primary opacity-60 uppercase tracking-[0.4em] mb-3 font-bold" dir="ltr">
            © 2026 DEVIL.INC
          </p>
          <div className="w-24 h-[1px] bg-gradient-to-r from-transparent via-brand-primary to-transparent mx-auto rounded-full" />
        </footer>
      </div>
    </div>
  );
}
