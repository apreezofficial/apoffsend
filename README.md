# ApOffSend

Send files and text between your **PC and phone, offline**. It runs a small
server on your PC; your phone opens it in the browser by scanning a QR code.
No internet, no cloud, no app to install on the phone, no npm dependencies.

- PC → phone and phone → PC, any file type, any size (streamed, not loaded into memory)
- Live progress, speed and time left; queue many files at once
- Download everything as one `.zip`
- Resumable / seekable downloads (HTTP range requests — videos play right in the browser)
- Share text and links both ways, with one-tap copy
- New files show up instantly on both sides
- Drag and drop or paste (Ctrl+V) files on the PC
- Access code in the QR link so other people on the same Wi-Fi can't get in

## Install on a PC

Install page: **https://apoffsend.pxxl.pro**

**Windows, easiest:** download [ApOffSend-Setup.bat](https://apoffsend.pxxl.pro/ApOffSend-Setup.bat) and double-click it.
It downloads ApOffSend, installs Node.js if it is missing, and adds Desktop and Start Menu shortcuts.
If Windows says it protected your PC, click **More info → Run anyway**.

Or paste this into Command Prompt or PowerShell:

```bash
powershell -c "irm https://raw.githubusercontent.com/apreezofficial/apoffsend/main/public/install.ps1 | iex"
```

Or [download the zip](https://github.com/apreezofficial/apoffsend/archive/refs/heads/main.zip). You need
[Node.js](https://nodejs.org) 18 or newer, and nothing else.

## Start

**Windows:** double-click `start.bat`.

**Any OS:**

```bash
node server.js
```

The browser opens on the PC with a QR code. Scan it with your phone's camera
and you're connected.

## Getting the phone and PC on the same network (no internet needed)

Pick one:

1. **Same Wi-Fi router** — a router works even without internet.
2. **Phone hotspot** — turn on the hotspot on your phone and connect the PC to it.
   Mobile data can be off.
3. **PC hotspot** — on Windows: Settings → Network → Mobile hotspot, then join it from the phone.

## If the phone can't open the page

- Windows Firewall: the first time you start it, Windows asks whether to allow
  Node.js — allow it on **Private and Public** networks (phone hotspots are often
  marked Public). Or run `firewall.bat` as administrator once.
- If the PC page lists several addresses, tap another one to switch the QR code.
- Guest Wi-Fi networks often block devices from seeing each other — use a hotspot instead.

## Where files go

```
~/ApOffSend/from-pc      files the PC sends (the phone downloads these)
~/ApOffSend/from-phone   files received from the phone
```

You can also drop files straight into `from-pc` with Explorer — they appear on the phone.

## Options

```
node server.js [options] [files to share...]

  -p, --port <n>   Port (default 8080; the next free one is used if taken)
  -d, --dir <dir>  Folder for transferred files (default ~/ApOffSend)
      --no-open    Don't open the browser on the PC
      --no-pin     Don't require the access code
```

Example — share two files straight from the command line:

```bash
node server.js "C:\Videos\clip.mp4" report.pdf
```

## Hosting the install page

If you deploy this repo to a hosting service, visitors there only get the install page.
Requests that come through a reverse proxy (`X-Forwarded-For` and similar headers) are
treated as internet traffic. They can't see or send files and never get the access code.
Transfers only happen on the copy running on your own PC.

## Test

```bash
npm test
```
