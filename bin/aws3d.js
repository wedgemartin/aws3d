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
  const region = flag('--region', process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1')
  const port = parseInt(flag('--port', '9876'), 10)

  createProxy({ profile, region, port })
} else {
  console.log(`
  aws3d — 3D AWS infrastructure visualizer

  Usage:
    aws3d serve [options]

  Options:
    --profile <name>   AWS profile (default: AWS_PROFILE env or 'default')
    --region <region>  AWS region (default: AWS_REGION env or 'us-east-1')
    --port <port>      Proxy port (default: 9876)

  Examples:
    aws3d serve --profile production --region us-west-2
    aws3d serve --profile my-profile
  `)
}
