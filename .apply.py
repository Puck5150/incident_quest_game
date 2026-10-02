exec(open('/private/tmp/claude-501/-Users-keithbarnett-workspace-incident-quest-game/fc5e763e-0c3b-437a-a8c4-b9ae4c4c823c/scratchpad/cont.py').read())

append_cmds('content/databases/postgres-replica-read-after-write.yaml', '''
    - match: "\\\\! ./check-address-roundtrip.sh"
      when_actions: [read-your-writes]
      output: |
        19:12:04 POST /account/address "12 Mill Lane" -> 200 Saved!
        19:12:04 GET  /account -> address: "12 Mill Lane"   (read from primary)
    - match: "\\\\! ./check-address-roundtrip.sh"
      output: |
        19:12:04 POST /account/address "12 Mill Lane" -> 200 Saved!
        19:12:04 GET  /account -> address: "4 Old Road"   (read from replica_1)
''')

before_existing('content/databases/postgres-too-many-clients.yaml', '''    - match: "sudo -u postgres psql -c \\"SELECT application_name, count(*)''', '''    - match: "sudo -u postgres psql -c \\"SELECT application_name, count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1 ORDER BY 2 DESC\\""
      when_actions: [pooler]
      output: |
         application_name | count
        ------------------+-------
         pgbouncer        |    40
         psql             |     1
        (2 rows)
    - match: "sudo -u postgres psql -c \\"SELECT application_name, count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1 ORDER BY 2 DESC\\""
      when_actions: [smaller-pool]
      output: |
         application_name | count
        ------------------+-------
         shop-api         |    80
         psql             |     1
        (2 rows)
''')
append_cmds('content/databases/postgres-too-many-clients.yaml', '''
    - match: "kubectl logs deploy/shop-api --since=5m | grep -c 'too many clients'"
      when_actions: [pooler]
      output: |
        0
    - match: "kubectl logs deploy/shop-api --since=5m | grep -c 'too many clients'"
      when_actions: [smaller-pool]
      output: |
        0
    - match: "kubectl logs deploy/shop-api --since=5m | grep -c 'too many clients'"
      output: |
        1843
''')

before_existing('content/gcp/gcp-bigquery-full-scan.yaml', '''    - match: "bq show --format=prettyjson analytics.events"''', '''    - match: "bq show --format=prettyjson analytics.events"
      when_actions: [require-filter]
      output: |
        {
          "numBytes": "19901375283200",
          "timePartitioning": { "type": "DAY", "field": "event_ts" },
          "requirePartitionFilter": true
        }
''')

append_cmds('content/networking/expired-tls-certificate.yaml', '''
    - match: "openssl s_client -connect api.example.com:443 -servername api.example.com </dev/null 2>/dev/null | openssl x509 -noout -enddate"
      when_actions: [renew]
      output: |
        notAfter=Dec 30 23:14:07 2026 GMT
    - match: "openssl s_client -connect api.example.com:443 -servername api.example.com </dev/null 2>/dev/null | openssl x509 -noout -enddate"
      output: |
        notAfter=Oct  1 00:07:51 2026 GMT
''')
