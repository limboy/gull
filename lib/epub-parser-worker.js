'use strict';

const { parentPort } = require('worker_threads');
const { parseEpub, parseEpubCover } = require('./epub-parser');

// Both tasks read the same archives, so they share one worker rather than
// competing for the Electron main thread.
const TASKS = {
  parse: parseEpub,
  cover: parseEpubCover,
};

parentPort.on('message', ({ id, filePath, task = 'parse' }) => {
  try {
    const run = TASKS[task];
    if (!run) throw new Error(`Unknown worker task: ${task}`);
    parentPort.postMessage({ id, result: run(filePath) });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
  }
});
