const db = require('./db');
const tombstoneUtils = require('@twd/tombstone-utils');

const IDS_TO_IGNORE = /^_design\/|-info$/;
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
  delete doc._revisions;

  return {
    _id: tombstoneUtils.generateTombstoneId(doc._id, doc._rev),
    type: 'tombstone',
    tombstone: doc,
  };
};

const isDeleteStub = doc => {
  const stubKeys = ['_id', '_rev', '_deleted', '_revisions'];
  return doc._deleted && Object.keys(doc).every(key => stubKeys.includes(key));
};

const generateTombstones = async (changes) => {
  const getDocs = changes.map(change => ({ id: change.id, rev: change.changes[0].rev }));
  const result = await db.medic.bulkGet({ docs: getDocs, revs: true });
  const docs = result.results.map(result => result.docs[0].ok).filter(doc => doc);

  const stubs = docs.filter(isDeleteStub);
  if (stubs.length) {
    const getPreviousRevs = stubs
      .map(stub => {
        const previousRev = stub._revisions.ids.length > 1 && `${stub._revisions.start - 1}-${stub._revisions.ids[1]}`;
        return previousRev && { id: stub._id, rev: previousRev };
      })
      .filter(pair => pair);
    const result = await db.medic.bulkGet({docs: getPreviousRevs});
    const previousRevs = result.results.map(result => result.docs[0].ok).filter(doc => doc);
    docs.forEach((doc, idx) => {
      if (isDeleteStub(doc)) {
        const previousRev = previousRevs.find(previousRev => previousRev._id === doc._id);
        docs[idx] = Object.assign({}, previousRev, doc);
      }
    });
  }

  const tombstones = docs.map(generateTombstone);
  await db.medic.bulkDocs(tombstones);
};

const processDeletes = async (changes) => {
  await deleteInfoDocs(changes, db.sentinel);
  await deleteInfoDocs(changes, db.medic);
  await generateTombstones(changes);
  changes.forEach(change => console.log('processed delete', change.id));
};

const getChangesToTouch = (changes, infoDocs, dates) => {
  const changesToTouch = [];
  infoDocs.rows.forEach((row, idx) => {
    if (!row.doc) {
      // no infodoc means Sentinel has never seen this doc
      return changesToTouch.push(changes[idx]);
    }
    const infoDoc = row.doc;

    /*
     This code is outdated, but keeping for explanatory reasons

    // fortunately for us, Muso is running 3.6.0 where `latest_replication_date` is set when sentinel processes the doc
    // unfortunately, that has been changed in 3.7.x to be updated to when API receives the doc change
    // it's more correct but we lose this piece of information - maybe we should add it again under a different name
    const infoDocDate = new Date(infoDoc.latest_replication_date).getTime();
    // this is an older document that has been edited recently (sometime between the deletions) and has not been seen
    // by Sentinel yet.
    if (infoDocDate < SENTINEL_RESTART_DATE) {
      return changesToTouch.push(changes[idx]);
    }
    */

    // since 3.7.x, infodocs are created by API, however API doesn't create the "transitions" property
    // (unless it's an SMS that it runs transitions over itself but this script is not aimed at SMS instances)
    // Sentinel updates the infodocs when it processes the doc for the first time to add "transitions" property.
    // This means that we will not touch documents that have been updated, even if Sentinel hasn't seen their latest seq.
    if (!infoDoc.transitions) {
      return changesToTouch.push(changes[idx]);
    }

    // The user can make two dates available to us: the date when Sentinel got blocked and the date it got unblocked.
    // All documents that were edited within that interval should be touched.
    if (dates) {
      const infoDocDate = new Date(infoDoc.latest_replication_date).getTime();
      if (infoDocDate >= dates.start && infoDocDate <= dates.end) {
        return changesToTouch.push(changes[idx]);
      }
    };

    console.log('skipping', changes[idx].id);
  });

  return changesToTouch;
};

const processDocs = async (changes, dates) => {
  const infoDocIds = changes.map(infoDocId);
  const infoDocs = await db.sentinel.allDocs({ keys: infoDocIds, include_docs: true });
  const changesToTouch = getChangesToTouch(changes, infoDocs, dates);
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

const batch = async (seq, dates) => {
  const limit = 1000;
  const opts = {
    limit: limit,
    since: seq,
    batch_size: limit + 1,
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
  await processDocs(nonDeletes, dates);

  return changes.results.length && changes.last_seq;
};

module.exports.execute = async (startSeq, dates) => {
  do {
    startSeq = await batch(startSeq, dates);
  } while (startSeq);
};
