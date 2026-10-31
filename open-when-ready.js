#!/usr/bin/env node
/**
 * SmartMart POS — open-when-ready
 * Polls the local app until it answers, then opens the browser ONCE.
 * Works on Windows, macOS and Linux. Exits silently on success,
 * exit code 1 if the server never came up within the time limit.
 */
const http = require('node:http')
const { exec } = require('node:child_process')

const port = Number(process.env.PORT || 3000)
const url = process.env.APP_URL || `http://smartmart.local:${port}`
const deadline = Date.now() + 120000 // wait up to 2 minutes

function openBrowser() {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`
  exec(cmd, (error) => {
    if (error) {
      console.error(`Could not open a browser automatically. Open ${url} manually.`)
      process.exitCode = 1
      return
    }
    process.exit(0)
  })
}

function ping() {
  const req = http.get(url, (res) => {
    res.resume() // drain the response
    if (res.statusCode >= 200 && res.statusCode < 400) {
      openBrowser()
      return
    }

    if (Date.now() > deadline) {
      console.error(`SmartMart returned HTTP ${res.statusCode}. Check the server window for errors.`)
      process.exit(1)
      return
    }
    setTimeout(ping, 1500)
  })
  req.setTimeout(2500, () => req.destroy(new Error('slow')))
  req.on('error', () => {
    if (Date.now() > deadline) {
      console.error(`SmartMart did not respond in time. Open ${url} after the server starts.`)
      process.exit(1)
    }
    setTimeout(ping, 1500)
  })
}

ping()
