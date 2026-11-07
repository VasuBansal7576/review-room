# Orphan recording maintenance

An interrupted upload can leave a recording file that no saved room event references. These files count against the recording storage limit. Use the operator tool to inspect them with the application's absolute data directory:

```sh
node tools/prune-orphan-recordings.js --data-dir /absolute/path/to/data
```

The default is a dry run. It lists unreferenced files for rooms whose saved records are readable and marks files at least 24 hours old as eligible. Files for missing rooms are counted but never deleted. Invalid room records stop the operation.

To remove eligible files, first stop every application instance using the data directory. Confirm the dry-run list and make a backup if needed. Then run:

```sh
node tools/prune-orphan-recordings.js --data-dir /absolute/path/to/data --delete --server-stopped
```

The `--server-stopped` flag asserts that the operator stopped the app. The tool cannot verify this. Running it while an instance is active can race with new room references. It rechecks references and file identity before each deletion, but this is not a substitute for stopping writers. Deletion is permanent. This tool does not provide backups, automatic retention, or recovery for files whose room record is missing.
