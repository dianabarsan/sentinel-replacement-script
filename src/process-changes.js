const db = require('./db');
const tombstoneUtils = require('@twd/tombstone-utils');

const IDS_TO_IGNORE = /^_design\/|-info$/;
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

  /*
  This code is outdated, but keeping for explanatory reasons

  // fortunately for us, Muso is running 3.6.0 where `latest_replication_date` is set when sentinel processes the doc
  // unfortunately, that has been changed in 3.7.x to be updated to when API receives the doc change
  // it's more correct but we lose this piece of information - maybe we should add it again under a different name
  const infoDocDate = new Date(infoDoc.latest_replication_date).getTime();
  // this is an older document that has been edited recently (sometime between the deletions) and has not been seen
  // by Sentinel yet.
  if (infoDocDate < SENTINEL_RESTART_DATE) {
    return true;
  }
  */

  // since 3.7.x, infodocs are created by API, however API doesn't create the "transitions" property
  // (unless it's an SMS that it runs transitions over itself but this script is not aimed at SMS instances)
  // Sentinel updates the infodocs when it processes the doc for the first time to add "transitions" property.
  // This means that we will not touch documents that have been updated, even if Sentinel hasn't seen their latest seq.
  if (!infoDoc.transitions) {
    return true;
  }
  // An option here would be to have two timestamps available, one representing the time when deletions started and one
  // representing the time we restarted sentinel to bump the seq, unblocking it.
  // If the document was updated within that interval, touch it.
  // I very much do not like the idea of hardcoding or requiring two timestamps parameters.
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
