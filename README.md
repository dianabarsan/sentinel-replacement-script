This script will process the whole changes feed, starting with a provided `seq`.
Will process every change following next rules:
- if the change is a design document or tombstone, it is ignored
- if the change is a delete, the tombstone doc is created and the infodoc is deleted
- if the changed doc doesn't have an infodoc, the changed doc is "touched" (saved without changes
) - so it's pushed to the end of the changes feed and actually get processed by the actual
 Sentinel process
- if the changed doc has an infodoc that lacks a "transitions" property, we "touch" the doc
- we don't "touch" the same doc twice  

To install, run  `npm ci`. 

To run, the script requires the following parameters:
- `--url=<your_instance_url_with_authentication>` or 

    `EXPORT COUCH_URL=<your_instance_url_with_authentication>`
- `--since=<the_processed_seq_that_was_overwritten_in_sentinel_meta_data>` or 

    `EXPORT SINCE=<the_processed_seq_that_was_overwritten_in_sentinel_meta_data>`   

Run command example:
`npm run process -- --url=http://admin:pass@localhost:5988/medic --since=3755-fakeseq`

*Disclaimer* 
This script only works for instances running 3.7.x+ at the time of document creation and only
 supports webapp workflows.  
