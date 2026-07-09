import http from 'node:http'
import { EC2Client, DescribeInstancesCommand, DescribeInstanceStatusCommand, DescribeVolumesCommand, DescribeSubnetsCommand, DescribeSecurityGroupsCommand, DescribeNetworkAclsCommand, RebootInstancesCommand, StopInstancesCommand, StartInstancesCommand, DescribeVpcPeeringConnectionsCommand } from '@aws-sdk/client-ec2'
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks'
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand, DescribeGlobalClustersCommand } from '@aws-sdk/client-rds'
import { KafkaClient, ListClustersV2Command } from '@aws-sdk/client-kafka'
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand, DescribeListenersCommand, DescribeRulesCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import { EFSClient, DescribeFileSystemsCommand } from '@aws-sdk/client-efs'
import { OpenSearchClient, ListDomainNamesCommand, DescribeDomainsCommand } from '@aws-sdk/client-opensearch'
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from '@aws-sdk/client-sts'
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail'
import { fromIni, fromEnv } from '@aws-sdk/credential-providers'

export function createProxy({ profile, region, regions, port = 9876, roleArn, host, readOnly }) {
  // Backward compat: accept single region string or regions array
  if (!regions) {
    regions = Array.isArray(region) ? region : [region || 'us-east-1']
  } else if (typeof regions === 'string') {
    regions = [regions]
  }

  const hasEnvCreds = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY

  // If --role-arn is provided, we assume the role ourselves and auto-refresh
  let assumedCreds = null
  let assumedExpiry = 0

  function forceRefreshCreds() {
    assumedCreds = null
    assumedExpiry = 0
  }

  function buildCredentialProvider() {
    if (roleArn) {
      // Return a provider that auto-refreshes via AssumeRole
      return async () => {
        const now = Date.now()
        if (assumedCreds && now < assumedExpiry - 300000) return assumedCreds // 5min buffer
        // Use base creds (env vars or profile) to assume the role
        const baseCreds = hasEnvCreds ? fromEnv() : profile ? fromIni({ profile }) : undefined
        const baseOpts = { region: regions[0], ...(baseCreds && { credentials: baseCreds }) }
        const baseSts = new STSClient(baseOpts)
        const resp = await baseSts.send(new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: 'aws3d-proxy',
          DurationSeconds: 3600,
        }))
        assumedCreds = {
          accessKeyId: resp.Credentials.AccessKeyId,
          secretAccessKey: resp.Credentials.SecretAccessKey,
          sessionToken: resp.Credentials.SessionToken,
        }
        assumedExpiry = resp.Credentials.Expiration.getTime()
        const remaining = Math.round((assumedExpiry - Date.now()) / 60000)
        console.log(`  ↻ Assumed role, expires in ${remaining}min`)
        return assumedCreds
      }
    }
    if (hasEnvCreds) return fromEnv()
    if (profile) return fromIni({ profile })
    return undefined
  }

  // Create AWS clients PER REGION
  let clientsByRegion = {}

  function buildClientsForRegion(r, creds) {
    const opts = { region: r, ...(creds && { credentials: creds }) }
    return {
      ec2: new EC2Client(opts),
      eks: new EKSClient(opts),
      rds: new RDSClient(opts),
      kafka: new KafkaClient(opts),
      elbv2: new ElasticLoadBalancingV2Client(opts),
      efs: new EFSClient(opts),
      opensearch: new OpenSearchClient(opts),
      sts: new STSClient(opts),
      cloudtrail: new CloudTrailClient(opts),
    }
  }

  function rebuildClients() {
    const freshCreds = buildCredentialProvider()
    clientsByRegion = {}
    for (const r of regions) {
      clientsByRegion[r] = buildClientsForRegion(r, freshCreds)
    }
    eksClusterCache = {}
    console.log('  ↻ All clients rebuilt with fresh credentials')
  }

  // Initial client build
  const creds = buildCredentialProvider()
  for (const r of regions) {
    clientsByRegion[r] = buildClientsForRegion(r, creds)
  }

  // Helper to get clients for a specific region (defaults to first)
  function getClients(r) {
    return clientsByRegion[r] || clientsByRegion[regions[0]]
  }

  // fetchStatusForRegion: extracted logic that fetches all resources for one region
  async function fetchStatusForRegion(regionClients) {
    const { ec2, eks, rds, kafka, elbv2, efs, opensearch } = regionClients

    const [instances, instanceStatus, clusters, dbInstances, dbClusters, globalClusters, mskClusters, loadBalancers, fileSystems, osDomainNames] = await Promise.all([
      ec2.send(new DescribeInstancesCommand({})).catch(e => ({ Reservations: [], _error: e.message })),
      ec2.send(new DescribeInstanceStatusCommand({ IncludeAllInstances: true })).catch(e => ({ InstanceStatuses: [], _error: e.message })),
      eks.send(new ListClustersCommand({})).catch(e => ({ clusters: [], _error: e.message })),
      rds.send(new DescribeDBInstancesCommand({})).catch(e => ({ DBInstances: [], _error: e.message })),
      rds.send(new DescribeDBClustersCommand({})).catch(e => ({ DBClusters: [], _error: e.message })),
      rds.send(new DescribeGlobalClustersCommand({})).catch(e => ({ GlobalClusters: [], _error: e.message })),
      kafka.send(new ListClustersV2Command({})).catch(e => ({ ClusterInfoList: [], _error: e.message })),
      elbv2.send(new DescribeLoadBalancersCommand({})).catch(e => ({ LoadBalancers: [], _error: e.message })),
      efs.send(new DescribeFileSystemsCommand({})).catch(e => ({ FileSystems: [], _error: e.message })),
      opensearch.send(new ListDomainNamesCommand({})).catch(e => ({ DomainNames: [], _error: e.message })),
    ])

    // Build status check map
    const statusMap = {}
    for (const s of (instanceStatus.InstanceStatuses || [])) {
      statusMap[s.InstanceId] = {
        system: s.SystemStatus?.Status,
        instance: s.InstanceStatus?.Status,
      }
    }

    // Get all volume IDs and fetch sizes/types
    const allVolumeIds = (instances.Reservations || []).flatMap(r => r.Instances)
      .flatMap(i => (i.BlockDeviceMappings || []).map(b => b.Ebs?.VolumeId).filter(Boolean))
    const volumeMap = {}
    if (allVolumeIds.length > 0) {
      try {
        const volRes = await ec2.send(new DescribeVolumesCommand({ VolumeIds: allVolumeIds.slice(0, 200) }))
        for (const v of (volRes.Volumes || [])) {
          volumeMap[v.VolumeId] = { size: v.Size, type: v.VolumeType, iops: v.Iops }
        }
      } catch (e) { console.warn('DescribeVolumes failed:', e.message) }
    }

    // Normalize EC2
    const ec2Instances = (instances.Reservations || []).flatMap(r => r.Instances).map(i => {
      const checks = statusMap[i.InstanceId]
      const systemOk = checks?.system === 'ok' ? 1 : 0
      const instanceOk = checks?.instance === 'ok' ? 1 : 0
      const totalChecks = 2
      const passedChecks = systemOk + instanceOk

      return {
        id: i.InstanceId,
        name: (i.Tags || []).find(t => t.Key === 'Name')?.Value || i.InstanceId,
        state: i.State?.Name,
        type: i.InstanceType,
        az: i.Placement?.AvailabilityZone,
        ip: i.PrivateIpAddress,
        subnetId: i.SubnetId,
        vpcId: i.VpcId,
        securityGroups: (i.SecurityGroups || []).map(sg => sg.GroupId),
        launchTime: i.LaunchTime,
        checks: `${passedChecks}/${totalChecks}`,
        checksStatus: checks?.system === 'initializing' || checks?.instance === 'initializing' ? 'initializing' : null,
        volumes: (i.BlockDeviceMappings || []).map(b => ({
          device: b.DeviceName,
          volumeId: b.Ebs?.VolumeId,
          ...(volumeMap[b.Ebs?.VolumeId] || {}),
        })),
        rootDevice: i.RootDeviceType,
        status: i.State?.Name === 'running'
          ? (checks?.system === 'ok' && checks?.instance === 'ok' ? 'healthy' : 'degraded')
          : i.State?.Name === 'stopped' ? 'down' : 'degraded',
      }
    })

    // Normalize EKS
    const eksDetails = []
    for (const name of (clusters.clusters || [])) {
      try {
        const detail = await eks.send(new DescribeClusterCommand({ name }))
        eksDetails.push({
          id: detail.cluster.arn,
          name: detail.cluster.name,
          version: detail.cluster.version,
          status: detail.cluster.status === 'ACTIVE' ? 'healthy' : 'degraded',
          endpoint: detail.cluster.endpoint,
          ca: detail.cluster.certificateAuthority?.data,
        })
      } catch {}
    }

    // Normalize RDS
    const rdsNormalized = (dbInstances.DBInstances || []).map(db => ({
      id: db.DBInstanceIdentifier,
      name: db.DBInstanceIdentifier,
      engine: db.Engine,
      version: db.EngineVersion,
      az: db.AvailabilityZone,
      endpoint: db.Endpoint?.Address || null,
      secondaryAz: db.SecondaryAvailabilityZone || null,
      multiAz: db.MultiAZ || false,
      status: db.DBInstanceStatus === 'available' ? 'healthy' : db.DBInstanceStatus === 'stopped' ? 'down' : 'degraded',
    }))

    // Normalize MSK
    const mskNormalized = (mskClusters.ClusterInfoList || []).map(c => ({
      id: c.ClusterArn,
      name: c.ClusterName,
      state: c.State,
      status: c.State === 'ACTIVE' ? 'healthy' : 'degraded',
    }))

    // Normalize ELBs
    const elbNormalized = (loadBalancers.LoadBalancers || []).map(lb => ({
      id: lb.LoadBalancerArn,
      name: lb.LoadBalancerName,
      type: lb.Type,
      scheme: lb.Scheme,
      az: lb.AvailabilityZones?.[0]?.ZoneName || null,
      azs: (lb.AvailabilityZones || []).map(z => z.ZoneName),
      dnsName: lb.DNSName,
      status: lb.State?.Code === 'active' ? 'healthy' : 'degraded',
    }))

    // Normalize EFS
    const efsNormalized = (fileSystems.FileSystems || []).map(fs => ({
      id: fs.FileSystemId,
      name: fs.Name || fs.FileSystemId,
      sizeBytes: fs.SizeInBytes?.Value,
      status: fs.LifeCycleState === 'available' ? 'healthy' : 'degraded',
    }))

    // Fetch subnet details for all unique subnet IDs
    const subnetIds = [...new Set(ec2Instances.map(i => i.subnetId).filter(Boolean))]
    const subnetMap = {}
    if (subnetIds.length > 0) {
      try {
        const subRes = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: subnetIds }))
        for (const s of (subRes.Subnets || [])) {
          subnetMap[s.SubnetId] = {
            id: s.SubnetId,
            cidr: s.CidrBlock,
            az: s.AvailabilityZone,
            vpcId: s.VpcId,
            name: (s.Tags || []).find(t => t.Key === 'Name')?.Value || s.SubnetId,
          }
        }
      } catch (e) { console.warn('DescribeSubnets failed:', e.message) }
    }

    // Normalize OpenSearch
    const osDomains = (osDomainNames.DomainNames || []).map(d => d.DomainName).filter(Boolean)
    let opensearchNormalized = []
    if (osDomains.length > 0) {
      try {
        const desc = await opensearch.send(new DescribeDomainsCommand({ DomainNames: osDomains }))
        opensearchNormalized = (desc.DomainStatusList || []).map(d => ({
          id: d.ARN,
          name: d.DomainName,
          version: d.EngineVersion,
          instanceType: d.ClusterConfig?.InstanceType,
          instanceCount: d.ClusterConfig?.InstanceCount,
          endpoint: d.Endpoints?.vpc || d.Endpoint || null,
          status: d.Processing ? 'degraded' : 'healthy',
        }))
      } catch (e) { console.warn('DescribeDomains failed:', e.message) }
    }

    // Normalize Aurora clusters
    // Build global cluster membership map: globalClusterId -> { role per region }
    const globalClusterMap = {}
    for (const gc of (globalClusters.GlobalClusters || [])) {
      for (const member of (gc.GlobalClusterMembers || [])) {
        globalClusterMap[member.DBClusterArn] = {
          globalClusterId: gc.GlobalClusterIdentifier,
          isWriter: member.IsWriter,
        }
      }
    }

    const auroraNormalized = (dbClusters.DBClusters || []).map(c => {
      const globalInfo = globalClusterMap[c.DBClusterArn]
      return {
        id: c.DBClusterIdentifier,
        name: c.DBClusterIdentifier,
        engine: c.Engine,
        version: c.EngineVersion,
        az: c.AvailabilityZones?.[0] || null,
        endpoint: c.Endpoint,
        readerEndpoint: c.ReaderEndpoint,
        status: c.Status === 'available' ? 'healthy' : c.Status === 'stopped' ? 'down' : 'degraded',
        globalClusterId: globalInfo?.globalClusterId || null,
        isWriter: globalInfo?.isWriter ?? true,
        role: globalInfo ? (globalInfo.isWriter ? 'primary' : 'reader') : 'standalone',
      }
    })

    return { ec2: ec2Instances, eks: eksDetails, rds: rdsNormalized, msk: mskNormalized, elb: elbNormalized, efs: efsNormalized, opensearch: opensearchNormalized, aurora: auroraNormalized, subnets: subnetMap }
  }

  // Fetch status across all regions in parallel
  async function fetchStatus() {
    const entries = await Promise.all(
      regions.map(async (r) => {
        const data = await fetchStatusForRegion(clientsByRegion[r])
        return [r, data]
      })
    )
    const regionsData = Object.fromEntries(entries)
    return { regions: regionsData, ts: Date.now() }
  }

  // Fetch VPC peering connections across all regions
  async function fetchVpcPeering() {
    const allPeerings = []
    const results = await Promise.all(
      regions.map(async (r) => {
        try {
          const resp = await clientsByRegion[r].ec2.send(new DescribeVpcPeeringConnectionsCommand({}))
          return resp.VpcPeeringConnections || []
        } catch (e) {
          console.warn(`DescribeVpcPeeringConnections failed for ${r}:`, e.message)
          return []
        }
      })
    )
    // Deduplicate by peering ID (same peering appears in both regions)
    const seen = new Set()
    for (const connections of results) {
      for (const p of connections) {
        if (seen.has(p.VpcPeeringConnectionId)) continue
        seen.add(p.VpcPeeringConnectionId)
        allPeerings.push({
          id: p.VpcPeeringConnectionId,
          status: p.Status?.Code || 'unknown',
          requesterVpcId: p.RequesterVpcInfo?.VpcId,
          requesterRegion: p.RequesterVpcInfo?.Region,
          requesterCidr: p.RequesterVpcInfo?.CidrBlock,
          accepterVpcId: p.AccepterVpcInfo?.VpcId,
          accepterRegion: p.AccepterVpcInfo?.Region,
          accepterCidr: p.AccepterVpcInfo?.CidrBlock,
        })
      }
    }
    return { peerings: allPeerings }
  }

  // On-demand: get target instances for a specific ELB
  async function fetchElbTargets(lbArn, regionKey) {
    const { elbv2 } = getClients(regionKey)
    // Get listeners
    const listenerRes = await elbv2.send(new DescribeListenersCommand({ LoadBalancerArn: lbArn }))

    // Get all target groups for this LB and their health
    const tgRes = await elbv2.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lbArn }))
    const tgMap = {}
    for (const tg of (tgRes.TargetGroups || [])) {
      const health = await elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }))
      tgMap[tg.TargetGroupArn] = {
        name: tg.TargetGroupName,
        port: tg.Port,
        targets: (health.TargetHealthDescriptions || []).map(t => ({
          instanceId: t.Target?.Id,
          port: t.Target?.Port,
          health: t.TargetHealth?.State,
        })),
      }
    }

    // Build port groups from listeners + rules
    const portGroups = []
    for (const listener of (listenerRes.Listeners || [])) {
      const port = listener.Port
      const protocol = listener.Protocol
      const defaultAction = listener.DefaultActions?.[0]

      // Check if default action is a redirect (like HTTP→HTTPS)
      if (defaultAction?.Type === 'redirect') {
        portGroups.push({ listenerPort: port, protocol, path: '(redirect)', targetGroup: 'redirect', targetPort: null, targets: [] })
        continue
      }

      // Get rules for this listener
      const rulesRes = await elbv2.send(new DescribeRulesCommand({ ListenerArn: listener.ListenerArn })).catch(() => ({ Rules: [] }))
      const rules = (rulesRes.Rules || []).filter(r => !r.IsDefault)

      // Add each rule as a port group
      for (const rule of rules) {
        const tgArn = rule.Actions?.[0]?.TargetGroupArn
        const tg = tgMap[tgArn]
        const pathCondition = rule.Conditions?.find(c => c.Field === 'path-pattern')
        const hostCondition = rule.Conditions?.find(c => c.Field === 'host-header')
        const path = pathCondition?.Values?.[0] || hostCondition?.Values?.[0] || ''
        if (tg) {
          portGroups.push({ listenerPort: port, protocol, path, targetGroup: tg.name, targetPort: tg.port, targets: tg.targets })
        }
      }

      // Add default action as fallback
      const defaultTg = tgMap[defaultAction?.TargetGroupArn]
      if (defaultTg) {
        portGroups.push({ listenerPort: port, protocol, path: '(default)', targetGroup: defaultTg.name, targetPort: defaultTg.port, targets: defaultTg.targets })
      }
    }

    const allTargets = Object.values(tgMap).flatMap(tg => tg.targets.map(t => ({ ...t, targetGroup: tg.name })))
    return { portGroups, targets: allTargets }
  }

  // EKS Kubernetes API helpers
  let eksClusterCache = {} // name → { endpoint, ca }

  async function getEksToken(clusterName, regionKey) {
    const r = regionKey || regions[0]
    console.log(`    → Generating EKS token for: ${clusterName} (region: ${r})`)
    const creds = await (buildCredentialProvider()?.() || Promise.resolve(null))
    if (!creds) throw new Error('No credentials available for EKS token')

    const { SignatureV4 } = await import('@smithy/signature-v4')
    const { Sha256 } = await import('@aws-crypto/sha256-js')
    const { HttpRequest } = await import('@smithy/protocol-http')

    const stsHost = `sts.${r}.amazonaws.com`

    const request = new HttpRequest({
      method: 'GET',
      protocol: 'https:',
      hostname: stsHost,
      path: '/',
      query: {
        'Action': 'GetCallerIdentity',
        'Version': '2011-06-15',
      },
      headers: {
        'host': stsHost,
        'x-k8s-aws-id': clusterName,
      },
    })

    const signer = new SignatureV4({
      credentials: creds,
      region: r,
      service: 'sts',
      sha256: Sha256,
    })

    const signed = await signer.presign(request, { expiresIn: 60 })

    const qs = Object.entries(signed.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    const url = `https://${signed.hostname}${signed.path}?${qs}`

    const token = 'k8s-aws-v1.' + Buffer.from(url).toString('base64url').replace(/=+$/, '')
    console.log(`    ✓ Token generated (${token.length} chars)`)
    console.log(`    DEBUG URL: ${url.substring(0, 200)}...`)
    return token
  }

  async function k8sGet(clusterName, path, regionKey) {
    const r = regionKey || regions[0]
    console.log(`    → K8s GET: ${path}`)
    if (!eksClusterCache[clusterName]) {
      const { eks } = getClients(r)
      const detail = await eks.send(new DescribeClusterCommand({ name: clusterName }))
      eksClusterCache[clusterName] = { endpoint: detail.cluster.endpoint, ca: detail.cluster.certificateAuthority?.data, region: r }
    }
    const { endpoint, ca } = eksClusterCache[clusterName]
    const token = await getEksToken(clusterName, r)

    const https = await import('node:https')
    return new Promise((resolve, reject) => {
      const url = new URL(path, endpoint)
      const opts = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        ca: ca ? Buffer.from(ca, 'base64') : undefined,
      }
      const req = https.request(opts, (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ error: data }) }
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  async function k8sDelete(clusterName, path, regionKey) {
    const r = regionKey || regions[0]
    console.log(`    → K8s DELETE: ${path}`)
    if (!eksClusterCache[clusterName]) {
      const { eks } = getClients(r)
      const detail = await eks.send(new DescribeClusterCommand({ name: clusterName }))
      eksClusterCache[clusterName] = { endpoint: detail.cluster.endpoint, ca: detail.cluster.certificateAuthority?.data, region: r }
    }
    const { endpoint, ca } = eksClusterCache[clusterName]
    const token = await getEksToken(clusterName, r)

    const https = await import('node:https')
    return new Promise((resolve, reject) => {
      const url = new URL(path, endpoint)
      const opts = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        ca: ca ? Buffer.from(ca, 'base64') : undefined,
      }
      const req = https.request(opts, (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ error: data }) }
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', c => data += c)
      req.on('end', () => resolve(data))
    })
  }

  const bindHost = host || '127.0.0.1'

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || ''
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url, `http://localhost:${port}`)
    // Helper: resolve region from query param or default to first
    const resolveRegion = () => url.searchParams.get('region') || regions[0]

    if (url.pathname === '/api/status') {
      try {
        const data = await fetchStatus()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/vpc-peering') {
      try {
        const data = await fetchVpcPeering()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/elb/targets') {
      const arn = url.searchParams.get('arn')
      if (!arn) { res.writeHead(400); res.end('Missing ?arn='); return }
      const regionKey = resolveRegion()
      try {
        const data = await fetchElbTargets(arn, regionKey)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/ec2/events') {
      const instanceId = url.searchParams.get('id')
      if (!instanceId) { res.writeHead(400); res.end('Missing ?id='); return }
      const regionKey = resolveRegion()
      const { cloudtrail } = getClients(regionKey)
      try {
        const resp = await cloudtrail.send(new LookupEventsCommand({
          LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: instanceId }],
          MaxResults: 50,
        }))
        const ec2Events = ['RunInstances', 'StartInstances', 'StopInstances', 'RebootInstances', 'TerminateInstances', 'ModifyInstanceAttribute', 'AttachVolume', 'DetachVolume', 'CreateTags', 'AssociateAddress']
        const events = (resp.Events || [])
          .filter(e => ec2Events.includes(e.EventName))
          .slice(0, 5)
          .map(e => ({
            time: e.EventTime,
            name: e.EventName,
            user: e.Username,
          }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ events }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/ec2/sg') {
      const sgIds = url.searchParams.get('ids')?.split(',')
      if (!sgIds?.length) { res.writeHead(400); res.end('Missing ?ids=sg-xxx,sg-yyy'); return }
      const regionKey = resolveRegion()
      const { ec2 } = getClients(regionKey)
      try {
        const resp = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: sgIds }))
        const groups = (resp.SecurityGroups || []).map(sg => ({
          id: sg.GroupId,
          name: sg.GroupName,
          description: sg.Description,
          inbound: (sg.IpPermissions || []).map(r => ({
            protocol: r.IpProtocol === '-1' ? 'all' : r.IpProtocol,
            fromPort: r.FromPort,
            toPort: r.ToPort,
            sources: [
              ...(r.IpRanges || []).map(ip => ip.CidrIp),
              ...(r.UserIdGroupPairs || []).map(g => g.GroupId),
            ],
          })),
        }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ groups }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/ec2/nacl') {
      const subnetId = url.searchParams.get('subnet')
      if (!subnetId) { res.writeHead(400); res.end('Missing ?subnet='); return }
      const regionKey = resolveRegion()
      const { ec2 } = getClients(regionKey)
      try {
        const resp = await ec2.send(new DescribeNetworkAclsCommand({
          Filters: [{ Name: 'association.subnet-id', Values: [subnetId] }],
        }))
        const nacls = (resp.NetworkAcls || []).map(nacl => ({
          id: nacl.NetworkAclId,
          inbound: (nacl.Entries || []).filter(e => !e.Egress).map(e => ({
            rule: e.RuleNumber,
            protocol: e.Protocol === '-1' ? 'all' : e.Protocol,
            action: e.RuleAction,
            cidr: e.CidrBlock,
            fromPort: e.PortRange?.From,
            toPort: e.PortRange?.To,
          })),
        }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ nacls }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/eks/namespaces') {
      const cluster = url.searchParams.get('cluster')
      if (!cluster) { res.writeHead(400); res.end('Missing ?cluster='); return }
      const regionKey = resolveRegion()
      console.log(`  → EKS namespaces for cluster: ${cluster} (region: ${regionKey})`)
      try {
        const data = await k8sGet(cluster, '/api/v1/namespaces', regionKey)
        if (data.error || data.kind === 'Status') {
          console.log(`  ✗ K8s API error:`, JSON.stringify(data).slice(0, 200))
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: data.message || data.error || 'K8s API error' }))
          return
        }
        const systemNs = ['kube-system', 'kube-public', 'kube-node-lease', 'default']
        const namespaces = (data.items || [])
          .filter(ns => !systemNs.includes(ns.metadata.name))
          .map(ns => ({ name: ns.metadata.name, status: ns.status?.phase }))
        console.log(`  ✓ Found ${namespaces.length} namespaces`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ namespaces }))
      } catch (e) {
        console.log(`  ✗ EKS namespaces error: ${e.message}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/eks/pods') {
      const cluster = url.searchParams.get('cluster')
      const namespace = url.searchParams.get('namespace')
      if (!cluster) { res.writeHead(400); res.end('Missing ?cluster='); return }
      const regionKey = resolveRegion()
      console.log(`  → EKS pods for cluster: ${cluster}, namespace: ${namespace || 'all'} (region: ${regionKey})`)
      try {
        const path = namespace ? `/api/v1/namespaces/${namespace}/pods` : '/api/v1/pods'
        const data = await k8sGet(cluster, path, regionKey)
        if (data.error || data.kind === 'Status') {
          console.log(`  ✗ K8s API error:`, JSON.stringify(data).slice(0, 200))
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: data.message || data.error || 'K8s API error' }))
          return
        }
        const pods = (data.items || []).map(pod => ({
          name: pod.metadata.name,
          namespace: pod.metadata.namespace,
          node: pod.spec.nodeName,
          status: pod.status?.phase,
          containers: (pod.spec.containers || []).map(c => c.name),
          ready: (pod.status?.containerStatuses || []).filter(c => c.ready).length,
          total: (pod.spec.containers || []).length,
          startTime: pod.status?.startTime,
          restarts: (pod.status?.containerStatuses || []).reduce((sum, c) => sum + (c.restartCount || 0), 0),
        }))
        console.log(`  ✓ Found ${pods.length} pods`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ pods }))
      } catch (e) {
        console.log(`  ✗ EKS pods error: ${e.message}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/eks/nodes') {
      const cluster = url.searchParams.get('cluster')
      if (!cluster) { res.writeHead(400); res.end('Missing ?cluster='); return }
      const regionKey = resolveRegion()
      console.log(`  → EKS nodes for cluster: ${cluster} (region: ${regionKey})`)
      try {
        const nodesData = await k8sGet(cluster, '/api/v1/nodes', regionKey)
        let metricsData = await k8sGet(cluster, '/apis/metrics.k8s.io/v1beta1/nodes', regionKey).catch(() => null)
        const metricsMap = {}
        if (metricsData?.items?.length) {
          for (const m of metricsData.items) {
            metricsMap[m.metadata.name] = { cpuUsage: m.usage?.cpu, memUsage: m.usage?.memory }
          }
        } else {
          // Fallback: sum pod resource requests per node
          console.log(`    ⚠ Metrics API unavailable, computing from pod requests`)
          const podsData = await k8sGet(cluster, '/api/v1/pods?fieldSelector=status.phase=Running', regionKey).catch(() => ({ items: [] }))
          for (const pod of (podsData.items || [])) {
            const nodeName = pod.spec.nodeName
            if (!nodeName) continue
            if (!metricsMap[nodeName]) metricsMap[nodeName] = { cpuUsage: 0, memUsage: 0 }
            for (const c of (pod.spec.containers || [])) {
              const req = c.resources?.requests || {}
              const cpu = req.cpu || '0'
              const mem = req.memory || '0'
              if (cpu.endsWith('m')) metricsMap[nodeName].cpuUsage += parseInt(cpu)
              else if (cpu.endsWith('n')) metricsMap[nodeName].cpuUsage += parseInt(cpu) / 1000000
              else metricsMap[nodeName].cpuUsage += parseFloat(cpu) * 1000
              if (mem.endsWith('Ki')) metricsMap[nodeName].memUsage += parseInt(mem) * 1024
              else if (mem.endsWith('Mi')) metricsMap[nodeName].memUsage += parseInt(mem) * 1024 * 1024
              else if (mem.endsWith('Gi')) metricsMap[nodeName].memUsage += parseInt(mem) * 1024 * 1024 * 1024
              else metricsMap[nodeName].memUsage += parseInt(mem) || 0
            }
          }
          for (const [name, val] of Object.entries(metricsMap)) {
            metricsMap[name] = { cpuUsage: `${Math.round(val.cpuUsage)}m`, memUsage: `${Math.round(val.memUsage / 1024)}Ki` }
          }
        }
        const nodes = (nodesData.items || []).map(n => ({
          name: n.metadata.name,
          instanceId: n.spec.providerID?.split('/').pop() || null,
          cpuAllocatable: n.status.allocatable?.cpu,
          memAllocatable: n.status.allocatable?.memory,
          cpuUsage: metricsMap[n.metadata.name]?.cpuUsage || null,
          memUsage: metricsMap[n.metadata.name]?.memUsage || null,
        }))
        console.log(`  ✓ Found ${nodes.length} nodes`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ nodes }))
      } catch (e) {
        console.log(`  ✗ EKS nodes error: ${e.message}`)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/health') {
      // Also verify credentials are still valid
      const { sts } = getClients(regions[0])
      try {
        const identity = await sts.send(new GetCallerIdentityCommand({}))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, regions, profile: hasEnvCreds ? '(env vars)' : (profile || 'default'), account: identity.Account, canRefresh: !!roleArn, readOnly: !!readOnly }))
      } catch (e) {
        const expired = e.name === 'ExpiredTokenException' || e.message?.includes('expired') || e.name === 'InvalidIdentityToken'
        if (expired && roleArn) {
          forceRefreshCreds()
          rebuildClients()
          try {
            const { sts: freshSts } = getClients(regions[0])
            const identity = await freshSts.send(new GetCallerIdentityCommand({}))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, refreshed: true, regions, profile: hasEnvCreds ? '(env vars)' : (profile || 'default'), account: identity.Account, canRefresh: true, readOnly: !!readOnly }))
            return
          } catch {}
        }
        res.writeHead(expired ? 401 : 200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: !expired, expired, error: expired ? 'Credentials expired — restart proxy with fresh credentials' : null, regions, profile: hasEnvCreds ? '(env vars)' : (profile || 'default'), canRefresh: !!roleArn, readOnly: !!readOnly }))
      }
    } else if (url.pathname === '/api/refresh' && req.method === 'POST') {
      const body = await readBody(req)
      let newCreds = null
      try { newCreds = body ? JSON.parse(body) : null } catch {}

      if (newCreds?.accessKeyId && newCreds?.secretAccessKey) {
        process.env.AWS_ACCESS_KEY_ID = newCreds.accessKeyId
        process.env.AWS_SECRET_ACCESS_KEY = newCreds.secretAccessKey
        if (newCreds.sessionToken) process.env.AWS_SESSION_TOKEN = newCreds.sessionToken
        else delete process.env.AWS_SESSION_TOKEN
        console.log('  ↻ New credentials injected via API')
      }

      forceRefreshCreds()
      rebuildClients()
      try {
        const { sts } = getClients(regions[0])
        const identity = await sts.send(new GetCallerIdentityCommand({}))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, account: identity.Account }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/ec2/reboot' && req.method === 'POST') {
      if (readOnly) { res.writeHead(403); res.end(JSON.stringify({ error: 'Read-only mode' })); return }
      const body = await readBody(req)
      const { instanceId, region: actionRegion } = JSON.parse(body)
      if (!instanceId) { res.writeHead(400); res.end('Missing instanceId'); return }
      const { ec2 } = getClients(actionRegion || regions[0])
      try {
        await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, action: 'reboot', instanceId }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/ec2/stop' && req.method === 'POST') {
      if (readOnly) { res.writeHead(403); res.end(JSON.stringify({ error: 'Read-only mode' })); return }
      const body = await readBody(req)
      const { instanceId, region: actionRegion } = JSON.parse(body)
      if (!instanceId) { res.writeHead(400); res.end('Missing instanceId'); return }
      const { ec2 } = getClients(actionRegion || regions[0])
      try {
        await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, action: 'stop', instanceId }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/ec2/start' && req.method === 'POST') {
      if (readOnly) { res.writeHead(403); res.end(JSON.stringify({ error: 'Read-only mode' })); return }
      const body = await readBody(req)
      const { instanceId, region: actionRegion } = JSON.parse(body)
      if (!instanceId) { res.writeHead(400); res.end('Missing instanceId'); return }
      const { ec2 } = getClients(actionRegion || regions[0])
      try {
        await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, action: 'start', instanceId }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/eks/pod/delete' && req.method === 'POST') {
      if (readOnly) { res.writeHead(403); res.end(JSON.stringify({ error: 'Read-only mode' })); return }
      const body = await readBody(req)
      const { cluster, namespace, pod, region: actionRegion } = JSON.parse(body)
      if (!cluster || !namespace || !pod) { res.writeHead(400); res.end('Missing cluster, namespace, or pod'); return }
      const regionKey = actionRegion || regions[0]
      console.log(`  → Deleting pod ${namespace}/${pod} in cluster ${cluster} (region: ${regionKey})`)
      try {
        await k8sDelete(cluster, `/api/v1/namespaces/${namespace}/pods/${pod}`, regionKey)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, action: 'delete', pod }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  // Proactive credential refresh — re-assume 5 min before expiry
  if (roleArn) {
    setInterval(async () => {
      const now = Date.now()
      if (assumedExpiry > 0 && now > assumedExpiry - 300000) {
        console.log('  ↻ Proactively refreshing credentials...')
        forceRefreshCreds()
        try {
          const { sts } = getClients(regions[0])
          await sts.send(new GetCallerIdentityCommand({}))
        } catch (e) {
          console.warn('  ⚠ Credential refresh failed:', e.message)
        }
      }
    }, 60000) // check every minute
  }

  server.listen(port, bindHost, () => {
    console.log(`\n  🏢 aws3d proxy running on http://${bindHost}:${port}`)
    console.log(`     Profile: ${profile || '(default)'}`)
    console.log(`     Regions: ${regions.join(', ')}`)
    if (roleArn) console.log(`     Role:    ${roleArn} (auto-refresh)`)
    if (readOnly) console.log(`     Mode:    READ-ONLY`)
    console.log(`\n  Endpoints:`)
    console.log(`     GET /api/status        — full infrastructure status (all regions)`)
    console.log(`     GET /api/vpc-peering   — VPC peering connections (all regions)`)
    console.log(`     GET /api/elb/targets   — target instances for an ELB (?region=)`)
    console.log(`     GET /api/health        — proxy health check\n`)
  })

  return server
}
