# VRCJAT Audio Downloader

Small Node.js utility for downloading stored Opus audio frames from the VRCJAT STT API and converting each session into a WAV file.

Sessions are grouped by display name and saved under the `audio` directory.

## Output

Files are stored like this:

```text
audio/
├── Username/
│   ├── 123.wav
│   └── 456.wav
└── Another User/
    └── 789.wav
```

Existing WAV files are skipped, so the script can be stopped and started again without downloading completed sessions a second time.

## Requirements

* Node.js 18 or newer
* npm

## Install

Clone the repository and install the dependencies:

```bash
git clone https://github.com/BarcodeBimbo/Vrcjat_Ripper.git
cd Vrcjat_Ripper
npm install
```

Required packages:

```bash
npm install axios opus-decoder wav
```

## Run

```bash
node ripper.js
```

The script will:

1. Fetch all available sessions from the API.
2. Fetch the Opus frames for each session.
3. Sort the frames by sequence number.
4. Decode the Opus audio.
5. Write the decoded audio to a WAV file.
6. Skip sessions that have already been downloaded.

## Configuration

The main settings are at the top of `ripper.js`:

```js
const API_URL = 'https://stt.vrcjat.com/api';
const OUTPUT_DIR = path.join(__dirname, 'audio');

const PAGE_SIZE = 200;
const REQUEST_DELAY = 150;
```

`API_URL` controls the API endpoint.

`OUTPUT_DIR` controls where WAV files are saved.

`PAGE_SIZE` controls how many sessions or frames are requested at once.

`REQUEST_DELAY` adds a small delay between API requests.

## Audio Format

Generated files use:

```text
Sample rate: 48,000 Hz
Channels:    Mono
Format:      32-bit float WAV
```

The source session can contain more than one channel, but the current exporter writes the first decoded channel to the WAV file.

## Resuming Downloads

The downloader checks whether the expected WAV file already exists before processing a session.

For example:

```text
audio/ExampleUser/123.wav
```

If the file already exists, session `123` is skipped.

This makes it safe to rerun the downloader after an interruption.

## Invalid Frames

Individual Opus frames that cannot be decoded are skipped.

A session is marked as failed if it contains no frames or none of its frames produce usable audio.

Failures in one session do not stop the rest of the download.

## File Names

Characters that are not valid in Windows file or directory names are replaced with underscores:

```text
\ / : * ? " < > |
```

This allows display names to be used safely as directory names on Windows.

## Why?

<div align="center">
  <img src="https://github.com/user-attachments/assets/a84dbec0-b4b8-48b8-a65e-c9c21ca8f44b" alt="" height="200">
</div>

## License

This project is licensed under the MIT License. See the [LICENSE](https://github.com/BarcodeBimbo/Vrcjat_Ripper/blob/main/LICENSE) file for details.
