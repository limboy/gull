'use strict';

const { parentPort } = require('worker_threads');
const { parseEpub } = require('./epub-parser');

parentPort.on('message', ({ id, filePath }) => {
  try {
    parentPort.postMessage({ id, result: parseEpub(filePath) });
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
