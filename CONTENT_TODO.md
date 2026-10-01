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

## cloud/gcp-regional-cpu-quota
- [ ] `list-errors` rows follow the documented format, trimmed (the INSTANCE_TEMPLATE and
      VERSION_NAME columns are dropped); the docs' examples say "in zone", and the
      "Limit: 240.0 in region us-central1." wording for a regional quota is from experience.
- [ ] `instance-groups managed describe`, `regions describe` and `managed list` output:
      trimmed and representative.
- [ ] The autoscaler status message is verbatim from the docs; showing it with a timestamp
      in a log view is representative (the console shows it on the instance group pages).

## cloud/azure-cross-region-latency
- [ ] The 85 ms East US to West Europe figure is Microsoft's published P50 for the 30 days
      ending July 30, 2026; re-check it when the table updates. The ~2 ms in-region query
      time and the 86 ms measured from the app are scenario numbers.
- [ ] `az webapp show`, `az postgres flexible-server show` / `replica list` output and the
      `replicationRole` value "AsyncReplica": representative.
- [ ] psql output with `\timing` on: format from the psql docs; the values are scenario data.

## cloud/gcp-lifecycle-deleted-objects
- [ ] `gcloud storage buckets describe --format=json(...)` field names (lifecycle_config,
      soft_delete_policy.retentionDurationSeconds): representative, not verified against a real run.
- [ ] Soft-deleted listing format (`gs://bucket/object#generation`): the docs describe
      generation numbers but don't print a listing.
- [ ] The audit log row is simplified; real entries are JSON with methodName and resourceName.

## aws basics (Phase A: private-subnet-no-route, security-group-port, s3-object-arn, access-keys-to-role, cloudwatch-alarm-stale, nat-gateway-cost)
- [ ] CLI JSON outputs are trimmed and representative (field names from API references).
- [ ] Error texts from experience, not printed in docs: `curl: (28) ...`, `aws s3 cp` "HeadObject ... Forbidden",
      S3 `InvalidAccessKeyId` for a deactivated key, Cost Explorer usage-type rows (USE1-NatGateway-Bytes).

## azure basics (Phase B: nsg-rule-priority, vnet-peering-one-way, key-vault-wrong-role, rbac-wrong-scope, alert-suppressed, vm-stopped-not-deallocated)
- [ ] `az ... --out table` layouts and trimmed JSON: representative (column and field names from the docs where shown).
- [ ] Key Vault 403 text (ForbiddenByRbac, "Caller is not authorized to perform action on resource") and the
      AuthorizationFailed suffix "If access was recently granted, please refresh your credentials.": from experience.
- [ ] Deploy action name `Microsoft.Web/sites/publishxml/action` in the AuthorizationFailed example: representative.
- [ ] Fired-alert history wording "(suppressed by <rule>)" and the processing rule's `actionType: RemoveAllActionGroups`:
      representative; the docs describe the behaviour, not this output.
- [ ] `az network nic show-effective-route-table` table and `nc` output: representative.

## AWS and Azure depth (Phase C incidents)
- [ ] aws-lambda-concurrency-starved: API Gateway execution log lines ("Lambda invocation failed with status: 429",
      "Method completed with status: 502") are from experience; Lambda's exception and reason names are documented.
- [ ] aws-sqs-visibility-timeout: worker log lines and the "release" x-axis labels are scenario data.
- [ ] azure-service-bus-dead-letter: Service Bus Explorer peek layout, the DeadLetterErrorDescription text and the
      System.Text.Json exception message: representative.
- [ ] azure-front-door-host-header: App Service answering 404 for an unknown host name is from experience (not
      printed in the docs); `az afd origin show` / `az webapp config hostname list` output: representative.

## google cloud basics (Phase D: firewall-network-tag, service-account-no-role, alert-retest-window, bigquery-full-scan)
- [ ] Kept representative output minimal (no Google Cloud experience to check against). Remaining items:
      gcloud `--format` output shapes, the bucket IAM policy's legacy bindings, and the INFORMATION_SCHEMA.JOBS
      summary table. The 403 text, dry-run message and retest-window behaviour are from the docs.

## cloud-design (design challenges, all three)
- [ ] aws-vpc-network-layout and azure-vnet-network-layout: costs are scenario units; "S3/storage traffic via NAT"
      at 8 units stands in for per-GB processing charges on several TB a month.
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
