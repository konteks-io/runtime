#!/usr/bin/env node
const path = require('node:path');
const { pathToFileURL } = require('node:url');
process.env.DO_NOT_TRACK = '1';
import(pathToFileURL(path.resolve(__dirname, '../../..', 'acp-improvement/tools/graft/node_modules/@nanonets/graft/dist/claude/statusline.js')).href).then(m => m.main()).catch(e => console.error('[graft] ' + e.message));
