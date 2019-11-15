const program = require('commander');
const db = require('./db');
const processChanges = require('./process-changes');

program.version('0.0.1');
program
  .option('--since <since>', 'Start processing from this CouchDB seq')
  .option('--url <url>', 'Instance url');

program.parse(process.argv);

const parseUrl = (couchUrl) => {
  couchUrl = couchUrl.replace(/\/$/, ''); // replace trailing slash
  try {
    const url = new URL(couchUrl);
    if (url.pathname === '/') {
      url.pathname = 'medic';
    }
    return url;
  } catch (err) {
    console.err('Error while parsing provided instance URL', err.message);
    process.exit(1);
  }
};

const couchUrl = program.url || process.env.COUCH_URL;
const since = program.since || process.env.SINCE;

if (!couchUrl) {
  console.error('Instance url not provided');
  process.exit(1);
}
if (!since) {
  console.error('Since SEQ not provided');
  process.exit(1);
}

db.init(parseUrl(couchUrl));

(async () => {
  try {
    await processChanges.execute(since);
  } catch (err) {
    console.error(err);
  }
})();


