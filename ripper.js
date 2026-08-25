const axios = require('axios');
const { OpusDecoder } = require('opus-decoder');
const { Writer } = require('wav');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://stt.vrcjat.com/api';
const OUTPUT_DIR = path.join(__dirname, 'audio');

const PAGE_SIZE = 200;
const REQUEST_DELAY = 150;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function safeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

async function getSessions() {
    const sessions = [];
    let after;

    for (;;) {
        const params = {
            limit: PAGE_SIZE
        };

        if (after) {
            params.after = after;
        }

        const response = await axios.get(`${API_URL}/sessions`, { params });
        const data = response.data;

        if (Array.isArray(data.sessions)) {
            sessions.push(...data.sessions);
        }

        if (!data.hasMore) {
            break;
        }

        after = data.nextAfter;
        await sleep(REQUEST_DELAY);
    }

    return sessions;
}

async function getFrames(sessionId) {
    const frames = [];
    let afterSeq = 0;

    for (;;) {
        const response = await axios.get(
            `${API_URL}/sessions/${sessionId}/opus-frames`,
            {
                params: {
                    afterSeq,
                    limit: PAGE_SIZE
                }
            }
        );

        const data = response.data;

        if (Array.isArray(data.frames)) {
            frames.push(...data.frames);
        }

        if (!data.hasMore) {
            break;
        }

        afterSeq = data.nextAfterSeq;
        await sleep(REQUEST_DELAY);
    }

    return frames;
}

async function decodeFrames(frames, channels) {
    const decoder = new OpusDecoder({
        sampleRate: 48000,
        channels
    });

    await decoder.ready;

    const chunks = [];
    let sampleCount = 0;

    try {
        for (const frame of frames) {
            if (!frame.b64) {
                continue;
            }

            try {
                const opusData = Buffer.from(frame.b64, 'base64');
                const decoded = decoder.decodeFrame(opusData);

                if (!decoded.samplesDecoded || !decoded.channelData?.length) {
                    continue;
                }

                const samples = decoded.channelData[0];

                chunks.push(samples);
                sampleCount += samples.length;
            } catch {
                // Skip bad frames instead of dropping the entire session.
            }
        }
    } finally {
        decoder.free();
    }

    if (!sampleCount) {
        return null;
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

        writer.end(
            Buffer.from(
                pcm.buffer,
                pcm.byteOffset,
                pcm.byteLength
            )
        );
    });
}

async function downloadSession(session) {
    const username = session.display_name || `user_${session.id}`;
    const folderName = safeFilename(username) || `user_${session.id}`;

    const userDir = path.join(OUTPUT_DIR, folderName);
    const outputFile = path.join(userDir, `${session.id}.wav`);

    if (fs.existsSync(outputFile)) {
        return 'skipped';
    }

    console.log(`Downloading session ${session.id} (${username})`);

    const frames = await getFrames(session.id);

    if (!frames.length) {
        console.log(`No audio frames found for session ${session.id}`);
        return 'failed';
    }

    frames.sort((a, b) => a.seq - b.seq);

    const pcm = await decodeFrames(frames, session.channels || 1);

    if (!pcm) {
        console.log(`No usable audio found for session ${session.id}`);
        return 'failed';
    }

    fs.mkdirSync(userDir, { recursive: true });

    await writeWav(outputFile, pcm);

    const seconds = pcm.length / 48000;

    console.log(`Saved ${outputFile} (${seconds.toFixed(2)}s)`);

    return 'success';
}

async function main() {
    console.log('Fetching sessions...');

    const sessions = await getSessions();

    console.log(`Found ${sessions.length} sessions.`);
    console.log('');

    const totals = {
        success: 0,
        skipped: 0,
        failed: 0
    };

    for (const session of sessions) {
        try {
            const result = await downloadSession(session);
            totals[result]++;
        } catch (error) {
            totals.failed++;

            const message = error.response?.status
                ? `HTTP ${error.response.status}`
                : error.message;

            console.error(`Session ${session.id} failed: ${message}`);
        }

        await sleep(REQUEST_DELAY);
    }

    console.log('');
    console.log(`Downloaded: ${totals.success}`);
    console.log(`Skipped:    ${totals.skipped}`);
    console.log(`Failed:     ${totals.failed}`);
}

main().catch(error => {
    console.error('Fatal error:', error.message);
    process.exitCode = 1;
});