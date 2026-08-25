const axios = require('axios');
const { OpusDecoder } = require('opus-decoder');
const { Writer } = require('wav');
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const readline = require('readline');

const DEFAULT_API_URL = 'https://stt.vrcjat.com/api';
const PAGE_SIZE = 200;
const REQUEST_DELAY = 150;
const OUTPUT_DIR = path.join(__dirname, 'audio');
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

const MAGENTA = '\x1b[35m';
const RESET = '\x1b[0m';

const args = process.argv.slice(2);
let cliApiUrl = process.env.API_BASE_URL || DEFAULT_API_URL;
let cliQuery = null;
let cliMode = null;
let cliPort = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--api-url' && args[i + 1]) {
    cliApiUrl = args[++i];
    continue;
  }

  if (arg === '--query' && args[i + 1]) {
    cliQuery = args[++i];
    continue;
  }

  if (arg === '--serve') {
    cliMode = 'serve';
    cliPort = 3000;

    if (args[i + 1] && !isNaN(args[i + 1])) {
      cliPort = parseInt(args[++i], 10);
    }
    continue;
  }

  if (arg === '--mode' && args[i + 1]) {
    cliMode = args[++i];

    if (cliMode === 'serve' && args[i + 1] && !isNaN(args[i + 1])) {
      cliPort = parseInt(args[++i], 10);
    }
    continue;
  }

  if (arg === '--help') {
    console.log(`
Usage: node ripper.js [options]

Options:
  --mode download          Run the downloader (default)
  --mode serve [port]      Start web search UI on given port (default 3000)
  --api-url <url>          Base API URL (default: ${DEFAULT_API_URL})
  --query <text>           Only download sessions matching query (downloader only)
  --help                   Show this help

If no arguments are given, an interactive menu will be displayed.
`);
    process.exit(0);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeFilename(name) {
  if (!name) return 'unknown';
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'unknown';
}

async function apiGet(requestUrl, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(requestUrl, { timeout: 30000 });
      return response.data;
    } catch (err) {
      if (attempt === retries) {
        throw new Error(`API request failed after ${retries} attempts: ${err.message}`);
      }

      console.warn(
        `Request to ${requestUrl} failed (${attempt}/${retries}), retrying in ${RETRY_DELAY}ms...`
      );
      await sleep(RETRY_DELAY * attempt);
    }
  }
}

async function getSessions(after, query, apiUrl) {
  const params = { limit: PAGE_SIZE };

  if (after) params.after = after;
  if (query) params.q = query;

  try {
    return await apiGet(`${apiUrl}/sessions`, { params });
  } catch (err) {
    console.error(`Failed to fetch sessions: ${err.message}`);
    throw err;
  }
}

async function getFrames(sessionId, apiUrl) {
  const frames = [];
  let afterSeq = 0;
  let hasMore = true;

  while (hasMore) {
    try {
      const data = await apiGet(`${apiUrl}/sessions/${sessionId}/opus-frames`, {
        params: { afterSeq, limit: PAGE_SIZE }
      });

      if (Array.isArray(data.frames)) {
        frames.push(...data.frames);
      }

      hasMore = data.hasMore || false;
      afterSeq = data.nextAfterSeq || 0;
      await sleep(REQUEST_DELAY);
    } catch (err) {
      console.error(`Failed to fetch frames for session ${sessionId}: ${err.message}`);
      throw err;
    }
  }

  return frames;
}

async function decodeFrames(frames, channels) {
  if (!frames || frames.length === 0) {
    throw new Error('No frames provided for decoding.');
  }

  let decoder;

  try {
    decoder = new OpusDecoder({ sampleRate: 48000, channels });
    await decoder.ready;
  } catch (err) {
    throw new Error(`Failed to initialize Opus decoder: ${err.message}`);
  }

  const chunks = [];
  let sampleCount = 0;

  for (const frame of frames) {
    if (!frame.b64) continue;

    try {
      const opusData = Buffer.from(frame.b64, 'base64');
      const decoded = decoder.decodeFrame(opusData);

      if (!decoded.samplesDecoded || !decoded.channelData?.length) continue;

      const samples = decoded.channelData[0];
      chunks.push(samples);
      sampleCount += samples.length;
    } catch (err) {
      console.warn(`Skipping corrupt frame: ${err.message}`);
    }
  }

  decoder.free();

  if (!sampleCount) {
    throw new Error('No usable audio samples decoded.');
  }

  const pcm = new Float32Array(sampleCount);
  let offset = 0;

  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }

  return pcm;
}

function writeWav(filename, pcm) {
  return new Promise((resolve, reject) => {
    try {
      const output = fs.createWriteStream(filename);
      const writer = new Writer({
        sampleRate: 48000,
        channels: 1,
        bitDepth: 32,
        float: true
      });

      output.on('finish', resolve);
      output.on('error', reject);
      writer.on('error', reject);

      writer.pipe(output);
      writer.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    } catch (err) {
      reject(err);
    }
  });
}

async function downloadSession(session, apiUrl) {
  if (!session || !session.id) {
    throw new Error('Invalid session object');
  }

  const username = session.display_name || `user_${session.id}`;
  const userDir = path.join(OUTPUT_DIR, safeFilename(username));
  const outputFile = path.join(userDir, `${session.id}.wav`);

  try {
    if (fs.existsSync(outputFile)) return 'skipped';
  } catch (_) {
    // Let the write attempt report the real filesystem error later.
  }

  console.log(`Downloading session ${session.id} (${username})`);

  let frames;
  try {
    frames = await getFrames(session.id, apiUrl);
  } catch (err) {
    console.error(`Failed to get frames for session ${session.id}: ${err.message}`);
    return 'failed';
  }

  if (!frames || frames.length === 0) {
    console.log(`No audio frames found for session ${session.id}`);
    return 'failed';
  }

  frames.sort((a, b) => (a.seq || 0) - (b.seq || 0));

  let pcm;
  try {
    pcm = await decodeFrames(frames, session.channels || 1);
  } catch (err) {
    console.error(`Decoding failed for session ${session.id}: ${err.message}`);
    return 'failed';
  }

  try {
    fs.mkdirSync(userDir, { recursive: true });
    await writeWav(outputFile, pcm);
  } catch (err) {
    console.error(`Failed to save ${outputFile}: ${err.message}`);
    return 'failed';
  }

  console.log(`Saved ${outputFile} (${(pcm.length / 48000).toFixed(2)}s)`);
  return 'success';
}

async function runDownload(apiUrl, query) {
  console.log(`Fetching sessions${query ? ` matching "${query}"` : '...'}`);

  const totals = {
    success: 0,
    skipped: 0,
    failed: 0
  };

  let after = null;
  let hasMore = true;

  while (hasMore) {
    let data;

    try {
      data = await getSessions(after, query, apiUrl);
    } catch (err) {
      console.error(`Failed to fetch session list: ${err.message}`);
      break;
    }

    const sessions = data.sessions || [];
    if (!sessions.length && !data.hasMore) break;

    for (const session of sessions) {
      try {
        const result = await downloadSession(session, apiUrl);
        totals[result] = (totals[result] || 0) + 1;
      } catch (err) {
        totals.failed++;
        console.error(`Session ${session.id} failed: ${err.message}`);
      }

      await sleep(REQUEST_DELAY);
    }

    hasMore = data.hasMore || false;
    after = data.nextAfter || null;
  }

  console.log('\nSummary:');
  console.log(`Downloaded: ${totals.success}`);
  console.log(`Skipped:    ${totals.skipped}`);
  console.log(`Failed:     ${totals.failed}`);
}

function sendJsonError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function startWebServer(port, apiUrl) {
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      const filePath = path.join(__dirname, 'index.html');

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end('Error loading index.html');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      const target = `${apiUrl}${pathname.slice(4)}${parsed.search || ''}`;

      try {
        const response = await axios.get(target, { timeout: 30000 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response.data));
      } catch (err) {
        const status = err.response?.status || 500;
        const message = err.response?.data?.error || err.message || 'API proxy error';
        sendJsonError(res, status, message);
      }
      return;
    }

    if (pathname === '/download' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });

      req.on('end', async () => {
        let sessionId;

        try {
          const payload = JSON.parse(body);
          sessionId = payload.sessionId;
          if (!sessionId) throw new Error('Missing sessionId');
        } catch (_) {
          sendJsonError(res, 400, 'Invalid request body');
          return;
        }

        let session = {
          id: sessionId,
          display_name: `session_${sessionId}`,
          channels: 1
        };

        try {
          const response = await axios.get(`${apiUrl}/sessions/${sessionId}`, {
            timeout: 15000
          });

          if (response.data) session = response.data;
        } catch (_) {
          console.warn(`Could not fetch session details for ${sessionId}, using defaults.`);
        }

        try {
          const result = await downloadSession(session, apiUrl);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          sendJsonError(res, 500, `Download failed: ${err.message}`);
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.on('error', err => {
    console.error(`Server error: ${err.message}`);

    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try a different port.`);
      process.exit(1);
    }
  });

  server.on('uncaughtException', err => {
    console.error('Uncaught exception in server:', err);
  });

  server.listen(port, () => {
    console.log(`Web search UI running at http://localhost:${port}`);
    console.log(`API proxy uses: ${apiUrl}`);
  });
}

function showMenu() {
  const reaper = MAGENTA +
    '                  ...                            \n' +
    '                 ;::::;                           \n' +
    '               ;::::; :;                          \n' +
    '             ;:::::\'   :;                         \n' +
    '            ;:::::;     ;.                        \n' +
    '           ,:::::\'       ;           OOO\\         \n' +
    '           ::::::;       ;          OOOOO\\        \n' +
    '           ;:::::;       ;         OOOOOOOO       \n' +
    '          ,;::::::;     ;\'         / OOOOOOO      \n' +
    '        ;:::::::::`. ,,,;.        /  / DOOOOOO    \n' +
    '      .\';:::::::::::::::::;,     /  /     DOOOO   \n' +
    '     ,::::::;::::::;;;;:::::,   /  /        DOOO  \n' +
    '    ;`::::::`\'::::::;;;::::: ,#/  /          DOOO \n' +
    '    :`:::::::`;::::::;;::: ;::#  /            DOOO\n' +
    '    ::`:::::::`;:::::::: ;::::# /              DOO\n' +
    '    `:`:::::::`;:::::: ;::::::#/               DOO\n' +
    '     :::`:::::::`;; ;:::::::::##                OO\n' +
    '     ::::`:::::::`;::::::::;:::#                OO\n' +
    '     `:::::`::::::::::::;\'`:;::#                O \n' +
    '      `:::::`::::::::;\' /  / `:#                  \n' +
    '       ::::::`:::::;\'  /  /   `#                  \n' +
    RESET;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log(reaper);
  console.log('\n🎙️  VRChat Audio Ripper');
  console.log('=======================');
  console.log('1) Downloader (CLI) – download all or filtered sessions');
  console.log('2) Web Server (UI) – search and download via browser');
  console.log('3) Exit');
  console.log('');

  rl.question('Select an option (1-3): ', answer => {
    const choice = parseInt(answer.trim(), 10);

    if (isNaN(choice) || choice < 1 || choice > 3) {
      console.log('Invalid choice. Please enter 1, 2, or 3.');
      rl.close();
      showMenu();
      return;
    }

    if (choice === 3) {
      console.log('Goodbye!');
      rl.close();
      process.exit(0);
    }

    rl.question(`Enter API base URL (default: ${DEFAULT_API_URL}): `, apiInput => {
      const apiUrl = apiInput.trim() || DEFAULT_API_URL;

      if (choice === 1) {
        rl.question('Enter search query (or press Enter for all sessions): ', queryInput => {
          const query = queryInput.trim() || null;
          rl.close();

          console.log('\nStarting downloader...\n');
          runDownload(apiUrl, query).catch(err => {
            console.error('Fatal error:', err.message);
            process.exitCode = 1;
          });
        });
        return;
      }

      rl.question('Enter port (default: 3000): ', portInput => {
        const port = parseInt(portInput.trim(), 10) || 3000;
        rl.close();

        console.log(`\nStarting web server on port ${port}...\n`);
        startWebServer(port, apiUrl);
      });
    });
  });
}

process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  console.error('Unhandled Rejection:', reason);
});

if (args.length === 0) {
  showMenu();
} else if (cliMode === 'serve') {
  startWebServer(cliPort, cliApiUrl);
} else {
  runDownload(cliApiUrl, cliQuery).catch(err => {
    console.error('Fatal error:', err.message);
    process.exitCode = 1;
  });
}
