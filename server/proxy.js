import http from 'node:http'
import { EC2Client, DescribeInstancesCommand, DescribeInstanceStatusCommand } from '@aws-sdk/client-ec2'
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks'
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds'
import { KafkaClient, ListClustersV2Command } from '@aws-sdk/client-kafka'
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand } from '@aws-sdk/client-elastic-load-balancing-v2'
import { EFSClient, DescribeFileSystemsCommand } from '@aws-sdk/client-efs'
import { fromIni, fromEnv } from '@aws-sdk/credential-providers'

export function createProxy({ profile, region, port = 9876 }) {
  const hasEnvCreds = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  const creds = hasEnvCreds
    ? fromEnv()
    : profile
      ? fromIni({ profile })
      : undefined

  const opts = { region, ...(creds && { credentials: creds }) }

  const ec2 = new EC2Client(opts)
  const eks = new EKSClient(opts)
  const rds = new RDSClient(opts)
  const kafka = new KafkaClient(opts)
  const elbv2 = new ElasticLoadBalancingV2Client(opts)
  const efs = new EFSClient(opts)

  async function fetchStatus() {
    const [instances, clusters, dbInstances, mskClusters, loadBalancers, fileSystems] = await Promise.all([
      ec2.send(new DescribeInstancesCommand({})).catch(e => ({ Reservations: [], _error: e.message })),
      eks.send(new ListClustersCommand({})).catch(e => ({ clusters: [], _error: e.message })),
      rds.send(new DescribeDBInstancesCommand({})).catch(e => ({ DBInstances: [], _error: e.message })),
      kafka.send(new ListClustersV2Command({})).catch(e => ({ ClusterInfoList: [], _error: e.message })),
      elbv2.send(new DescribeLoadBalancersCommand({})).catch(e => ({ LoadBalancers: [], _error: e.message })),
      efs.send(new DescribeFileSystemsCommand({})).catch(e => ({ FileSystems: [], _error: e.message })),
    ])

    // Normalize EC2
    const ec2Instances = (instances.Reservations || []).flatMap(r => r.Instances).map(i => ({
      id: i.InstanceId,
      name: (i.Tags || []).find(t => t.Key === 'Name')?.Value || i.InstanceId,
      state: i.State?.Name,
      type: i.InstanceType,
      az: i.Placement?.AvailabilityZone,
      ip: i.PrivateIpAddress,
      status: i.State?.Name === 'running' ? 'healthy' : i.State?.Name === 'stopped' ? 'down' : 'degraded',
    }))

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

    return { ec2: ec2Instances, eks: eksDetails, rds: rdsNormalized, msk: mskNormalized, elb: elbNormalized, efs: efsNormalized, ts: Date.now() }
  }

  // On-demand: get target instances for a specific ELB
  async function fetchElbTargets(lbArn) {
    const tgRes = await elbv2.send(new DescribeTargetGroupsCommand({ LoadBalancerArn: lbArn }))
    const targets = []
    for (const tg of (tgRes.TargetGroups || [])) {
      const health = await elbv2.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }))
      for (const t of (health.TargetHealthDescriptions || [])) {
        targets.push({
          instanceId: t.Target?.Id,
          port: t.Target?.Port,
          health: t.TargetHealth?.State, // healthy, unhealthy, draining, unused
          targetGroup: tg.TargetGroupName,
        })
      }
    }
    return targets
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || ''
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
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
        const targets = await fetchElbTargets(arn)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ targets }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    } else if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, profile: hasEnvCreds ? '(env vars)' : (profile || 'default'), region }))
    } else {
      res.writeHead(404)
      res.end('Not found')
    }
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  🏢 aws3d proxy running on http://127.0.0.1:${port}`)
    console.log(`     Profile: ${profile || '(default)'}`)
    console.log(`     Region:  ${region}`)
    console.log(`\n  Endpoints:`)
    console.log(`     GET /api/status       — full infrastructure status`)
    console.log(`     GET /api/elb/targets  — target instances for an ELB (on-demand)`)
    console.log(`     GET /api/health       — proxy health check\n`)
  })

  return server
}
