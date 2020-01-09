This script will process the whole changes feed, starting with a provided `seq`.
Will process every change following next rules:
- if the change is a design document or tombstone, it is ignored
- if the change is a delete, the tombstone doc is created and the infodoc is deleted
- if the changed doc doesn't have an infodoc, the changed doc is "touched" (saved without changes
) - so it's pushed to the end of the changes feed and actually get processed by the actual
 Sentinel process
- if the changed doc has an infodoc that lacks a "transitions" property, we "touch" the doc
- optionally, if you provide two date parameters, which represent the moment the documents were
 deleted and the moment Sentinel was restarted after fast-forwarding, every doc that has
  been edited between those two dates will be touched. 
- we don't "touch" the same doc twice  

To install, run  `npm ci`. 

To run, the script requires the following parameters:
- `--url=<your_instance_url_with_authentication>` or 

    `EXPORT COUCH_URL=<your_instance_url_with_authentication>`
- `--since=<the_processed_seq_that_was_overwritten_in_sentinel_meta_data>` or 

    `EXPORT SINCE=<the_processed_seq_that_was_overwritten_in_sentinel_meta_data>`   
    
- `--start=<your_start_date>` OR

   `EXPORT START_DATE=<your_start_date>`
    
- `--end=<your_end_date>` OR

   `EXPORT END_DATE=<your_end_date>`

Run command example:
`npm run process -- --url=http://admin:pass@localhost:5988/medic --since=3755-fakeseq`

`npm run process -- --url=http://admin:pass@localhost:5988/medic --since=3755-fakeseq --start
="2019-12-30 11:20:33" --end="2020-01-07 23:29:10"`

*Disclaimer* 
This script only works for instances running 3.7.x+ at the time of document deletion and only
 supports webapp workflows.  
