# Content TODO

Things in scenario files that are unverified, or representative rather than
copied verbatim from official docs. Every scenario's *behavior* claims (what a
command does, why the fix works) are sourced; the items below are mostly exact
*output formatting* that the docs don't print. Check them against a real run
from your own experience and tick them off.

## linux/full-disk
- [ ] `df -h` header row and column layout: df(1) (coreutils 9.11) doesn't print a sample.
- [ ] `du -sh` and `ls -lh` output layout: representative.
- [ ] `OSError: [Errno 28] No space left on device`: the Python docs describe
      errno/strerror but don't show the str() format.
- [ ] logrotate with `missingok` and a glob that matches nothing: logrotate(8)
      documents missingok for a *missing log file*. Confirm it's also silent for
      a non-matching glob (the debrief relies on the documented wording only).
- [ ] `: > file`: Bash docs confirm output redirection truncates an existing file;
      `:` as the null command is standard but not quoted here.

## networking/dns-resolution-failure
- [ ] `dig +short` timeout text `;; connection timed out; no servers could be reached`:
      the BIND 9 dig manual documents exit code 9 ("No reply from server") but not
      this exact message, which differs between BIND versions.
- [ ] `ping -c 3` output (iputils format): representative.
- [ ] `curl: (6) Could not resolve host: <name>`: the libcurl docs confirm error 6
      and its meaning; the exact CLI prefix format is representative.
- [ ] Ansible INI inventory: group syntax matches the docs. Whether `#` comments are
      allowed isn't stated there, so the scenario avoids them.

## containers/image-pull-backoff
- [ ] `kubectl describe pod` Events for a missing tag (Pulling / Failed to pull image
      ... not found / ErrImagePull / Back-off pulling image / ImagePullBackOff): the
      docs describe the states but don't print these event messages; the "not found"
      text varies by container runtime and registry.
- [ ] `kubectl rollout status` "Waiting for rollout to finish" and "exceeded its
      progress deadline" lines are from the Deployments page; the CI log framing
      (`Error: Process completed with exit code 1.`) and registry push output are representative.

## containers/crashloopbackoff
- [ ] `kubectl get pods` RESTARTS column `6 (82s ago)`: the docs' example shows a bare count.
- [ ] `kubectl describe pod` `Environment:` line `<set to the key 'url' in secret 'orders-db'>`: representative.
- [ ] `kubectl top pods` output: representative.
- [ ] `kubectl rollout history` with `<none>` change-cause: representative.

## networking/expired-tls-certificate
- [ ] `certbot certificates` "(INVALID: EXPIRED)" marker: the user guide shows
      "VALID: 30 days" and "INVALID: TEST_CERT"; the expired wording is from experience.
- [ ] letsencrypt.log lines and the dry-run failure text, including
      "Timeout during connect (likely firewall problem)": representative of certbot
      and Let's Encrypt output, not printed in their docs.
- [ ] `curl: (60) SSL certificate problem: certificate has expired` plus the
      "More details here" line: error 60 is documented; the CLI message format is representative.
- [ ] `ufw status` column layout and `systemctl status certbot.timer`: representative.

## linux/oom-killed-service
- [ ] systemd journal lines ("A process of this unit has been killed by the OOM
      killer.", "Failed with result 'oom-kill'.", "Scheduled restart job, restart
      counter is at N."): the oom-kill result is documented; the exact messages are from experience.
- [ ] Kernel OOM report (`Memory cgroup out of memory: Killed process ...`,
      `oom-kill:constraint=CONSTRAINT_MEMCG,...`): representative; field order varies by kernel version.
- [ ] `systemctl status` "Memory: ... (high: ... max: ... available: ... peak: ...)"
      line: format varies by systemd version.
- [ ] `free -h` layout: representative.

## iac/terraform-state-lock
- [ ] The `Error acquiring the state lock` block (box-drawing borders, Lock Info
      fields, closing paragraph) isn't printed in the HashiCorp docs.
      The behavior (lock blocks the run, force-unlock takes the lock ID, docs warn
      against -lock=false) is sourced.
- [ ] `aws s3 ls` output layout and the `terraform.tfstate.tflock` object name: the
      S3 backend docs confirm the `.tflock` suffix.
- [ ] GitHub Actions cancelled-step message `Error: The operation was canceled.`: representative.
- [ ] terraform plan output formatting: representative.

## cicd/failing-github-actions
- [ ] npm ci error lines (`npm error code EUSAGE`, the "can only install packages
      when your package.json and package-lock.json ... are in sync" sentence, the
      `Invalid: lock file's ...` line): npm docs confirm the behavior ("npm ci will
      exit with an error") but don't print the message.
- [ ] setup-node log lines and `Error: Process completed with exit code 1.`: representative.
- [ ] `gh run list` column layout: representative.

## iac/terraform-moved-block
- [ ] Plan output: "will be destroyed", "(because ... is not in configuration)",
      "has moved to", and the "Plan: X to add" summary are Terraform's wording from
      experience; the refactoring docs describe the behavior but don't print a plan.
- [ ] Forced-replacement wording ("must be replaced", "# forces replacement")
      used in hypothesis feedback: from experience.

## cicd/github-token-permissions
- [ ] "GITHUB_TOKEN Permissions" section in the Set up job log: representative.
- [ ] `gh pr edit` failure text with 'Resource not accessible by integration':
      the API message is widely seen but not quoted in GitHub's docs; the gh CLI
      framing is representative.

## microservices/cascading-failure
- [ ] All traces, metrics and logs are synthetic: realistic shapes built from the
      SRE book's and Azure Circuit Breaker pattern's descriptions, not copied from
      a real system.
- [ ] Amazon Builders' Library "Timeouts, retries and backoff with jitter" would be a
      good extra source, but the page is now JavaScript-rendered and couldn't be fetched.

## microservices/poison-message-loop
- [ ] `rabbitmqctl list_queues` / `list_policies` / `rabbitmq-diagnostics cluster_status`
      output layouts: representative.
- [ ] Message rates, CPU and the consumer code are scenario data. The behavior
      claims (requeue to original position, redelivery loops, nack not counting
      toward delivery-limit in 4.3, dead-lettering on reject without requeue,
      purge removes all messages) are sourced.

## cloud/aws-single-az-database
- [ ] AWS Health Dashboard event wording: representative, modeled on typical AZ
      connectivity events rather than copied from a specific one.
- [ ] `aws rds describe-db-instances` JSON: field names match the RDS API
      reference (AvailabilityZone, MultiAZ, ReadReplica*); the trimmed layout
      (with `...`) is ours.
- [ ] ALB target-health and app log lines: representative.

## cloud/azure-appgw-health-probe
- [ ] `az network application-gateway show-backend-health` JSON: the health
      states and the "Status code of the backend's HTTP response didn't match
      the probe setting. Expected:... Received:..." message are from Microsoft's
      docs; the lowercase JSON field names and structure are representative.
- [ ] `az network application-gateway probe show` JSON: representative.

## cloud/gcp-cloud-run-connection-exhaustion
- [ ] PostgreSQL `FATAL:  sorry, too many clients already` wording, wrapped by
      psycopg2/SQLAlchemy: widely seen but not quoted from the PostgreSQL docs here.
- [ ] `gcloud run services describe` and `gcloud sql instances describe` output:
      representative.
- [ ] `--max` flag: taken from the current Cloud Run docs (older docs and
      scripts use `--max-instances`).

## cloud/azure-public-blob-container
- [ ] `az storage container show-permission` output (`{"publicAccess": "container"}` / `"off"`):
      the docs show the command, not its output.
- [ ] Anonymous List Blobs on a private container returning `ResourceNotFound`: from
      experience (Azure doesn't confirm a private container exists); not in the docs.
- [ ] StorageBlobLogs rows (columns, OperationName values) and the IPs: representative;
      the documented query filters on AuthenticationType == "Anonymous".

## cloud/aws-permissions-boundary
- [ ] The AccessDeniedException text follows the documented permissions-boundary
      format; the assumed-role ARN and the app's log framing are representative.
- [ ] `get-role --query Role.PermissionsBoundary`, `get-role-policy`, `simulate-principal-policy`
      and `ecs describe-services` output layouts: field names are from the API references,
      the JSON shapes are trimmed and representative.

## cloud/aws-route53-failover
- [ ] `get-health-check-status` status strings ("Failure: Connection timed out. The endpoint
      or the internet connection is down, or requests are being blocked by your firewall.",
      "Failure: HTTP Status Code 503, ...", "Success: HTTP Status Code 200, OK"): from experience.
- [ ] `list-resource-record-sets` and `describe-security-groups` output: trimmed and representative.
- [ ] The pl-0r53hc prefix list id is invented; the docs say AWS-managed prefix lists exist for
      the health checker ranges but this page doesn't name the list.

## cloud-design (design challenges, all three)
- [ ] Cost units are illustrative by design (PLAN_DESIGN_CHALLENGES.md §2). Check
      that the relative ordering feels right to you.
- [ ] Hidden capabilities (`scales`, `survives`) are judgment calls, not doc
      facts. For example: Front Door caching absorbs a 20× static-page spike
      (`scales: 20`), and Application Gateway doesn't (`scales: 1`). Review these
      against your experience.

## cloud-design/aws-checkout-az-resilience
- [ ] "Every instance launches in the one Availability Zone you gave the group"
      is inferred from how Auto Scaling groups use subnets; not quoted.

## cloud-design/azure-tv-ad-marketing-site
- [ ] Standard plan facts are from "Reliability in Azure App Service" (fault
      domains; nonzonal plans can go down in a zone outage). Cost of Standard vs.
      Premium v3 is illustrative.

## cloud-design/gcp-launch-day-signups
- [ ] "About 60 Cloud Run instances at peak" and the 500-connection limit are
      scenario numbers, not Google figures.

## cloud-design/aws-checkout-canvas (canvas, not playable until C3)
- [ ] Web server capacity (2× normal traffic each) is a scenario number.
- [ ] The engine's model: a `sync` link = automatic failover with no lost
      writes; an `async` link = manual promotion, possible lost writes. That
      matches RDS Multi-AZ vs. read replicas (sourced), but it's a simplification
      for other databases.
- [ ] Apps reaching the database "through its endpoint" (so a traffic link to
      the primary also reaches its sync standby after failover) models the RDS
      DNS switch described in the failover docs.

## cloud-design/azure-portal-canvas and gcp-signup-canvas
- [ ] Capacities (App Service instance 2×, VM 2×, Cloud Run 6×) and costs are
      scenario numbers.
- [ ] Placing App Service instances in zone lanes models how a zone-redundant
      plan spreads instances; in Azure you don't place instances yourself.
- [ ] The GCP "regional load balancer" palette item's fact is paraphrased from
      the Compute Engine regions/zones guidance (move traffic to another zone),
      not from a load-balancing product page.

## cloud-design/zone-resilient-checkout ("pick your cloud")
- [ ] The GCP load balancer's "spread backends across zones" fact is paraphrased
      from the Compute Engine regions/zones guidance; the load-balancing overview
      only states that regional load balancers support backends in one region.
- [ ] Web server capacity (1× each) and all costs are scenario numbers.
- [ ] The `differences` notes are the author's comparison of sourced facts;
      review them for anything you'd phrase differently from experience.

## cloud-design/traffic-spike-any-cloud ("pick your cloud", slot)
- [ ] CloudFront facts come from the cache-hit-ratio page ("served directly from
      the CloudFront cache instead of going to your origin servers"); a general
      "how CloudFront works" page would be a better second source.
- [ ] The "scales: 20" judgment for CDNs and "scales: 1" for regional load
      balancers is the same simplification as the Azure TV-ad challenge.
- [ ] The Regional ALB option on Google Cloud: its "every request is forwarded"
      fact is how the option is used here (no caching configured), not a
      product limitation.
