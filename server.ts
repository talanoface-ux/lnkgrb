import express from 'express';
import path from 'path';
import axios from 'axios';
import { google } from 'googleapis';
import { PassThrough } from 'stream';
import * as cheerio from 'cheerio';

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

      const response = await axios.get(finalUrl, { 
        headers, 
        timeout: 15000, // Reduced timeout
        responseType: 'stream',
        validateStatus: () => true // Don't throw for 404/403 to handle them gracefully
      });

      const statusCode = response.status;
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      
      console.log(`Mirror status: ${statusCode}, Type: ${contentType}`);

      if (statusCode >= 400) {
        console.warn(`Mirror returned error status: ${statusCode}`);
        response.data.destroy();
        continue;
      }

      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        console.log('Skipping extraction as target is not an HTML page:', contentType);
        response.data.destroy();
        // If it's already a video, just return it
        if (contentType.includes('video/')) {
          return { url: finalUrl, filename: 'video.mp4' };
        }
        continue; // Try next mirror
      }

      // Read only up to 2MB of HTML content
      let html = '';
      let bytesRead = 0;
      for await (const chunk of response.data) {
        bytesRead += chunk.length;
        html += chunk.toString();
        if (bytesRead > 2 * 1024 * 1024) {
          response.data.destroy();
          break;
        }
      }

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
  status: 'loading' | 'success' | 'resumed' | 'error' | 'idle' | 'paused';
  message: string;
  progress: number;
  details?: string;
  fileId?: string;
  timestamp: number;
  speed?: string;
  remainingTime?: string;
  sourceStream?: any; 
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
app.post('/api/job-control/:id', (req, res) => {
  const { action } = req.body;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (action === 'pause' && job.status === 'loading') {
    job.status = 'paused';
    if (job.sourceStream) job.sourceStream.pause();
    job.message = 'موقتاً متوقف شد';
  } else if (action === 'resume' && job.status === 'paused') {
    job.status = 'loading';
    if (job.sourceStream) job.sourceStream.resume();
    job.message = 'در حال ادامه...';
  } else if (action === 'cancel') {
    job.status = 'error'; // We'll treat canceled as an error state for now to reuse existing UI logic
    if (job.sourceStream) job.sourceStream.destroy();
    job.message = 'کنسل شد';
    job.details = 'کاربر درخواست توقف و حذف عملیات را داد.';
    job.progress = 0;
  }
  
  res.json({ success: true, status: job.status });
});

// API Route: Process Video (Download -> Zip -> Upload) - Now non-blocking
app.post('/api/process-video', async (req, res) => {
  console.log('Received process-video request');
  let { videoUrl, accessToken } = req.body;

  if (!videoUrl || !accessToken) {
    return res.status(400).json({ error: 'Video URL and Access Token are required' });
  }

  videoUrl = videoUrl.trim();
  const jobId = Math.random().toString(36).substring(2, 15);

  jobs.set(jobId, { 
    status: 'loading', 
    message: 'Starting process...', 
    progress: 10,
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

      // 1. Check if we need to extract - simplified detection to avoid getting stuck
      const isDirectMedia = lowerUrl.includes('.mp4') || 
                            lowerUrl.includes('.webm') || 
                            lowerUrl.includes('.mkv') || 
                            lowerUrl.includes('.avi') || 
                            lowerUrl.includes('.mov') || 
                            lowerUrl.includes('/video?token=') || // Proxy links
                            lowerUrl.includes('phncdn.com') || // Pornhub CDN
                            lowerUrl.includes('googlevideo.com'); // Google CDN
      
      const needsExtraction = !isDirectMedia || lowerUrl.includes('view_video.php') || lowerUrl.includes('/watch?v=') || lowerUrl.includes('pornhub.com/view_video');

      if (needsExtraction) {
        try {
          const extracted = await extractVideoUrl(videoUrl);
          finalDownloadUrl = extracted.url;
          finalFileName = extracted.filename;
          console.log('Extracted URL:', finalDownloadUrl);
        } catch (extractionError: any) {
          console.error('Extraction failed:', extractionError.message);
          if (isPornhubDomain || isYoutubeDomain) {
            jobs.set(jobId, { ...jobs.get(jobId)!, status: 'error', message: 'Extraction Failure', details: extractionError.message, progress: 0, timestamp: Date.now() });
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

      jobs.set(jobId, { ...jobs.get(jobId)!, progress: 40, message: 'Initializing upload...' });

      // 2. Setup Google Drive Client
      console.log('Setting up Drive client...');
      const auth = new google.auth.OAuth2();
      auth.setCredentials({ access_token: accessToken });
      const drive = google.drive({ version: 'v3', auth });
      
      // 3. Download video as stream
      console.log('Initiating video download stream from:', finalDownloadUrl);
      
      const config: any = { 
        responseType: 'stream',
        timeout: 0, 
        maxRedirects: 10,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': isPornhubDomain ? 'https://www.pornhub.com/' : 'https://www.google.com/',
        },
        validateStatus: () => true 
      };

      const targetLower = finalDownloadUrl.toLowerCase();
      if (targetLower.includes('pornhub.com') || targetLower.includes('phncdn.com')) {
        config.headers['Cookie'] = 'accessAgeDisclaimerPH=1; age_verified=1; accessPH=1; content_filter=0; platform=pc; bs=1; expired_notice_PH=1; cookie_free_porn=1; atatus_checker=1; invite_survey_seen=1; hide_survey=1; cookiesBannerSeen=1; has_access=1; access_verified=1; welcome_PH=1; d_id=1; il=1;';
      }
      
      console.log('Axios request sent, waiting for response...');
      const videoResponse = await axios.get(finalDownloadUrl, config);

      // Store stream
      const job = jobs.get(jobId);
      if (job) jobs.set(jobId, { ...job, sourceStream: videoResponse.data });

      if (videoResponse.status >= 400) {
        console.error('Video request failed with status:', videoResponse.status);
        jobs.set(jobId, { ...jobs.get(jobId)!, status: 'error', message: 'خطای منبع', details: `سایت منبع خطای ${videoResponse.status} داد.`, progress: 0, timestamp: Date.now() });
        videoResponse.data.destroy();
        return;
      }

      const contentType = String(videoResponse.headers['content-type'] || '').toLowerCase();
      const contentDisposition = String(videoResponse.headers['content-disposition'] || '').toLowerCase();
      
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xml') || contentType.includes('text/xml');
      
      if (isHtml) {
        console.error('Download attempt returned HTML/XML instead of video stream.');
        jobs.set(jobId, { ...jobs.get(jobId)!, status: 'error', message: 'خطای محتوا', details: 'سایت منبع به جای ویدیو، یک صفحه وب برگرداند. احتمالا لینک منقضی شده یا دسترسی مسدود است.', progress: 0, timestamp: Date.now() });
        videoResponse.data.destroy();
        return;
      }

      if (contentType.includes('mpegurl') || finalDownloadUrl.includes('.m3u8')) {
        jobs.set(jobId, { ...jobs.get(jobId)!, status: 'error', message: 'لینک نامعتبر', details: 'این لینک یک لیست پخش (HLS) است. متاسفانه نسخه فعلی فقط از لینک‌های مستقیم mp4 پشتیبانی می‌کند.', progress: 0, timestamp: Date.now() });
        videoResponse.data.destroy();
        return;
      }

      jobs.set(jobId, { ...jobs.get(jobId)!, progress: 50, message: 'در حال انتقال استریم ویدیو به درایو...' });

      if (contentDisposition.includes('filename=')) {
        const match = contentDisposition.match(/filename="?([^";]+)"?/);
        if (match && match[1]) {
          const remoteName = decodeURIComponent(match[1]);
          if (remoteName.match(/\.(mp4|webm|mkv|avi|mov)$/i)) {
            finalFileName = remoteName;
          }
        }
      }

      console.log(`Uploading stream to drive. Filename: ${finalFileName}`);

      // 4. Upload stream to Google Drive
      const totalSize = parseInt(String(videoResponse.headers['content-length'] || '0'), 10);
      let bytesProcessed = 0;
      const startTime = Date.now();
      
      const progressStream = new PassThrough();
      progressStream.on('data', (chunk) => {
        bytesProcessed += chunk.length;
        if (totalSize > 0) {
          const percentage = Math.floor((bytesProcessed / totalSize) * 100);
          const elapsed = (Date.now() - startTime) / 1000;
          const speedBytesPerSec = bytesProcessed / elapsed;
          const speedMBPerSec = (speedBytesPerSec / (1024 * 1024)).toFixed(1);
          const remainingBytes = totalSize - bytesProcessed;
          const remainingTimeSec = Math.floor(remainingBytes / speedBytesPerSec);
          
          const mbTransferred = (bytesProcessed / (1024 * 1024)).toFixed(1);
          const mbTotal = (totalSize / (1024 * 1024)).toFixed(1);

          // Update once every 500ms
          const job = jobs.get(jobId);
          if (job && job.status === 'loading') {
            jobs.set(jobId, { 
              ...job,
              progress: percentage,
              message: `${mbTransferred} / ${mbTotal} MB`,
              speed: `${speedMBPerSec} MB/s`,
              remainingTime: remainingTimeSec > 0 ? `${remainingTimeSec}s` : '...'
            });
          }
        }
      });
      
      console.log(`Uploading stream to drive. Filename: ${finalFileName}`);

      const driveResponse: any = await drive.files.create({
        requestBody: {
          name: finalFileName,
          mimeType: 'video/mp4',
        },
        media: {
          mimeType: 'video/mp4',
          body: videoResponse.data.pipe(progressStream),
        }
      }, {
        timeout: 0,
      });

      const fileId = driveResponse.data.id;
      console.log('Upload success:', fileId);
      jobs.set(jobId, { 
        ...jobs.get(jobId)!,
        status: 'success', 
        message: 'ویدیو با موفقیت به درایو آپلود شد!', 
        progress: 100, 
        fileId: fileId,
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

