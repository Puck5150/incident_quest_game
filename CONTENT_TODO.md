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
- [ ] `create_before_destroy` is only recorded on the plan item (for the renderer); ordering and propagation belong to TF3.

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
- [ ] Replacements are always destroy-then-create; `create_before_destroy` ordering (two objects at one address, "deposed" objects) is not modeled.
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
- [ ] content/iac/terraform-import-existing.yaml (scripted, migrates in TF7) still says BucketAlreadyOwnedByYou for a us-east-1 bucket (CI log line, hypothesis feedback, evidence label, debrief, source). Correct it to `creating S3 Bucket (NAME): BucketAlreadyExists` when migrating.

## terraform incidents batch 2 (TF5)

TF5 batch status: four failed-apply incidents on the simulator, each with a playthrough test (tests/terraform-<id>.test.ts) and a UI test (tests/terraform-batch2-ui.test.tsx: ideal path and trap through IncidentScreen, typed and button actions, remount replay, the force-unlock dialog).
- terraform-partial-apply-iam: no rollback; read `with ADDR,` and the AccessDenied caller/action; fix the permission (as the right identity) and apply again, never destroy to start clean.
- terraform-vcpu-limit: a cloud-side quota stops one resource; two real fixes (right-size in code, or a Service Quotas increase), and the re-run only creates what's missing.
- terraform-cancelled-ci-lock: a cancelled CI run leaves the lock held; prove the holder is dead, force-unlock, read the plan, finish the apply; never -lock=false.
- terraform-sg-cycle: `Error: Cycle` from two groups referencing each other; break one edge in code (CIDR or a separate rule), apply in place, never recreate the groups or open the port to the internet.

Open simulator defects found in TF5 (not fixed):
- [ ] Address-keyed faults can be bypassed by renaming: a fault's `at` is an address, so renaming the resource in the `.tf` (or `state mv` plus a rename) makes a new address the fault doesn't cover, and the create succeeds. In terraform-partial-apply-iam a renamed db would still be denied in reality. Simulator limit; a fault keyed on the type/natural id (or on the provider call) would close it.
- [ ] Profiles: the lab's `aws` answers only from scripted lines, so a profile works per command (`--profile NAME`, or an exact scripted `AWS_PROFILE=NAME aws ...` line the engine answers first); `export AWS_PROFILE=...` and an env prefix inside a pipeline run in the shell and get the default profile's output, and ~/.bashrc is never sourced. Later improvement: have `IncidentShell.program` honour `ctx.env.AWS_PROFILE` when choosing scripted output.
- [ ] Apply concurrency: creates run one at a time, so an independent resource that fails (the db instance, which has no reference to the network) prints `Creating...` first and its error only at the end, after the others complete. Real Terraform runs independent creates in parallel (default `-parallelism=10`); the interleaving would differ but the outcome (network created, db denied, error box at the end) is the same.
- [ ] Scripted commands always exit 0: the scripted `aws iam put-role-policy` AccessDenied (no `--profile`) prints the error but real AWS CLI v2 exits non-zero (254 for a service error).
- [ ] Instance `private_ip` comes from 10.0.x.x regardless of the subnet's CIDR (terraform-vcpu-limit: 10.70.1.0/24); it shows in the destroy plan.
- [ ] Nested-block attributes the provider fills (ipv6_cidr_blocks = [], prefix_list_ids = [], security_groups = [], self = false in each rule, cidr_blocks = [] where unset) aren't modeled, so the state's rules hold only what the configuration sets, and `state show`/the plan diff print shorter rule objects than real Terraform does (terraform-sg-cycle).
- [ ] The built-in SG DependencyViolation text (src/game/terraform/provider.ts `dependencyViolation`) lacks the SDK v2 `operation error EC2: DeleteSecurityGroup, https response error ...` wrapper; terraform-sg-cycle's faults supply the full shape.
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
- [ ] The fix's file checks are line-anchored (`^[ \t]*...`), so commented-out lines (`#`, `//`) never count: one live `security_groups = [aws_security_group.web|app.id]` line; an `ingress { ... }` block for 8080 and one for 8443, each with a live non-empty `cidr_blocks` or `security_groups` line (so `self = true` or a rule deleted down to a comment isn't credited); and no 8080/8443 block with a live `cidr_blocks` containing "0.0.0.0/0" or `ipv6_cidr_blocks` containing "::/0". The block regexes use `[^{}]*`, so a brace inside a comment in the block, a `/* */` comment, or a port given by a variable defeats them. A broader private CIDR (the whole VPC) is accepted.
- [ ] `open-callbacks-to-internet` (destructive, world-detected): the same "open" regex as the fix's negative clause AND plan_clean, i.e. the open rule is what's applied. Closing it afterwards can still earn the fix; the session has already recorded the destructive mistake.
- [ ] Not simulated: `terraform graph` (mentioned in the debrief), `aws_security_group_rule`/`aws_vpc_security_group_ingress_rule` (the idiomatic fix, in real_world only), `gh pr checks`, describe-security-groups by vpc-id (would list the VPC's default group too).
- [ ] describe-security-groups output: field names from the AWS CLI reference example; the field order (GroupId, IpPermissionsEgress, VpcId, SecurityGroupArn, OwnerId, GroupName, Description, IpPermissions, Tags) is from experience with recent CLI v2 output, not docs. `gh pr diff` prints the same unified diff as `git diff main` (gh manual: shows the PR's changes; exact header lines not checked).
- [ ] Invented: ids, RequestIDs, PR #318, commit hashes, branch callbacks-8443, the people, the 8443 callback story.

## terraform follow-ups (TF7)

- [ ] Simulator defect (found in TF5 terraform-sg-cycle): `create_before_destroy` is ignored by apply ordering (src/game/terraform/apply.ts): a `+/-` replacement still deletes first. In terraform-sg-cycle a renamed group with create_before_destroy fails on the old group's DependencyViolation before creating the new one; real Terraform would create the new group, then fail deleting the old one and keep it as deposed.
- [ ] Lock bypass history for state-writing CLI commands: `state rm`, `state mv`, `taint`, `untaint`, `import`, `workspace new`/`delete` run with `-lock=false` past a held lock record nothing (only apply/destroy steps get ` (lock bypassed)`). Record a marker for them too, and add an "any bypass" predicate leaf (e.g. `lock_bypassed: true` on its own) so a trap needn't list addresses.
- [ ] Retire content/iac/terraform-state-lock.yaml (scripted, S3 use_lockfile): terraform-cancelled-ci-lock supersedes it on the simulator. (It also uses the evidence tag `partial-apply`, as terraform-partial-apply-iam does; tags are per incident, so no clash.)
- [ ] Apply ordering is sequential and ignores `-parallelism` (see the TF5 defect list); revisit with create_before_destroy.
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
