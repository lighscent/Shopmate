const log = require('logxpert');

log.settings({
  level: process.env.LOG_LEVEL || 'info',
  console: {
    enableTimestamp: true,
    timestampFormat: 'YYYY-MM-DD HH:mm:ss'
  },
  files: {
    folder: 'logs',
    prefix: 'shopmate',
    runNumber: true,
    maxFile: '14d',
    maxSize: '20m',
    zippedArchive: true,
  }
});

module.exports = log;
