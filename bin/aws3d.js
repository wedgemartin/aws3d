#!/usr/bin/env node
import { createProxy } from '../server/proxy.js'

const args = process.argv.slice(2)

function flag(name, fallback) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

const command = args.find(a => !a.startsWith('-'))

if (command === 'serve') {
  const profile = flag('--profile', process.env.AWS_PROFILE || undefined)
  const regionFlag = flag('--region', process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1')
  const regions = regionFlag.split(',').map(r => r.trim())
  const port = parseInt(flag('--port', '9876'), 10)
  const roleArn = flag('--role-arn', undefined)
  const host = flag('--host', '127.0.0.1')
  const readOnly = args.includes('--read-only')

  createProxy({ profile, regions, port, roleArn, host, readOnly })
} else {
  console.log(`
  aws3d — 3D AWS infrastructure visualizer

  Usage:
    aws3d serve [options]

  Options:
    --profile <name>      AWS profile (default: AWS_PROFILE env or 'default')
    --region <regions>    AWS region(s), comma-separated (default: us-east-1)
    --port <port>         Proxy port (default: 9876)
    --role-arn <arn>      Assume this IAM role (auto-refreshes before expiry)
    --host <addr>         Bind address (default: 127.0.0.1, use 0.0.0.0 for LAN)
    --read-only           Disable mutating actions (reboot, stop, start, kill pod)

  Examples:
    aws3d serve --profile production --region us-west-2
    aws3d serve --region us-east-1,us-west-2
    aws3d serve --role-arn arn:aws:iam::123456789:role/MyRole --region us-east-1
    aws3d serve --host 0.0.0.0 --read-only --region us-gov-west-1
  `)
}
