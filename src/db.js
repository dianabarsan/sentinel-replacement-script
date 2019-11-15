const PouchDB = require('pouchdb-core');
PouchDB.plugin(require('pouchdb-adapter-http'));

module.exports.init = (url) => {
  module.exports.medic = new PouchDB(url.href);
  module.exports.sentinel = new PouchDB(url.href + '-sentinel');
};
