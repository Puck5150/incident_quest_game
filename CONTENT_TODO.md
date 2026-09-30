# Content TODO

Things in scenario files that are unverified, or representative rather than
copied from official docs. Resolve each item before calling a scenario "done".

## linux/full-disk (Milestone 2 placeholder; full rewrite in Milestone 5)
- [ ] Entire scenario is a placeholder written to exercise the engine.
- [ ] `df -h` output: column headers and layout are representative. The df(1) man
      page (coreutils 9.11) does not document the default header row.
- [ ] Deleting a file a process holds open doesn't free space until it's closed:
      cite unlink(2).
- [ ] Truncating with `: > file` keeps the inode, so the open file handle stays valid.
      Find an official source.
- [ ] logrotate syntax (`daily`, `rotate`, `compress`, `missingok`) and the claim
      that `missingok` hides a glob that matches nothing: verify against logrotate(8).
- [ ] Python `OSError: [Errno 28] No space left on device` message format: verify
      against docs.python.org.
- [ ] nginx "upstream prematurely closed connection" log line format: verify
      against nginx.org docs.
