# Unzip Files Online — specification

**Tagline:** Open a ZIP in your browser, browse its files, and save one or all of them, with nothing uploaded.

**Category:** Data & Files

**Free alternative to:** ezyZip Unzip (uploads or processes through an ad-supported page, sign-up prompts for big archives, mobile experience cluttered with ads and fake download buttons)

**Search phrases:** unzip online, open zip file online, extract zip online, unzip files on phone, zip extractor, view zip contents

**Allowed libraries:** fflate

**Published at:** https://turhe123.github.io/unzip-files-local/

## Acceptance checks (each must have a test)

- dropping sample-archive.zip lists its files with sizes and folder structure
- clicking a text file entry shows a preview of its first lines
- clicking Save on one entry downloads that file with its original name
- the Save all button downloads each file or a re-zipped copy without errors
- a corrupt file shows a clear error message
- works at 390px wide

## Spec

Search demand: unzip online, open zip file online and extract zip on phone are constant queries, especially from people on Chromebooks, locked-down work laptops, iPhones and tablets where no archive tool is installed. Existing sites such as ezyZip and similar are loaded with ads, lookalike download buttons, upload steps for some formats, and size limits. People also worry that sensitive archives, such as bank statements or exported data, are being sent to a stranger's server.

Our version does one job: open a ZIP archive locally and let the user inspect and extract files. Features: drop or pick a ZIP, a file tree with folders collapsible, columns for name, size, compressed size and modified date, search filter by name, text and image preview for selected entries, per entry Save buttons, checkboxes for selecting several entries, and a Save selected action that downloads the chosen files. Encrypted entries are detected and marked as password protected with a clear message that this tool cannot open them, rather than failing silently. Zip bomb protection shows a warning if the total uncompressed size is above a threshold.

UI: a drop zone above the fold. After loading, a header shows archive name, number of files, total uncompressed size and compression ratio. Below is the file list with checkboxes, then a sticky action bar with Save selected and Save all as separate files. Preview opens in a side panel on wide screens and below the list on narrow screens. Empty state states that files never leave the device. Error state distinguishes not a zip file, corrupt archive and unsupported compression. Keyboard: arrow keys move through the list, space toggles the checkbox, Enter opens the preview.

Technical approach: read the file with the File API, scan the end of central directory record to list entries cheaply without inflating anything, using the allowed fflate library for the unzip step and its synchronous or streaming inflate in a Web Worker for entries over a few megabytes. Decompress only entries the user requests, keeping memory low. Create Blobs with a MIME type guessed from the extension and download through revocable object URLs for several files trigger staggered anchor clicks, with an alternative option to repack the selected entries into a new ZIP via fflate zip. Decode file names as UTF-8 when the flag is set, otherwise attempt a CP437 decode, which fixes garbled names from older Windows archives. Text preview decodes the first 4 KB with TextDecoder image preview uses an object URL in an image element with a size cap.

Edge cases: archives over 1 GB may exhaust memory on mobile Safari, so show a size warning before extraction nested ZIPs are listed and can be opened by clicking paths containing dot dot segments are sanitised so saved names cannot traverse duplicate names are numbered empty folders are shown ZIP64 is supported by fflate self extracting executables are rejected multi-part archives are explained as unsupported.

Demo data: a bundled archive named holiday-photos-notes.zip from a fictional family trip containing a readme text file, a CSV packing list, a small PNG and a folder named Receipts with two text files, one with an accented file name.
