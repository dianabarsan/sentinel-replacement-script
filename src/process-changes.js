const db = require('./db');
const tombstoneUtils = require('@twd/tombstone-utils');

const IDS_TO_IGNORE = /^_design\/|-info$/;
// this is the day we restarted Sentinel, should this be a param ?
const SENTINEL_RESTART_DATE = new Date('2019-11-13T13:00:000Z').getTime();
const TOUCHED_DOCS_CACHE = {};

const handle404 = promise => {
  return promise.catch(err => {
    if (err.status !== 404) {
      throw err;
    }
  })
};

const infoDocId = change => `${change.id}-info`;

const deleteInfoDoc = async (change, database) => {
  const medicInfoDoc = await database.get(infoDocId(change));
  medicInfoDoc._deleted = true;
  await database.put(medicInfoDoc);
};

const processDelete = async (change) => {
  await handle404(deleteInfoDoc(change, db.medic));
  await handle404(deleteInfoDoc(change, db.sentinel));
  await handle404(tombstoneUtils.processChange(Promise, db.medic, change));
};

const needsProcessing = async (change) => {
  // we're going to process the whole changes feed, and quite possibly, as we touch docs we're going to find them again
  // when getting close to the end of the queue. Maybe Sentinel has not reached them yet, checking for an infodoc will fail.
  // So we keep their ids in memory so they don't get touched twice.
  if (TOUCHED_DOCS_CACHE[change.id]) {
    // we pushed this doc to the end of the queue and now we're finding it again.
    return false;
  }

  const infoDoc = await handle404(db.sentinel.get(infoDocId(change)));
  // no infodoc means Sentinel has never seen this doc
  if (!infoDoc) {
    return true;
  }

  // fortunately for us, Muso is running 3.6.0 where `latest_replication_date` is set when sentinel processes the doc
  // unfortunately, that has been changed in 3.7.x to be updated to when API receives the doc change
  // it's more correct but we lose this piece of information - maybe we should add it again under a different name
  const infoDocDate = new Date(infoDoc.latest_replication_date).getTime();
  // this is an older document that has been edited recently (sometime between the deletions) and has not been seen
  // by Sentinel yet.
  if (infoDocDate < SENTINEL_RESTART_DATE) {
    return true;
  }
};

const processChange = async (change) => {
  if (change.id.match(IDS_TO_IGNORE) || tombstoneUtils.isTombstoneId(change.id)) {
    return;
  }

  if (change.deleted) {
    console.log('Processing delete', change.id);
    return processDelete(change);
  }

  const shouldTouchDoc = await needsProcessing(change);
  if (!shouldTouchDoc) {
    console.log('Skipping doc', change.id);
    return;
  }

  console.log('Touching doc', change.id);
  const doc = await db.medic.get(change.id);
  await db.medic.put(doc);
  TOUCHED_DOCS_CACHE[change.id] = true;
};

const batch = async (seq) => {
  const opts = {
    limit: 100,
    since: seq,
  };
  console.log('Getting changes from', seq);
  const changes = await db.medic.changes(opts);
  for (let change of changes.results) {
    await processChange(change);
  }

  return changes.results.length && changes.last_seq;
};

module.exports.execute = async (startSeq) => {
  do {
    startSeq = await batch(startSeq);
  } while (startSeq);
};
