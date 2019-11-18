const db = require('./db');
const tombstoneUtils = require('@twd/tombstone-utils');

const IDS_TO_IGNORE = /^_design\/|-info$/;
// this is the day we restarted Sentinel, should this be a param ?
const SENTINEL_RESTART_DATE = new Date('2019-11-13T13:00:000Z').getTime();
const TOUCHED_DOCS_CACHE = {};

const infoDocId = change => `${change.id}-info`;

const deleteInfoDocs = async (changes, database) => {
  const infoDocIds = changes.map(infoDocId);
  const infoDocs = await database.allDocs({ keys: infoDocIds, include_docs: true });
  const infoDocDeletes = infoDocs.rows
    .map(row => row.doc && (row.doc._deleted = true) && row.doc)
    .filter(doc => doc);
  if (!infoDocDeletes.length) {
    return;
  }

  await database.bulkDocs(infoDocDeletes);
};

const generateTombstone = (doc) => {
  delete doc._attachments;
  delete doc._deleted;

  return {
    _id: tombstoneUtils.generateTombstoneId(doc._id, doc._rev),
    type: 'tombstone',
    tombstone: doc,
  };
};

const generateTombstones = async (changes) => {
  const getDocs = changes.map(change => ({ id: change.id, rev: change.changes[0].rev }));
  const result = await db.medic.bulkGet({ docs: getDocs });
  const docs = result.results.map(result => result.docs[0].ok).filter(doc => doc);

  const tombstones = docs.map(generateTombstone);
  await db.medic.bulkDocs(tombstones);
};

const processDeletes = async (changes) => {
  await deleteInfoDocs(changes, db.sentinel);
  await deleteInfoDocs(changes, db.medic);
  await generateTombstones(changes);
  changes.forEach(change => console.log('processed delete', change.id));
};

const getChangesToTouch = (changes, infoDocs) => {
  const changesToTouch = [];
  infoDocs.rows.forEach((row, idx) => {
    if (!row.doc) {
      // no infodoc means Sentinel has never seen this doc
      return changesToTouch.push(changes[idx]);
    }
    const infoDoc = row.doc;
    // fortunately for us, Muso is running 3.6.0 where `latest_replication_date` is set when sentinel processes the doc
    // unfortunately, that has been changed in 3.7.x to be updated to when API receives the doc change
    // it's more correct but we lose this piece of information - maybe we should add it again under a different name
    const infoDocDate = new Date(infoDoc.latest_replication_date).getTime();
    // this is an older document that has been edited recently (sometime between the deletions) and has not been seen
    // by Sentinel yet.
    if (infoDocDate < SENTINEL_RESTART_DATE) {
      return changesToTouch.push(changes[idx]);
    }

    console.log('skipping', changes[idx].id);
  });

  return changesToTouch;
};

const processDocs = async (changes) => {
  const infoDocIds = changes.map(infoDocId);
  const infoDocs = await db.sentinel.allDocs({ keys: infoDocIds, include_docs: true });
  const changesToTouch = getChangesToTouch(changes, infoDocs);
  if (!changesToTouch.length) {
    return;
  }

  const requestDocs = changesToTouch.map(change => ({ id: change.id }));
  const result = await db.medic.bulkGet({ docs: requestDocs });
  const docs = result.results.map(result => result.docs[0].ok).filter(doc => doc);
  if (!docs.length) {
    return;
  }
  await db.medic.bulkDocs(docs);
  docs.forEach(doc => {
    TOUCHED_DOCS_CACHE[doc._id] = true;
    console.log('touched doc', doc._id);
  });
};

const batch = async (seq) => {
  const opts = {
    limit: 100,
    since: seq,
  };
  console.log('Getting changes from', seq);
  const changes = await db.medic.changes(opts);

  const deletes = [];
  const nonDeletes = [];

  for (let change of changes.results) {
    if (change.id.match(IDS_TO_IGNORE) || tombstoneUtils.isTombstoneId(change.id)) {
      continue;
    }

    if (change.deleted) {
      deletes.push(change);
      continue;
    }

    // we're going to process the whole changes feed, and quite possibly, as we touch docs we're going to find them again
    // when getting close to the end of the queue. Maybe Sentinel has not reached them yet, checking for an infodoc will fail.
    // So we keep their ids in memory so they don't get touched twice.
    if (TOUCHED_DOCS_CACHE[change.id]) {
      // we pushed this doc to the end of the queue and now we're finding it again.
      continue;
    }

    nonDeletes.push(change);
  }

  await processDeletes(deletes);
  await processDocs(nonDeletes);

  return changes.results.length && changes.last_seq;
};

module.exports.execute = async (startSeq) => {
  do {
    startSeq = await batch(startSeq);
  } while (startSeq);
};
