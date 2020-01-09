const program = require('commander');
const db = require('./db');
const processChangesBulk = require('./process_changes_bulk');

program.version('0.0.1');
program
  .option('--since <since>', 'Start processing from this CouchDB seq')
  .option('--url <url>', 'Instance url')
  .option('--start <timestamp>', 'Date when Sentinel became blocked (date of deletions)')
  .option('--end <timestamp>', 'Date when Sentinel became unblocked (restarted)');

program.parse(process.argv);

const throwError = (err, message = '') => {
  console.error(err, message);
  process.exit(1);
};

const parseUrl = (couchUrl) => {
  couchUrl = couchUrl.replace(/\/$/, ''); // replace trailing slash
  try {
    const url = new URL(couchUrl);
    if (url.pathname === '/') {
      url.pathname = 'medic';
    }
    return url;
  } catch (err) {
    throwError('Error while parsing provided instance URL', err.message);
  }
};

const couchUrl = program.url || process.env.COUCH_URL;
const since = program.since || process.env.SINCE;
let dates = false;

if (!couchUrl) {
  throwError('Instance url not provided');
}
if (!since) {
  throwError('Since SEQ not provided');
}

let startTs = program.start || process.env.START_DATE;
let endTs = program.end || process.env.END_DATE;

if (startTs || endTs) {
  startTs = Date.parse(startTs);
  endTs = Date.parse(endTs);
  if (isNaN(startTs)) {
    throwError('Invalid start date');
  }
  if (isNaN(endTs)) {
    throwError('Invalid end date');
  }

  dates = {
    start: startTs,
    end: endTs,
  };
}

db.init(parseUrl(couchUrl));

(async () => {
  try {
    await processChangesBulk.execute(since, dates);
  } catch (err) {
    console.error(err);
  }
})();
