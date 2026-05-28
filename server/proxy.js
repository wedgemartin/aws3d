import http from 'node:http'
import { EC2Client, DescribeInstancesCommand, DescribeInstanceStatusCommand } from '@aws-sdk/client-ec2'
import { EKSClient, ListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks'
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds'
import { KafkaClient, ListClustersV2Command } from '@aws-sdk/client-kafka'
import { fromIni, fromEnv } from '@aws-sdk/credential-providers'

export function createProxy({ profile, region, port = 9876 }) {
  // Use env vars if available (from assume-role aliases), otherwise try profile
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

  async function fetchStatus() {
    const [instances, instanceStatus, clusters, dbInstances, mskClusters] = await Promise.all([
      ec2.send(new DescribeInstancesCommand({})).catch(e => ({ Reservations: [], _error: e.message })),
      ec2.send(new DescribeInstanceStatusCommand({ IncludeAllInstances: true })).catch(e => ({ InstanceStatuses: [], _error: e.message })),
      eks.send(new ListClustersCommand({})).catch(e => ({ clusters: [], _error: e.message })),
      rds.send(new DescribeDBInstancesCommand({})).catch(e => ({ DBInstances: [], _error: e.message })),
      kafka.send(new ListClustersV2Command({})).catch(e => ({ ClusterInfoList: [], _error: e.message })),
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

    return { ec2: ec2Instances, eks: eksDetails, rds: rdsNormalized, msk: mskNormalized, ts: Date.now() }
  }

  const server = http.createServer(async (req, res) => {
    // CORS — localhost only
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
    console.log(`     GET /api/status  — full infrastructure status`)
    console.log(`     GET /api/health  — proxy health check\n`)
  })

  return server
}
