// Sample infrastructure data — fictional "Acme Corp" environment.
// When the local proxy is running, this is replaced with live AWS data.

export const region = {
  name: 'us-west-2',
  label: 'Acme Corp Production',
  azs: ['us-west-2a', 'us-west-2b'],
}

export const Status = { HEALTHY: 'healthy', DEGRADED: 'degraded', DOWN: 'down', UNKNOWN: 'unknown' }

export const azs = [
  { id: 'az-a', name: 'us-west-2a', label: 'AZ-A', privateSubnet: '10.0.1.0/24', publicSubnet: '10.0.101.0/24' },
  { id: 'az-b', name: 'us-west-2b', label: 'AZ-B', privateSubnet: '10.0.2.0/24', publicSubnet: '10.0.102.0/24' },
]

export const eksCluster = {
  id: 'eks-main',
  name: 'acme-prod-eks',
  version: '1.31',
  nodeType: 'm6i.xlarge',
  desiredNodes: 3,
  azs: ['az-a', 'az-b'],
  status: Status.HEALTHY,
}

export const mskCluster = {
  id: 'msk-main',
  name: 'acme-prod-msk',
  brokerCount: 2,
  instanceType: 'kafka.m5.large',
  azs: ['az-a', 'az-b'],
  port: 9092,
  status: Status.HEALTHY,
}

export const rdsInstances = [
  { id: 'rds-app', name: 'app-db', engine: 'postgres', version: '15', az: 'az-a', status: Status.HEALTHY },
  { id: 'rds-auth', name: 'auth-db', engine: 'postgres', version: '15', az: 'az-a', status: Status.HEALTHY },
  { id: 'rds-analytics', name: 'analytics-db', engine: 'mysql', version: '8.0', az: 'az-b', status: Status.HEALTHY },
  { id: 'rds-cache-meta', name: 'cache-meta', engine: 'postgres', version: '15', az: 'az-b', status: Status.HEALTHY },
]

export const ec2Servers = [
  // Infrastructure
  { id: 'vpn-01', name: 'vpn-01', role: 'vpn', ip: '10.0.101.10', az: 'az-a', subnet: 'public', status: Status.HEALTHY },
  { id: 'bastion-01', name: 'bastion-01', role: 'vpn', ip: '10.0.101.20', az: 'az-b', subnet: 'public', status: Status.HEALTHY },
  // API tier
  { id: 'api-01', name: 'api-01', role: 'api', ip: '10.0.1.10', az: 'az-a', subnet: 'private', status: Status.HEALTHY },
  { id: 'api-02', name: 'api-02', role: 'api', ip: '10.0.2.10', az: 'az-b', subnet: 'private', status: Status.HEALTHY },
  { id: 'api-03', name: 'api-03', role: 'api', ip: '10.0.1.11', az: 'az-a', subnet: 'private', status: Status.HEALTHY },
  // Workers
  { id: 'worker-01', name: 'worker-01', role: 'worker', ip: '10.0.1.20', az: 'az-a', subnet: 'private', status: Status.HEALTHY },
  { id: 'worker-02', name: 'worker-02', role: 'worker', ip: '10.0.2.20', az: 'az-b', subnet: 'private', status: Status.HEALTHY },
  { id: 'worker-03', name: 'worker-03', role: 'worker', ip: '10.0.1.21', az: 'az-a', subnet: 'private', status: Status.HEALTHY },
  { id: 'worker-04', name: 'worker-04', role: 'worker', ip: '10.0.2.21', az: 'az-b', subnet: 'private', status: Status.HEALTHY },
  // Cache / messaging
  { id: 'redis-01', name: 'redis-01', role: 'cache', ip: '10.0.1.30', az: 'az-a', subnet: 'private', status: Status.HEALTHY },
  { id: 'redis-02', name: 'redis-02', role: 'cache', ip: '10.0.2.30', az: 'az-b', subnet: 'private', status: Status.HEALTHY },
  // Monitoring
  { id: 'monitor-01', name: 'monitor-01', role: 'monitoring', ip: '10.0.1.40', az: 'az-a', subnet: 'private', status: Status.HEALTHY },
  { id: 'logging-01', name: 'logging-01', role: 'monitoring', ip: '10.0.2.40', az: 'az-b', subnet: 'private', status: Status.HEALTHY },
]

export const connections = [
  { id: 'conn-eks', from: 'az-a', to: 'az-b', service: 'EKS Cluster', color: '#00bfa5', type: 'cluster' },
  { id: 'conn-msk', from: 'az-a', to: 'az-b', service: 'MSK Replication', color: '#e65100', type: 'streaming' },
  { id: 'conn-alb', from: 'az-a', to: 'az-b', service: 'ALB', color: '#43a047', type: 'loadbalancer' },
]

export const managedServices = [
  { id: 'efs-main', name: 'EFS', type: 'storage', az: 'az-a', status: Status.HEALTHY },
  { id: 'kms-main', name: 'KMS', type: 'security', az: 'az-a', status: Status.HEALTHY },
  { id: 'alb-prod', name: 'Prod ALB', type: 'loadbalancer', az: 'az-a', status: Status.HEALTHY },
  { id: 'acm-cert', name: 'TLS Cert', type: 'security', az: 'az-a', status: Status.HEALTHY },
]

// AWS Architecture Icon color convention
export const categoryColors = {
  ec2:       { dark: '#3d2200', bright: '#ff9900' },
  eks:       { dark: '#1a3333', bright: '#00bfa5' },
  rds:       { dark: '#2a1a3d', bright: '#9b59b6' },
  msk:       { dark: '#3d1a00', bright: '#e65100' },
  efs:       { dark: '#1a2233', bright: '#3f51b5' },
  security:  { dark: '#2d1a1a', bright: '#e53935' },
  network:   { dark: '#1a2d1a', bright: '#43a047' },
}

export const roleCategory = {
  vpn: 'ec2',
  api: 'ec2',
  worker: 'ec2',
  cache: 'ec2',
  monitoring: 'ec2',
  eks: 'eks',
  rds: 'rds',
  msk: 'msk',
  managed: 'efs',
}

export const roleColors = {
  vpn: '#ff9900',
  api: '#ff9900',
  worker: '#ff9900',
  cache: '#ff9900',
  monitoring: '#ff9900',
  eks: '#00bfa5',
  rds: '#9b59b6',
  msk: '#e65100',
  managed: '#3f51b5',
}
