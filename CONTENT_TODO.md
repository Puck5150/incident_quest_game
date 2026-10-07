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

## AWS and Azure depth, batch 2
- [ ] aws-lambda-vpc-public-subnet: Lambda log framing around "Task timed out after 30.03 seconds" is representative.
- [ ] aws-asg-elb-health-check: CLI output tables trimmed; describe-auto-scaling-instances health shown as HEALTHY.
- [ ] aws-s3-sse-kms-decrypt: the AccessDenied text naming kms:Decrypt follows the documented format; how S3 relays
      it to the caller is from experience.
- [ ] azure-slot-swap-connection-string: `az webapp config connection-string list` table shape, orders-per-hour table.
- [ ] azure-private-endpoint-dns: nslookup output, the 403 AuthorizationFailure text, the public storage host name.
- [ ] azure-cosmos-hot-partition: metric chart values and the container show/throughput output shapes.

## Exam-outline gap batch (S3 classes, DynamoDB, CloudFront, Azure Files, Policy, Backup)
- [ ] aws-cloudfront-stale-index: S3 returning 403 (not 404) for a missing object when the reader can't list the
      bucket is from experience; header lines and ages are representative.
- [ ] aws-dynamodb-gsi-throttle / aws-s3-glacier-lifecycle: CLI query outputs and metric values are representative.
- [ ] azure-files-port-445: firewall rule table is scenario data; Test-NetConnection output format is from the docs.
- [ ] azure-policy-allowed-locations: the built-in "Allowed locations" definition ID and the listOfAllowedLocations
      parameter name are from memory; the error format is from the docs.
- [ ] azure-backup-file-recovery: `az backup recoverypoint list` output shape and recovery point names.

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

## Exam-outline design challenges (2026-10-01): aws-clickstream-ingestion, aws-catalog-cache, aws-containers-platform, azure-containers-platform, azure-entra-groups-access
- [ ] All costs, budgets and `scales` values are scenario numbers, not prices.
- [ ] Kinesis: "on-demand mode scales with traffic" is simplified; the docs
      describe accommodating up to double the previous peak, with throttling
      possible beyond that.
- [ ] ElastiCache: a single node "coming back empty" after failure is the
      no-replica case; check the node-replacement wording against the docs.
- [ ] Containers (AWS): treating EKS managed node groups as failing the
      "no servers to patch" test is a judgment (AWS builds the AMIs, you start
      updates). The Docker Hub rate-limit failure is plausible behind shared
      NAT IPs, not a documented AWS behaviour.
- [ ] Containers (Azure): the AKS "ops" failure is a judgment (node image
      auto-upgrade channels exist); the point is that a cluster is still
      something to operate.
- [ ] Entra ID: Helpdesk Administrator also covers some limited admin roles;
      the fact says "non-administrators" for simplicity. Security defaults
      prompt for MFA "when needed", not at every sign-in; the `mfa` test
      checks that a second factor can be required.

## GCP exam-outline design challenges (2026-10-01): gcp-clickstream-ingestion, gcp-catalog-cache, gcp-containers-platform, gcp-iam-groups-access
- [ ] All costs, budgets and `scales` values are scenario numbers, not prices.
- [x] Checked against docs on 2026-10-01: Cloud Tasks 500 tasks/s per queue;
      Memorystore Basic (no replication, no failover) vs Standard (cross-zone
      replica, automatic failover); Pub/Sub seek needs topic retention or
      retained acknowledged messages.
- [ ] Containers: GKE Autopilot failing the "no cluster to operate" test is a
      judgment (Google manages nodes; the team still runs Kubernetes objects).
- [ ] IAM: the "cleanup script in the wrong project" test is a stand-in for
      blast radius; the Editor failure is plausible, not a documented case.
- [x] Google Cloud docs URLs moved to docs.cloud.google.com (2026-10-01), using
      each URL's actual redirect target. Pricing pages stay on cloud.google.com:
      they don't redirect.

## Multi-stage incidents (2026-10-02): aws-alb-migration-two-faults, aws-lambda-export-two-faults, azure-app-sql-two-faults, azure-slot-swap-key-vault-two-faults
- [x] Checked against docs on 2026-10-02: ALB health check defaults (path /,
      success code 200), reason codes and descriptions (Target.Timeout "Request
      timed out", Target.ResponseCodeMismatch "Health checks failed with these
      codes: [404]") and fail-open; Lambda default timeout 3 s and the
      "Task timed out after 3.00 seconds" message; RDS/Lambda security group
      pattern; Azure SQL 40615 (firewall) and 18456 (login); "Allow Azure
      services" includes other customers; App Service outbound IPs picked at
      random from the set; managed identities aren't swapped; unresolved Key
      Vault references are passed as the literal string.
- [ ] Representative output, not captured from real systems: the ALB access log
      lines (fields truncated), the Auto Scaling activity Cause text, the
      Lambda log lines and REPORT line layout, node-postgres's "Connection
      terminated due to connection timeout", the PostgreSQL slow-statement log
      line, the full text of SQL errors 40615 and 18456 as SqlClient prints
      them, the sqlcmd table layout, and the Key Vault Application Settings
      Diagnostics output (the detector exists; its exact wording is mine).
- [ ] Judgment: in the ALB incident, users see errors "while instances are
      swapped" during Auto Scaling churn; the exact symptom depends on
      deregistration delay and connection draining.

## Linux, Networking and Databases expansion (2026-10-02): 6 Linux, 6 Networking, 8 Databases
- [x] Checked against docs on 2026-10-02: path_resolution search permission;
      df -i; sshd(8) refusing authorized_keys under group/world-writable dirs
      (StrictModes); crontab(5) environment (cron sets SHELL, HOME, LOGNAME;
      crontabs can set variables) - neither man7 nor Debian documents a
      default PATH, so the incident shows a captured env instead of claiming
      one; RHEL 9 SELinux troubleshooting (ausearch, restorecon, semanage);
      proc_loadavg (states R and D); nginx certificate chains (browsers may
      cache intermediates); Express trust proxy; curl NO_PROXY leading dot;
      RFC 1034 CNAME rule; PostgreSQL listen_addresses default localhost,
      max_connections default ~100 (both need restart), replication slots can
      fill pg_wal, ACCESS EXCLUSIVE blocks SELECT, lock_timeout and
      idle_in_transaction_session_timeout; MySQL deadlock victim rollback,
      isolation level doesn't affect deadlocks, consistent lock order.
- [ ] Representative output, not captured from real systems: nginx/Apache
      error lines (AH00132 wording), namei/df/ss/ip layouts, the cron env
      dump, auth.log lines, the AVC record, top/ps/dmesg lines, ping output,
      OpenSSL 3's s_client chain formatting, Squid access log fields,
      named-checkzone wording, psql table layouts, EXPLAIN ANALYZE numbers,
      the InnoDB status excerpt (abridged with "..."), PostgreSQL log lines.
- [ ] Judgment/behaviour from experience, not quoted docs: "mv keeps a file's
      SELinux label" (vs. cp); new queries queueing behind a waiting ACCESS
      EXCLUSIVE request; lowering client MTU shrinking the advertised TCP MSS.

## Containers to 8 (2026-10-02): liveness-probe-slow-start, pending-insufficient-cpu, service-selector-no-endpoints, configmap-env-not-reloaded, rwo-volume-multi-attach, network-policy-default-deny
- [x] Checked against Kubernetes docs on 2026-10-02: startup probes disable
      the other probes until they succeed; failed liveness probes restart the
      container; ConfigMaps consumed as env vars "are not updated
      automatically and require a pod restart" (docs source); access modes
      (RWO = one node); default-deny ingress with an empty podSelector,
      additive allow policies, plugin must enforce NetworkPolicy; the
      scheduler filters nodes by resource requests.
- [ ] Representative output: kubectl describe/get layouts, event messages
      (FailedScheduling, Multi-Attach, Unhealthy/Killing), EndpointSlice
      "<unset>" rendering, exit code 143 after SIGTERM.

## CI/CD to 8 (2026-10-02): fork-pr-secrets, stale-dependency-cache, deploy-race-concurrency, required-check-path-filter, artifacts-between-jobs, oidc-environment-subject
- [x] Checked against GitHub docs on 2026-10-02: no secrets (and a read-only
      GITHUB_TOKEN) for pull_request runs from forks; cache keys with
      hashFiles, exact hits restore without re-saving; concurrency groups
      (one running, newest pending replaces older pending, cancel-in-progress);
      skipped workflows leave required checks Pending ("avoid requiring
      workflows that can be skipped"); artifacts for sharing data between
      jobs; OIDC sub claim forms for branches and environments (and that new
      repositories since July 2026 use a different default format).
- [ ] Representative output: gh CLI tables and --log lines (including the
      "Skipped:" step line), runner machine names, the actions/cache log
      wording, the AWS credentials action error text.

## IaC to 8 (2026-10-02): terraform-drift-hotfix, terraform-count-index-shift, terraform-import-existing, terraform-state-in-git, terraform-ignore-changes-autoscaling, terraform-forces-replacement
- [x] Checked on 2026-10-02: state stores sensitive values in plain text,
      keep it out of git, use encrypted remote backends; the dependency lock
      file and init -upgrade; ignore_changes for attributes another process
      manages; RDS can only be encrypted at creation (encrypted snapshot copy
      and restore otherwise); in the AWS provider source, storage_encrypted is
      ForceNew and identifier is NOT (it renames in place), so the
      forces-replacement incident uses encryption, not a rename.
- [ ] Representative output: terraform plan/apply formatting, the S3
      BucketAlreadyOwnedByYou error as the provider prints it, git/grep
      output. The prevent_destroy error wording follows Terraform's message.

## Microservices to 8 (2026-10-02): idempotency-double-charge, breaking-api-field, rate-limit-retry-after, trace-context-dropped, transactional-outbox, jwt-clock-skew
- [x] Checked on 2026-10-02: Stripe idempotency keys (first result saved and
      replayed); AWS Prescriptive Guidance transactional outbox (dual write,
      outbox table, idempotent consumers); RFC 6585 429 may carry Retry-After.
      The planned deep-health-check incident was dropped: its source (AWS
      Builders' Library) moved to a page that couldn't be read to verify.
- [ ] Representative output: service log lines, the supplier email,
      replay script output, trace span timings, timedatectl layout.
- [ ] From standards/experience, not re-fetched this session: RFC 9110
      idempotent methods and Retry-After, Google's API compatibility guide,
      W3C traceparent format, RFC 7519 nbf leeway wording.

## Google Cloud to 8 (2026-10-02): gcp-lb-health-check-firewall
- [x] Checked on 2026-10-02: health check probes for global external
      Application Load Balancers come from 35.191.0.0/16 (IPv4); ingress allow
      rules are required or the implied deny drops probes; Google recommends
      allowing all documented probe ranges (130.211.0.0/22 is included in the
      rule as Google's other documented health-check range).
- [ ] Representative output: gcloud get-health and firewall-rules table layouts.

## terraform simulator (diagnostics, TF1)
Wording the parser and graph print that is representative, not copied from the docs. Check against a real run.
- [ ] The boxed error layout (`╷`/`│`/`╵`, `on FILE line N, in resource "a" "b":`, the right-aligned source line number) and the 76-column wrap of the detail text.
- [ ] `Argument or block definition required`, `Unclosed configuration block`, `Attribute redefined`, `Missing newline after argument` / `block`, `Unsupported argument` (top-level), `Invalid character`: summaries are from experience; detail strings are paraphrased.
- [ ] String and comment errors: `Unterminated template string`, `Unterminated comment`, `Unterminated heredoc`, `Unterminated template interpolation`, `Invalid escape sequence`.
- [ ] `Reference to undeclared resource` / `input variable` / `local value` / `module`, `Invalid reference`: the resource and variable detail strings match the Terraform language docs closely; the local, module and data ones are paraphrased.
- [ ] `Duplicate resource "T" configuration` and the variable, output, local and module duplicate messages: real ones also print an end column (`main.tf:1,1-27`); this prints only line,col.
- [ ] `Cycle: a, b`: modern Terraform may add `(expand)` suffixes or list more nodes; the node list order is sorted here.
- [ ] `Invalid <type> block` for a wrong label count: real Terraform has separate `Missing name for resource` / `Extraneous label` messages.
- [ ] Unsupported on purpose (reported as `Unsupported ...`): `for` expressions, splats, template directives (`%{ }`), template strip markers (`~`), nesting depth beyond 100 levels or 100 operators in one chain.
