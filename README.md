# D20 MP3 Converter

Windows desktop app that converts music files to MP3 that plays on devices that only read plain MP3 with ID3v2.3 tags.

## Output profile

- MP3, CBR 256 kbps (192 / 256 / 320 selectable), 44.1 kHz (48 kHz selectable), stereo. Surround is downmixed.
- ID3v2.3 tags, ISO-8859-1 or UTF-16 as needed, no ID3v1 trailer. Kept: title, artist, album, album artist, track, disc, year, genre.
- Cover art embedded as baseline JPEG, fitted inside 500x500 (aspect kept), 200 KB or less.
- File names safe for FAT32 / exFAT: `\ / : * ? " < > |` and control characters removed, no trailing dots or spaces, 100 characters maximum, reserved device names escaped. ASCII-only names by default.
- No file over 4 GB: long files are split into numbered parts.

## Input

FLAC, WAV, AIFF, M4A/AAC, ALAC, OGG/Vorbis, Opus, WMA, APE, WavPack, and the audio track of MP4, MKV, WebM and MOV. Files or folders (subfolders included), through the in-app browser or drag and drop.

Existing MP3s:

- Already matching the profile: copied byte for byte, or skipped (setting).
- Wrong tag version or cover: tags and cover rewritten, audio stream copied bit-exact (no re-encode).
- "Re-encode to profile" setting: re-encoded unless target sample rate, stereo and CBR.
- A `.mp3` file that contains something else (for example AAC) is converted.

## Options

Bitrate, sample rate, files at once, keep source folder structure, skip existing outputs, ASCII-only names, "NN - Title" names from tags, title from file name when the tag is missing, cover from `folder.jpg` / `cover.jpg` or a same-named image when tags have none, write `folder.jpg` to output folders, 192 kbps for low-bitrate lossy sources, loudness normalisation (EBU R128, -16 LUFS, off by default), dry run.

## Behaviour

- Output goes next to each source file by default, or into a folder you choose (optionally keeping the source folder structure).
- Originals are opened read-only. Nothing is overwritten: a name that is taken gets ` (2)`.
- Every output is verified with ffprobe after conversion: codec, bitrate, sample rate, channels, duration within 1 s of the source, tag values, tag version, cover present and within limits. Mismatches are listed per file.
- Per-file and overall progress, cancel for one file or the whole run (the partial file is removed), summary of converted / retagged / copied / skipped / failed / cancelled with the failure reason per file.
- Every step is written to an in-memory activity log (backtick key): file, full ffmpeg command, progress, result, errors.

## Clean

Built on the shared clean kit (`clean/`): throwaway Chromium profile in `%TEMP%` that is zeroed and deleted on exit, in-memory session, in-app file browser instead of Windows dialogs, in-memory log, no settings file, no registry writes by the app. Every launch starts from the defaults. GPU acceleration is off so Direct3D does not write a shader cache under `%LOCALAPPDATA%\D3DSCache`. Cover art is passed to ffmpeg over stdin and tags as arguments; there are no temp files. The only files written are the MP3s (and `folder.jpg` if enabled) in the chosen output folder.

ffmpeg and ffprobe are bundled (`@ffmpeg-installer/ffmpeg`, `@ffprobe-installer/ffprobe`); a system ffmpeg is not used.

## Build

Electron 33, electron-builder 25, Windows 10, Git Bash.

    npm install --include=dev
    npm start
    npm run build        # dist/D20Mp3Converter-Setup-<version>.exe and D20Mp3Converter-Portable-<version>.exe

Icon: `electron ../clean-kit/tools/make-icon.js assets/icon.svg.txt assets/icon.png`

## Tests

    node test/make-fixtures.js --long   # inputs in every format, built with the bundled ffmpeg
    node test/headless.js               # converts them all, checks each output with ffprobe and an ID3v2 parser
    node test/e2e-cdp.js [app.exe]      # drives the real window over the Chrome DevTools protocol
    node test/disk-audit.js portable    # snapshot of %TEMP%, %APPDATA%, %LOCALAPPDATA% before and after a full run
    node test/disk-audit.js installed
    node tools/survey.js <library>      # read-only survey of a music folder
    node test/library-dryrun.js <library> <output folder>

APE has no encoder in ffmpeg, so there is no APE fixture; the bundled build has the decoder.
