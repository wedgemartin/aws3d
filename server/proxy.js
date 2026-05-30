import http from 'node:http'
import { EC2Client, DescribeInstancesCommand, DescribeInstanceStatusCommand, DescribeVolumesCommand, DescribeSubnetsCommand, RebootInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2'
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks'
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds'
import { KafkaClient, ListClustersV2Command } from '@aws-sdk/client-kafka'
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand, DescribeListenersCommand, DescribeRulesCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import { EFSClient, DescribeFileSystemsCommand } from '@aws-sdk/client-efs'
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from '@aws-sdk/client-sts'
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail'
import { fromIni, fromEnv } from '@aws-sdk/credential-providers'

export function createProxy({ profile, region, port = 9876, roleArn }) {
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
        const baseOpts = { region, ...(baseCreds && { credentials: baseCreds }) }
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

  const creds = buildCredentialProvider()
  const opts = { region, ...(creds && { credentials: creds }) }

  const ec2 = new EC2Client(opts)
  const eks = new EKSClient(opts)
  const rds = new RDSClient(opts)
  const kafka = new KafkaClient(opts)
  const elbv2 = new ElasticLoadBalancingV2Client(opts)
  const efs = new EFSClient(opts)
  const sts = new STSClient(opts)
  const cloudtrail = new CloudTrailClient(opts)

  async function fetchStatus() {
    const [instances, instanceStatus, clusters, dbInstances, mskClusters, loadBalancers, fileSystems] = await Promise.all([
      ec2.send(new DescribeInstancesCommand({})).catch(e => ({ Reservations: [], _error: e.message })),
      ec2.send(new DescribeInstanceStatusCommand({ IncludeAllInstances: true })).catch(e => ({ InstanceStatuses: [], _error: e.message })),
      eks.send(new ListClustersCommand({})).catch(e => ({ clusters: [], _error: e.message })),
      rds.send(new DescribeDBInstancesCommand({})).catch(e => ({ DBInstances: [], _error: e.message })),
      kafka.send(new ListClustersV2Command({})).catch(e => ({ ClusterInfoList: [], _error: e.message })),
      elbv2.send(new DescribeLoadBalancersCommand({})).catch(e => ({ LoadBalancers: [], _error: e.message })),
      efs.send(new DescribeFileSystemsCommand({})).catch(e => ({ FileSystems: [], _error: e.message })),
    ])

    // Build status check map
    const statusMap = {}
    for (const s of (instanceStatus.InstanceStatuses || [])) {
      statusMap[s.InstanceId] = {
        system: s.SystemStatus?.Status,  // ok, impaired, initializing
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
      type: lb.Type, // application, network, gateway
      scheme: lb.Scheme, // internet-facing, internal
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

    return { ec2: ec2Instances, eks: eksDetails, rds: rdsNormalized, msk: mskNormalized, elb: elbNormalized, efs: efsNormalized, subnets: subnetMap, ts: Date.now() }
  }

  // On-demand: get target instances for a specific ELB
  async function fetchElbTargets(lbArn) {
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

  function readBody(req) {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', c => data += c)
      req.on('end', () => resolve(data))
    })
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || ''
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    const url = new URL(req.url, `http://localhost:${port}`)

    if (url.pathname === '/api/status') {
      try {
        const data = await fetchStatus()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/elb/targets') {
      const arn = url.searchParams.get('arn')
      if (!arn) { res.writeHead(400); res.end('Missing ?arn='); return }
      try {
        const data = await fetchElbTargets(arn)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/ec2/events') {
      const instanceId = url.searchParams.get('id')
      if (!instanceId) { res.writeHead(400); res.end('Missing ?id='); return }
      try {
        const resp = await cloudtrail.send(new LookupEventsCommand({
          LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: instanceId }],
          MaxResults: 5,
        }))
        const events = (resp.Events || []).map(e => ({
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
    } else if (url.pathname === '/api/health') {
      // Also verify credentials are still valid
      try {
        const identity = await sts.send(new GetCallerIdentityCommand({}))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, profile: hasEnvCreds ? '(env vars)' : (profile || 'default'), region, account: identity.Account, canRefresh: !!roleArn }))
      } catch (e) {
        const expired = e.name === 'ExpiredTokenException' || e.message?.includes('expired') || e.name === 'InvalidIdentityToken'
        // Auto-refresh if we have a role ARN
        if (expired && roleArn) {
          forceRefreshCreds()
          try {
            await sts.send(new GetCallerIdentityCommand({}))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, refreshed: true, profile: hasEnvCreds ? '(env vars)' : (profile || 'default'), region, canRefresh: true }))
            return
          } catch {}
        }
        res.writeHead(expired ? 401 : 200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: !expired, expired, error: expired ? 'Credentials expired' : null, profile: hasEnvCreds ? '(env vars)' : (profile || 'default'), region, canRefresh: !!roleArn }))
      }
    } else if (url.pathname === '/api/refresh' && req.method === 'POST') {
      if (!roleArn) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No --role-arn configured, cannot refresh' }))
        return
      }
      forceRefreshCreds()
      try {
        const identity = await sts.send(new GetCallerIdentityCommand({}))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, account: identity.Account }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/ec2/reboot' && req.method === 'POST') {
      const body = await readBody(req)
      const { instanceId } = JSON.parse(body)
      if (!instanceId) { res.writeHead(400); res.end('Missing instanceId'); return }
      try {
        await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, action: 'reboot', instanceId }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/ec2/stop' && req.method === 'POST') {
      const body = await readBody(req)
      const { instanceId } = JSON.parse(body)
      if (!instanceId) { res.writeHead(400); res.end('Missing instanceId'); return }
      try {
        await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, action: 'stop', instanceId }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  🏢 aws3d proxy running on http://127.0.0.1:${port}`)
    console.log(`     Profile: ${profile || '(default)'}`)
    console.log(`     Region:  ${region}`)
    if (roleArn) console.log(`     Role:    ${roleArn} (auto-refresh)`)
    console.log(`\n  Endpoints:`)
    console.log(`     GET /api/status       — full infrastructure status`)
    console.log(`     GET /api/elb/targets  — target instances for an ELB (on-demand)`)
    console.log(`     GET /api/health       — proxy health check\n`)
  })

  return server
}
