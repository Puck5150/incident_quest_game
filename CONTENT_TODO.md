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

## cicd/failing-github-actions
- [ ] npm ci error lines (`npm error code EUSAGE`, the "can only install packages
      when your package.json and package-lock.json ... are in sync" sentence, the
      `Invalid: lock file's ...` line): npm docs confirm the behavior ("npm ci will
      exit with an error") but don't print the message.
- [ ] setup-node log lines and `Error: Process completed with exit code 1.`: representative.
- [ ] `gh run list` column layout: representative.

## iac/terraform-moved-block
- [x] Plan rows ("will be destroyed", "(because ... is not in configuration)", "has moved to", the "Plan: X to add" summary) now come from the simulator (TF7b task 8); the CI log is checked against a real simulated plan. Still hand-written: the CI log's "(8 more attributes known after apply)" abbreviation.
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

- [ ] Canvas entry-point rules (2026-10 audit fixes): Cloud Run is marked
      `public: true` (users reach it directly), based on it exposing its own
      HTTPS endpoint; confirm against the Cloud Run docs and add a source. The
      added debrief lines (keep web servers and database behind the load
      balancer; database private) are general practice, not sourced to a
      specific product page. Audit suggestions NOT added because unverified:
      Cloud SQL backups/PITR and private IP, Cloud Armor, VM service accounts;
      the Azure `pg-geo` "lag is typically at least several minutes" fact
      (check the read-replica docs); Cloud SQL HA is really one instance with
      `availability_type = REGIONAL`, not two separately created instances.

- [ ] Azure canvas: requiring an entry point in front of App Service instances
      is a design-judgement call (App Service has its own public endpoint, like
      Cloud Run). The debrief's "single address, not each instance exposed" and
      "database stays private" lines are general practice, not sourced.

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
- [ ] Representative output: the S3 duplicate-bucket error as the provider
      prints it (in us-east-1 the simulator now prints
      `creating S3 Bucket (NAME): BucketAlreadyExists`, see TF4), git/grep output. (terraform-forces-replacement's
      `terraform plan` output is now printed by the simulator, no longer scripted.)

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

## terraform simulator (expression evaluator, TF2a)
- [ ] Evaluator error wording: `Invalid operand`, `Incorrect condition type`, `Unsupported attribute`, `Invalid index`, `Invalid template interpolation value`, `Not enough function arguments` / `Too many function arguments`, `Call to unknown function`: summaries follow the Terraform language docs and CLI; the detail strings are paraphrased.
- [ ] `Invalid function argument` details for lookup, element, coalesce, tonumber and cidrsubnet: paraphrased from the function docs.
- [ ] Unsupported on purpose (reported as `Call to unknown function`): `file`, `templatefile`, `try`, `can`, `for` expressions, anything not in the allowlist.
- [ ] Sets are modeled as sorted, de-duplicated lists, so `toset` output order is by value; real Terraform sets have no defined order.
- [ ] Division/modulo by zero: `Operation failed` / `Error during operation: can't divide by zero.` and `Invalid number` / `The number is too large to represent.` (non-finite literals and overflow) are paraphrased.
- [ ] Unsupported on purpose: `replace` with a `/regex/` search string (`Unsupported function argument`); expressions nested deeper than the stack allows (`Unsupported nesting depth`).
- [ ] Float formatting differs from Terraform's arbitrary precision (`0.1+0.2` prints 0.30000000000000004; huge numbers print in exponent form).
- [ ] Conditional branches and `toset` do not unify mixed types; `replace` with an empty search string differs from Go.

## terraform simulator (resource schemas, TF2b-1)
Which attributes force replacement, which are computed, and the defaults are from experience with the AWS provider; check each against the provider docs ("Forces new resource" notes) before relying on it in an incident.
- [ ] aws_vpc: `cidr_block` forces replacement; `enable_dns_support` default true, `enable_dns_hostnames` default false.
- [ ] aws_subnet: `vpc_id`, `cidr_block`, `availability_zone` force replacement.
- [ ] aws_security_group: `name`, `name_prefix`, `description`, `vpc_id` force replacement; description default "Managed by Terraform".
- [ ] aws_instance: `ami`, `subnet_id`, `availability_zone`, `key_name` force replacement (subnet_id may be updatable in newer provider versions); `instance_type` and `user_data` update in place.
- [ ] aws_db_instance: `identifier`, `engine`, `storage_encrypted`, `kms_key_id`, `db_name`, `username` force replacement; `instance_class`, `allocated_storage`, `multi_az` update in place.
- [ ] aws_s3_bucket (`bucket`), aws_sqs_queue (`name`, `fifo_queue`; defaults 30 s visibility, 345600 s retention), aws_iam_role (`name`, `path`), aws_ecs_service (`name`, `cluster`), aws_cloudwatch_log_group (`name`).
- [ ] The "Invalid resource type" detail: real Terraform prints only the first sentence; the second is a lab note.

## terraform simulator (requirements found in TF2b-1 review)

- [ ] TF2b-2 loader/validator must reject malformed author-shaped input instead of letting raw JS errors out: a state instance without `attributes`, a null/string reality entry.
- [ ] readOnly attributes (id, arn...) set in configuration should be reported by validate as an unconfigurable attribute, not silently ignored (diffInstance ignores them by design).
- [ ] `apply` must structuredClone `planned` before writing it into state (planned is a shallow copy of prior).
- [ ] Numeric strings vs numbers (`retention_in_days = "7"` vs state 7) show a spurious update because comparison is strict and attributes have no types.
- [ ] `instanceAddress` quoting uses JSON.stringify; Terraform's HCL quoting also doubles `${` and `%{` and escapes U+2028.
- [ ] `listAddresses` sorts as plain strings (`[10]` before `[2]`, data sources last); check Terraform's real `state list` ordering before TF2c.
- [ ] `stateJson` fidelity gaps: nested maps like tags not key-sorted, outputs lack `type` and are not sorted, `sensitive_attributes` always `[]` (even for aws_db_instance.password), no `dependencies` field (the destroy-order walker will need `dependencies?: string[]` on StateInstance).

## terraform simulator (plan walker, TF2b-2)
- [ ] The `count` / `for_each` unknown-value errors ("Invalid count argument", "Invalid for_each argument") and their long detail text, "Missing resource instance key", "No value for required variable", "Reference to undeclared ...": summaries follow the CLI; detail wording is from memory of the Terraform language docs.
- [ ] A `for_each` over a list is accepted as a set of strings, because the lab represents sets as lists; real Terraform rejects a list ("must be a map, or set of strings, and you have provided a value of type tuple").
- [ ] Data sources are read from the data entries in state (or unknown if absent); real Terraform reads them from the provider during plan.
- [ ] Unsupported on purpose (reported as `Unsupported ...`): modules, `dynamic` blocks, `provisioner`/`connection` behavior, `variable` `validation` blocks (ignored) and `type` conversion.
- [ ] Nested blocks compare as lists of objects with exactly the attributes written; a state authored with extra provider-set keys in a nested block (for example every field of a security group rule) will show a change.

## terraform simulator (requirements found in TF2b-2 review)
- [ ] Unknown argument names (`cidr_blok = ...`) are accepted: a TF2c `validate` must report 'Unsupported argument' once schemas list every configurable attribute (typo hunting is core gameplay).
- [ ] A sensitive value (`aws_db_instance.password`, a `sensitive = true` variable) flows through an output with `sensitive: false`; real Terraform errors 'Output refers to sensitive values'.
- [ ] `-var` values need conversion by the variable's declared `type`, which is currently ignored (only `count` converts a numeric string).
- [ ] A variable `default = var.a` is evaluated; real Terraform says 'Variables not allowed'.
- [ ] Data blocks are never evaluated and only their first state instance is used (so `1/0` in a data block is silent and `data.x.y[0]` with count on a data block fails).
- [ ] A resource whose `count` references itself reports `Cycle: ...` with no file/line (real: 'Self-referential block').
- [ ] `[all]` / `["all"]` are accepted for ignore_changes but real Terraform only takes the bare keyword `all`.
- [ ] A state instance without `attributes` throws a raw TypeError (loader TODO).

## terraform simulator (lifecycle effects, TF2b-3a)
- [x] "Instance cannot be destroyed" wording: source-checked by review against hashicorp/terraform `main`, word for word.
- [x] Tainted-reason precedence (triggered > tainted > requested) fixed in the final review.
- [ ] "Incompletely-matched force-replace resource instance" warning texts were taken from hashicorp/terraform `main` by review, not independently verified.
- [ ] `replace_triggered_by` attribute- and instance-level references (`aws_vpc.main.id`, `aws_vpc.main[0]`) are rejected as Unsupported; TF2b-3b should implement them.
- [ ] Real Terraform records only the first triggering reference; the simulator matches this, confirm the renderer shows just one.
- [ ] `replace_triggered_by = [var.x]`-style references are now rejected ('Invalid replace_triggered_by expression'); confirm wording against real Terraform.
- [x] `create_before_destroy` ordering is now modelled (TF7a Task 1, see the TF7a entries below); propagation of CBD to dependencies (Terraform forces dependencies of a CBD resource to CBD too) is still not.

## terraform simulator (moved / import / removed, TF2b-3b)
- [ ] `Moved object still exists` (an error, per review of move_validate.go), `Resource type mismatch`, `Cycle in move statements`, `Removed resource still exists`: summaries and details from memory of the CLI; confirm wording.
- [ ] `Configuration for import target does not exist` and `Cannot import non-existent remote object`: recalled closely, still unverified.
- [ ] An `import` is read from the simulated cloud by `type:id`; real providers also accept composite or provider-specific ids (for example `bucket-name` for S3, `cluster/service` for ECS). Each incident that imports must seed `reality` under the id it uses.
- [ ] An `import` block for an instance that is already in state is ignored silently; real Terraform also ignores it only when the ids match.
- [ ] `moved` is applied in the order resolved by following chains per instance; real Terraform validates the whole set of statements (for example conflicting moves from one address) with more specific errors.
- [ ] `removed` only supports whole-resource addresses and `lifecycle { destroy = bool }`; provisioner blocks inside `removed` are not modeled.
- [ ] `Unresolved resource instance address changes` wording is from memory (real Terraform records a blocked move and reports it in the plan).
- [ ] `Redundant move statement` wording is from review.
- [ ] The message for an invalid import id (`Invalid import id argument`) is invented.
- [ ] A moved instance that is then destroyed by a smaller count loses its `movedFrom` (renderer cosmetic).
- [ ] An import that references its own resource (`id = aws_s3_bucket.x.id`) reports a location-less Cycle error.
- [ ] The plan summary has no "to forget" count; the renderer can count `forget` items.
- [ ] Duplicate `removed` blocks, and `removed` combined with `moved` on one address, are not diagnosed.
- [ ] An import id of `true`/`false` is rejected, but real Terraform converts it to a string.
- [ ] Nested blocks inside `moved`/`import`/`removed` (for example `lifecycle {}` in `moved`) are silently accepted.
- [ ] The blocked-move warning has no source location (real Terraform's has none either).
- [ ] State with duplicate instance addresses is not diagnosed by `applyMoves`.
- [ ] An explicit instance move and a whole-resource move can land on the same instance address with equal chain length (`moved a -> c` plus `moved b[0] -> c[0]`); the ambiguity check compares statement destinations only, so the winner is decided by state order. Exotic; tighten the check if it ever matters.

## terraform simulator (plan renderer, TF2c-1)
Layout reproduced from memory of Terraform 1.x CLI output; check each against a real `terraform plan`.
- [ ] Legend wording and symbols (`+ create`, `~ update in-place`, `- destroy`, `-/+ destroy and then create replacement`, `+/- create replacement and then destroy`); omitted entirely for a moves-only plan.
- [ ] Comment headers: `will be created`, `will be updated in-place`, `must be replaced`, `is tainted, so must be replaced`, `will be replaced, as requested`, `will be replaced due to changes in replace_triggered_by`, `will be destroyed` with `(because … is not in configuration | index […] is out of range for count | key […] is not in for_each map)`, `has moved to`, `will be imported`, and the forget wording.
- [x] Which unchanged attributes are shown as context (`id`, `name`, `tags`, in full, at every block level) and how hidden attributes are counted (non-null attributes) — source-checked by review.
- [x] The forget block (` .` row, one-space comments, id/name/tags context and hidden count; legend header with no symbol lines) — source-checked by review.
- [x] Lists of objects (`ingress`, `egress`) are attributes, not nested blocks: rendered as lists of objects, security group rules as sets matched by value — fixed in wave C.
- [x] Alignment over hidden attributes and all map keys, collection-becomes-unknown, nested block layout (attributes, blank line, blocks), list diffs (position-wise for equal length, one context element), `# forces replacement` on the opening line, and sensitive masking in drift and output changes — source-checked by review.
- [ ] Map and list diff layout (`# (N unchanged elements hidden)`, `-> null` after a removed map) and the `Plan: N to import, …` summary format.
- [x] Drift note hidden when the plan is otherwise empty, two blank lines before "Unless you have made…", imported objects shown in full, destroy reasons for wrong repetition — source-checked by review. Still unchecked: the 77-character rule.
- [x] Output-change block alignment over all outputs, and the 78-column apply hint for output-only plans (no actions header) — source-checked by review.
- [ ] Not rendered: multi-line string values, `<=` data reads, `-target` and `-refresh-only` banners, colour.
- [ ] Deferred from review: multi-line strings as `<<-EOT` heredocs with per-line diffs.
- [ ] Deferred from review: JSON policy strings as `jsonencode(...)` (matters for `aws_iam_role.assume_role_policy`).
- [ ] Deferred from review: multi-line strings as heredocs. The AWS provider stores `user_data` as a SHA1 hash in state, so real plans show a hash; our schema stores the raw `user_data`.
- [ ] Deferred from review: show unchanged children inside changed non-important maps and lists for imports.
- [ ] Deferred from review: Go `%q` string escapes (`\x01` vs JSON `\u0001`).
- [ ] Deferred from review: `# Warning: this will destroy the imported resource` on import plus replace.
- [ ] Deferred from review: destroy reason when a moved target is not in the configuration.
- [ ] Deferred from review: non-identifier attribute names quoted with `%q`.
- [x] Drift limited to what changing objects refer to (`driftShown`) — fixed in wave C.
- [x] A deleted object that the plan creates again shows no drift note (nothing refers to itself); a deleted object prints only the attributes the plan uses — fixed in wave D.
- [ ] **SECURITY / Critical:** sensitive marks do not travel through expressions. `tags = { P = aws_db_instance.db.password }` prints the raw password in another resource's plan attributes where real Terraform prints `(sensitive value)`. Fixing it needs value-level sensitivity tracking in the evaluator; its own task.
- [ ] Drift address matching should key on the instance address when a reference has a literal index (`web[0].private_ip` shows only `web[0]`; whole-resource references to a counted resource match nothing).
- [ ] List diffs should pair deletions with additions inside a run (real ProcessSlice zips them in order): `[{a=1},{a=2},{a=9}] -> [{a=3},{a=9}]` prints `~ { a = 1 -> 3 }` then `- { a = 2 }`.
- [ ] The relevant-reference walk should skip depends_on/lifecycle/count/for_each references and read only the referenced attribute's own expression.
- [ ] Null attributes inside list/set elements should be skipped (not printed as `null`, not counted in width).
- [ ] Drift context should show the BEFORE value for changed-but-irrelevant attributes; drift addresses of moved resources are pre-move addresses.
- [ ] Unknown tags should make `tags_all` `(known after apply)` as a whole.
- [ ] Deferred from review: driftBlock address parsing for `data.` and `module.` addresses.
- [ ] Deferred from review: deep nesting recursion (stack depth on deeply nested values).

## terraform simulator (CLI, TF2c-2)

- [ ] `terraform init` transcript and lock file text (provider version 5.67.0 and the `h1:` hash are invented).
- [ ] Usage text (`terraform` with no arguments / `-help`).
- [ ] The `Inconsistent dependency lock file` and `No configuration files` error boxes.
- [ ] The `Refreshing state...` / `Reading...` / `Read complete` lines.
- [ ] The trailing notes of `plan` with and without `-out`.
- [ ] `state list` ordering and the `No state file was found!` condition.
- [ ] `state show` layout: attributes aligned to the longest name, null attributes omitted, `(tainted)` suffix.
- [ ] `output` list and named formats, and the `No outputs found` warning.
- [ ] `workspace list` format.
- [ ] The not-simulated message for apply and friends (to be replaced by TF3).
- [ ] tfvars parsing wraps the file in a `locals` block: error line numbers are shifted by one and corrected.
- [ ] SECURITY / teaching correctness (do before any incident that handles secrets): sensitive variables are not tracked. `variable "pw" { sensitive = true }` with `-var pw=hunter2` plans `+ cidr_block = "hunter2"` and outputs show the raw value; real Terraform prints `(sensitive value)` and refuses an output that refers to sensitive values without `sensitive = true`. Needs value-level sensitivity tracking in the evaluator (same task as the cross-resource sensitive-propagation gap already logged).
- [ ] Conversion: `Number('0x10')` is accepted (cty rejects it), and typed `default` values are not converted.
- [ ] tfvars parse errors show `in locals:` in the box header (leaks the wrapping).
- [ ] The `<sub> -help` texts are paraphrased on one line; copy the real Help() bodies from command_*.go (`state list -help` prints the `state` help).
- [ ] IncidentScreen keys the feedback paragraph on `log.length`, so every editor save re-animates the old feedback and screen readers announce it again (pre-existing, more visible now).
- [ ] Variable type conversion for `-var` values is not done (all values are strings).
- [ ] `-chdir` and the working-directory rule.
- [ ] Scripted `terraform` commands are ignored for incidents with a terraform block.
- [ ] (fix wave E) Invented or unverified: `terraform <sub> -help` usage lines (one-line descriptions for init, validate, show, state, output, workspace, version are paraphrased; `plan` is the real sentence); the message `init` prints when it appends to an existing lock file ("Terraform has made some changes to the provider dependency selections..."); the `Inconsistent dependency lock file` text is reused for a provider missing from an existing lock file.
- [ ] (fix wave E) `Invalid value for input variable` detail prints `FILE:LINE` where real Terraform prints `FILE:LINE,COL-COL`; `list(...)`/`map(...)` typed variables are not converted.
- [ ] (fix wave E) `terraform output -json` types are `string`/`number`/`bool` or `dynamic` (real prints structural types such as `["list","string"]`); `-raw` collection error detail is a lab paraphrase; the `Raw output format is only supported for single outputs` error has no detail here.
- [ ] (fix wave E) The undeclared-variable warnings print at most two, then a summary of the rest, sorted by name (real order may differ).

## terraform simulator (apply engine, TF3a)
- [ ] Provider error texts (S3 `creating S3 Bucket (NAME): BucketAlreadyExists` since TF4: verified against the provider source, see the TF4 section; `EntityAlreadyExists`, `ResourceAlreadyExistsException`, `QueueNameExists`, `DBInstanceAlreadyExists`, `DependencyViolation` for VPC/subnet/security group): shaped like the AWS SDK v2 errors the provider wraps, with invented request ids; confirm each against real provider output.
- [ ] Generated ids and ARNs per resource type (formats, `aws_db_instance.id` = identifier, `aws_sqs_queue.id` = URL, `aws_ecs_service.id` = ARN) and the defaults filled on create (engine_version 15.4, allocated_storage 20, availability_zone us-east-1a, private_ip 10.0.x.y): from memory of the provider.
- [ ] Durations per type (create/update/delete seconds) are plausible, not measured.
- [x] Replacements without `create_before_destroy` are destroy-then-create; with it, TF7a Task 1 creates first and keeps a failed-delete old object as deposed (see below).
- [ ] A failed create after a successful destroy leaves the resource missing from state, as real Terraform does; there is no rollback.
- [ ] Apply treats the first dependency violation as final (no retries); real providers retry some eventual-consistency errors for minutes before failing.
- [ ] State `dependencies` for the starting state are derived from ids found in attributes; real state records the configuration's references.
- [ ] After a partially failed apply, `state.outputs` keep their previous values (they are only recomputed after a clean apply); real Terraform updates the outputs it can evaluate.
- [ ] The simulated cloud's `referencedBy` treats any attribute that mentions an id (tags included) as a dependency, so a tag holding a subnet or VPC id blocks deleting it; real AWS only blocks on real attachments.
- [ ] An `update` fault never fires for an item the plan turns into a replace (it runs as delete + create); script `delete`/`create` faults for those.
- [ ] A dependency knot the ordering cannot untangle is reported as `Cycle: <addresses>` (no source location), or surfaces as the cloud's DependencyViolation; real Terraform reports cycles at plan time with its own wording.
- [ ] Security groups created without `vpc_id` get an invented default-VPC id (`vpc-0…`); `aws_db_instance.storage_encrypted` defaults to false on create.

## terraform simulator (apply/destroy commands, TF3b)
- [ ] Confirm prompt wording and layout (`Enter a value:`, blank lines with `-auto-approve`), and `Apply cancelled.` / `Destroy cancelled.` with exit 1: unverified against real Terraform 1.9.
- [ ] `Still creating...` cadence and the `[id=X, 10s elapsed]` form.
- [ ] Import progress lines.
- [ ] Saved-plan marker file (real plan files are zips) and the wording of the stale/load errors.
- [ ] Wording of `Can't set variables/-replace when applying a saved plan`.
- [ ] A saved plan applies with the apply-time refresh setting and the current reality.
- [ ] `destroy` with nothing in state prints `No changes. No objects need to be destroyed.` + `Either you have not created any objects yet or the existing objects were already deleted outside of Terraform.`: wording from memory, unverified.
- [ ] `plan -out` with no changes writes the plan file silently (no `Saved the plan to` footer): unverified whether real Terraform prints anything.
- [ ] Piped empty stdin is treated as declined; real Terraform would error on EOF.
- [ ] `Outputs:` section after apply: format and which outputs show.
- [ ] Help one-liners for `apply`/`destroy` (help currently lists just the commands).
- [ ] The xterm confirm overlay has only been tested in jsdom; check it by hand in a browser.

## terraform done_when predicates (TF3d)
- [ ] The "(Saved. The game counts this as a fix once you've named the root cause.)" note shown for a world-detected action before the root cause is named: wording unreviewed.
- [ ] `plan_clean` / `plan_has` ignore `-target` and `-refresh-only`; they always do a full refresh and plan.
- [ ] No scoring bonus yet for good practice (plan before apply, `-out`, checking the workspace).
- [ ] Stage-aware evidence is still open (evidence is visible from the start at every stage; see AUTHORING.md). Evidence tags earned from `state show`/scripted AWS output (`unencrypted`) can no longer be earned once an apply has changed the world.
- [ ] `doneWhen` reads `TF_VAR_*` from the saved shell env of the main host, not from a live shell.
- [ ] `schemas/incident.json` grew about 2.6k lines because zod inlines the predicate union twice; consider `reused: 'ref'` in `scripts/schemas.ts` (rewrites all schemas).
- [ ] Semantics chosen where the plan was ambiguous (Tasks 1 to 5):
  - A key-less address covers `ADDR[...]`; an address ending in `]` matches exactly; `plan_has.no_destroy` follows the same rule.
  - `reality_has` with `attr` but no `equals` means the attribute key exists; `equals: null` on a missing attribute is false.
  - `applied` matches the op before the address, so `create x` never matches `update x`; history records only ok apply steps.
  - A plan that throws, cannot be loaded, or has diagnostics is "not satisfied" for `plan_clean` and `plan_has`; any evaluation error is false.
  - `done_when` is judged on the main host whichever host the player is on, cwd the lab dir.
  - `file:` and `done_when` together require both; `done_when` is checked only after `file:` passes.
  - Replay after a remount rebuilds the "(Saved…)" note but never sends TAKE_ACTION again (found in Task 5).

## terraform simulator (state commands, locks, workspaces, TF3c)
State commands:
- [ ] `state mv` error texts: `Invalid source address` / `Invalid target address` details, and the invented "already has instances with keys, so it has no unkeyed instance" check (real Terraform has none). Success lines (`Move "A" to "B"`, `Successfully moved N object(s).`) unverified.
- [ ] `state mv` rewrites `dependencies` when the source resource is emptied; real Terraform does not.
- [ ] `state rm` texts: `Removed ADDR`, `Would remove`, `Successfully removed N resource instance(s).`, `No matching objects found.`.
- [ ] `state mv`/`state rm` write no `terraform.tfstate.backup`.
- [ ] taint/untaint texts: `No such resource instance`, `Resource instance is not tainted`, `Data sources cannot be untainted.` (by analogy with taint), and the success lines.
- [ ] import: the error family (`Invalid address` is invented; undeclared, already managed, no remote object) and the progress/success output.
- [ ] import and refresh work without a state file; the other state commands require one (NO_STATE plain for mv/rm, boxed for taint/untaint).
- [ ] refresh: output layout, and real Terraform may print a deprecation warning pointing at `apply -refresh-only`. Outputs are printed from state, not re-evaluated from the configuration.
- [ ] `refresh` with no state file prints nothing; real Terraform warns that the state is empty.
- [ ] `Invalid address` / `ADDR is not a valid resource instance address.` for an unparseable address in import, state rm, taint and untaint: invented wording.
- [ ] Unknown flags on the new commands use the boxed `Failed to parse command-line flags` form; the generic ignored flags (`-state`, `-backup`, …) are accepted silently.

Locks:
- [ ] Lock error box layout, Lock Info field order, default `Error message:` (`resource temporarily unavailable`); the real message differs per backend (S3+DynamoDB `ConditionalCheckFailedException`, azurerm blob lease, gcs). Long messages wrap at 76 columns.
- [ ] No "Acquiring state lock" / "Releasing state lock" lines are printed (real remote backends print them).
- [ ] `-lock-timeout` is accepted but never waits.
- [ ] Locks are authored only: an interrupted or failed apply never leaves one. One lock per lab, not per workspace.
- [x] A wrong-ID `force-unlock` reveals the real lock ID: true for the S3 backend with DynamoDB (v1.9.8 client.go puts the held lock's info on the error). Verified in TF5.
- [x] force-unlock texts checked against v1.9.8 internal/command/unlock.go in TF5: prompt (was "may be still be in use", now "may still be in use"), success text, `force-unlock cancelled.`, `Expected a single argument: LOCK_ID` (no full stop), `Failed to unlock state: %s` printed plainly (Ui.Error, not a diagnostic box), asking before the unlock call. The failure detail is now the S3+DynamoDB one: no lock `failed to retrieve lock info for lock ID "ID": unexpected end of JSON input`, mismatch `lock ID "X" does not match existing lock ("ID")` followed by the Lock Info block. Other backends word it differently (gcs/azurerm/consul: lowercase `lock id`); the simulator always uses the S3 form.
- [ ] The blank line between the echoed answer and the result is still recalled, not verified.
- [ ] The notYet box's "You can still use" list (our UI text) now includes `force-unlock` and `workspace`.

Workspaces:
- [ ] `Workspace "NAME" already exists` (plain form), `Expected a single argument: NAME.`, the unknown-workspace text for `select`, the unknown-subcommand usage line, `Switched to workspace` when already on it.
- [ ] Delete texts: `Workspace is not empty` box, `Workspace is your active workspace`, `Can't delete default workspace` and its place in the check order; `-force` on a non-empty workspace prints no warning line.
- [ ] A saved plan from another workspace reuses the generic `Saved plan is stale` text.
- [ ] `workspace select -or-create` creates without taking the lock (`workspace new` does take it).
- [ ] Names `.` and `..` are accepted by the name rule; real Terraform likely refuses them.
- [ ] Lineages: scenario workspaces use `…0000000000NN` from 02, `workspace new` uses 10 + counter; they collide with 9+ authored workspaces.
- [ ] `terraform.tfstate.d/NAME/terraform.tfstate` files are not on the simulated disk.

## terraform simulator (done_when predicates, TF3d)
- [ ] `applied` history is not scoped per workspace: an apply in another workspace satisfies it. Scope it if a scenario uses workspaces with `done_when`.
- [ ] Schema errors for a malformed `done_when` are opaque (the zod union reports every branch); give authors a clearer message.

## terraform incidents batch 1 (TF4)

TF4 batch status: three simulator-backed iac incidents, each resolved and trapped through the UI in `tests/terraform-batch1-ui.test.tsx`. terraform-state-lost teaches recovering lost state with `terraform import` (or import blocks) instead of applying or recreating; terraform-count-to-for-each teaches that count to for_each changes addresses and the objects are moved (moved blocks or `state mv`), keeping prevent_destroy; terraform-forgotten-taint teaches reading "is tainted, so must be replaced" and clearing a stale taint with `terraform untaint` (`-replace` as the deliberate way).

Open simulator and engine defects (fix in the simulator, not in content):
- [ ] SQS: `aws_sqs_queue` already-exists should adopt the existing queue when the attributes are identical. Per the SQS CreateQueue API Reference (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_CreateQueue.html), CreateQueue with an existing name and the same attributes returns the existing queue's URL; `QueueNameExists` only when attribute values differ. The simulator always fails with `QueueNameExists ... different value for attribute VisibilityTimeout` (terraform-state-lost uses a second log group instead of a queue because of this).
- [ ] Import `tags_all`: `terraform import` copies the cloud object's attributes verbatim, so a `cloud.add` object without `tags_all` imports without it (the real provider's read stores `tags_all = {}`). terraform-state-lost works around it by authoring `tags_all: {}`; the provider read should fill it.
- [ ] Fresh-clone init: real Terraform needs `terraform init` on a fresh clone before `plan` ("Required plugins are not installed" / "Inconsistent dependency lock file"); the lab starts initialized unless `initialized: false`. terraform-state-lost stays initialized and mentions init only in the debrief. Decide whether fresh-clone stories should set `initialized: false`.
- [ ] S3 duplicate create: the simulator prints the us-east-1 text (`creating S3 Bucket (NAME): BucketAlreadyExists`, the provider's pre-check). If other Regions are ever modeled, they need the `BucketAlreadyOwnedByYou` form.
- [ ] `plan -out` on a failed plan writes nothing. Real Terraform writes the Errored (partial) plan to the file (`backend_plan.go`), and `terraform apply tfplan` then fails with "Cannot apply incomplete plan". The simulator reports `Failed to load "tfplan" as a plan file` (or applies an older saved plan under that name if still current).
- [ ] Partial plans: only prevent_destroy failures print the partial plan. Other planning-time errors (evaluation, moved/import checks) print errors only; real Terraform renders an Errored plan for errors raised during the plan walk (partial plan, or "Planning failed..." with no changes, `jsonformat/plan.go`). Which simulator errors real Terraform catches earlier, in validate, was not checked.
- [ ] Apply ordering (likely; from the apply-graph rules, not a real run): the count-to-for-each trap destroys the old subnets before creating the new ones. Real orphan destroys and the new creates have no ordering edge, so the creates would run while the old subnets still exist and fail with `InvalidSubnet.Conflict`; the db hosts are terminated either way. The trap feedback only claims the host terminations.
- [ ] Output nits: `apply -auto-approve` prints the first `Destroying...` straight after the `Plan:` line (real Terraform leaves a blank line); refresh lines print in address order (real: dependency order, VPC first); ids created by apply are shorter than real ones (`subnet-08110b62c`, real subnet ids have 17 hex digits).
- [ ] `state mv` with an unquoted for_each key (`aws_subnet.private[us-east-1a]` after shell quote removal) prints `Invalid target address ... address is not a valid resource instance or resource address.`; the real error text was not checked.
- [ ] History engine gap: plain `history` is answered by the engine with this session's commands only, so it can't show the seeded old entries. `history | grep taint`/`history | grep terraform` (with `-i`, quotes, or no spaces around `|`) are scripted and `~/.bash_history` is on disk; other forms (`history | tail`, `history | grep web`) show only the session, and the `just-bash` `history` builtin prints nothing. A real fix would have the engine read `~/.bash_history`.
- [ ] Typed runs of spaces collapse in the terminal input (seen again writing the UI tests: `sed 's/^  lifecycle/...'` never matches), so indentation-anchored sed edits can't be typed.

terraform-state-lost (unverified):
- [ ] `aws s3api head-bucket` output (`BucketRegion`, `AccessPointAlias: false`): documented output fields, but the CLI reference example says a successful call returns no output. Check what CLI v2 prints today for a general purpose bucket.
- [ ] `aws sts get-caller-identity`: the `UserId` and the `PlatformEngineer` role are invented. `aws iam get-role`/`aws logs describe-log-groups`: field names follow the CLI references; RoleId, dates, creationTime and storedBytes are invented.
- [ ] Story (local state on a wiped laptop, `.gitignore` excluding `*.tfstate`) is illustrative, not from a published incident.
- [ ] Provider import ID formats (bucket, role, log group names) verified on the provider's GitHub docs; the registry pages render with JS and could not be opened.

terraform-count-to-for-each (unverified):
- [ ] The `has moved to` blocks show `id` and `tags` with the rest hidden; real Terraform shows identifying attributes for no-op moves, but the exact set was not compared.
- [ ] `state mv` from an index to a key: the docs show it only for moved blocks (`aws_instance.c[0]` to `aws_instance.c["small"]`); real `state mv` accepting it is assumed from the address grammar.
- [ ] `git log`, `git diff`, `aws ec2 describe-subnets`/`describe-instances` outputs are scripted; ids, IPs, commit hashes and messages are invented; describe-instances is trimmed.
- [ ] Story (self-managed Postgres on EC2 with prevent_destroy, a count-to-for_each refactor PR) is illustrative. The brief named `aws_instance.app`; it is `aws_instance.db` so prevent_destroy guards hosts that hold data.
- [x] Verified (Terraform v1.9.8 source): `(because resource does not use count)` (`jsonformat/plan.go`), `Instance cannot be destroyed` (`checkPreventDestroy`), and the partial plan on a prevent_destroy failure.

terraform-forgotten-taint (unverified):
- [ ] Shell history deviations: real bash would also list the `history | grep ...` line and this session's terraform commands; the scripted outputs show only the old lines. The seeded `~/.bash_history` is the file's tail, so its length doesn't match history numbers 1871-1876. Timestamps assume the laptop is on UTC; history numbers are invented.
- [ ] `git diff`, `git log`, `aws ec2 describe-instances` outputs are scripted; ids, IPs, launch time and commit hashes are invented; describe-instances is trimmed.
- [ ] Story (taint during a 502 debugging session, never applied, surfacing in a tag-only PR) is illustrative. The load balancer is not modelled; the instance has no `vpc_security_group_ids` because the simulator schema lacks it.
- [ ] "A replacement means minutes of 502s" behind a load balancer is reasonable but not quantified from docs.
- [x] Verified (Terraform v1.9.8 source and docs, 2026-10-08): the tainted/requested replace reasons, `# ADDR: (tainted)` in state show, taint/untaint success and error texts (`taint.go`/`untaint.go`), taint deprecated for `-replace` (v0.15.2+), untaint changes state only.

Legacy content:
- [x] Verified (TF4 provider source, 2026-10-08): terraform-import-existing now runs on the simulator; the CI log is the tail of a real simulated `apply`, and all `BucketAlreadyOwnedByYou` wording is gone (debrief keeps one sentence that other Regions answer a duplicate create differently).

## terraform incidents batch 2 (TF5)

TF5 batch status: four failed-apply incidents on the simulator, each with a playthrough test (tests/terraform-<id>.test.ts) and a UI test (tests/terraform-batch2-ui.test.tsx: ideal path and trap through IncidentScreen, typed and button actions, remount replay, the force-unlock dialog).
- terraform-partial-apply-iam: no rollback; read `with ADDR,` and the AccessDenied caller/action; fix the permission (as the right identity) and apply again, never destroy to start clean.
- terraform-vcpu-limit: a cloud-side quota stops one resource; two real fixes (right-size in code, or a Service Quotas increase), and the re-run only creates what's missing.
- terraform-cancelled-ci-lock: a cancelled CI run leaves the lock held; prove the holder is dead, force-unlock, read the plan, finish the apply; never -lock=false.
- terraform-sg-cycle: `Error: Cycle` from two groups referencing each other; split every rule into its own rule resource by group id (clearing the groups' old inline rules first), apply in place; a CIDR is wrong, never recreate the groups or open the port to the internet.

Open simulator defects found in TF5 (not fixed):
- [ ] Address-keyed faults can be bypassed by renaming: a fault's `at` is an address, so renaming the resource in the `.tf` (or `state mv` plus a rename) makes a new address the fault doesn't cover, and the create succeeds. In terraform-partial-apply-iam a renamed db would still be denied in reality. Simulator limit; a fault keyed on the type/natural id (or on the provider call) would close it.
- [ ] Profiles: the lab's `aws` answers only from scripted lines, so a profile works per command (`--profile NAME`, or an exact scripted `AWS_PROFILE=NAME aws ...` line the engine answers first); `export AWS_PROFILE=...` and an env prefix inside a pipeline run in the shell and get the default profile's output, and ~/.bashrc is never sourced. Later improvement: have `IncidentShell.program` honour `ctx.env.AWS_PROFILE` when choosing scripted output.
- [ ] Apply concurrency: creates run one at a time, so an independent resource that fails (the db instance, which has no reference to the network) prints `Creating...` first and its error only at the end, after the others complete. Real Terraform runs independent creates in parallel (default `-parallelism=10`); the interleaving would differ but the outcome (network created, db denied, error box at the end) is the same.
- [ ] Scripted commands always exit 0: the scripted `aws iam put-role-policy` AccessDenied (no `--profile`) prints the error but real AWS CLI v2 exits non-zero (254 for a service error).
- [ ] Instance `private_ip` comes from 10.0.x.x regardless of the subnet's CIDR (terraform-vcpu-limit: 10.70.1.0/24); it shows in the destroy plan.
- [ ] Nested-block attributes the provider fills (ipv6_cidr_blocks = [], prefix_list_ids = [], security_groups = [], self = false in each rule, cidr_blocks = [] where unset) aren't modeled, so the state's rules hold only what the configuration sets, and `state show`/the plan diff print shorter rule objects than real Terraform does (terraform-sg-cycle).
- [x] The built-in SG DependencyViolation text now carries the SDK v2 `operation error EC2: DeleteSecurityGroup, https response error StatusCode: 400, RequestID: ...` wrapper (TF7a). The wrapper shape follows the DeleteVpc/DeleteSubnet texts; the 400 status is the usual EC2 shape, not checked against a real run.
- [ ] `force-unlock` failure texts are always the S3+DynamoDB wording (`failed to retrieve lock info ...`, `lock ID ... does not match existing lock`), whatever backend an incident authors; other backends word them differently.
- [ ] Before any apply, `terraform state list` prints "No state file was found!" with an S3 backend configured (terraform-vcpu-limit); real Terraform with an empty remote backend may print nothing. Not checked.
- [ ] Fault/trap design limit: a destructive action that is button-only or later undone (terraform-sg-cycle: recreate-groups, open-callbacks-to-internet closed again) leaves the fix earnable; the mistake stays on the score. The other three TF5 traps make the fix unearnable for the session.

terraform-partial-apply-iam:
- [x] Verified 2026-10-08: Terraform does not roll back a partially completed apply (developer.hashicorp.com/terraform/cli/commands/apply); provider v5.70.0 wraps the create error as `creating RDS DB Instance (%s): %s` and calls `CreateDBInstance` through the SDK v2 `RDSClient` (internal/service/rds/instance.go); implicit-deny wording `User: ARN is not authorized to perform: ACTION on resource: ARN because no identity-based policy allows the ACTION action` (IAM User Guide, troubleshoot_access-denied); `aws iam put-role-policy` synopsis and no output on success (CLI reference); `get-caller-identity` assumed-role Arn/UserId shape (STS API reference example 2); `list-role-policies` output shape (CLI reference); IAM's own denial says `on resource: role NAME` (seen in a real error quoted on community.deeplearning.ai).
- [ ] The full fault text (`operation error RDS: CreateDBInstance, https response error StatusCode: 403, RequestID: ..., api error AccessDenied: ...`) is assembled from the SDK v2 error format and the IAM wording; a real wrapped RDS AccessDenied from provider v5 was not seen (the only real Terraform example found was the SDK v1 form `AccessDenied: User: ... status code: 403`). RequestID is invented.
- [ ] RDS returns error code `AccessDenied` with HTTP 403 for an unauthorized CreateDBInstance: from real-world quotes (deeplearning.ai community thread: `AccessDenied`, status 403), not from AWS docs or a captured response.
- [ ] ci-apply.log: the terraform part is the simulator's output for the same config from an empty state, with the generated ids replaced by realistic 17-hex-digit ids and the session name `GitHubActions`; the `Run ...` header and `Error: Process completed with exit code 1.` imitate GitHub Actions (no timestamps). The pipeline's real session name depends on the OIDC action's `role-session-name`.
- [ ] Invented values: resource ids, role ids (`AROA...`), the SSO role name, profile layout in ~/.aws/config, the `terraform-deploy` policy content, the password variable value.
- [ ] Simplifications: the db instance has no `db_subnet_group_name`/`vpc_security_group_ids` (not in the simulator schema), so it would land in the default VPC in reality; the debrief doesn't claim otherwise. The grant takes effect at once; real IAM changes are eventually consistent (mentioned in the debrief). The grant is accepted with any policy document: the game can't check the JSON the player would write.
- [ ] Story (a deploy role written for the network first, a first pipeline apply denied at the database) is illustrative, not from a published incident.

terraform-vcpu-limit:
- [x] Verified 2026-10-08: quota name `Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances`, code `L-1216C47A`, default 5, adjustable, counted in vCPUs of running instances per account per Region, stopped instances don't count (EC2 User Guide ec2-on-demand-instances, instance types guide ec2-instance-quotas); `VcpuLimitExceeded` is a client error (400-series) and `InsufficientInstanceCapacity` a server error (500-series) in the EC2 API error codes page; `get-service-quota` output shape incl. `"Unit": "None"` and the `UsageMetric` dimensions `Class: Standard/OnDemand, Resource: vCPU` (CLI reference example); `request-service-quota-increase` synopsis, `--desired-value` is the new total, status starts `PENDING` (CLI reference); c5 vCPUs large 2 ... 12xlarge 48, 18xlarge 72, 24xlarge 96, metal 96, t3.small 2 (instance types guide); `VCpuInfo.DefaultVCpus` field (describe-instance-types reference); provider v5.70.0 wraps the error as `creating EC2 Instance: %s` (internal/service/ec2/ec2_instance.go).
- [ ] The VcpuLimitExceeded message text (`You have requested more vCPU capacity than your current vCPU limit of N allows for the instance bucket that the specified instance type belongs to. Please visit http://aws.amazon.com/contact-us/ec2-request to request an adjustment to this limit.`) is from real errors quoted by Red Hat, Databricks and towardsthecloud.com, not from AWS docs. The SDK v2 wrapping (`operation error EC2: RunInstances, https response error StatusCode: 400, RequestID: ..., api error VcpuLimitExceeded: ...`) is assembled from the SDK format; RequestIDs are invented. HTTP 400 follows the docs' "400-series" for client errors; the exact code wasn't seen.
- [ ] The quota request is granted at once in the simulator; in reality it sits PENDING (or CASE_OPENED) and can take minutes to days (said in the action feedback and debrief). The typed request is accepted only for `--desired-value` >= 98 and no other `--region`. Scripted lookalikes: `--desired-value 96` (us-east-1) and `--desired-value 128 --region us-west-2` answer with a PENDING RequestedQuota (shape from the CLI reference; Id, Created and Requester invented) and take nothing; other values or Regions get the generic "no simulated output".
- [ ] The over-quota fault uses `if: { attr: instance_type, matches }` (added to the simulator in this task): standard-family types (A, C, D, H, I incl. im4gn/is4gen, M, R, T, Z) of size 16xlarge and up, and metal except a1.metal (16), z1d.metal (48), m5zn.metal (48). That rule (N-xlarge = 4N vCPUs from 16xlarge up; those three the only metals under 64) was checked against the vCPU table in the test (instance types guide: co, gp, mo, pg pages), not against every instance type AWS sells. finish-apply accepts the over-quota class up to 96 vCPUs ((16|18|24)xlarge, metal, metal-16xl/24xl); a metal over 96 (c6i.metal 128) would really still fail at a 98 quota but launches in the simulator once the action is taken.
- [ ] right-size's regex reads the loadgen block up to its first `}`: `instance_type` must be a literal before `tags`, as in the starting file. Moving it below `tags` or into a variable isn't credited.
- [ ] Switching the provider to another region isn't simulated (the simulator's region is fixed to us-east-1); the trap is button-only.
- [ ] Invented: account id, AMI id, quota applied value 64 ("raised for earlier tests" in the debrief), the story (PR merged, never applied).

terraform-cancelled-ci-lock:
- [x] Verified 2026-10-08 against Terraform source (raw.githubusercontent.com, tags v1.9.8 and main): the lock error is the diagnostic `Error acquiring the state lock` with detail `Error message: %s` + the advice paragraph (internal/command/clistate/state.go LockErrorMessage); the error is `LockError.Error()` = the backend error, newline, `LockInfo.String()` (`Lock Info:` then ID/Path/Operation/Who/Version/Created/Info padded to column 13, trailing newline: hence the two blank lines before the advice) (internal/states/statemgr/locker.go); `Who` is `user@host`, `Created` is a UTC `time.Time` printed by Go's default format; `Path` for the S3 backend is `bucket/key` (client.go lockPath); `Operation` is the backendrun.OperationType stringer, `OperationTypeApply`; the DynamoDB lock is a conditional PutItem (`attribute_not_exists(LockID)`), so a held lock returns ConditionalCheckFailedException and the backend reads the holder's info back. Real-world shape of the message `operation error DynamoDB: PutItem, https response error StatusCode: 400, RequestID: ..., ConditionalCheckFailedException: The conditional request failed` (no `api error`: a modeled exception) seen in a dev.to post (aws-builders, switching to S3 native locking). force-unlock prompt/texts as above. Interrupt texts `Interrupt received. / Please wait for Terraform to exit or data loss may occur. / Gracefully shutting down...` and `Two interrupts received. Exiting immediately. Note that data loss may have occurred.` (internal/command/views/operation.go; wrapped at 78 columns on a non-terminal, so `occurred.` lands on its own line); SIGINT and SIGTERM both count as interrupts (commands.go makeShutdownCh, signal_unix.go); on the first interrupt the state is persisted at once (internal/backend/local/hook_state.go Stopping). GitHub cancels a run with SIGINT, SIGTERM 7.5 s later, then kills the process tree (docs.github.com workflow-cancellation). `gh run list` columns STATUS TITLE WORKFLOW BRANCH EVENT ID ELAPSED AGE, `X` for any completed non-success run (cancelled included), `*` for in progress, `no runs found` when empty; `gh run view` header/JOBS/ANNOTATIONS/footer layout, steps listed only for a failed job (cli/cli pkg/cmd/run). `-lock-timeout` and `-lock=false` wording (plan docs); `dynamodb_table` needs a `LockID` string partition key, DynamoDB locking deprecated in favour of `use_lockfile` in newer versions (s3 backend docs).
- [ ] Timeline simplified: the log shows the reconciler `Creating...` when the cancel arrived, and the world has no instance (describe-instances is empty). In reality an interrupted RunInstances may or may not have launched one; the debrief says to check. Why Terraform hadn't exited within 7.5 s (an in-flight create) is implied, not shown. The brief's "last line Terminated" was replaced by GitHub's own lines.
- [ ] From experience, not docs: the GitHub job log lines `Current runner version`, `Runner name`, `Runner group name`, `Machine name`, `##[group]`/`##[endgroup]`, `shell: /usr/bin/bash -e {0}`, `##[error]The operation was canceled.`, `Post job cleanup.`, `Cleaning up orphan processes`, and the timestamp prefix; the annotation `The run was canceled by @USER.` (seen on a public GitHub Enterprise run page) but its `apply: .github#1` location line and `Process completed with exit code 1.` at `.github#24` are guesses. The log has no ANSI colour codes (a real raw log from a coloured terraform would).
- [ ] The lock box wraps the long DynamoDB message at the simulator's width; real Terraform wraps to the terminal width.
- [ ] Not simulated: `aws dynamodb get-item/scan/delete-item` on terraform-locks (deleting the lock item by hand does the same as force-unlock, without the ID check); `gh run view --log`, `--job`; `gh run list --json`. They answer "no simulated output".
- [ ] key_evidence is all earnable while the lock is held (lock holder, run dead, network in state); the post-unlock plan (`ci-partial-plan`) is non-key. gh run #213 is a README change and the CI log installs the simulator's provider v5.67.0, so nothing contradicts `~> 5.0`.
- [ ] Invented: lock ID, RequestID, resource ids, run/job ids, runner name and user, PR titles and numbers, @dmitri-k, the AMI id, the timestamps.

terraform-sg-cycle:
- [x] Verified 2026-10-09 against Terraform v1.9.8 source (raw.githubusercontent.com): the cycle error is `dag.AcyclicGraph.Validate`'s `fmt.Errorf("Cycle: %s", strings.Join(names, ", "))` (internal/dag/dag.go), one error per strongly connected component of more than one node (internal/dag/tarjan.go); it reaches the CLI as a plain error, so no `with`/`on` location and no detail. `plan`/`apply` run Validate first (backendrun CLIOpts.Validation = true in internal/command/meta_backend.go; backend_local.go `if b.OpValidation`), and the validate graph's resource nodes are `NodeValidatableResource`, whose Name() is the bare address (node_resource_abstract.go), so no ` (expand)` suffix (that suffix belongs to `nodeExpandPlannableResource`, the plan graph). format.Diagnostic prints the summary followed by `\n\n` whatever follows, so the box has a blank `│` line under the summary even with nothing else (internal/command/format/diagnostic.go): the simulator now prints it (src/game/terraform/diag.ts). Same source: appendSourceSnippets prints `with ADDR,`, then (only when there is a source range) the `on FILE line N` snippet followed by a blank line, so a located diagnostic always has a blank `│` line after the snippet, while an address-only one runs straight into the detail with no blank (the function returns before its trailing newline when Range is nil). diag.ts now follows that; tests/terraform-diag.test.ts covers both.
- [ ] The order of the two names: real Terraform's order comes from Tarjan over `Set.List()`, a Go map iteration, so it can be either order from run to run; the simulator sorts them (app, web), which is one of the two real outputs.
- [x] Verified 2026-10-09: aws_security_group `ingress` is a set block without ForceNew and changes go through `updateSecurityGroupRules` (in place); delete retries DependencyViolation/InvalidGroup.InUse for the delete timeout (15m) and then fails with `deleting Security Group (%s): %s`; create fails with `creating Security Group (%s): %s` (provider v5.67.0 internal/service/ec2/vpc_security_group.go). Provider docs: "When a security group is associated with a resource, the delete won't succeed"; inline rules discouraged in favour of aws_vpc_security_group_ingress_rule, and not to be mixed with rule resources; one of cidr_blocks/ipv6_cidr_blocks/prefix_list_ids/security_groups is needed (website/docs/r/security_group.html.markdown). AWS API reference: DeleteSecurityGroup fails with DependencyViolation for a group associated with an instance or ENI or referenced by another group in the same VPC; EC2 error codes: InvalidGroup.Duplicate for a second group of the same name in a VPC. VPC User Guide (security-group-rules): a rule may reference another group in the same VPC (or peered/transit gateway); nothing forbids two groups referencing each other (the docs don't address mutual references explicitly).
- [ ] Error message texts from real-world reports, not AWS docs: `resource sg-... has a dependent object` (DependencyViolation on DeleteSecurityGroup), `The subnet 'subnet-...' has dependencies and cannot be deleted.` (DeleteSubnet), `The security group 'NAME' already exists for VPC 'vpc-...'` (InvalidGroup.Duplicate). The SDK v2 wrapper and the 400 status are the usual EC2 shape. The simulator's own generic SG DependencyViolation text (src/game/terraform/provider.ts `dependencyViolation`) lacks the `operation error EC2: DeleteSecurityGroup, https response error ...` part; this incident's faults supply the full shape.
- [ ] The destructive trap (recreate the groups) is button-only: every terminal route is refused by AWS in this world (delete faults for both groups and both subnets: the hosts use them; create faults for a second checkout-web/checkout-app). The fix's done_when still excludes any applied delete/create of either group. `state rm` then apply fails on InvalidGroup.Duplicate; `terraform import` brings the group back and the fix is earnable again.
- [ ] Not simulated: `terraform graph` (mentioned in the debrief), `gh pr checks`, describe-security-groups by vpc-id (would list the VPC's default group too). (The separate rule resources are now simulated; see the 2026-10-10 rework section.)
- [ ] describe-security-groups output: field names from the AWS CLI reference example; the field order (GroupId, IpPermissionsEgress, VpcId, SecurityGroupArn, OwnerId, GroupName, Description, IpPermissions, Tags) is from experience with recent CLI v2 output, not docs. `gh pr diff` prints the same unified diff as `git diff main` (gh manual: shows the PR's changes; exact header lines not checked).
- [ ] Invented: ids, RequestIDs, PR #318, commit hashes, branch callbacks-8443, the people, the 8443 callback story.

## terraform follow-ups (TF7)

- [x] Done in TF7a Task 1 (was: a hypothetical engine defect; no shipped incident uses `create_before_destroy`, terraform-sg-cycle does not): `create_before_destroy` was ignored by apply ordering (src/game/terraform/apply.ts): a `+/-` replacement still deletes first. In terraform-sg-cycle a renamed group with create_before_destroy fails on the old group's DependencyViolation before creating the new one; real Terraform would create the new group, then fail deleting the old one and keep it as deposed.
- [x] Done in TF7a Task 4 (was: lock bypass history for state-writing CLI commands): `state rm`/`mv`, `taint`, `untaint`, `import`, `workspace new`/`delete` record a history line with ` (lock bypassed)` when `-lock=false` ran past a held lock; `lock_bypassed: true` is the any-bypass leaf.
- [x] Done in TF7b Task 3: content/iac/terraform-state-lock.yaml retired; terraform-cancelled-ci-lock supersedes it on the simulator. (The retired file also used the evidence tag `partial-apply`, as terraform-partial-apply-iam does; tags are per incident, so no clash.)
- [ ] Unverified (TF7a Task 3): `NotFound` wording on a `-refresh=false` update of a vanished object: EC2 `updating EC2 Instance (ID): operation error EC2: ModifyInstanceAttribute, ... api error InvalidInstanceID.NotFound: The instance ID 'ID' does not exist` (operation name chosen, not traced), S3 `updating S3 Bucket (ID) tags: ... PutBucketTagging ... StatusCode: 404 ... NoSuchBucket: The specified bucket does not exist`, every other type a generic `updating TYPE (ID): NotFound: the object does not exist`. A delete of a vanished object succeeds silently (providers treat NotFound as gone; not checked per resource type in provider v5.70.0).
- [ ] Limitations (TF7a Task 3): the NotFound update texts hardcode the operation (`ModifyInstanceAttribute`, `PutBucketTagging ... tags`) whatever attribute changed; a `cloud.release` and a `cloud.add`/state object with the same `type:id` act on the one cloud entry (the release deletes it once its actions are taken), and a release is applied at the next shell sync, `done_when` check or terraform command, not at the instant of the action.
- [ ] Apply ordering is sequential and ignores `-parallelism` (see the TF5 defect list); create_before_destroy ordering landed in TF7a Task 1 without it.
- [x] Verified 2026-10-09 against Terraform v1.9.8 (internal/command/jsonformat/plan.go resourceChangeComment, internal/terraform/node_resource_apply_instance.go): a deposed object's plan row is `# ADDR (deposed object KEY) will be destroyed` followed by `# (left over from a partially-failed replacement of this instance)`; the `+/-` symbol and legend for create-then-destroy replacements were already in place; on a failed create under create_before_destroy the old object is restored (MaybeRestoreResourceInstanceDeposed), so nothing is deposed.
- [ ] Unverified (TF7a Task 1): the step order of a CBD replace is create new, update dependents that now point at the new id, delete the old one (the old delete waits for every create/update that depends on the resource); written from the graph rules (create_before_destroy reverses the destroy edge), not traced through a real run.
- [ ] Unverified (TF7a Task 1): the apply progress line for a deposed delete reads `ADDR (deposed object KEY): Destroying... [id=...]`; the 8-hex-digit key is generated (`hex(seed, 8)`), real keys are 8 hex digits too.
- [ ] Simplifications (TF7a Task 1): at most one deposed object per address (a second CBD replace is held back until the first deposed object is gone; real Terraform can hold several); a failed deposed delete no longer blocks the live instance's updates or its dependents, but it still holds back the live instance's own destroy and a second CBD replace at that address in the same run (so the deposed object is never orphaned or overwritten); prevent_destroy is not applied to a deposed object; deposed objects are not handled by `import`, `state mv` renames of single deposed entries, `state push`, or refresh (a deposed object deleted out of band is only noticed when its delete runs); `terraform state list` prints the deposed row but `state show`/`state rm ADDR#deposed` cannot address it; `state_has`/`state_lacks` predicates ignore deposed objects; `tfstate` JSON writes it as an extra instance with `deposed: KEY`.
- [ ] Faults keyed on something other than the address (type/natural id, or the provider call), so a rename can't dodge them (TF5 defect list).
- [ ] Scripted commands with an exit code (TF5: put-role-policy AccessDenied should exit 254).
- [ ] `IncidentShell.program` honouring `ctx.env.AWS_PROFILE` (export / env prefix inside a pipeline) when choosing scripted output.
- [ ] Deferred TF5 candidates: eventual consistency (needs a retry/timeout model) and a stale saved plan in CI (needs a world event between `plan -out` and `apply`).

## terraform modules engine (TF6a)

- [x] Verified 2026-10-09 against Terraform v1.9.8 source (raw.githubusercontent.com): `Unreadable module directory` is emitted twice for a missing local module dir at init, first `Unable to evaluate directory symlink: lstat modules/nope: no such file or directory` (filepath.EvalSymlinks error), then `The directory  could not be read for module "nope" at main.tf:3.` (the directory name is empty after the failed EvalSymlinks, hence the two spaces); neither has a source range (internal/initwd/module_install.go installLocalModule). `Module not installed`, `Module source has changed`, and the unreadable-cache variant are from the spec (configload loader_load.go).
- [ ] Unverified: the exact bytes of `.terraform/modules/modules.json` (the simulator writes compact JSON, root record first, entries sorted by key; real Terraform may indent and keeps its own order). The player normally only sees it via `cat`.
- [ ] Lab-specific, invented: `Unsupported module source` (registry, git and other remote sources; TF6b adds registry), the same summary for a `../` source that leaves the lab directory (real Terraform allows it for the root module), `Invalid module source` for a non-literal `source`. `Missing required argument` / `The argument "source" is required, but no definition was found.` is the standard HCL text, not checked for module blocks.
- [ ] Simplifications: a local module directory with no `.tf` files counts as unreadable (the shell cannot tell a missing directory from an empty one); `init` prints `Initializing modules...` with no leading blank line and lists modules in key order.
- [x] Verified 2026-10-09 against Terraform v1.9.8 (internal/terraform/evaluate_valid.go, evaluate.go, transform_module_variable.go): inside a child module the undeclared-resource/module texts end `has not been declared in module.net.` / `is declared in module.net.` (moduleConfigDisplayAddr: "the root module" or the module address, nested `module.a.module.b`); variable and local texts do not name the module. A missing module input and an undeclared input come from the HCL body schema built from the child's variables (`Missing required argument` / `The argument "cidr" is required, but no definition was found.`, `Unsupported argument` / `An argument named "bogus" is not expected here.`).
- [ ] Simplifications (graph): the missing-argument diagnostic points at the module block start (real: the call body start); `Unsupported attribute` for an undeclared module output (`This object does not have an attribute named "x".`, from the object type built from the child's outputs, not a literal string in evaluate.go) is reported at the start of the `module` reference, not at the attribute name; real Terraform also appends `Did you mean "x"?` suggestions that the simulator never prints; cycle lists use static qualified addresses without real Terraform's `(expand)` suffixes.
- [x] Verified 2026-10-09 against Terraform v1.9.8 (internal/command/jsonformat/plan.go L432-442): a destroy because the resource is gone prints `(because aws_x.y is not in configuration)` with the UNQUALIFIED type.name, even for a module resource; a destroy because the module instance is gone prints `(because module.net is not in configuration)` (ModuleAddress, instance-qualified).
- [x] Verified: `path.module` inside a child module is the module's SourceDir relative to the working directory (`modules/net`), root `.`.
- [ ] Simplification (TF6a apply/CLI): a syntax error in any module file makes the graph report only the syntax diagnostics (real Terraform also stops at parse errors, but loads and reports them per module directory; ordering and grouping of several errors across modules may differ). Saved plans store the whole installed module tree (a lab-internal representation, not a real plan file).
- [x] Verified 2026-10-09 against Terraform v1.9.8: `moved` between a module and a resource is `Invalid "moved" addresses` / `The "from" and "to" addresses must either both refer to resources or both refer to modules.` (internal/configs/moved.go); an `import` block in a child module is `Invalid import configuration` / `An import block was detected in "module.net". Import blocks are only allowed in the root module.` (internal/configs/config_build.go L226-227); the plan line `# aws_vpc.main has moved to module.net.aws_vpc.main` (internal/command/jsonformat/plan.go L471, PreviousAddress then the new address); `terraform import` of an undeclared address names the module path without instance keys (`please create its configuration in module.net.`, internal/command/import.go) and the root as `the root module`.
- [ ] Unverified: the capitalisation of the CLI import error (`Resource address "..." does not exist in the configuration.`; the real command prints `resource address %q ...` in lowercase after `Error:` through the plain UI, not a diagnostic). Kept from TF3.
- [ ] Lab-specific, invented: a module moved into itself (`moved { from = module.a  to = module.a.module.b }`) is `Invalid "moved" addresses` / `Cannot move module.a to module.a.module.b: a module cannot be moved into itself.` (real Terraform may word or detect it differently); the `Invalid "to" address` / `Invalid "from" address` detail texts now also mention module addresses.
- [ ] Simplifications (TF6a moved/import): `moved`/`removed` blocks inside child modules are ignored (real Terraform applies them relative to the module; TF6b); `removed { from = module.net }` (whole module) is deferred and reported as `Invalid "from" address`; `moved` blocks rewrite the `dependencies` recorded in state (static resource keys, whole-module renames included), as `state mv` does; partial instance-key moves of a counted resource rename the whole resource key.
- [ ] Open questions (spec): does the player-facing JSON (`state pull`) of a module move order resources the way real Terraform does (the simulator keeps state order, moved groups appended)? Is a missing `moved` for a renamed module worth a hint in `plan`? (real Terraform has none).

## terraform modules engine (TF6b)

- [x] Verified 2026-10-09 against Terraform v1.9.8 (internal/command/jsonformat/plan.go L436-442, jsonplan/plan.go): a destroy because a module instance is gone (removed `for_each` key, `count` shrink, `count`/`for_each` switch of the call) prints `(because module.net["b"] is not in configuration)` (the resource's full ModuleAddress, instance-qualified; there is no module-level wrong-repetition reason). The check order follows node_resource_plan_orphan.go from memory (resource configuration missing first, then module instance missing, then the resource's own repetition); that file was not re-fetched.
- [ ] Unverified: terraform removing a whole module call prints the resource reason in real Terraform (the resource config lookup is nil), while TF6a pins `(because module.net is not in configuration)`; kept as TF6a had it.
- [ ] Unverified texts for a bare repeated module reference used wrongly: `module.net.vpc_id` on a `for_each` call gives `Unsupported attribute` / `This object does not have an attribute named "vpc_id".`; on a `count` call (a tuple) `This value does not have any attributes.` (real HCL wording for tuples not checked). Resources use `Missing resource instance key` instead; real Terraform has no such message for modules (not checked).
- [ ] Invented: `terraform import` into a module instance the call does not expand to (unknown key, or no key on a repeated call) reuses `Configuration for import target does not exist` (real: `internal/command/import.go` only checks the static configuration, `Import to non-existent module` for a missing module call; the instance-level error text was not found). A missing module call still gives the TF6a `does not exist in the configuration` text (real: `Import to non-existent module`).
- [ ] Simplification: dependencies are per resource (static key-less names, as in real state files) and the apply scheduler treats a dependent of `module.net.aws_x.y` as depending on every instance; a failed instance therefore also holds back dependents of the other instances (real Terraform tracks instances). `-replace=module.net.aws_x.y` (no key) warns with the instance list, like a counted resource.
- [ ] Simplification: `moved` from a module step without a key matches every instance and carries the key (`module.net` to `module.network`), but not when the destination adds a key to an already keyed instance. Moving only some keys to a new module name keeps both static names in the dependents' `dependencies`. There is no implicit move between `module.net` and `module.net[0]` (resources get one in real Terraform 1.1+; modules need `moved`).
- [x] Verified 2026-10-09 against Terraform v1.9.8 (internal/modsdir/manifest.go, command/hook_module_install.go, initwd/module_install.go): the manifest key of a nested module is the call names joined with `.` (`net.inner`); `init`/`get` print `- KEY in DIR` once per module (including nested), where a local module's Dir is the parent's Dir joined with the source (`modules/net` + `./inner` = `modules/net/inner`). The simulator prints entries sorted by key string; real Terraform walks depth first in call-name order, which differs only for names such as `net-x` vs `net.inner`.
- [ ] Invented (lab-specific): `Module cycle` (`Module "x" calls the module in "DIR", which is already being loaded: . -> a -> b -> a.`) and `Module stack level too deep` (`This configuration has nested modules more than 8 levels deep.`). Terraform v1.9.8 has no guard for local sources (grep of configs/ and initwd/ found none), so a real cycle never terminates there.
- [ ] Unverified: root `moved` blocks that address nested modules by full path (`module.net.module.inner` to `module.net.module.core`) are supported and shown as `X has moved to Y` with full addresses; real Terraform accepts module paths in root moved blocks, but its restriction text for moves out of a module package (`Cross-package move statement`, only relevant for remote modules) is not modelled. `moved` blocks inside child modules (relative to the module) remain ignored.
- [ ] Simplification: a configuration error inside a repeated module is reported once at the first instance (diagnostics are deduplicated on file, position, summary and context); a message that would differ per instance only shows the first.
- [ ] Orphan reason for a resource of a nested module whose call (or an ancestor call) was removed from configuration is `(because module.net.module.inner is not in configuration)` with the RESOURCE's own module path (so for a grandchild resource the grandchild path), following jsonformat/plan.go ModuleAddress.
- [x] Verified 2026-10-09 against Terraform v1.9.8 (initwd/module_install.go, command/hook_module_install.go, configload/loader_load.go, configs/version_constraint.go) and hashicorp/go-version v1.6.0: `Downloading SOURCE VERSION for KEY...` and `- KEY in DIR` lines; `Unresolvable module version constraint` / `There is no available version of module "ADDR" (FILE:LINE) which matches the given version constraint. The newest available version is X.`; `Module not found` / `Module "NAME" (from FILE:LINE) cannot be found in the module registry at HOST.`; `Module has no versions`; `Invalid version constraint` for a local source (`Cannot apply a version constraint to module "x" (at FILE:LINE) because it has a relative local path.`) and for malformed strings (`This string does not use correct version constraint syntax.`); `Module version requirements have changed` (with and without `(x.y.z)`, reported at the `source` line); registry install dir `.terraform/modules/<dotted key>`; `Upgrading modules...` header; `~>` semantics including the go-version quirk that `~> 5` has no upper bound.
- [ ] Deviation from the plan text: when a registry module is already installed and still satisfies, REAL Terraform calls neither hook (the installer returns early), so plain `init` prints nothing for it, and the lab does the same. Local modules still print `- net in modules/net` on every init (TF6a behaviour, kept); real Terraform prints nothing for an already recorded local module either.
- [ ] Unverified: `%q` of the registry address in `Unresolvable module version constraint` / `Module has no versions` is assumed to be the full `registry.terraform.io/NS/NAME/PROVIDER` (the Go `String()` of the package address); the spec's shorter form was from memory.
- [ ] Simplification: the `Invalid version constraint` for a `version` on a local source is raised at every `init`/`get` (real Terraform raises it only when it installs that module, so a recorded unchanged local module with a stray `version` would pass a re-init). `Module source has changed` and `Module version requirements have changed` are both located at the `source` line, as real (fixed at the end of TF6b).
- [ ] Simplification: registry modules support no `//subdir` suffix, no `version` on non-literal strings (ignored), and only the `X.Y.Z[-pre]` form in authored data (go-version also accepts 1-2 segment strings in constraints, which the matcher does). A file the previous version had and the new one lacks is emptied (the simulated disk has no delete), so it stays on disk as an empty `.tf`.
- [x] Verified 2026-10-09 against Terraform v1.9.8 (configs/config.go VerifyDependencySelections, backend/local/backend_local.go, configs/module.go CheckCoreVersionRequirements, depsfile/locks.go, providercache/installer.go, command/init.go): both `Inconsistent dependency lock file` entry forms and when each is used (lock `constraints` differs from the current combined constraints, or equal), the suggestion switch (`terraform init` only when the lock is EMPTY, else `terraform init -upgrade`), `Unsupported Terraform Core version` incl. the `Module module.x (from SOURCE)` form located at the required_version value, the installer errors (`locked provider ADDR VERSION does not match configured version constraint C; must use terraform init -upgrade to allow selection of new versions`, `no available releases match the given constraints C`), `Provider dependency changes detected`, `The -upgrade flag conflicts with -lockfile=readonly.`, and that `Locks.Equal` ignores constraints (a constraint-only change is written to the lock silently, without the "made some changes" paragraph).
- [ ] Deviations/simplifications (providers): `terraform validate` does NOT check lock versions (real validate never calls VerifyDependencySelections), but the old missing-entry check on validate is kept as TF5 had it (real validate would say `Missing required provider` / needs init); the `terraform init` text suggestion for a missing entry now follows the real switch (`-upgrade` once the lock has any entry; before it always said `terraform init`). Combined constraints are joined in module walk order with `, ` and duplicates dropped (real Terraform sorts and canonicalises the constraint string). A `required_providers` entry that names a provider no resource uses still needs a lock entry (as real). A required_providers `version` that is not a valid constraint is `Invalid version constraint` located at the provider entry (real points at the version expression). `required_version` with a prerelease constraint is not given the real `Invalid required_version constraint` error.
- [ ] Unverified: the wrapper of the installer error for a constraint/lock mismatch is the default branch of init's QueryPackagesFailure (`Failed to query available provider packages` / `Could not retrieve the list of available versions for provider hashicorp/aws: <error>`); real init may add the `terraform init -upgrade`-style suggestion differently and prints the `Initializing provider plugins...` progress lines before it. `init -upgrade` for an already-installed picked version prints `- Using previously-installed hashicorp/aws vX` after the `Finding` line (real prints the cache message depending on the plugin cache). Provider hashes are invented (`h1:` + 32 FNV-derived bytes in base64; the default version 5.67.0 keeps its old constant) and only the `h1:` form is written (real locks also list `zh:` hashes).
- [ ] Simplifications (providers): the scenario `terraform.providers` is keyed by provider name (the last segment of the source), so two sources with the same name share an entry; providers without an entry offer only 5.67.0; the starting lock file lists `aws` only; its `constraints` are collected from every `.tf` file in `terraform.files` and the installed registry files, called or not.
- [x] Verified 2026-10-09 against Terraform v1.9.8 (internal/builtin/providers/terraform/data_source_state.go): `Unable to find remote state` / `No stored state was found for the given workspace in the given backend.` (attribute path `workspace`, so the data block when `workspace` is not set), `Invalid backend configuration` / `There is no backend type named "bogus".` (path `backend`), `The configuration must be an object value.`, `Invalid default values` / `Defaults must be given in an object value.`; the attributes are backend, config, defaults, outputs, workspace and there is NO `id`; `workspace` is stored as given (null when unset, not "default"), `defaults` null when unset; outputs = defaults overlaid with the upstream's root outputs.
- [ ] Unverified/invented (remote state): the printed diagnostics reuse the lab's "with ADDR, on FILE line N, in data ..." form; `Incorrect attribute value type` for a non-string `backend`/`workspace` is the generic HCL text; the backend list (local, remote, azurerm, consul, cos, gcs, http, inmem, kubernetes, oss, pg, s3) is from memory of internal/backend/init; `Missing required argument` for `backend` is raised at plan, not by `validate`. Real backend-specific errors (a missing S3 bucket: `Error: Failed to get existing workspaces`, credentials) are not modelled.
- [ ] Simplifications (remote state): mutable upstream (a remote state changing during the session) is deferred; `terraform_remote_state` with `count`/`for_each` is not expanded; the entry is saved in state by apply and dropped by the next plan/apply when its block is removed (a read deferred by an unknown argument keeps its entry); `terraform refresh` does not re-read it; `-refresh=false` still reads it (as real does); the first plan prints the `Reading...` lines from the configuration, later ones from state.

### TF6b: simulator limits (summary)

- [ ] Stale empty `.tf` after a registry upgrade: a file the old version had and the new one lacks is emptied, not deleted (the simulated disk context has no delete).
- [ ] A failed instance of a repeated module (or counted resource) holds back the dependents of ALL instances (dependencies are static per-resource names, not per instance).
- [ ] Unverified: orphan-reason precedence for a removed whole module call (`module.net is not in configuration` pinned from TF6a; real may print the resource reason).
- [ ] Unverified: `init` entry order for odd call names (`net-x` vs `net.inner`); the mounted starting lock always carries the config's current constraints (an author wanting a stale-constraint start mounts their own `.terraform.lock.hcl` in `terraform.files`); `init` writes the lock on a constraint-only change silently (real also does not print the "made some changes" text, matches).
- [ ] Invented: provider hashes (`h1:` FNV-derived), the combined constraint string (joined in walk order, not canonicalised/sorted as real), lab errors `Module cycle` / `Module stack level too deep`.
- [ ] A registry module with a local submodule cannot be pre-installed through `modules.installed` (schema requires local dirs in `terraform.files`); it needs `terraform init`.

### TF6c prerequisites (what incident authors can rely on now)

- Keyed (`count`/`for_each`) and nested module calls, with addresses at any depth in state, `faults`, `done_when`, `-replace`, `taint`, `import`, `moved`.
- Authored registry modules with versions, `init`/`init -upgrade`/`get -update`, version-constraint errors, installed-version starting labs.
- Provider versions and lock file (`terraform.providers`, stale-lock starts via an authored `.terraform.lock.hcl`), `required_version`, `-lockfile=readonly`.
- `terraform_remote_state` with authored upstream outputs (`terraform.remote_states`), orphan data entries dropped on removal.
- Not available: mutable upstream state, git/S3 module sources, module `providers`, per-instance dependency tracking, `removed` of a whole module.
- Verified texts are the `[x]` entries above; every `[ ]` text is unverified or invented and must not be quoted as real Terraform output in explanations.

### TF6b final-review items

- [ ] Low confidence: `removed { from = module.x["k"].aws_... }` is accepted and then reports `Removed resource still exists`; real Terraform 1.9 may reject instance keys in `from`.
- [ ] Simplification: a hand-edited `.terraform.lock.hcl` is indistinguishable from `init -upgrade` for `done_when` (no provider cache model); author wrong actions for it with `file_contains` on `main.tf`.
- [ ] Not simulated: `-target`, `terraform providers`, `providers lock`, `show <planfile>`, `console`, `fmt`.

## terraform incidents batch 3 (TF6c)

### -target (task 1)

- Verified against Terraform v1.9.8 source: warning texts (`internal/terraform/context_plan.go`, `context_apply.go`), error title `Invalid target "..."` (`internal/command/arguments/extended.go`), graph rule (`transform_targets.go`: targets plus ancestors; outputs kept when every resource ancestor is targeted; only directly targeted nodes get `SetTargets`), and warning order (`backend/local/backend_apply.go`: the apply warning prints just before the summary; plan warnings print after the plan and before the prompt).
- Unverified: the detail of `Invalid target` is always `Resource specification must include a resource type and name.` (the real detail varies with the parse failure: HCL syntax errors, `Invalid address` variants). Not accepted: the optional `resource.` prefix and whitespace around the address.
- Deviation: `moved` blocks are applied to the whole state even with targets (Terraform warns `Moved resource instances excluded by targeting` and skips excluded ones); `import` blocks outside the set are ignored.
- Deviation from the task text: `apply tfplan` prints only `Applied changes may be incomplete` (the plan-time warning is part of `plan`, as in Terraform).

### Provider cache and `terraform providers` (task 2)

- Verified against Terraform v1.9.8 source: `internal/command/meta_providers.go` (`providerFactories`: `there is no package for %s %s cached in %s`, `the cached package for %s %s (in %s) does not match any of the checksums recorded in the dependency lock file`, only `h1:` hashes count, no hashes = no check), `meta_backend.go` (`Required plugins are not installed` and its two paragraphs, raised by `Meta.Backend`, i.e. by every backend-opening command), `meta.go`/`validate.go` (validate gets the plain error from `contextOpts`), `providercache/installer.go` + `package_install.go` (the `Failed to install provider` / `the current package for ... doesn't match any of the checksums previously recorded ...` text, `-upgrade` keeps the recorded hashes only when the selected version equals the locked one), `internal/command/providers.go` (tree and state sections), `providerreqs/version.go` (constraint string form).
- Deviation from the task text: the task expected state/output not to run the cache check and a `provider ...: the cached package ... 5.31.0 ...` line; the source shows that every command that opens the backend runs it, with the `  - ADDRESS: ...` line format. A lock whose VERSION is edited produces the `there is no package for` form (the cache is looked up by the locked version); the `cached package ... does not match` form needs a hash edit.
- Invented/simplified: the marker file text and the package hash (deterministic stand-ins; the default version keeps the existing hash); the sim registry always serves the authentic package for a version (`providerHash`); `TF_IN_AUTOMATION` variant of the suggestion (`You must install the required plugins before running Terraform operations.`) is not modelled; the cache check covers only the providers the configuration needs; a lock with no `h1:` hash and a cached package is treated as installed by `init` (real Terraform reinstalls); `providers` constraints are shown as written (Terraform prints the canonical form: sorted, `>= 5` as `>= 5.0.0`, `= 1.0.0` as `1.0.0`) and module/provider order is alphabetical (Terraform's is random); `providers -test-directory` and a DIR argument are ignored/refused; `providers lock`, `mirror`, `schema` stay "not available".

### terraform-module-refactor (task 3)

- Verified (pages opened 2026-10-09): moved blocks can move a resource into a child module and Terraform otherwise destroys and creates at the new address (refactoring page); `state mv` into a module and the coordination warning (state/mv page); `-target` is for "exceptional circumstances" and expands to dependencies (cli/commands/plan page); module path in addresses (resource-addressing page); `prevent_destroy` rejects destroy plans and does not guard a removed block (lifecycle page). Plan and warning texts are the simulator's, verified in Task 1.
- Design decision: `terraform apply -target=module.network` creates a second network (3 created, originals stay in state under the old addresses) and is the `wrong` action `target-the-module`, detected by `applied create module.network` without `applied delete aws_vpc.main` (a plain apply that also creates the module is the trap, not this). The fix excludes any `applied create module.network`: the duplicates cannot be removed (destroy -target=module.network includes the dependent protected db host) and a moved block does not reconcile two existing objects, so the fix is not earnable afterwards.
- Verified (review, v1.9.8 `refactoring/move_validate.go` has no error; `move_execute.go` skips the move and only logs a warning): a `moved` block whose `to` already exists is skipped, as the simulator does; the db host is an `aws_instance` (a self-managed Postgres host) because `aws_db_instance` has no subnet attribute in the simulator schema; no `aws ec2 describe-vpcs` library entry exists, so only subnets and instances are scripted lookups.


### terraform-module-upgrade (task 4)

- Verified (pages opened 2026-10-09): module `version` is for registry modules, and changing it needs `terraform init` (`-upgrade` for already-installed modules) (language/modules/configuration); `~>` semantics and the advice to require specific versions for third-party modules (expressions/version-constraints); plain `init` does not change already-installed modules, `-upgrade` applies to modules and providers, modules install under `.terraform` (cli/commands/init); the lock file tracks only providers and Terraform always selects the newest module version meeting the constraint (files/dependency-lock); `prevent_destroy` rejects destroying plans (meta-arguments/lifecycle); RDS can only be encrypted at creation, encrypted snapshot copy as the workaround (AWS RDS Overview.Encryption). Plan and error texts are the simulator's, verified in earlier tasks.
- Design: v2.1.0 of the invented acme/database/aws sets `storage_encrypted` from a variable defaulting to true (ForceNew on aws_db_instance); prevent_destroy inside the module gives the partial plan + error. Two fix actions (solution_paths [[pin-the-module],[override-the-input]]), both world-based: pin = plan_clean + modules.json shows db Version 2.0.x (any spelling of the constraint); override = plan_clean + a `storage_encrypted = false` line in main.tf + modules.json Version 2.1.0. Pin and override together cannot plan (2.0.1 has no such input). Trap: remove the guard in `.terraform/modules/db/main.tf` and apply (world: `applied delete module.db.aws_db_instance.main`). Wrong: ignore_changes in the cached module (detected by `file_contains`), re-running `init -upgrade` (button only).
- Unverified/advice, not quoted as doc facts: `get -update` overwrites edits in `.terraform/modules` (the init page does not describe `get -update`); "read release notes and try an upgrade in a non-production copy first" is general practice, no page opened; the `Note: Objects have changed outside of Terraform` wording in the console-change feedback comes from earlier incidents, not re-verified here; git log/status output is invented.
- Simulator note: scripted `cat .terraform/modules/...` lines are mounted over the lab's module files at start, so their output is exactly the registry version's file; keep them equal to the authored 2.1.0 files (a YAML anchor does this).

### terraform-provider-lock-drift (task 5)

- Verified (pages opened 2026-10-09 with WebFetch, which returns a model summary of the page, not raw text, so wording below is paraphrase): the lock file records version, constraints and checksums; commit it to version control so changes are reviewed; `terraform init -upgrade` overrides recorded selections and takes the newest version matching the constraints; `-lockfile=readonly` suppresses lock changes but verifies checksums and conflicts with `-upgrade`; do not hand-edit hashes (files/dependency-lock, cli/commands/init). Plan/init/cache error texts are the simulator's, verified in Tasks 1 and 2 and the earlier provider work.
- Unverified: `terraform providers lock` for multi-platform checksums is mentioned in the debrief from the lock-file page summary only; `terraform providers lock` itself is not simulated. The git outputs (log, diff, status, stat), the branch name, PR number and all hashes in the mounted starting lock are invented (the 5.31.0 hash is a stand-in; the cache is seeded from it). That 5.50+ is "an S3 fix" is invented story, no real provider release is claimed.
- Design: the PR bumps `~> 5.31` to `~> 5.50`; the starting lock is mounted (5.31.0, constraints `~> 5.31`), `.gitignore` is mounted too (for the ignore-the-lock trap). One fix (`refresh-lock`), world-based: `plan_clean` + main.tf still has a constraint with a 5.50-or-later floor + the lock names 5.67.0 or 5.50.0 together with the package hash `init` writes for that version (so a hand-edited version with the old hash is never credited, and neither is a version-only edit). Reachable versions: `available: [5.31.0, 5.50.0, 5.67.0]` (5.50.0 only via a capped constraint such as `~> 5.50, < 5.60`).
- Wrong actions (all world-detected): `revert-the-bump` (plan_clean and the raised constraint gone), `hand-edit-lock` (lock version >= 5.50 without the authentic hash), `ignore-the-lock` (`.gitignore` names the lock file). Editing to 5.67.0 by hand is not repaired by `init -upgrade` (same version selected, recorded hashes kept) nor by plain `init`; deleting the lock and `init` repairs it (tested). The mistakes stay recorded; the fix remains earnable.
- No `destructive` action, on purpose: the validator does not require one (AUTHORING.md says every scenario needs a shotgun trap, but nothing in this world deletes or changes live objects; provider versions are not behaviour-sensitive in the lab). A button-only destructive would be invented harm. The task 8 UI test for this incident therefore has no destructive trap path (use `hand-edit-lock` as the mistake path, `mistakes.wrong === 1`).
- Scripted `git diff --stat origin/main` and `git status` switch with `when_actions: [refresh-lock]` (the lock shows as modified: commit it). The `|2` indentation indicator keeps the leading space git prints on stat lines. Terraform commands are real simulator output; `terraform version/providers` carry evidence via `terraform.evidence`, so they have no command_notes (the validator only accepts notes for scripted commands).
- Limits: `-lockfile=readonly` flows are tested but not part of the fix (the debrief recommends them for CI). Real Terraform's `Inconsistent dependency lock file` box is also produced by `init` only in different forms; not modelled beyond the existing `Failed to query available provider packages`.
- Review fixes: `git checkout [--] FILE` / `git restore [--source=HEAD] FILE` in a terraform lab now restore the file as the incident mounted it (src/game/shell.ts `git`; the starting tree is the committed one), so undoing a hand edit brings back the stale 5.31.0 lock and the original error. Limits: only files the lab mounted at start; `git stash`, `git reset`, `git checkout BRANCH` and `-p` stay "no simulated output"; files the player created are not touched. The `ignore-the-lock` regex skips `#` comment and `!` negation lines.

### terraform-remote-state-rename (task 6)

- Verified (pages opened 2026-10-09 with WebFetch, which returns a model summary, so wording is paraphrase): only root-module output values of the remote state are exposed; `defaults` supplies values for outputs the state lacks; anyone who can read the root outputs can read the full state snapshot, and HashiCorp suggests publishing shared values to a separate store (language/state/remote-state-data); other configurations read root module outputs through terraform_remote_state (language/values/outputs). Error texts are the simulator's, verified in the remote-state work.
- Unverified: that a rename is a breaking change for consumers and that keeping both outputs for a release is the polite migration is general practice, stated in the debrief as advice, no page says it (the outputs page has nothing on renaming); that an EC2 instance cannot move between subnets (so `subnet_id` forces replacement) is the simulator's schema, the AWS provider page could not be read; git outputs, commit ids, author and dates are invented; the network repo is scripted (`cat ../network/outputs.tf`, `git -C ../network log`), the simulator has no second directory.
- Simulator deviation: real Terraform prints the `data.terraform_remote_state.network: Reading...` / `Read complete` lines before the Unsupported attribute error (the read finishes first); the simulator prints only the error box when evaluation fails, so the incident does not use those lines as evidence. `terraform refresh` and its error behaviour on the stale reference are not modelled (refresh succeeds); `terraform destroy -auto-approve` with the stale reference also succeeds in the simulator (real Terraform evaluates the config and most likely hits the same Unsupported attribute error), and is credited as `apply-the-replacement`. The plan error box also omits the `data.terraform_remote_state.network.outputs is object with 3 attributes` context line real Terraform prints (from memory, not checked).
- Design: the starting state holds the data entry with the old output name (`private_subnets`) as of the last apply, so `state show` is evidence the output used to exist; the authored upstream outputs lack it. One fix (`use-the-new-output`), world-based: plan_clean + the new output name read in main.tf + no literal `subnet_id = "..."` + no `defaults =` + no applied delete of aws_instance.app. Wrong: `hard-code-the-ids`, `fake-the-old-output` (defaults), `point-at-another-output` (public_subnet_ids/vpc_id: the plan shows `-/+ ... forces replacement` before any apply); destructive `apply-the-replacement` (applied delete aws_instance.app). Selecting `private_subnet_ids[1]` also replaces the server but is not a named mistake.
- Added a command-library entry `git-c-log` for `git -C DIR log`.

### terraform-module-key-removed (task 7)

- Verified (pages opened 2026-10-09): `state rm` leaves the remote object existing but unmanaged and a later plan wants to create "forgotten" instances again; `state rm 'module.foo'` removes a whole module (cli/commands/state/rm). `prevent_destroy` rejects destroying plans, and "doesn't prevent Terraform from destroying a resource if you remove its configuration" (meta-arguments/lifecycle). `for_each` applies to modules and instances are addressed `module.NAME[KEY]` (meta-arguments/for_each). Plan and warning texts are the simulator's, verified in earlier tasks.
- Unverified: the page for_each does not state outright that removing a key destroys the instance (taken from Terraform's behaviour, covered in earlier incidents); whether real Terraform raises `Instance cannot be destroyed` for a resource inside a removed module INSTANCE whose module block still exists (the lifecycle page's limitation is about removed resource blocks; the module config remains here, so the guard applies, per the task brief); the `removed` block with `destroy = false` is mentioned in the library entry only as an alternative (Terraform 1.7+), not exercised in the simulator.
- Deviation: the db's reason line reads `(because module.stack["west"].module.data is not in configuration)` (the simulator reports the nested module); the VPC's reads `module.stack["west"]`. Real Terraform prints the instance-level reason for both.
- Design: the fix `stop-managing-west` is credited by world (state lacks `module.stack["west"]`, east kept, plan clean, west database and VPC still in AWS, no applied delete). `restore-the-key` by world too (plan clean, both regions in state, no deletes). Trap by `applied delete module.stack["west"]` (after the guard is removed, `0 added, 0 changed, 2 destroyed`). `-target='module.stack["east"]'` is a no-op (no action; teaches in hints and debrief); `terraform destroy` is a button-only wrong action (refused by the guard). The database uses `skip_final_snapshot = true` so the trap leaves no final snapshot (real destroys with false need a `final_snapshot_identifier`).
- Invented: git log/diff output, branch name, ids, the PR scenario; library entry `terraform-state-rm` added.

### TF6c batch status

- [x] Five incidents shipped, each with simulator-backed terraform output, a UI test (`tests/terraform-batch3-ui.test.tsx`) and a per-incident unit test: `terraform-module-refactor` (moved blocks / `state mv` when code moves into a module; `-target` is not the fix), `terraform-module-upgrade` (a floating registry constraint pulls a new release; pin or override, never edit `.terraform/modules`), `terraform-provider-lock-drift` (raised constraint vs stale `.terraform.lock.hcl`; `init -upgrade`, not a hand edit), `terraform-remote-state-rename` (an upstream output renamed; read the new name, not a hard-coded id), `terraform-module-key-removed` (dropping a `for_each` key plans to destroy the module instance; `prevent_destroy` is the review, restore the key or `state rm`).
- [x] No id, evidence tag or command-library id collides with existing content (checked by grep over `content/`).
- [ ] Open simulator defects: print the `Reading...` lines before an evaluation error (cli.ts, would change other incidents); stale empty `.tf` after a registry upgrade; one failed instance of a repeated module holds back the dependents of all instances.
- [ ] Nit, `terraform-module-key-removed`: `git checkout main -- variables.tf`, `git restore --source=main variables.tf`, `git revert HEAD` and `git reset --hard HEAD~1` return "no simulated output" (the player should edit the file). A UI test pins this so a change is noticed.
- [ ] TF7 follow-ups: `providers lock`, `show <planfile>`, `fmt`, `console`; mutable upstream remote state; a lock-bypass marker for state-writing commands; `import`/`moved` inside child modules.

## terraform destroy errors (TF7a)
- [ ] Unverified: the BucketNotEmpty text `deleting S3 Bucket (NAME): operation error S3: DeleteBucket, https response error StatusCode: 409, RequestID: ..., HostID: ..., api error BucketNotEmpty: The bucket you tried to delete is not empty` (409 and the S3 error message are from the S3 API error list; the provider's `deleting S3 Bucket (NAME)` prefix and the HostID format are from memory of provider v5.70.0 `internal/service/s3/bucket.go`, not checked). Real HostIDs are long base64 strings; the simulator uses hex.
- [ ] Unverified: a versioned bucket in real AWS adds `You must delete all versions in the bucket.`; bucket versions and delete markers are not modelled.
- [ ] `force_destroy` is read from the state attribute (as the provider reads it from the resource data at delete); objects count when their reality key is `aws_s3_object:BUCKET/...`. Any other thing mentioning a bucket name does not block it.
- [ ] Lock bypass marker (TF7a): `terraform refresh -lock=false` past a held lock commits state but records no marker (not in the brief's command list); `state mv` of a whole module records one line, not one per moved object.

## terraform incidents batch 4 (TF7a)

### TF7a batch status

- Four incidents, all dark (`published: false`, listed in DARK in tests/published.test.tsx), none flipped:
  - `terraform-destroy-nonempty-bucket`: BucketNotEmpty and `force_destroy` read from state (apply it, then destroy; or empty the bucket); trap is `state rm` of the bucket.
  - `terraform-destroy-dependency-violation`: DeleteSubnet DependencyViolation caused by a foreign network interface; release it after checking whose it is; trap is `state rm` of the network.
  - `terraform-deleted-out-of-band`: console deletes leave state stale; the queue comes back, the retired worker's block goes; read plan and `state list` before any destroy; trap is deleting both blocks.
  - `terraform-orphans-after-state-rm`: stale lock plus orphans missing from state; force-unlock, import both, destroy; never `-lock=false` writes; works whether the cause is named before or after the destroy.
- Engine changes: `create_before_destroy` ordering with deposed objects, BucketNotEmpty and DependencyViolation provider errors, `cloud.release` and NotFound on vanished objects, lock-bypass history marker (`lock_bypassed`), history ops (`state-rm`, `import`, etc.), history-based `applied` import.
- Task 9 sweep applied: relaxed `aws s3` typed regexes (flag before path, `--human-readable`), `--output json` on describe-network-interfaces, wording fixes in dependency-violation and deleted-out-of-band, `terraform refresh` in the debrief, plan/state-list-before-destroy hint, less pointed ticket. UI tests: tests/terraform-batch4-ui.test.tsx. No id, evidence-tag or command-library collisions (evidence tags are per incident; command library untouched except the earlier `--recursive` part).
- Open items:
  - [ ] Real provider retries DeleteSubnet on DependencyViolation for about 20 minutes, then errors with a timeout wrapper; the lab shows the immediate error (dependency-violation).
  - [ ] Late root-cause naming vs transient fix predicates in the other incidents (see the list under orphans-after-state-rm).
  - [ ] `terraform plan -refresh-only` (and plan -destroy) answer "not yet simulated"; `apply -refresh-only` and `terraform refresh` work.
  - [ ] Unverified items listed per incident below.
- [x] TF7b: migrate the 9 scripted terraform incidents to the simulator, then retire `terraform-state-lock.yaml`. Done 2026-10-11 (see `## terraform migrations (TF7b)`); the other TF7 follow-ups are untouched.

### terraform-destroy-nonempty-bucket (task 5)

- [x] Verified 2026-10-09 against the S3 API reference (DeleteBucket): all objects, including versions and delete markers, must be deleted before the bucket.
- [ ] Unverified: the Terraform registry page for `aws_s3_bucket` (5.70.0) could not be read (JavaScript page), so `force_destroy` semantics ("delete all objects so the bucket can be destroyed, applies only once in state") are from memory of the provider docs and source; the source entry in the YAML records the page, not a read of its text.
- [ ] Unverified: BucketNotEmpty text/409/HostID (see "terraform destroy errors (TF7a)"), the `aws s3 ls` output shapes (`PRE logs/` line, `DATE TIME SIZE KEY` rows), the `delete: s3://...` lines named in the empty-bucket feedback, and the `aws s3 rm` flag set accepted by the action regex. Invented: account/role names (`PlatformAdmin`), sg/vpc ids, object keys and sizes, the ticket story (archive copy, sign-off).
- Design: state starts with all three resources (bucket, queue, SG), so one `destroy` deletes queue and SG and stops on the bucket. Fixes: `force-destroy-route` (world: bucket gone from state and reality, `force_destroy = true` line in main.tf), and a two-step path `empty-bucket` + `destroy-after-emptying`. `empty-bucket` is taken by typing `aws s3 rm s3://acme-reports-logs --recursive` (optional `--quiet`, `--region us-east-1`, trailing slash) and has no `done_when`: the predicate language cannot see `aws_s3_object` objects (`reality_lacks` takes only modelled resource types), so a typed command is the only evidence; its `cloud.release` entries (one per object) empty the bucket. `destroy-after-emptying` is world-based (bucket gone, no `force_destroy = true` in the file). Deviation from the brief: no `done_when` on the empty step, hence the test helper `detectedAll` shows it false; the engine takes it from the typed command.
- Decision: `aws s3 rb --force` is NOT accepted (it would also remove the bucket from the cloud, which `cloud.release` of objects does not model; it answers "no simulated output"). Partial deletes (`rm` without `--recursive`, with `--exclude`, of one key) do not match and do not release anything.
- Trap `state-rm-bucket` (destructive): `state_lacks` bucket and `reality_has` bucket. The fix stays earnable afterwards (`terraform import aws_s3_bucket.logs acme-reports-logs`, then route A), the mistake stays on the score; tested.
- Wrong actions `grant-more-permissions` and `retry-without-lock` are button-only. Editing the config without applying is not an action (it is a step of route A and teaches state-vs-config via the debrief and the failing second destroy).
- Known limits: after route A the scripted `aws s3 ls` still lists the objects (the bucket is gone; real AWS would say NoSuchBucket); versioned buckets not modelled.
- Added a `--recursive` part to the existing `aws-s3-ls` command-library entry (coverage test required it).

### terraform-destroy-dependency-violation (task 6)

- [ ] Unverified: the AWS docs pages in `sources` (delete-subnet, using-eni) and the error docs link were not read for this task; the retrieved dates record the pages, not a read of their text. The DeleteSubnet DependencyViolation wording is from "terraform destroy errors (TF7a)" (SDK wrapper from memory).
- [ ] Unverified: the `aws ec2 describe-network-interfaces` output shape (fields shown, ordering, `Status: available`, `TagSet`). Invented: the ingest team's interface (description is from the brief), account/role names, vpc/subnet/sg/eni ids, the ticket story (ingest team moved off, platform sign-off). The "other team's interface" is illustrative; real endpoint/Lambda/ELB interfaces are service-managed and cannot be deleted directly (said in the debrief).
- [ ] Unverified: `aws ec2 delete-network-interface` (no output on success; the real command also has `--dry-run`, which the action regex refuses). Accepted spellings: optional `--region us-east-1` before or after `--network-interface-id eni-...`.
- Design: state is vpc, subnet, SG, instance; one destroy deletes the instance and SG then stops at the subnet. The ENI is a `cloud.add` object that mentions the subnet and vpc ids (not the stack's SG id, otherwise the SG would block too); `cloud.release` removes it when `release-eni` is taken. `release-eni` has no `done_when`: the predicate language cannot see `aws_network_interface` objects as a world check beyond the typed command, so the typed command is the evidence (test helper `detectedAll` shows it false). `destroy-after-release` is world-based (state lacks subnet and vpc, vpc gone from reality, applied delete of the subnet).
- Decisions: the sim lets the player delete the interface once evidence shows it is unattached (`Status: available`) and the ticket says the owner moved off; the methodical bonus is lost if deleted before reading whose it is (no trap). Trap `state-rm-network` (destructive): `state_lacks` subnet and `reality_has` subnet; the fix is not earned afterwards unless the player imports both back. `-target=aws_vpc.main`, `depends_on` and permissions are button-only wrong actions. The `eni-not-in-state` evidence is a `state list` containing `aws_vpc.main` (the list shows no interface).
- Known limits: the VPC's own default security group/route table/NACL are not modelled. After the fix the scripted describe returns an empty list (matches world).
- Added an `aws-ec2-network-interfaces` command-library entry.

### terraform-deleted-out-of-band (task 7)

- [ ] Unverified: the Terraform docs pages in `sources` (resource-drift tutorial, plan, destroy) were not read for this task; the retrieved dates record the pages. The "Objects have changed outside of Terraform" / "has been deleted" / "No objects need to be destroyed" wording is the engine renderer's (not re-verified against `jsonformat/plan.go` here).
- [ ] Unverified: scripted `aws sqs get-queue-url` error text (`AWS.SimpleQueueService.NonExistentQueue` vs the newer `QueueDoesNotExist` code) and `aws ec2 describe-instances` `InvalidInstanceID.NotFound` text and its `--output json` handling (real CLI prints the error to stderr). Invented: account/role names, vpc/subnet/instance ids, the Slack thread in NOTES.md, the ticket story. No `aws sqs list-queues` command (empty output makes poor evidence).
- Design: state is vpc, subnet, queue (`aws_sqs_queue.jobs`), instance (`aws_instance.worker`); `cloud.delete` removes queue and instance. The instance's tags reference `aws_sqs_queue.jobs.name` ON PURPOSE: the engine (like Terraform) only reports a deleted object's drift when a changing resource refers to it, so without that reference the plan prints no "has been deleted" note at all. Only the queue's deletion is therefore named in the note; the worker appears only as a create. `evidence: drift-in-plan` is the queue line.
- Deviation from the brief: its teammate story had a plain `destroy` printing `0 to destroy` while the vpc and subnet exist, which the engine (rightly) cannot do (the vpc and subnet would be destroyed). The ticket instead has Dev run a targeted `terraform destroy -target=aws_sqs_queue.jobs -target=aws_instance.worker`, which prints "No changes. No objects need to be destroyed." (evidence `destroy-nothing`). Note that running it persists the refresh, so state then lacks both and the plan afterwards no longer prints the drift note (plan still wants 2 creates); evidence already collected stays collected.
- Fix: `remove-instance-block` (file check: worker block gone, queue block present) then `apply-reconcile` (world: queue and vpc/subnet in state, worker not, `plan_clean`, applied create queue, no applied delete of vpc/subnet, worker block absent). Order-independent; `terraform apply -refresh-only` first is fine. The recreated queue keeps the same id/URL (SQS URL derives from the name; real-world note in the debrief). Mixed world: neither bulk route is credited.
- Traps: `recreate-everything` (wrong; `applied create aws_instance.worker`, history-based so it stays on the score, fix still earnable after destroying the new instance), `remove-both-blocks` (destructive; queue block gone and `plan_clean`), `destroy-to-start-clean` (destructive; applied delete of vpc or subnet). `state-rm-both` and `refresh-false-apply` are button-only wrong actions without `done_when`: `state rm` writes no history and a refreshed state is indistinguishable from a state-rm'd one, and a `-refresh=false` apply with stale state changes nothing (state_has/plan_clean cannot tell it apart). Under `-refresh=false` the stale state gives "No changes." (tested); the NotFound-on-update path is not exercised here because nothing in the configuration differs from state.
- Added an `aws-sqs-get-queue-url` command-library entry (`aws-ec2-describe-instances` already covers describe-instances; no collision with `^aws sqs get-queue-attributes`).

### terraform-orphans-after-state-rm (task 8)

- [x] Verified 2026-10-09 against the provider v5.70.0 docs (raw GitHub markdown): `aws_instance` imports by `id`, `aws_db_instance` by `identifier`; `skip_final_snapshot = false` requires `final_snapshot_identifier`.
- [x] Verified 2026-10-09 by reading the import, state rm and locking pages (import takes the lock unless `-lock=false`; state rm leaves the remote object; `-lock=false` not recommended). [ ] Unverified: Marta's saved destroy output (`Still destroying...` lines, the double-interrupt text) is modelled on the TF5 CI log, not captured from a real run; the "DeleteSubnet keeps retrying ~20 min" provider behaviour is from memory. The `describe-instances` / `describe-db-instances` JSON shapes are abbreviated and unverified. Invented: account/role names, ids, the lock id/time, the ticket story, Marta/Dmitri and the sprint notes.
- Design: state is vpc, subnet, SG; `cloud.add` holds the worker (mentions subnet and SG ids) and the db (mentions the SG id only; `vpc_security_group_ids` is not in the db schema so it exists only in reality). The `.tf` declares both, so a plan after unlocking is `2 to add`; apply creates a second worker and fails on `DBInstanceAlreadyExists`. Evidence: lock error/holder (`plan`), `marta-dead` (`cat marta-destroy.txt`, in `terraform.files` as well as scripted), `orphans-not-in-state` (`state list`), `worker-running`, `db-running` (scripted, flags in any order, `--output json`), `plan-wants-create`, `destroy-blocked`, `sprint-notes` (unlabelled bonus, not in key_evidence: the content guard wants labelled == key). `plan -lock=false` reads and is not a trap (ticket and hint say so).
- Fix is two world-based steps: `unlock-and-import` (lock_free, `applied import` of both, not lock_bypassed; history-based on purpose: a `state_has` check would be false once the destroy empties state, and `checkFixes` only takes an action when the root cause is already named, so late naming would never credit it) then `destroy-environment` (brief's predicate). Every action has a `done_when` except the button-only wrong action `lock-timeout`.
- Traps: `bypass-lock` (destructive, `lock_bypassed`; import, state rm or a successful destroy with `-lock=false`; the fix is never credited), `apply-recreate` (destructive, history `create aws_instance.worker`; recoverable by `destroy -target=aws_instance.worker`, import, destroy), `state-rm-rest` (destructive, state lacks vpc and reality has it; recoverable by importing the network back, stays on the score).
- Known limits: the provider retries a DeleteSubnet DependencyViolation for a long while before failing (from memory; the lab fails at once, feedback says "eventually"); a failed `terraform destroy -lock=false` (nothing applied) records no bypass marker, so it is not a trap although it ran past the lock; the lab destroy does not enforce `skip_final_snapshot` on an imported db (debrief says real Terraform needs it applied first); scripted `describe-*` follow only `destroy-environment`, so after the duplicate-worker trap they show the original only. 
- Command library: `aws-ec2-describe-instances` and `aws-rds-describe-instances` already cover the scripted describes; no new entries.
- [ ] Late root-cause naming vs transient fix predicates (found in TF7a terraform-orphans-after-state-rm review): `checkFixes` takes a fix action only when the root cause is named at that moment, so a fix credited by `state_has`/`state_lacks` is lost if a later step (a destroy) changes state before the player names the cause. Fixed for orphans-after-state-rm with history-based `applied import`. DONE in TF7b task 11 for partial-apply-iam and vcpu-limit (`finish-apply`, and vcpu `right-size`): `applied create` of the last resource, `not applied deviant` (-target/-var/-refresh=false/-lock=false), `not applied delete` on the dependencies, plus `not applied state-rm` of the database (iam) and, for vcpu, a persistent compute.tf size regex and `plan_has no_change [aws_instance.loadgen]` (survives changes to unrelated resources, but fails if loadgen was changed after the apply, e.g. shrunk then edited back). Trade-off: credit stays once earned if the player later destroys the database or loadgen by another route (the destructive/other actions' own leaves still catch the damage); IAM is not re-checked after the apply (the denial lifts only after the least-privilege grant action, so a successful create proves it, but a later over-broad policy is only penalised by the grant-wildcard action itself). `-replace` of the database (iam) leaves the credit, by design (tested). Also sticky: `destroy -target=aws_db_instance.orders` after a create leaves finish-apply credited (destroy-and-retry stays false). vcpu: a fault `on: update` mirrors the create fault so resizing loadgen up in place needs the quota too, and `not applied update loadgen` means any in-place edit of loadgen after creation (even a tag) loses finish-apply. Known limit: the vcpu size regexes read compute.tf only, so moving the loadgen resource to another file makes the correct route fail. Still the same exposure, unchecked in play: module-key-removed (both paths), cancelled-ci-lock, count-to-for-each, forgotten-taint, module-refactor, state-lost, sg-cycle, deleted-out-of-band (`apply-reconcile`). Final TF7a review: severity LOW for published incidents (their fix predicates are essentially monotone; loss needs more state-changing work between fixing and naming). Do not add a generic latch (in-memory only, differs after remount, can credit an undone fix); prefer per-incident persistent predicates, or latch only YAML-flagged actions.

## terraform TF7b (engine, task 1)

- [ ] Unverified: `random_password` argument set from memory of the random provider v3.x docs (every configurable argument is `RequiresReplace`; `id` is the literal `none`; `result` sensitive; default special alphabet `!@#$%&*()-_=+[]{}<>:?`; no `min_*`, `bcrypt_hash`). Could not fetch the provider docs offline. The provider version printed on `init` follows the lab default (5.67.0), not a real random provider version.
- Known limit: resource blocks do not reject arguments missing from the schema (`min_special = 2` is accepted and shown as an attribute); this is true for every type, not only `random_password`.
- Note: an initialised lab's mounted lock is AWS-only, so `random_password` needs `initialized: false` or a shipped `.terraform.lock.hcl` with a random block (AUTHORING). The `random` provider defaults to 3.6.3 (unverified as the current release).
- Note: the at-least-one-key refine on `plan_has` (`no_destroy` or `no_change`) is not representable in schemas/incident.json; zod enforces it.

## terraform TF7b (engine, task 2)

- [x] Verified 2026-10-10 against Terraform v1.9.8 source (raw GitHub): `internal/command/meta_backend.go` (the `Backend initialization required, please run "terraform init"` error with `Reason:` and the errBackendInit body; `Backend initialization required: please run ...` with a colon for a changed block; `Backend configuration changed` with the `-migrate-state` / `-reconfigure` advice; `Successfully configured the backend`, `Successfully unset the backend`, the `Backend configuration changed!` and unconfiguring notices), `meta_backend_migrate.go` (the copy question and its text; `-force-copy` skips it; no way to ask is an error), `statemgr/filesystem.go` (migration writes a nil state: the local file is truncated to zero bytes and `.backup` gets the previous snapshot) and `arguments/init.go` (the `-migrate-state` / `-reconfigure` exclusion).
- Deviation from the Task 2 brief, following the source: a FIRST backend block (state in the local file, nothing recorded) does not fail with `Backend configuration changed`; `init` goes straight to the copy question, and `-reconfigure` does not skip it (only an already-recorded backend gets the changed/removed errors and a copy-free `-reconfigure`). The brief's flow applies once a backend is recorded.
- [ ] Unverified: blank-line spacing of the init output around the copy question and the `Successfully configured` text; the exact error for "cannot ask" (real: an `errInteractiveInputDisabled` error; the lab prints it as a boxed error); the wrapped width of the boxed errors. The `.terraform/terraform.tfstate` record is not a file in the lab.
- [ ] Unverified: `-reconfigure` that removes a backend block clears the record here; real Terraform's handling of the stale record afterwards was not traced.
- Simplifications: one remote backend type (every `backend "X"` behaves alike, a `local` block with a different path is not modelled as a file move); no `workspace_key_prefix` handling; only the default workspace's state is mirrored in the file (real: other workspaces under `terraform.tfstate.d/`); `init-migrate TYPE` is a history line but not yet an `applied` op in the schema (add it to the enum when an incident needs to credit it); `terraform init -backend=false` and `-backend-config` are ignored.


## terraform migrations (TF7b)

Batch status: DONE (2026-10-11). All nine scripted terraform incidents now run on the simulator or were retired; none scripts a `terraform` command (guard: tests/terraform-no-scripted.test.ts; each incident's key_evidence is reachable before any action, tests/terraform-batch5-ui.test.tsx). Every migrated incident was reviewed against the fix-quality standard: only best-practice, least-privilege, durable fixes are credited, stopgaps are flagged `wrong` or `destructive`. The per-incident detail below and in the TF7b entries further down is the review list.

Summary of final behaviour (ids unchanged unless noted; learning goals, hypotheses, hints, analogies, debriefs, concepts and sources were kept except where listed):

- terraform-state-lock: RETIRED (Task 3), superseded by terraform-cancelled-ci-lock. No redirect: progress is keyed by incident id and unknown ids are ignored, so a save that completed the old id loads untouched, keeps its XP, and other incidents still score (tests/terraform-retired.test.ts proves load, no backup written, recordResult, unlockedTracks). A redirect would credit a different incident the player never played.
- terraform-forces-replacement: already on the simulator (TF4), nothing to do.
- terraform-count-index-shift (Task 4): the real plan (2 replaced, 1 destroyed) replaces the scripted text; computed attributes now show as `(known after apply)` and `queue[3]` carries `(because index [3] is out of range for count)`. Fix credited (final review round): ONLY `for_each` plus declarative `moved` blocks mapping each live index to its key (checked in config; plan clean, queues kept, no create). `terraform state mv` and `state rm` + import are flagged `wrong` (new action `state-mv`, `state-rm` now detected from the history) and are sticky: a `state mv` or `state rm` of any queue address blocks the credit even if moved blocks are added later. Reason, same as moved-block: a state edit is a one-off nobody reviews and does not travel to other workspaces; hints, ideal path and feedback say so. Applying the shifted plan is destructive and not recoverable. Click-only: none. Limit: deleting the moved blocks after a clean apply loses the credit (config check).
- terraform-drift-hotfix (Task 5): plain `plan` no longer prints "Objects have changed outside of Terraform" (real behaviour: only for the object being changed); evidence `drift` now needs `plan -refresh-only`. Fix: codify the rule (state, reality and plan agree, no SG update ever applied, no `ignore_changes`); any applied SG update is the destructive trap. Limits: `dynamic "ingress"` and separate rule resources are not recognised; a differently-described rule reads as a change.
- terraform-import-existing (Task 7): error text is now the real `BucketAlreadyExists` everywhere (no `BucketAlreadyOwnedByYou`, tested); name-taken feedback rewritten around `head-bucket`. Fix: import (block or CLI) with `prevent_destroy = true`, no `force_destroy`, clean plan, bucket kept; rename and delete-recreate are detected from the world. Sticky trade-off: crediting happens at the import, so a later destroy of the bucket is caught only by its own destructive leaf. Untaught-enforceable: post-import hardening (public access block, encryption, versioning, TLS policy). `plan -generate-config-out` answers "not simulated yet".
- terraform-moved-block (Task 8): the declarative `moved` block is the ONLY credited fix; `terraform state mv` and `state rm` are flagged `wrong` from the apply history, even if a `moved` block is added later (the brief's idea of crediting `state mv` was rejected: it is imperative, one-off surgery that does not travel to other workspaces/environments). Untouched apply (destroy and recreate) is destructive; `prevent_destroy` in the module is `wrong`. The CI plan log now mirrors the simulator's rows. Players notice the changed `state-mv` feedback.
- terraform-ignore-changes-autoscaling (Task 6): plan-driven evidence (`desired_count` in the plan, `12 -> 2`). Fix: `ignore_changes` on `desired_count` only, with the service kept at 12 and no update ever applied (`ignore_changes = all`, hard-coding 12 and ignoring another attribute are not credited). Typed `terraform apply` at 12 is the flagged trap (it resets reality to 2). Click-only: `set-12`, `remove-autoscaling`.
- terraform-state-in-git (Task 9): the fix is a recorded s3 backend (encrypted, with locking) proven by a clean plan after the state copy, `.gitignore` for the state file and its backup, and the leaked secret gone from the local file and `.backup`; `rotate` needs a new `random_password` and a different real password. Version raised to 1.11.0 (use_lockfile). Engine bug fixed: `apply -replace` kept re-planning the address. Click-only/untaught-enforceable: `git rm --cached`, history purging, clone cleanup (the lab cannot see git; scripted `git ls-files` keeps listing), `manage_master_user_password`. Sticky/limit: random_password has the constant id `none`, so create_before_destroy replacement is quirky.
- wrong-workspace-major (Task 10): runs on the simulator with real prod/staging workspaces and tfvars. Fix `prod-apply` needs orders-prod resized by an apply with exactly `-var-file=prod.tfvars` and none of the deviant forms (-target, -refresh=false, -lock=false, -var), prod.tfvars still setting the class and `db_apply_immediately = false` (flipping it to true is the stage 2 `flip-default` stopgap), main.tf still reading both from `var.*` (hard-coding the class or apply_immediately is not credited), no delete or state rm. The history markers are sticky: a stopgap apply earns no credit even if a clean apply follows. New destructive action `destroy-prod`. Click-only: the guard (`precondition`/`check` not simulated). Unverified: apply_immediately plan details (see the TF7b entry below).
- Persistent predicates (Task 11), TF7a incidents terraform-partial-apply-iam and terraform-vcpu-limit: `finish-apply` (and vcpu `right-size`) use history (`applied create` of the last resource, no deviant apply, no state rm/delete of the dependencies, and for vcpu `plan_has no_change [loadgen]`) so late root-cause naming no longer loses the credit. Fault `on: update` mirrors the create fault for vcpu. Trade-offs: credit is sticky once earned if a later route destroys the database/loadgen; IAM is not re-checked after the apply; `-replace` of the database and `destroy -target` keep the credit; any later in-place edit of loadgen loses it; the vcpu regexes read compute.tf only.

Engine additions (Tasks 1, 2, 5, 8, 9, 10): `plan_has.no_change`; `random_password`; local `terraform.tfstate` file on disk and backend `init -migrate-state` / `-reconfigure` (state_file, savedBackend); `plan -refresh-only` and `apply -refresh-only`; order-insensitive set attributes (`equalSet`); security-group rules; history markers for deviant applies (`applied` gained `var_file`, `deviant`); applied ops `state-mv` and `state-rm`; `apply -replace` fixed to replace in one apply; `on: update` faults; the `backend` predicate.

Players will notice: real plan text and counts in the five plan-driven incidents; refresh-only needed to see drift; the `state-mv` feedback in moved-block; import-existing's error text; wrong-workspace-major's stricter prod-apply; the retired state-lock incident.

Final review round (2026-10-11): drift-hotfix `codify`/`codify-nat` and import-existing `import-block` refuse a deviant (-target, -refresh=false, -lock=false, -var) apply; state-in-git `rotate` has `after: [remote-backend]` (an order rule: the new secret must not first land in the git-tracked local state; rotating first and migrating later still credits both once the migration is done) and its second .gitignore regex also accepts `*.tfstate.backup` and `terraform.tfstate*`; the history parser peels known markers from the end so a ` (` inside a for_each key is not cut.

Verified/unverified lists live with each incident below (and in the per-task TF7b entries); unverified items are marked `[ ]`.

### terraform-count-index-shift (Task 4)

- Migrated onto the simulator; same id, learning goal, hypotheses, hints, analogy, debrief, concepts and sources (verbatim). The scripted `terraform plan` / `state list | grep` commands and the `queues.tf` file artifact are gone; `queues.tf` is the lab's PR-branch file. Real plan output: two `must be replaced`, one `will be destroyed`, `Plan: 2 to add, 0 to change, 3 to destroy.`
- Changed text: the old scripted plan showed the replaced resources as diffs of only `name`; the real one lists the computed attributes (`arn`, `id`, `url`, `tags_all`) as `-> (known after apply)`. The destroyed `queue[3]` now carries `(because index [3] is out of range for count)`. Both are the engine's output.
- [ ] Unverified against a real provider run: `(because index [3] is out of range for count)` on the destroyed `queue[3]`, and the computed-attribute lines in the replace diffs.
- Fix route credited by world state and config (revised in the final review round): `for_each` + `moved` blocks for the three live queues; a `moved` block for `returns` is optional. Staying on `count` or using `for_each` with `terraform state mv`, and `state rm` + import, are `wrong` and block the credit (they were credited routes before the review). Deviation from the brief: its fix predicate said `not applied delete queue[1..3]`, but the correct fix itself deletes returns at `[1]` (route a) or at the index it was parked on (route c, any of 1 to 4), so the fix and the trap both use `create`: the fix requires `not applied create aws_sqs_queue.queue`, the trap `apply-anyway` is `applied create aws_sqs_queue.queue` or any of the three live queue URLs missing from reality. A replaced queue keeps its URL, so the replacement is detectable only by the `create` in history.
- Action label of `for-each-moved` reworded to the lab's flow (returns is already out of the list; moved blocks only for the live queues); id unchanged.
- Evidence `count-list` is earned by the first `plan` (`is out of range for count`), not by a file read, so `cat queues.tf` is the real live file (a scripted `cat` would go stale after edits). The only scripted command is `git log --oneline -3` (invented commit subjects, unverified). `state-rm` followed by `import` of the three live queues under for_each keys plans clean but leaves `returns` in the cloud, so it is not credited (the old incident called state surgery error-prone but "can be made to work").
- Command library: none of the scripted entries were library entries; nothing removed.
- [ ] Unverified: the exact `QueueNameExists` text for a re-create after `state rm` (modelled in the simulator, TF4).

### terraform-drift-hotfix (Task 5)

- Migrated onto the simulator; same id, learning goal, hypotheses, hints, analogy, debrief, concepts, sources, `#incidents` log (evidence `hotfix-note`), action ids/kinds and `solution_paths`. Scripted `terraform plan`, `plan -refresh-only` and their `when_actions` variants are gone. The only scripted command is an invented `git log --oneline -3` (commit hashes and subjects invented; unverified).
- Engine gaps found and closed here (the brief assumed them): (1) `plan -refresh-only` / `apply -refresh-only` were "not simulated yet"; now implemented (`cmdRefreshOnly` in cli.ts, `renderRefreshOnly` in render.ts). (2) `set` attributes (`ingress`) were compared in order, so a codified rule written before the existing one showed a bogus SG change; now order-insensitive (`equalSet`, used by the plan diff and by refresh).
- [ ] Unverified against real Terraform 1.9: the refresh-only plan text (the `This is a refresh-only plan, so Terraform will not take any actions to undo these...` paragraph; the no-drift sentence `No changes. Your infrastructure still matches the configuration.`), the `Would you like to update the Terraform state to reflect these detected changes?` prompt text, and `Apply complete! Resources: 0 added, 0 changed, 0 destroyed.` after a refresh-only apply. Written from memory. Flag combinations rejected: `-destroy` (not simulated), `-replace`, `-refresh=false` (messages from memory); `-target` or a plan file with `-refresh-only` answer "not simulated".
- Deviation: a plain `terraform plan` here prints NO "Objects have changed outside of Terraform" note. The engine (like real Terraform) reports drift only for objects the planned change refers to, and the security group is the object being changed. Evidence `drift` therefore comes only from `plan -refresh-only` (output contains `has changed`), as the old text intended. `plan-removes-rule` is the plain plan (contains `ingress`).
- Fix credited by world state (revised after review): `codify` = the group is in state, reality still holds both rules, the plan leaves the group alone, no SG `update` was ever applied, and `main.tf` has no `ignore_changes` (so literals, `var.x`, `local.x` and other files all work). Superseded detail follows. Old wording: `main.tf` holds the CIDR inside a `cidr_blocks` list AND `plan_has.no_change` for the SG AND no `update` ever applied to the SG. Routes accepted: the rule added in main.tf in either block order, any attribute order, CIDR list spacing; before or after a refresh-only apply. Not credited on purpose: `ignore_changes = [ingress]` (clean plan, but the hotfix stays undocumented in code), a comment with the CIDR, a rule whose description or port differs from the console change (plan still updates the group). The rule must live in `main.tf` (the lab's only file); moving the group to another file is not credited.
- Traps: `apply-anyway` (destructive) = any applied `update` of the SG; a codified rule written after that applies as an update too, so the fix is unearnable (tested). `target-instance` and `refresh-apply` stay button-only wrong actions (no typed predicate: the instance update also happens on the ideal path; a refresh-only apply is not visible to `done_when`). Their typed forms are tested to leave the group alone / keep removing the rule.
- Known limit: a player who codifies with a different description (e.g. "partner") sees the group still change; applying it then updates only the description but flags `apply-anyway` (the history leaf cannot tell the harmless update from the rule removal).
- Unsupported spellings of the codified rule (engine limits): `dynamic "ingress"` blocks and separate `aws_security_group_rule` resources. `ignore_changes` is only detected in `main.tf`.
- Nit fixed: the refresh-only "No changes" paragraph is wrapped at 78 columns (text itself still unverified).

### terraform-ignore-changes-autoscaling (Task 6)

- Migrated onto the simulator; same id, learning goal, hypotheses, hints, analogy, debrief, concepts, sources, action ids/kinds/labels and `solution_paths`. Lab: `ecs.tf` with `aws_ecs_service.checkout` (literal `cluster = "prod"`, `task_definition = "checkout:42"`, `desired_count = 2`; there is no `aws_ecs_cluster` in resources.ts); the autoscaler is `cloud.patch` setting reality to 12. Scripted `terraform plan` (both variants) and the `ecs.tf (excerpt)` file artifact are gone (a scripted read would go stale). Remaining scripted commands are the two `aws` ones (autoscaler min/max, which keeps evidence `autoscaling`, and `describe-services` = 12, which stays 12 even after an apply: known limit).
- Evidence: `plan-reset` (plan contains `desired_count`) and `desired-fixed` (plan contains `12 -> 2`, i.e. the code's value) come from the real plan. `desired-fixed` was a file read of `ecs.tf` in the old version; its label ("The code sets desired_count = 2") still holds.
- Fix `ignore-desired` by world state: service in state, reality still 12, `ecs.tf` matches `ignore_changes = [... desired_count ...]` (one- or multi-line list, other attributes allowed, quoted names fine), clean plan, no `update` of the service ever applied. Not credited on purpose: `ignore_changes = all` (too broad), ignoring a different attribute (plan still resets), hard-coding `desired_count = 12` (`set-12`, clean plan but no `ignore_changes`). `ignore_changes` is only detected in `ecs.tf`.
- Deviation from the brief: `apply-at-night` (wrong, label unchanged) has `done_when: applied update` of the service, so a typed `terraform apply` while the service is at 12 is the flagged trap (it resets reality to 2, so the fix is unearnable). `set-12` and `remove-autoscaling` remain button-only (the autoscaling target is not a modelled type).
- Engine note: the typo `ignore_change = [...]` fails the plan with `Invalid reference` (not `Unsupported argument`, which real Terraform would also report); the lifecycle block does not reject unknown arguments (see TF7b engine, task 1 limit).
- [ ] Unverified: `task_definition = "checkout:42"` (a family:revision string is accepted by the AWS provider; the real lab would reference a task definition resource) and the autoscaler's `describe-scalable-targets` output shape (carried over from the old incident).
- [ ] nginx-permission-denied (fix-quality rework 2026-10-10): the chown(1) man page source has `retrieved: 2026-10-10` but was not read; verify. Design question for the user: crediting `chown -R www-data:www-data` makes the web worker the owner of the docroot (a compromised worker can rewrite pages); a stricter pattern is owner = deploy user, group = www-data, mode 750 dirs / 640 files. Group route (`chgrp www-data` + `chmod 750`) deliberately not credited for now.
- [ ] aws-route53-failover (fix-quality rework 2026-10-10): AWS docs confirm AWS-managed prefix lists exist for Route 53 health checks but the exact list name (e.g. `com.amazonaws.global.route53-healthchecks`) was NOT verified, so the credited action accepts either any `pl-` prefix list ID or public CIDRs of /16 or narrower (not 0.0.0.0/0, private or office ranges), on 443 only; the sim outputs use an invented `pl-0r53hc`. Also unverified: that the primary ALB is public 443 behind a WAF (invented to give the standby a defined target audience), CHG-2371 and the change-process log text, and curl timeout wording. Design note: with public 443 on the standby, the explicit health-checker rule is technically redundant; kept so a later tightening cannot silently kill checks.

## fix-quality rework (2026-10-10)

### terraform-partial-apply-iam

- The simulator has no IAM model, so the grant is judged by PARSING the typed command (`iam_policy` on an action, `src/game/awsPolicyCheck.ts`). Credited (`grant-rds-permission`): admin-profile `aws iam put-role-policy` for role orders-ci-deploy, one aws command and no shell operators, a policy name that is not `terraform-deploy` (case-insensitive), and an inline `--policy-document` (single- or double-quoted, any key order, Condition allowed) in which EVERY statement is Effect Allow with Resource exactly `arn:aws:rds:us-east-1:123456789012:db:orders-db` (string or one-element list), the union of actions is within {rds:CreateDBInstance, rds:AddTagsToResource} (case-insensitive) and includes rds:CreateDBInstance. Any other key (NotAction, NotResource, Principal) or an extra action/statement/resource is not credited. Evasion is closed in the helper: every word outside the policy document must be plain (no `$ \\ { } * ? ~ ! #`, `$'…'`, or expansion in double quotes), repeated JSON keys are rejected, top-level keys are limited to Version (2012-10-17 if present), Statement and Id, and names compare in ASCII lowercase. Wrong actions are judged first: `grant-wildcard` (any `*` in the document, any case, even on a compound line) and `overwrite-deploy-policy` (reusing `terraform-deploy`). Neither lifts the denial (the engine's `until_actions` is "all", so only the real grant does).
- Known limits: `file://` documents cannot be inspected (the lab has no policy file), so a scripted note asks for an inline document; the action button credits the grant directly. Subnet-group/parameter-group ARNs are not accepted because nothing in the incident's error names them. Variations such as `--cli-input-json` are not credited. NotAction/Principal/extra-action documents earn no verdict at all (neither credit nor the wildcard feedback), so the wildcard feedback only ever follows a real `*`; a separate "not least-privilege shape" wrong action could be added if playtesting shows players need that nudge.
- [ ] Unverified: whether real RDS needs more than `rds:CreateDBInstance` on the db ARN for this create (RDS may also evaluate subnet-group, parameter-group and option-group ARNs and `rds:AddTagsToResource`; a first RDS use also needs the service-linked role). The lab credits the single action the error named.
- [ ] Unverified wording: the `(lab)` note for `file://` policy documents, and the reworded feedback on both wrong actions.
- Action ids `grant-rds-permission`, `finish-apply` unchanged; two ids added.

### terraform-module-upgrade

- `override-the-input` is now `kind: wrong` (flagged when main.tf sets `storage_encrypted = false`); it is out of `solution_paths`. Only `pin-the-module` is a fix, and it now also requires main.tf to hold an exact `version = "2.0.x"` (optionally `= `), besides the installed 2.0.x in modules.json, a clean plan and no module delete. Ranges that resolve to 2.0.1 (`~> 2.0.1`, `< 2.1`) plan clean but are no longer credited.
- [x] RESOLVED (2026-10-11): the stage 2 migration was built (decision by the coordinator, user standard "no unencrypted prod DB at completion"). `pin-the-module` is the interim stage-1 fix; stage 2 requires the ordered typed `aws rds create-db-snapshot` -> `copy-db-snapshot --kms-key-id` -> `restore-db-instance-from-db-snapshot` (identifiers orders-db-pre-2-1, orders-db-enc-2-1, orders-db-v2). Cutover, importing the new instance into module.db and raising the pin to 2.1.0 are taught only.
- [ ] Unverified: the snapshot, KMS-encrypted copy, restore, cut-over description for encrypting an existing RDS instance (matches the RDS encryption docs from memory; no new source read).

### Decision for the user (terraform-module-upgrade)

- [x] RESOLVED (2026-10-11): see above, the stage 2 is built; the earlier question is closed.
- [ ] aws-route53-failover review fix (2026-10-10): accepting any public CIDR / any `pl-` id as the checker rule was a defect, now fixed: only the lab's exact prefix list `pl-0r53hc` or one of the three CIDRs in the scripted `curl .../ip-ranges.json` excerpt (15.177.0.0/18, 54.239.98.0/24, 54.240.217.160/29: invented values, not the real ROUTE53_HEALTHCHECKS list), tcp 443 only, no shell operators, no world-open range; weak actions are evaluated first. A CIDR route needs one command per range and the first credits the action (a prefix list is the cleaner route). Unverified, from memory: that Route 53 HealthCheckStatus metrics live in us-east-1 (CloudWatch metric doc not read), the invented alarm names/`describe-alarms` text, the managed prefix list name. Sources list not extended (health-check/CloudWatch docs not read in full; the ip-addresses page was fetched and confirms prefix lists and ROUTE53_HEALTHCHECKS).
- [ ] aws-route53-failover second review fix (2026-10-10): the checker-rule regex is now a flag grammar (match_regex is the only matcher the engine offers, so no tokenizer): allow-list `--group-id --protocol --port --cidr --ip-permissions --region us-west-2 --profile --output --no-cli-pager`, each once, space or `=` forms, bare/single/double-quoted exact values; duplicate or unknown flags (`--port 22` after a valid line, a second `--group-id`, `--group-name`, `--description`, `--dry-run`) are not credited, and unquoted shell-active characters cannot appear. `--ip-permissions` must be a quoted document (single quotes, or double quotes without `$ \` ! backtick) or a bare token without brackets/braces; the unquoted `[{...}]` shorthand is no longer credited. Weak forms now flagged wrong/destructive: `modify-security-group-rules` and `authorize-security-group-egress` with a world-open range, and quoted or `=` group ids. Known limit: a quoted ip-permissions document is judged by lookaheads over its text, not parsed as JSON.

### azure fix-quality rework (2026-10-10)

- [ ] Unverified Azure facts (from memory, no new source read): Website Contributor's allowed actions include Microsoft.Web/sites/publishxml/action (azure-rbac-wrong-scope credits it on the site scope); `az functionapp scale config set --maximum-instance-count` accepts -g/-n and the flag spellings in the matcher; Front Door HTTPS origin validation needs a certificate bound for the forwarded host name, and AzureFrontDoor.Backend plus X-Azure-FDID is the supported origin lockdown (azure-front-door-host-header); `az storage account show` library entry text (azure-public-blob-container).
- [ ] azure-rbac-wrong-scope: the credited role is now Website Contributor on web-prod; the click-only `use-federated-credential` step assumes the lab's SP uses a client secret (environment text added). If a harder variant is wanted, add an `az ad app federated-credential create` typed command.
- [ ] Deferred (large redesign, only taught as required click steps, no verification commands): azure-app-sql-two-faults private endpoint + VNet integration as the primary fix; azure-slot-swap-key-vault-two-faults per-slot user-assigned identities; azure-service-bus-dead-letter idempotency check and contract test are in the action labels only, not verified by a terminal command.

### terraform-sg-cycle (fix-quality rework, 2026-10-10)

- Credited fix is now the separate-rule-resource split by group id (`aws_vpc_security_group_{ingress,egress}_rule` or `aws_security_group_rule`), judged on world state (new `sg_rule` predicate: effective rules of both groups in the cloud, exact 8080/8443 from the peer group, web 443 and egress kept, no CIDR source on 8080/8443, nothing on 22, plan clean). Subnet/VPC CIDR is `widen-callbacks-to-cidr` (wrong); world-open is still `open-callbacks-to-internet` (destructive). Action ids `break-the-cycle` and `open-callbacks-to-internet` unchanged; `widen-callbacks-to-cidr` added.
- Verified from the provider docs (raw GitHub markdown, 2026-10-10): rule resource argument names; the warning against mixing inline rules with rule resources; that removing `ingress`/`egress` does not revoke existing rules and `ingress = []` / `egress = []` does.
- [ ] Unverified (lab model, from memory): which rule-resource attributes force replacement (the lab: only `security_group_id`; for `aws_security_group_rule` everything but `description`); the `sgr-` / `sgrule-` id shapes; the `InvalidPermission.Duplicate` error text and the "creating VPC Security Group Ingress Rule" prefix; that the real provider errors on a rule duplicating a live inline rule (believed so: AuthorizeSecurityGroupIngress duplicate).
- Lab limits: the real provider does not warn at plan time about inline + rule resources (it shows perpetual diffs); the lab prints a warning ("Security group rules are managed twice") and `plan_clean` refuses it. Mixing `aws_security_group_rule` with `aws_vpc_security_group_*_rule` on one group (also warned against by the docs) is not flagged. Rule-resource required-argument checks (one source, ip_protocol) are not validated. Importing the existing live rules by `sgr-` id (the no-gap migration) is not modelled; the debrief mentions it.
- Design note: the credited path takes a brief gap (old rules revoked, new created in one apply), taught in `real_world`.

### content/aws rework (2026-10-10)

- [ ] aws-cross-account-replication-dr: key policy via put-key-policy file:// cannot be inspected (lab has no policy file): regex pins DR key ARN, policy name default, safe filename, --profile dr; inline wildcard-principal docs are flagged destructive. Batch job regex is a lookahead grammar on --account-id, S3ReplicateObject, source bucket ARN, ObjectReplicationStatuses exactly NONE+FAILED; the exact create-job JSON shape is from memory (unverified). Unverified: kms:ViaService works for the cross-account replication role; BucketOwnerEnforced taking ownership of already-delivered replicas (about-object-ownership). owner-override kept wrong (insufficient alone) with honest feedback.
- [ ] aws-lambda-concurrency-starved: unverified from memory: update-event-source-mapping --scaling-config MaximumConcurrency syntax and its 2..1000 range, the invented mapping UUID, and the claim that a function reserved-concurrency cap on an SQS consumer sends throttled messages back to the queue toward the DLQ (documented on the Lambda SQS scaling page; page not re-read). Credited range 20-300 for the mapping, 200-500 for checkout's reservation are teaching choices. DLQ/maxReceiveCount setup not required (ESM cap avoids throttling).
- [ ] aws-single-az-database: unverified from memory: a promoted replica inheriting BackupRetentionPeriod 0 (scenario assumes the reporting replica had none), that stop-db-instance works on an instance in an impaired AZ and that RDS auto-restarts a stopped instance after 7 days, the fenced-output text, backup retention bound 7-35 (teaching choice). Repointing is still a label-only click (private Route 53 CNAME): the lab has no DNS state to check.
- [ ] aws-sqs-visibility-timeout: credited timeout 90-600 s is a teaching choice (p95 ~47 s); DLQ/idempotency actions are label-only clicks (no queue/DB state in the lab).
- [ ] aws-access-keys-to-role: CloudTrail lookup output (foreign IP 198.51.100.77 calls) is invented for teaching; IMDSv2 only mentioned. role contents/env cleanup remain label-only clicks.
- [ ] aws-alb-migration-two-faults: stale-rule revoke assumes alb-shop is idle (stage-2 premise); IaC change is prose only.
- [ ] aws-asg-elb-health-check: unverified: the instance maintenance policy (MinHealthyPercentage/MaxHealthyPercentage) governing replacement of health-check-failed instances (docs not re-read); label-only click; grace period credited 100-9999 s.
- [ ] aws-dynamodb-gsi-throttle: on-demand can be switched once per 24 h (from memory, not re-read); fixed 2000 WCU floor and autoscaling bounds are prose only (labels), not regex-checked.
- [ ] aws-nat-gateway-cost: endpoint policy is checked by a regex over an inline single-quoted JSON document (must name arn:aws:s3:::acme-media-*, no Resource "*", no Action "*" or "s3:*"); it is not a JSON parse (limit; a reordered or exotic document may be missed or flagged). Unverified: modify-vpc-endpoint --policy-document syntax and the default endpoint policy text from memory. lambda-vpc-public-subnet: NAT-per-zone/egress hardening is prose only (large redesign if required).
- [ ] aws-s3-glacier-lifecycle: unverified: Glacier Instant Retrieval 90-day minimum storage duration; versioned copy-in-place behaviour. Fixes remain label-only (lifecycle lives in IaC, no lab state). Standard-IA / Intelligent-Tiering Archive Instant Access not credited as alternatives (pricing not verified).
- [ ] aws-s3-sse-kms-decrypt: unverified: kms:ViaService condition works for the viewer's GetObject path (S3 calling KMS on the caller's behalf); Bucket Keys cost claim from memory; re-encryption is a label-only click (no lab state).
- [ ] aws-security-group-port: ALB egress narrowing and SSM-instead-of-SSH are prose only in the ideal path (large redesign if required).
- Design note (all aws scenarios above): label-only steps (IaC codification, alarms, DLQ, re-encryption, repointing DNS) are credited by click because the lab holds no state to check; they are required in solution_paths so they cannot be skipped, but their content is not verified.

- terraform-sg-cycle: the fix and the traps are judged by the cloud's effective rules (`sg_rule` predicate), not by file regexes; `open-callbacks-to-internet` fires on 0.0.0.0/0 or ::/0 on 8080/8443 once applied, `widen-callbacks-to-cidr` on the subnet or VPC CIDR. Only those exact CIDRs are flagged as the wrong trap; any other CIDR is just not credited.
#### azure fix-quality rework: honesty notes (nit round, 2026-10-10)

- [ ] Click-only required steps (credited by clicking, never verified by a typed command or file check): azure-files-port-445 `disable-public-access` (ordering is only taught via the 443 check output and feedback, not enforced); azure-public-blob-container `assess-exposure`, `disallow-account-anon`; azure-rbac-wrong-scope `use-federated-credential`; azure-orders-backlog-major `remove-sas`, `cap-calls`, `backoff-429`; azure-appgw-health-probe `probe-in-iac`; azure-private-endpoint-dns `zone-in-iac`; azure-nsg-rule-priority `nsg-in-iac`; azure-vnet-peering-one-way `scope-nsg`; azure-front-door-host-header `bind-certificate`, `lock-origin`, `fix-bicep`; azure-app-sql-two-faults `firewall-iac`; azure-slot-swap-connection-string `clean-staging-data`, `migrate-orders`; azure-slot-swap-key-vault-two-faults `revoke-staging-prod`; azure-cosmos-hot-partition `new-partition-key`, `lower-rus`, `alert-hot-partition`; azure-vm-stopped-not-deallocated `replace-cron`; azure-service-bus-dead-letter `fix-consumer`, `resubmit`, `dlq-alert`.
- [ ] azure-orders-backlog-major: `az functionapp scale config set/show` and `--maximum-instance-count` are Flex Consumption commands; the environment text does state Flex Consumption, but the matcher spellings are from memory.
- [ ] From-memory claims, not re-checked against docs: NormalizedRUConsumption by partition key range as the skew metric (cosmos), the contents of the Website Contributor and Virtual Machine Contributor roles and the Website Contributor GUID de139f84-1756-47ae-9be6-808fbbe81aa3 (also the Contributor and Owner GUIDs b24988ac-... and 8e3af657-... used in wrong-action matchers), swap-with-preview as the way to check a slot swap, SMB 3.x with encryption in transit as the Azure Files setting.
- [ ] azure-policy-allowed-locations: solution_paths changed from one path needing both steps to two alternative paths (allowed region, or exemption); progress or scoring that assumed both steps should be re-checked.

### linux/networking/containers fix-quality rework (2026-10-10)

- [ ] Unverified facts (from memory, docs not re-read): chgrp(1) man page cited in nginx-permission-denied (`retrieved` set but not opened); `install -d -o -g -m` flag semantics (ssh-strictmodes); systemd `StateDirectory=`/`PrivateTmp=` wording; `findmnt --verify` output and `RequiresMountsFor=` behaviour with `nofail` (media-disk-migration-major); ICMPv6 packet-too-big is type 2 and allowing it narrowly is the recommended practice (pmtu-black-hole); Redis ACL/`requirepass` guidance (duplicate-ip-cache-major); LimitRange/ResourceQuota defaults wording and report-builder sizing 6Gi request / 7Gi limit on 8 GiB nodes (evicted-checkout-major, a teaching choice); CPU request 300m (pending-insufficient-cpu, teaching choice); `openssl x509 -checkend` use and 21-day alert threshold (expired-tls-certificate).
- [ ] Label-only (click) steps with no lab state to verify: ssh-strictmodes `point-app`; media-disk-migration-major `cleanup-hidden` (a typed delete of the hidden copy is deliberately not credited, order of verify-before-delete can't be enforced) and `guard-service`; pmtu-black-hole `allow-frag-needed` and `mss-clamp` (firewall/gateway rules, no lab state); duplicate-ip-cache-major `persist-isolation`, `persist-nft`, `redis-auth`, `decommission-old`; evicted-checkout-major `namespace-defaults`, `capture-resources`; cron-environment `backup-alert`; load-average-nfs `nfs-alert`; dns-resolution-failure `run-role`; expired-tls-certificate `add-expiry-monitor`. A remote-file predicate (files on other hosts via ssh) would let nft/netplan/fstab persistence be checked; not available in the lab today.
- [ ] Not changed (deliberate, would need a large redesign or new command-library entries): scripted `diff -r` / `logrotate -d` / `findmnt --verify` outputs (each scripted command needs a content/commands entry); the nginx lab does not model per-file modes, so `mode-750` is judged by regex (chmod 750 on the folder, or `-R u=rwX,g=rX,o=` spellings), not by world state; an explicit `chmod -R 750` (executable files) is simply not credited.
- Design note: in nginx-permission-denied `chown-www` (owner www-data) is now `wrong`, owner stays alice with group www-data, directories 750 / files 640. pmtu-black-hole: `mss-clamp` is credited only together with `allow-frag-needed`.
- [ ] full-disk: the disk-usage alert is only a debrief follow-up, not a required step: full-disk is the shared fixture of many engine/scoring/UI tests (tests/engine, scoring, incident, shift-ui, routing), so changing its solution path means reworking all of them. Revisit if those fixtures move to a dedicated test scenario.

### content/aws rework, review follow-up (2026-10-10)

- [ ] aws-nat-gateway-cost: the earlier note about a regex over the endpoint policy is superseded. `endpoint_policy` (src/game/awsPolicyCheck.ts, documented in AUTHORING.md) now parses the inline document: Allow only, Principal exactly "*", actions inside {GetObject, PutObject, ListBucket, GetBucketLocation} with GetObject and PutObject required, Resource only acme-media-* bucket ARNs (objects as /*). Known limits: `file://` documents are not judged (scripted note; the action button credits); Condition blocks are accepted unexamined (they can only narrow an Allow); the `Version` 2008-10-17 default is accepted. Unverified: modify-vpc-endpoint syntax and that real endpoint policies need Principal "*".
- [ ] aws-cross-account-replication-dr: the batch-job matcher is still a regex (lookahead grammar) over the command text, not a parse of the manifest-generator JSON. It now requires ExpectedBucketOwner 111122223333, EligibleForReplication true, statuses exactly NONE+FAILED, and rejects CreatedAfter/CreatedBefore/KeyNameConstraint/MatchAny and repeated --account-id/--operation/--manifest-generator/--role-arn; narrower jobs are flagged wrong (`batch-narrow-job`). Other valid spellings (JSON from a file, --cli-input-json) are not credited.
- [ ] aws-asg-elb-health-check: grace period credited 100-1800 s only and must be stated; the 1800 cap is a teaching choice.
- [ ] aws-single-az-database: `promote-with-backups` (promote-read-replica --backup-retention-period 7-35) is the preferred spelling and is a second solution path. Unverified: that promote-read-replica accepts --backup-retention-period (from memory of the CLI reference).
- [ ] Accepted limits of the aws batch-job matcher (review nit 4): lowercase filter keys, an S3ReplicateObjectX operation prefix and unknown manifest-generator keys are still credited because the matcher is a regex over the command text, not a parse.

### cicd and databases fix-quality rework (2026-10-10)

- [ ] Unverified (from memory, docs not re-read): `gh workflow run --ref` accepts a tag and the dispatch then checks out the tagged commit (release-pipeline-major); `actions/create-github-app-token` as the per-run App token source; gh flag spellings -r/-f/-F/--field/--raw-field; the tj-actions/changed-files 2025 compromise wording (required-check-path-filter); org default workflow permissions path (github-token-permissions); environment deployment-branch policy and prevent-self-review (oidc-environment-subject).
- [ ] pgbouncer-transaction-pooling-major: PgBouncer's config page (fetched) does not say whether max_prepared_statements applies on RELOAD or needs a restart; the label now says RELOAD with a rolling restart if needed. Unverified.
- Click-only required steps (no lab state): release-pipeline-major `app-token`/`workflow-call`; postgres-lock-queue `migration-lock-timeout`, `analyst-replica`; postgres-too-many-clients `pooler-compat`, `pooler-auth`, `connection-budget`; oidc `restrict-environment`; github-token-permissions `org-default-read`; fork-pr-secrets `permissions-block`, `reviewed-run`; postgres-listen-localhost `tls`; pitr `lockdown-restore`, `least-priv-cleanup`; replica `lag-alert`; pgbouncer `void-and-refund`. The `read-your-writes` LSN approach is also a click.
- postgres-pitr-accidental-delete: `when_actions: [restore-side, copy-back]` is all-of in the engine (`every`), so no change was needed there.
- postgres-too-many-clients: `smaller-pool` alone no longer completes; it pairs with `connection-budget`. Teaching choice.
- Not changed (hint/debrief only or deferred): required-check-path-filter (label + real_world; no new required step), failing-github-actions (labels + real_world); scripted `SELECT rolconfig` verification for postgres-lock-queue not added (needs a content/commands entry).
- [ ] Deferred nits (review round): nginx lab credits no `install -d -o alice -g www-data -m 750 /srv/www/promo` (it sets only the folder, not contents, and would credit two steps from one command), no `chown root:www-data` (root-owned content is a valid deploy model but the lab's deploy user is alice); no scripted `diff -r` / `logrotate -d` / `findmnt --verify` outputs (each needs a content/commands entry); the pending-insufficient-cpu 14-day history excerpt and VPA 270m target are invented lab data.

### gcp + microservices fix-quality rework (2026-10-10)

- [x] gcp-scan-ingest-major (review rework): `perimeters update` has only `--set-ingress-policies=YAML_FILE` (replaces all) and `--clear-ingress-policies`; there is no `--add-ingress-policies`. The scenario now teaches describe -> merge the existing bi-export policy into ingress.yaml -> `perimeters dry-run update` -> apply with `--set-ingress-policies`. The file is judged by parsing (src/game/vpcscIngress.ts, `ingress_policy` on the `file` action) and the typed apply is credited by the terminal only while the file on disk passes (`requires_file`). Limits: a broad apply is not a separate wrong action (it just does not count, with a note); the order dry-run-before-apply is taught, not enforced; the ingress YAML key names (`identities`, `sources[].resource`, `ingressTo.operations[].methodSelectors[].method`, `resources`) and the dry-run command are from memory of the docs; `dlq-alert` is label-only; the bi-export policy is invented for the lab. Replaying a saved game rebuilds the apply's scripted output but not the check note.
- [ ] gcp-lifecycle-deleted-objects: clearing the rule before restoring is only taught in feedback (both are required but the order is not enforced). Restore start time credited 16:30-16:41Z on 2026-09-30 (teaching choice). `exports-rule` credits `--lifecycle-file=exports-cleanup.json` on acme-exports; `protect-docs` is label-only (retention policy/object holds need legal input).
- [ ] gcp-cloud-run-connection-exhaustion: cap credited 5-40 instances (teaching choice, pool 10 per instance < 500); IaC sync is in the label only. gcp-bigquery-full-scan `cap-bytes`, gcp-service-account-no-role `audit-default-sa` (org policy `iam.automaticIamGrantsForDefaultServiceAccounts`, from memory), gcp-regional-cpu-quota `alert-quota`/`isolate-batch`, jwt-clock-skew `check-fleet`/`clock-alert` (cart-02/search-01/notify-01 added to the maintenance log), breaking-api-field `contract-tests`, cascading-failure `bulkhead`/`migration-guard`, poison-message-loop `repair-replay`/`queue-alerts`, trace-context-dropped `fix-scan`/`propagation-test`, consumer-rebalance-storm-major `idempotent-sends`/`rebalance-alert`: all label-only clicks.
- [ ] gcp-firewall-network-tag `sa-target`: unverified that changing a VM's service account requires the VM to be stopped (from memory) and that `firewall-rules update --target-service-accounts` replaces tag targets without a separate flag to clear tags.
- [ ] idempotency-double-charge: unverified (Stripe docs not re-read): keys expire after 24 h; same key with different parameters errors; saved result replays errors too.
- [ ] poison-message-loop: verified against rabbitmq.com/docs/quorum-queues (2026-10-10): at-most-once is the default dead-letter-strategy, at-least-once needs overflow reject-publish; basic.nack does not increment delivery-count, basic.reject does; delivery-limit default 20 since 4.0. Still unverified: the "since 4.3 the limit counts failed deliveries" wording in the hypotheses/debrief (docs show the behaviour from 4.0).

#### cicd and databases fix-quality rework, review round 2 (2026-10-10)

- [ ] pgbouncer-transaction-pooling-major: the order void-and-refund before unique-index is taught but not enforced (both are required; the lab cannot tell which came first). Building the unique index before voiding the duplicates fails or leaves an INVALID index; the `count = 0` output now needs both actions.
- [ ] fork-pr-secrets `reviewed-run`: wording is a workflow_dispatch from the base repo given a reviewed commit SHA, with the key in an environment that has required reviewers. A label trigger on a fork PR only yields secrets via pull_request_target, so it is deliberately not described. Click-only; the pattern itself (checking out the SHA only after review) is unverified against GitHub's secure-use page.
- [ ] release-pipeline-major: fixed publish.yml lives on main and checks out `ref: inputs.tag`; dispatching on the tag ref runs the tag's older publish.yml (stage 1 still builds the tag commit, and stage 3 builds with main's fixed workflow). Unverified: `gh release upload` accepting `refs/tags/<tag>` (credited as a spelling only). Per-file uploads form a second solution path.
- [ ] postgres-lock-queue: the cancel path now also requires terminate-idle (ALTER ROLE ... SET only affects new sessions). Role timeouts credited 1min to 10min only; sub-minute values are `analyst-timeout-short` (wrong). Only analyst2 is covered by the typed matcher; other roles are in the label.

### iac fix-quality rework (2026-10-10)

- [ ] Invented scenario fiction (not sourced facts), review wording: terraform-drift-hotfix partner ticket SEC-4417 (callbacks only from 198.51.100.16/28, the rest of the /24 belongs to other customers of their hosting provider) and the 23:53 on-call log line; terraform-destroy-dependency-violation `#ingest-platform` thread (Priya confirms the ENI) and the CloudTrail output (DetachNetworkInterface on 2026-09-30 by ingest-platform-deploy); terraform-destroy-nonempty-bucket archive bucket `acme-archive-reports/reports-logs/`; terraform-count-index-shift get-queue-attributes output (all zero).
- [ ] terraform-forces-replacement: now two stages. Stage 1 credits only the revert as an interim step; stage 2 requires create-snapshot, copy-encrypted (needs `--kms-key-id`), restore-encrypted (typed `aws rds` commands, regex only, no lab state; the order is not enforced and names are pinned to the runbook names in the stage update). NOT modelled: the cutover, importing `orders-db-v2` into Terraform with `storage_encrypted = true` and prevent_destroy, and retiring the old instance (the simulator has no snapshot restore). Same design question as the open terraform-module-upgrade stage 2: confirm the user wants staged migrations for these two. Unverified from memory: `copy-db-snapshot --kms-key-id` accepts an alias, and the AWS CLI error wording for DBSnapshotNotFound.
- [ ] terraform-state-lost: now requires `backend.tf` with `backend "s3"` (bucket, key, encrypt = true, and use_lockfile = true or a dynamodb_table), a `terraform init` that migrated the state (the local terraform.tfstate emptied) and a clean plan. The file name backend.tf is required by the check (a backend in main.tf is not credited). Not checked: versioning/bucket policy on the state bucket, deleting terraform.tfstate.backup (taught in feedback/hints).
- [ ] terraform-module-key-removed: `stop-managing-west` is now a wrong action (no credited state rm route). If the user wants a gated route (export confirmed + snapshot + owner recorded) that needs a snapshot/confirmation step first; not built.
- [ ] terraform-drift-hotfix: `codify` needs the rule narrowed to 198.51.100.16/28 AND applied (reality changes), checked by sg_rule leaves; other narrow ranges (e.g. 10.0.0.0/8 on 8443 alongside) are not individually excluded. After the `apply-anyway` trap a correct narrowed apply still earns the fix (the trap predicate is world-based and no longer holds then); the destructive mark stays latched in the log.
- [ ] terraform-destroy-dependency-violation: reading the owner confirmation and CloudTrail evidence is encouraged (methodical bonus, key_evidence) but the typed delete is not gated on it (the engine has no evidence-gate for typed actions).
- [ ] terraform-vcpu-limit: quota credited 98 to 192 vCPUs (teaching choice); above 192 is `request-excessive-quota` (wrong). `right-size` is now wrong because the ticket says the soak test is sized to the 96-vCPU generator. Lowering the quota after teardown is taught only.
- [ ] Text-only follow-ups (taught in hints/debrief/feedback, not enforced): terraform-ignore-changes-autoscaling (autoscaling target and policy into code); terraform-destroy-nonempty-bucket (delete-marker cleanup of a versioned bucket, flag removal); terraform-import-existing (prevent_destroy is in the label but the choice has no done_when; post-import bucket hardening); terraform-state-in-git (bucket controls, .tfstate.backup purge, managed master password, clone/login audit); terraform-orphans-after-state-rm (the default password and skip_final_snapshot remain in the lab config; the final snapshot itself is now an enforced typed step); wrong-workspace-major (the new `workspace-guard` is a click-only required step with no lab state).

## Typed-line guard: actions the validator cannot check yet
The validator (src/schema/scenario.ts) tries every action's `example`, and the command written in its label when the
`match_regex` accepts it, against the typed-line guard (shell syntax, repeated flags on a fix). These 84 actions
with a `match_regex` have neither, so the check is skipped for them; the existing tests cover their canonical lines
(all of which pass the guard). Add an `example:` (one typed line the regex accepts) to each and tick it off.
Known: lines that spell unquoted `[`, `{`, `*`, `?` (AWS shorthand like `Rules=[{...}]` or `gs://bucket/**`,
`--ip-permissions IpProtocol=...,PrefixListIds=[{...}]`) are rejected by the guard even where a regex accepts them;
the labels and tests use the quoted form.
- [ ] aws-access-keys-to-role/attach-role
- [ ] aws-asg-elb-health-check/grace-zero
- [ ] aws-asg-elb-health-check/grace-too-long
- [ ] aws-asg-elb-health-check/grace-unset
- [ ] aws-cross-account-replication-dr/open-key
- [ ] aws-cross-account-replication-dr/grant-key
- [ ] aws-cross-account-replication-dr/batch-failed-only
- [ ] aws-cross-account-replication-dr/batch-none-failed
- [ ] aws-cross-account-replication-dr/batch-narrow-job
- [ ] aws-lambda-concurrency-starved/reserve-checkout-small
- [ ] aws-lambda-concurrency-starved/reserve-checkout-big
- [ ] aws-lambda-export-two-faults/timeout-too-short
- [ ] aws-lambda-export-two-faults/timeout-too-long
- [ ] aws-route53-failover/open-all-ports
- [ ] aws-route53-failover/open-standby-direct
- [ ] aws-route53-failover/remove-vpn-rule
- [ ] aws-route53-failover/allow-health-checkers
- [ ] aws-single-az-database/multi-az-deferred
- [ ] aws-single-az-database/reboot-db
- [ ] aws-single-az-database/delete-primary
- [ ] aws-sqs-visibility-timeout/timeout-too-low
- [ ] aws-sqs-visibility-timeout/timeout-too-high
- [ ] azure-appgw-health-probe/widen-probe
- [ ] azure-appgw-health-probe/restart-vms
- [ ] azure-appgw-health-probe/recreate-gateway
- [ ] azure-cosmos-hot-partition/raise-rus
- [ ] azure-front-door-host-header/custom-domain
- [ ] azure-key-vault-wrong-role/secrets-user
- [ ] azure-orders-backlog-major/cap-concurrency
- [ ] azure-private-endpoint-dns/link-zone
- [ ] azure-rbac-wrong-scope/owner-subscription
- [ ] azure-rbac-wrong-scope/subscription-contributor
- [ ] azure-rbac-wrong-scope/contributor-rg
- [ ] azure-vnet-peering-one-way/create-other-side
- [ ] failing-github-actions/delete-lock
- [ ] failing-github-actions/force-push
- [ ] release-pipeline-major/dispatch-main
- [ ] release-pipeline-major/dispatch-tag
- [ ] release-pipeline-major/clobber-binaries
- [ ] release-pipeline-major/upload-binaries
- [ ] release-pipeline-major/upload-darwin
- [ ] release-pipeline-major/upload-windows
- [ ] release-pipeline-major/upload-sums
- [ ] crashloopbackoff/rollback
- [ ] crashloopbackoff/delete-pods
- [ ] crashloopbackoff/delete-deployment
- [ ] evicted-checkout-major/run-capture
- [ ] image-pull-backoff/recreate-deployment
- [ ] postgres-lock-queue/cancel-migration
- [ ] postgres-lock-queue/analyst-timeout
- [ ] postgres-lock-queue/analyst-timeout-off
- [ ] postgres-lock-queue/analyst-timeout-short
- [ ] gcp-cloud-run-connection-exhaustion/cap-instances
- [ ] gcp-cloud-run-connection-exhaustion/raise-max
- [ ] gcp-cloud-run-connection-exhaustion/lower-concurrency
- [ ] gcp-cloud-run-connection-exhaustion/restart-sql
- [ ] gcp-lifecycle-deleted-objects/bulk-restore
- [ ] gcp-lifecycle-deleted-objects/exports-rule
- [ ] gcp-lifecycle-deleted-objects/reapply-docs
- [ ] gcp-scan-ingest-major/clear-ingress
- [ ] gcp-scan-ingest-major/ingress-rule
- [ ] gcp-scan-ingest-major/redrive
- [ ] terraform-destroy-dependency-violation/release-eni
- [ ] terraform-destroy-nonempty-bucket/empty-bucket
- [ ] terraform-moved-block/state-mv (now a `wrong` action detected from state history, `state mv`/`state rm` of the old address; the original unreviewed alternative text no longer applies)
- [ ] terraform-orphans-after-state-rm/snapshot-before-destroy
- [ ] terraform-vcpu-limit/request-quota-increase
- [ ] terraform-vcpu-limit/request-excessive-quota
- [ ] wrong-workspace-major/prod-apply
- [ ] wrong-workspace-major/apply-now
- [ ] full-disk/truncate-log
- [ ] full-disk/reboot
- [ ] media-disk-migration-major/recover-hidden
- [ ] nginx-permission-denied/chmod-loose
- [ ] oom-killed-service/kill-python
- [ ] jwt-clock-skew/fix-ntp
- [ ] poison-message-loop/lower-delivery-limit
- [ ] poison-message-loop/scale-workers
- [ ] dns-resolution-failure/flush-firewall
- [ ] duplicate-ip-cache-major/isolate-old
- [ ] duplicate-ip-cache-major/allow-subnet
- [ ] duplicate-ip-cache-major/copy-carts
- [ ] expired-tls-certificate/renew
- [ ] expired-tls-certificate/restart-nginx

### iac fix-quality rework, round 2 (2026-10-11)

- [ ] terraform-module-upgrade stage 2 and terraform-forces-replacement stage 2 share the same typed AWS steps (regex only, ordered with `after:`; no lab state, so a wrong id is simply not credited). Unverified from memory: `copy-db-snapshot --kms-key-id` accepts an alias; DBSnapshotNotFound wording.
- [ ] terraform-drift-hotfix: new `sg_only` leaf (every rule on the group comes from the listed peers). Routes: /28 or the two NAT /32s; extra sources of any kind (a /25, /23, 10.0.0.0/8, SSH from anywhere) are not credited; extra 8443 sources are the wrong action `codify-wide`, an extra rule on another port just never earns the fix (no feedback).
- [ ] terraform-state-lost: new `config_matches` leaf (any .tf in the lab dir, comments removed). The backend must have bucket, key, `encrypt = true` and `use_lockfile = true` or a `dynamodb_table`, each on its own line inside the `backend "s3"` block; `weak-backend` (wrong) fires on a declared backend that fails this.
- [ ] terraform-orphans-after-state-rm: `snapshot-before-destroy` is a typed step and `destroy-environment` has `after: [snapshot-before-destroy]`. Limit: the destroy fix is world-detected, so a player who destroys first can still type the snapshot afterwards (the snapshot of a deleted DB would fail in real life) and get credit.
- [ ] terraform-destroy-nonempty-bucket: `get-bucket-versioning` and `list-object-versions` now run (scripted, unversioned bucket) with command-library entries. Versioned-bucket cleanup (delete markers) is still taught only.
- [ ] Regex hygiene: vcpu quota, forces-replacement and module-upgrade snapshot regexes are anchored with a flag-grammar tail (`--flag value`, value not starting with `-`); delete-network-interface accepts `--network-interface-id=`; prod-apply accepts `-var-file prod.tfvars`/`-var-file=…`/`--var-file`, with `-auto-approve` either side; the SQS drain check accepts `--region`. Compound commands, substitutions and repeated flags are now rejected by the engine guard, not by these regexes.
- [ ] Not changed: the 9-tail `restore-unencrypted` / `delete-old-first` regexes are deliberately unanchored so variants are still caught as wrong/destructive.
- [ ] (round 3, 2026-10-11) terraform-state-lost now judges the backend `terraform init` recorded (new `backend` predicate: literal attributes only, so comments, tags, heredocs and nested blocks cannot satisfy it); a declared-but-uninitialised backend, or a failed init, is neither credited nor flagged `weak-backend`. Two backend blocks give `Duplicate backend configuration` (wording from memory, unverified).
- [ ] (round 3) Typed stage-2 `aws rds` commands accept `--flag=value`, quotes, `aws --region us-east-1 rds ...` and the harmless `--no-cli-pager`/`--output`/`--region us-east-1`; other extra flags (e.g. `--copy-tags`) are still not credited, with no specific feedback. `--kms-key-id alias/aws/rds` (the AWS-managed default key) is the wrong action `copy-default-key`; the runbook in the stage text names the customer-managed alias/orders-db, which is what supports this. Any other key value is credited.
- [ ] (TF7b) wrong-workspace-major runs on the simulator: `prod-apply` is detected from the world and the apply history (orders-prod is a db.r6g.xlarge; an update applied with exactly `-var-file=prod.tfvars`; no apply with `-target`, `-refresh=false`, `-lock=false` or `-var`; prod.tfvars unchanged; no delete or state rm). The markers are sticky (a stopgap apply earns no credit even if a clean apply follows, since that one has nothing left to change); `TF_VAR_*` and auto-loaded tfvars are not marked. `plan_clean` is not used (required variables). The guard stays a click-only taught step (`precondition`/`check` are not simulated). Unverified/simplified: the lab applies a class change at once whatever `apply_immediately` is (the queued-until-maintenance-window story is the scripted `aws rds` output), and real provider behavior of a plan after an `apply_immediately = false` class change (pending value vs refresh) is from memory; state records `apply_immediately = true` from Monday's staging apply, so the prod plan also shows it going back to false (the provider storing that argument in state is from memory); a lifecycle `precondition` being evaluated during plan (not before) is from the Terraform docs as remembered, no source added; the workspace-keyed map is advice only; invented: engine version, endpoint, storage, the staging instance (orders-staging, db.r6g.large), the `destroy-prod` wording. Not enforced: reading the plan before applying.
- [ ] (round 3) terraform-destroy-nonempty-bucket: list-object-versions output now has ETag and LastModified fields (invented values) and prints nothing once the bucket is emptied; get-bucket-versioning prints `{}` for an unversioned bucket (real CLI output wording from memory).

### terraform-import-existing migration (TF7b task 7)

- [ ] Unverified from memory: `head-bucket` on a bucket in another account answers 403 Forbidden (used in the `name-taken` hypothesis feedback); the scripted `head-bucket` output keeps only `BucketRegion` (real output has more fields).
- [ ] The fix needs an `applied import` of the address (an import block apply or `terraform import`), the bucket still in the cloud, `plan_clean` and no `applied delete`, so a rename-then-apply (new empty bucket under the same address) is never credited. `rename` and `delete-recreate` are world-detected (`applied create` / `applied delete` of the address). `delete-recreate` has no typed `aws s3 rb --force` route: the player reaches it only through force_destroy + apply + destroy (BucketNotEmpty otherwise). Deliberate limit (sticky detection): with prevent_destroy in place and the import done, the fix is taken at that moment; lifting prevent_destroy, setting force_destroy, apply and destroy afterwards still counts `delete-recreate` as a destructive mistake (UI-tested) but does not un-take the fix.
- [ ] `aws_s3_object` is cloud-only (not a modelled resource type), so the data being kept is guarded by the `applied delete` check, not a `reality_has` on an object.
- [ ] (fix round 1) The fix now requires `lifecycle { prevent_destroy = true }` (per-line `config_matches`, comments stripped) and no `force_destroy = true` in the config. Deliberate limit: post-import hardening (public access block, default encryption, versioning, TLS-only policy) stays taught only, not enforced.
- [ ] `plan -generate-config-out` (real in Terraform 1.9) now answers `Not available in this lab yet` ("not simulated yet in this lab"), tested.

### terraform-moved-block migration (TF7b task 8)

- [x] Scoring ruling (user has not approved changing live scoring; fix-quality standard): the declarative `moved` block is the ONLY credited fix. `terraform state mv` (and `state rm` plus `import`) is imperative one-off state surgery that does not travel to other workspaces or environments, so it is NOT a second fix route as the task brief proposed: `state-mv` stays kind `wrong` (not destructive) with teaching feedback, detected from the world (module address in state, old address gone, no `moved` block in main.tf, no delete applied). A `state mv`/`state rm` blocks the credit for good (sticky, final review round); the `state-mv` flag stays too. `solution_paths` stays `[[moved-block]]`. The fix predicate anchors the `from`/`to` addresses so a wrong `to` (e.g. `...orders_v2`) is not credited.
- [ ] Reviewer decision: the brief's plan to make `state-mv` a credited fix was overridden; revisit only with user approval of scoring changes.
- [ ] Unverified from memory: the claim that a `state mv` does not carry to other workspaces/environments (true by construction of state, but not quoted from a docs page); the "each moving its own state the first time it applies" wording for moved blocks across environments; moved blocks "Terraform v1.1 and later" (unchanged from before).
- [ ] The pipeline `terraform plan` log now mirrors the simulator's real plan rows and summary (attribute list is the simulator's, tested); "(8 more attributes known after apply)" is a hand-written abbreviation. The real RDS attribute count is not modelled.
- [ ] `prevent_destroy` is flagged `wrong` when it appears in `modules/database/main.tf` regardless of the rest, as teaching feedback; it does not block the moved-block fix when combined with it. The simulator's apply of the untouched PR with `prevent_destroy` on the module resource destroys the old address (the old address has no config), as the real tool would.

- [x] (fix round 1) moved-block now needs: a comment-stripped `moved` block (any root .tf file, `from`/`to` in either order, addresses anchored) AND a plan with no destroy and no update on either address AND the database still in the cloud under id db-ORDERSPROD7Q2X AND no applied delete of either address AND no `state rm` of either address in the history. So destroying the database, orphaning it with `state rm`, a commented-out block and a wrong `to` are never credited. `state-mv` (wrong) fires from the history on `state mv` or `state rm` of the old address, and stays flagged even if the player then adds the moved block (the surgery happened, and the moved block is then a no-op, so `moved-block` is NOT credited: `not applied state-mv` of both addresses); removing the moved block after a clean apply flags nothing. `merge-with-snapshot` also fires on a delete of the module address (destroy after the move). Engine: `applied.op` gained `state-mv` and `state-rm` (history lines the CLI already wrote), schemas and AUTHORING updated. Deliberate limits: sticky once taken; an environment with its own state file is not simulated.
- [ ] Unverified from memory: `state mv` is the right tool across state files/backends and for emergency repair (used in the state-mv feedback and hints; the `state mv` docs show moving between state files with -state-out).

### terraform-state-in-git migration (TF7b task 9)

- [ ] Scripted (cannot be simulated): `git ls-files | grep tfstate` and `git log`. `git rm --cached`, history purging and clone cleanup are taught in the label/feedback/debrief but not enforced; the scripted `git ls-files` prints nothing once `remote-backend` is credited, although the credit does not see `git rm --cached`.
- [ ] `remote-backend` is world-detected: the backend `terraform init` recorded (s3 with bucket, key, `encrypt = true`, and `use_lockfile` or `dynamodb_table`), `plan_clean` (this is what proves the state was copied: `init -reconfigure` or answering no leaves an empty state and the plan wants to create everything), the database and password still in state, no applied delete of the database, a `.gitignore` line for `*.tfstate`/`terraform.tfstate`, and no `"result"` in `terraform.tfstate` or `terraform.tfstate.backup` (the backup the migration leaves must be removed). `init-migrate` was NOT added to the `applied.op` enum (history address would be a backend type, not a resource address; `plan_clean` is the proof). Bucket versioning, bucket policy and public access block are taught only, not enforceable.
- [ ] `rotate` needs `applied create random_password.db`, the database kept, and the real database's password different from the leaked one (so recreating the password after `init -reconfigure` + apply, which only makes a second state entry, is not credited). `manage_master_user_password` is taught only (the lab's `aws_db_instance` does not model it).
- [ ] `gitignore-only` and `make-private` are button-only wrong actions (no detection), so the ideal order (ignore before init) is never flagged.
- [ ] Unverified from memory: S3 native locking (`use_lockfile`) arrived in Terraform 1.10 (experimental) and is GA in 1.11; both terraform-state-in-git and terraform-state-lost now set `version: 1.11.0`; `terraform init` leaves `terraform.tfstate.backup` behind on first migration (simulator behaviour from the Task 2 notes); the invented fake password in the lab state; `db.t3.medium`/`16.3` lab values.
- [ ] Engine fix: `apply -replace=ADDR` kept re-planning the address as "requested" after the replacement, so dependents (the database password) were updated with an unknown value and kept the old one until a second apply. Replaced addresses are now spent for the rest of the run (`src/game/terraform/apply.ts`).
- [ ] Parked nit: `echo | terraform init` (empty answer) is treated as "no" rather than an error; real Terraform's wording is not verified.
- [ ] (fix round 1) `git ls-files | grep tfstate` keeps listing the tracked files (the lab cannot see `git rm --cached`); feedback says the lab cannot check git. `.gitignore` must now cover `terraform.tfstate` itself (`*.tfstate`, `*.tfstate*`, `terraform.tfstate`) and the backup (`*.tfstate.*`, `*.tfstate*`, `terraform.tfstate.backup`, `*.backup`), end-anchored. `manage_master_user_password` is worded as a real-account option the lab does not model. Known sim quirk (not changed): random_password has the constant id `none`, so a create_before_destroy replacement of it makes the deposed delete remove the new object from the cloud; real ids are random.
