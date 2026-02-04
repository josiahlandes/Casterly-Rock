#!/usr/bin/env node
/**
 * SDCP Client for Elegoo Centauri Carbon
 *
 * Implements the Smart Device Control Protocol (SDCP) over WebSocket
 * for local network control of the printer.
 *
 * Usage: node sdcp-client.js <command> [args...]
 */

import { WebSocket } from 'ws';
import { readFileSync, createReadStream } from 'fs';
import { basename } from 'path';
import { createInterface } from 'readline';
import * as http from 'http';

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG_PATHS = [
  process.env.HOME + '/.casterly/config/3d-printing.yaml',
  new URL('../../../config/3d-printing.yaml', import.meta.url).pathname,
];

function loadConfig() {
  for (const path of CONFIG_PATHS) {
    try {
      const content = readFileSync(path, 'utf-8');
      // Simple YAML parsing for printer section
      const addressMatch = content.match(/address:\s*["']?([^"'\n]+)/);
      const portMatch = content.match(/port:\s*(\d+)/);

      return {
        address: addressMatch?.[1]?.trim() || '192.168.1.100',
        port: parseInt(portMatch?.[1] || '80', 10),
      };
    } catch {
      continue;
    }
  }
  return { address: '192.168.1.100', port: 80 };
}

const config = loadConfig();
const WS_URL = `ws://${config.address}/websocket`;
const HTTP_URL = `http://${config.address}`;

// ═══════════════════════════════════════════════════════════════════════════════
// SDCP Protocol Constants
// ═══════════════════════════════════════════════════════════════════════════════

const CMD = {
  REQUEST_STATUS: 0,
  DEVICE_ATTRIBUTES: 1,
  START_PRINT: 128,
  PAUSE_PRINT: 129,
  CANCEL_PRINT: 130,
  RESUME_PRINT: 131,
  LIST_FILES: 258,
  PRINT_HISTORY: 320,
  CAMERA_STREAM: 386,
  TOGGLE_LIGHT: 403,
};

const PRINT_STATUS = {
  0: 'Idle',
  5: 'Pausing',
  8: 'Preparing',
  9: 'Starting',
  10: 'Paused',
  13: 'Printing',
  20: 'Resuming',
};

// ═══════════════════════════════════════════════════════════════════════════════
// WebSocket Communication
// ═══════════════════════════════════════════════════════════════════════════════

function createRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function createMessage(cmd, data = {}) {
  return JSON.stringify({
    Id: '',
    Data: {
      Cmd: cmd,
      Data: data,
      RequestID: createRequestId(),
      MainboardID: '',
      TimeStamp: Math.floor(Date.now() / 1000),
      From: 1,
    },
  });
}

async function sendCommand(cmd, data = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout'));
    }, timeout);

    ws.on('open', () => {
      ws.send(createMessage(cmd, data));
    });

    ws.on('message', (rawData) => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(rawData.toString());
        ws.close();
        resolve(response);
      } catch (e) {
        ws.close();
        reject(new Error('Invalid response'));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function getStatus() {
  const response = await sendCommand(CMD.REQUEST_STATUS);
  return response?.Data?.Status || response;
}

async function getDeviceInfo() {
  const response = await sendCommand(CMD.DEVICE_ATTRIBUTES);
  return response?.Data?.Attributes || response;
}

// ═══════════════════════════════════════════════════════════════════════════════
// File Upload (HTTP, not WebSocket)
// ═══════════════════════════════════════════════════════════════════════════════

async function uploadFile(filepath, filename) {
  const fname = filename || basename(filepath);
  const fileContent = readFileSync(filepath);

  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substr(2);

  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fname}"`,
    'Content-Type: application/octet-stream',
    '',
    '',
  ].join('\r\n');

  const footer = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(header),
    fileContent,
    Buffer.from(footer),
  ]);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: config.address,
        port: config.port,
        path: '/upload',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI Commands
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const [, , command, ...args] = process.argv;

  try {
    switch (command) {
      case 'info': {
        console.log('Connecting to printer...');
        const info = await getDeviceInfo();
        console.log('═══════════════════════════════════════════════════════════');
        console.log('PRINTER INFO (Elegoo Centauri Carbon via SDCP)');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Address:  ${config.address}`);
        console.log(`Protocol: SDCP v3.0 (WebSocket)`);
        if (info.Name) console.log(`Name:     ${info.Name}`);
        if (info.FirmwareVersion) console.log(`Firmware: ${info.FirmwareVersion}`);
        if (info.MacAddress) console.log(`MAC:      ${info.MacAddress}`);
        console.log('═══════════════════════════════════════════════════════════');
        break;
      }

      case 'status': {
        const status = await getStatus();
        const state = PRINT_STATUS[status.CurrentStatus] || `Unknown (${status.CurrentStatus})`;

        console.log('═══════════════════════════════════════════════════════════');
        console.log('PRINT STATUS');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`State:    ${state}`);

        if (status.Filename) {
          console.log(`File:     ${status.Filename}`);
        }

        if (status.PrintProgress !== undefined) {
          console.log(`Progress: ${Math.round(status.PrintProgress)}%`);
        }

        if (status.PrintTime !== undefined && status.PrintTimeLeft !== undefined) {
          const elapsed = Math.round(status.PrintTime / 60);
          const remaining = Math.round(status.PrintTimeLeft / 60);
          console.log(`Time:     ${elapsed}m elapsed, ${remaining}m remaining`);
        }

        console.log('');
        console.log('Temperatures:');
        if (status.TempNozzle !== undefined) {
          console.log(`  Nozzle: ${status.TempNozzle}°C / ${status.TempNozzleTarget || 0}°C`);
        }
        if (status.TempBed !== undefined) {
          console.log(`  Bed:    ${status.TempBed}°C / ${status.TempBedTarget || 0}°C`);
        }
        if (status.TempChamber !== undefined) {
          console.log(`  Chamber: ${status.TempChamber}°C`);
        }

        console.log('═══════════════════════════════════════════════════════════');
        break;
      }

      case 'upload': {
        const filepath = args[0];
        const filename = args[1];

        if (!filepath) {
          console.error('Usage: sdcp-client.js upload <filepath> [filename]');
          process.exit(1);
        }

        console.log(`Uploading ${basename(filepath)}...`);
        const result = await uploadFile(filepath, filename);
        console.log('✓ Upload complete');
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'start': {
        const filename = args[0];
        if (!filename) {
          console.error('Usage: sdcp-client.js start <filename>');
          process.exit(1);
        }

        console.log(`Starting print: ${filename}`);
        await sendCommand(CMD.START_PRINT, { Filename: filename });
        console.log('✓ Print started');
        break;
      }

      case 'pause': {
        console.log('Pausing print...');
        await sendCommand(CMD.PAUSE_PRINT);
        console.log('✓ Print paused');
        break;
      }

      case 'resume': {
        console.log('Resuming print...');
        await sendCommand(CMD.RESUME_PRINT);
        console.log('✓ Print resumed');
        break;
      }

      case 'cancel': {
        console.log('Cancelling print...');
        await sendCommand(CMD.CANCEL_PRINT);
        console.log('✓ Print cancelled');
        break;
      }

      case 'files': {
        const response = await sendCommand(CMD.LIST_FILES, { Path: '/data/print' });
        const files = response?.Data?.FileList || [];

        console.log('Files on printer:');
        if (files.length === 0) {
          console.log('  (no files)');
        } else {
          for (const file of files) {
            const size = file.Size ? ` (${Math.round(file.Size / 1024)}KB)` : '';
            console.log(`  ${file.Name}${size}`);
          }
        }
        break;
      }

      default:
        console.log('SDCP Client for Elegoo Centauri Carbon');
        console.log('');
        console.log('Usage: sdcp-client.js <command> [args...]');
        console.log('');
        console.log('Commands:');
        console.log('  info              Get printer information');
        console.log('  status            Get current print status');
        console.log('  upload <file>     Upload gcode file to printer');
        console.log('  start <filename>  Start printing a file');
        console.log('  pause             Pause current print');
        console.log('  resume            Resume paused print');
        console.log('  cancel            Cancel current print');
        console.log('  files             List files on printer');
        break;
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
