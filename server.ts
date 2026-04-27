import express from 'express';
import path from 'path';
import axios from 'axios';
import { google } from 'googleapis';
import archiver from 'archiver';
import zipEncryptable from 'archiver-zip-encryptable';
import { PassThrough } from 'stream';
import * as cheerio from 'cheerio';

// Register encryption format
archiver.registerFormat('zip-encryptable', zipEncryptable);

// Helper for random passwords
function generateSecurePassword(length = 16) {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+";
  let retVal = "";
  for (let i = 0; i < length; ++i) {
    retVal += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return retVal;
}

// Lazy load Vite only when needed (saves startup time on Vercel)
async function getViteServer(options: any) {
  const { createServer } = await import('vite');
  return createServer(options);
}

async function extractVideoUrl(pageUrl: string): Promise<{ url: string, filename: string }> {
  const isPornhub = pageUrl.includes('pornhub.com');
  const isYoutube = pageUrl.includes('youtube.com') || pageUrl.includes('youtu.be');
  
  if (isYoutube) {
    console.log('Warn: YouTube links often fail due to bot protection.');
  }

  // Pre-process Pornhub URLs to try mirrors if one fails
  const mirrors = isPornhub ? [
    pageUrl.replace(/pornhub\.com/, 'rt.pornhub.com'), // RT (Russia) often avoids EU age gates
    pageUrl.replace(/pornhub\.com/, 'es.pornhub.com'), // ES (Spain)
    pageUrl.replace(/pornhub\.com/, 'it.pornhub.com'), // IT (Italy)
    pageUrl.replace(/pornhub\.com/, 'pt.pornhub.com'), // PT (Portugal)
    pageUrl.replace(/pornhub\.com/, 'pl.pornhub.com'), // PL (Poland)
    pageUrl
  ] : [pageUrl];

  let lastError = null;

  for (const urlToTry of mirrors) {
    try {
      // 1. Try Embed variant first for Pornhub as it often bypasses regional blocks
      const finalUrl = isPornhub && !urlToTry.includes('/embed/') 
        ? urlToTry.replace('view_video.php?viewkey=', 'embed/') 
        : urlToTry;

      console.log(`Smart extracting from: ${finalUrl}`);
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': isPornhub ? 'https://www.pornhub.com/' : 'https://www.google.com/',
        'Cookie': isPornhub ? 'accessAgeDisclaimerPH=1; age_verified=1; accessPH=1; content_filter=0; platform=pc; bs=1; expired_notice_PH=1; cookie_free_porn=1; atatus_checker=1; invite_survey_seen=1; hide_survey=1; cookiesBannerSeen=1; has_access=1; access_verified=1; welcome_PH=1; d_id=1; il=1; has_access=1;' : ''
      };

      const response = await axios.get(finalUrl, { headers, timeout: 20000 });
      const html = String(response.data);

      const $ = cheerio.load(html);
      let videoUrl = '';

      // Method 0: Search for flashvars/mediaDefinitions explicitly
      const scripts = $('script').get();
      for (const script of scripts) {
        const js = $(script).html() || '';
        
        // Look for the JSON-like part that contains the quality map
        if (js.includes('mediaDefinitions') || js.includes('flashvars') || js.includes('flashVars')) {
          // Regex to extract EVERYTHING that looks like an mp4 link in the script
          const allUrls = js.match(/https?[:\/\\]+[^"']+\.mp4[^"']*/gi) || [];
          const cleanUrls = allUrls.map(u => u.replace(/\\/g, ''))
            .filter(u => {
              const low = u.toLowerCase();
              return !low.includes('rs:fit') && !low.includes('vts:') && !low.includes('thumb');
            });

          if (cleanUrls.length > 0) {
            // Sort by apparent quality markers in the URL
            const best = cleanUrls.find(u => u.includes('1080')) || 
                         cleanUrls.find(u => u.includes('720')) || 
                         cleanUrls.find(u => u.includes('480')) || 
                         cleanUrls.sort((a,b) => b.length - a.length)[0];
            
            if (best) {
              videoUrl = best;
              console.log('High-confidence URL found in script.');
              break;
            }
          }
        }
      }

      // Method 1: Look for obfuscated videoUrl patterns
      if (!videoUrl) {
        const jsMatches = html.match(/"videoUrl":"(https?:\/\/.*?\.mp4.*?)"/gi);
        if (jsMatches) {
          videoUrl = jsMatches[0].match(/"videoUrl":"(.*?)"/)?.[1].replace(/\\/g, '') || '';
          if (videoUrl) console.log('Found via videoUrl JSON key.');
        }
      }

      // Method 2: Global scan for anything that looks like a direct CDN link (even without .mp4 extension)
      if (!videoUrl) {
        // Broaden to catch URLs that might be the video stream but don't strictly end in .mp4 in the string
        const globalMatches = html.match(/https?[:\/\\]+[^"']+\/videos\/[^"']*/gi) || 
                              html.match(/https?[:\/\\]+[^"']+\/(?:hls|mp4|webm)\/[^"']*/gi);
        
        if (globalMatches) {
          const clean = globalMatches.map((u: string) => u.replace(/\\/g, ''))
            .filter((u: string) => {
              const l = u.toLowerCase();
              return l.includes('phncdn.com') && 
                     !l.includes('thumb') && 
                     !l.includes('preview') &&
                     !l.includes('storyboard');
            });
          
          if (clean.length > 0) {
            videoUrl = clean.sort((a, b) => b.length - a.length)[0];
            console.log('Extracted via Global CDN Match (Deep).');
          }
        }
      }

      if (videoUrl) {
        const pageTitle = $('title').text().replace(' - Pornhub.com', '').split('|')[0].trim() || 'pornhub_video';
        const fileBase = pageTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        return { url: videoUrl, filename: `${fileBase}.mp4` };
      }
    } catch (err: any) {
      console.warn(`Mirror failed: ${urlToTry}`, err.message);
      lastError = err;
    }
  }

  if (isPornhub) {
    throw new Error('Pornhub extraction failed. The site is actively blocking our server (High-Regulation Zone). SOLUTION: Go to a downloader site (like keepv.id), get the direct MP4 download link, and paste THAT link here.');
  }
  throw lastError || new Error('Extraction failed: Could not find any video source on this page or its mirrors.');
}

// Global job store
const jobs = new Map<string, {
  status: 'loading' | 'success' | 'error';
  message: string;
  progress: number;
  details?: string;
  fileId?: string;
  zipPassword?: string;
  timestamp: number;
}>();

// Cleanup old jobs every hour (only on persistent servers)
if (!process.env.VERCEL) {
  setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
      if (now - job.timestamp > 3600000) { // 1 hour
        jobs.delete(id);
      }
    }
  }, 3600000);
}

const app = express();
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  console.log('Health check requested');
  try {
    const status = { 
      status: 'ok', 
      message: 'Server is reachable', 
      jobsCount: jobs ? jobs.size : 0,
      env: process.env.NODE_ENV,
      isVercel: !!process.env.VERCEL,
      timestamp: new Date().toISOString()
    };
    console.log('Health check success:', status);
    res.json(status);
  } catch (err: any) {
    console.error('Health check failed:', err);
    res.status(500).json({ 
      error: 'Internal Server Error during health check', 
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Get job status API
app.get('/api/job-status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// API Route: Process Video (Download -> Zip -> Upload) - Now non-blocking
app.post('/api/process-video', async (req, res) => {
  console.log('Received process-video request');
  let { videoUrl, accessToken } = req.body;

  if (!videoUrl || !accessToken) {
    return res.status(400).json({ error: 'Video URL and Access Token are required' });
  }

  const jobId = Math.random().toString(36).substring(2, 15);
  const password = generateSecurePassword(); 

  jobs.set(jobId, { 
    status: 'loading', 
    message: 'Starting process...', 
    progress: 10,
    zipPassword: password,
    timestamp: Date.now()
  });

  // Respond immediately with jobId
  res.json({ success: true, jobId });

  // Run the actual processing in the background
  (async () => {
    try {
      let finalDownloadUrl = videoUrl;
      let finalFileName = 'video.mp4';

      const lowerUrl = videoUrl.toLowerCase();
      const isPornhubDomain = /pornhub\.com|phncdn\.com/.test(lowerUrl);
      const isYoutubeDomain = /youtube\.com|youtu\.be|googlevideo\.com/.test(lowerUrl);

      jobs.set(jobId, { ...jobs.get(jobId)!, progress: 20, message: 'Analyzing source...' });

      // 1. Check if we need to extract
      const isDirectMedia = lowerUrl.match(/\.(mp4|webm|mkv|avi|mov|m3u8)(?:\?|$)/) || (isPornhubDomain && lowerUrl.includes('phncdn.com')) || (isYoutubeDomain && lowerUrl.includes('googlevideo.com'));
      const needsExtraction = !isDirectMedia || lowerUrl.includes('view_video.php') || lowerUrl.includes('/watch?v=') || (isPornhubDomain && !lowerUrl.includes('phncdn.com') && !lowerUrl.includes('.mp4'));

      if (needsExtraction) {
        try {
          const extracted = await extractVideoUrl(videoUrl);
          finalDownloadUrl = extracted.url;
          finalFileName = extracted.filename;
          console.log('Extracted URL:', finalDownloadUrl);
        } catch (extractionError: any) {
          console.error('Extraction failed:', extractionError.message);
          if (isPornhubDomain || isYoutubeDomain) {
            jobs.set(jobId, { status: 'error', message: 'Extraction Failure', details: extractionError.message, progress: 0, timestamp: Date.now() });
            return;
          }
        }
      } else {
        try {
          const urlObj = new URL(videoUrl);
          const queryFilename = urlObj.searchParams.get('filename');
          if (queryFilename) {
            finalFileName = queryFilename.endsWith('.mp4') ? queryFilename : `${queryFilename}.mp4`;
          } else {
            finalFileName = path.basename(urlObj.pathname) || 'video.mp4';
          }
        } catch (e) {
          finalFileName = 'video.mp4';
        }
      }

      let actualSize = 0;
      jobs.set(jobId, { ...jobs.get(jobId)!, progress: 40, message: 'Initializing ZIP transfer...' });

      // 2. Setup Google Drive Client
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: accessToken });
      const drive = google.drive({ version: 'v3', auth });
      
      // 3. Setup Streams
      const zipStream = new PassThrough({ highWaterMark: 2 * 1024 * 1024 }); 
      // Use encrypted format
      const archive = archiver('zip-encryptable' as any, { 
        zlib: { level: 0 }, // Store only (fastest)
        password: password
      } as any);

      const progressTracker = new PassThrough({ highWaterMark: 2 * 1024 * 1024 });
      let bytesProcessed = 0;
      
      progressTracker.on('data', (chunk) => {
        bytesProcessed += chunk.length;
        const mb = (bytesProcessed / 1024 / 1024).toFixed(1);
        const currentJob = jobs.get(jobId);
        if (currentJob && currentJob.status === 'loading') {
          jobs.set(jobId, { 
            ...currentJob, 
            message: `Zipping & Transferring: ${mb}MB...`,
            progress: 50 + Math.min(49, (bytesProcessed / (actualSize || 300000000)) * 49)
          });
        }
      });

      archive.on('error', (err) => {
        console.error('Archive error:', err);
        jobs.set(jobId, { status: 'error', message: 'Archiver Error', details: err.message, progress: 0, timestamp: Date.now() });
      });

      archive.pipe(progressTracker).pipe(zipStream);

      // 4. Download video as stream
      console.log('Starting stream download...');
      
      const config: any = { 
        responseType: 'stream',
        timeout: 0, 
        maxRedirects: 10,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': isPornhubDomain ? 'https://www.pornhub.com/' : 'https://www.google.com/',
        }
      };

      const targetLower = finalDownloadUrl.toLowerCase();
      if (targetLower.includes('pornhub.com') || targetLower.includes('phncdn.com')) {
        config.headers['Cookie'] = 'accessAgeDisclaimerPH=1; age_verified=1; accessPH=1; content_filter=0; platform=pc; bs=1; expired_notice_PH=1; cookie_free_porn=1; atatus_checker=1; invite_survey_seen=1; hide_survey=1; cookiesBannerSeen=1; has_access=1; access_verified=1; welcome_PH=1; d_id=1; il=1;';
      }
      
      const videoResponse = await axios.get(finalDownloadUrl, config);
      const contentType = String(videoResponse.headers['content-type'] || '').toLowerCase();
      const contentDisposition = String(videoResponse.headers['content-disposition'] || '').toLowerCase();
      actualSize = parseInt(String(videoResponse.headers['content-length'] || '0'));
      
      // Strict check: If it's HTML/XML or matches common error page patterns, it's NOT a video
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xml') || contentType.includes('text/xml');
      
      if (isHtml) {
        console.error('Download attempt returned HTML/XML instead of video stream.');
        jobs.set(jobId, { status: 'error', message: 'خطای محتوا', details: 'سایت منبع به جای ویدیو، یک صفحه وب برگرداند. احتمالا لینک منقضی شده یا دسترسی مسدود است.', progress: 0, timestamp: Date.now() });
        return;
      }

      // If it's a playlist (m3u8), we can't just download it as a stream
      if (contentType.includes('mpegurl') || finalDownloadUrl.includes('.m3u8')) {
        jobs.set(jobId, { status: 'error', message: 'لینک نامعتبر', details: 'این لینک یک لیست پخش (HLS) است. لطفا لینک مستقیم .mp4 را وارد کنید.', progress: 0, timestamp: Date.now() });
        return;
      }

      // Security: If size is extremely small (e.g. < 50kb) and it's supposedly a video, it might be an error string
      if (actualSize > 0 && actualSize < 50000) {
         console.warn('Extremely small file size detected for video stream.');
      }

      jobs.set(jobId, { ...jobs.get(jobId)!, progress: 50, message: 'در حال انتقال داده‌ها...' });

      // Detect filename from Content-Disposition if possible
      if (contentDisposition.includes('filename=')) {
        const match = contentDisposition.match(/filename="?([^";]+)"?/);
        if (match && match[1]) {
          const remoteName = match[1];
          if (remoteName.endsWith('.mp4') || remoteName.endsWith('.webm')) {
            finalFileName = remoteName;
          }
        }
      }

      archive.append(videoResponse.data, { name: finalFileName });
      archive.finalize();

      // 5. Upload ZIP stream to Google Drive
      const driveResponse: any = await drive.files.create({
        requestBody: {
          name: `${finalFileName}.zip`,
          mimeType: 'application/zip',
        },
        media: {
          mimeType: 'application/zip',
          body: zipStream,
        }
      }, {
        timeout: 0,
      });

      const fileId = driveResponse.data.id;
      console.log('Upload success:', fileId);
      jobs.set(jobId, { 
        status: 'success', 
        message: 'Video zipped and uploaded to Drive!', 
        progress: 100, 
        fileId: fileId,
        zipPassword: password, // Important to keep it here too
        timestamp: Date.now()
      });

    } catch (error: any) {
      console.error('Job error:', error.message);
      jobs.set(jobId, { 
        status: 'error', 
        message: 'Failed to process video.', 
        details: error.message, 
        progress: 0,
        timestamp: Date.now()
      });
    }
  })();
});

async function startServer() {
  const PORT = 3000;

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    const vite = await getViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (process.env.NODE_ENV === 'production' && !process.env.VERCEL) {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Only listen if not on Vercel (Vercel manages the entry point)
  if (!process.env.VERCEL) {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
}

// Only start the server listen loop and Vite dev server if NOT on Vercel
if (!process.env.VERCEL) {
  startServer();
}

export default app;

