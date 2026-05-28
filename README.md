# aws3d

3D visualization of your AWS infrastructure. Walk through your cloud like a data center.

![React Three Fiber](https://img.shields.io/badge/R3F-Three.js-blue) ![AWS SDK v3](https://img.shields.io/badge/AWS_SDK-v3-orange)

## What is this?

A browser-based 3D data center that renders your live AWS environment:

- **AZs** → Cages/rooms with wireframe walls
- **EC2 instances** → 1U servers in racks with blinking status LEDs
- **EKS clusters** → Teal racks; click a node to see cross-AZ connections
- **RDS databases** → Purple managed-service slabs with glow-strip health indicators
- **MSK brokers** → Orange slabs showing replication links across AZs
- **Multi-AZ connections** → Click any multi-AZ resource to see 90° routed interconnect lines

Navigate with WASD + mouse like a first-person game.

## Quickstart

```bash
git clone <this-repo>
cd aws3d
npm install
```

### 1. Start the local proxy

The proxy runs on your machine and uses your local AWS credentials. Nothing leaves localhost.

```bash
# Option A: Use environment variables (e.g., after assuming a role)
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...
npm run serve -- --region us-east-1

# Option B: Use a named profile from ~/.aws/config
npm run serve -- --profile my-profile --region us-west-2

# Option C: Use whatever AWS_PROFILE is set
export AWS_PROFILE=production
npm run serve
```

The proxy binds to `127.0.0.1:9876` — it only accepts connections from localhost.

### 2. Start the frontend

In a separate terminal:

```bash
npm run dev
```

Open http://localhost:5173. The UI auto-detects the proxy and shows a green **● Live** badge when connected.

If the proxy isn't running, the app shows sample data in demo mode.

## Controls

| Key | Action |
|-----|--------|
| Click canvas | Enter FPS mode |
| W/A/S/D | Move forward/left/back/right |
| Mouse | Look around |
| Q/E | Move down/up |
| Shift | Sprint |
| ESC | Release cursor |
| Click server | Pin selection, show interconnects |
| Click floor | Clear selection |

## Architecture

```
Browser (localhost:5173)          Local Proxy (127.0.0.1:9876)
┌─────────────────────┐          ┌──────────────────────────┐
│  React + R3F        │  fetch   │  Node.js + AWS SDK v3    │
│  3D Scene           │ ───────► │  Uses YOUR credentials   │
│  No credentials     │          │  Calls AWS APIs directly │
└─────────────────────┘          └──────────┬───────────────┘
                                            │
                                            ▼
                                   AWS APIs (EC2, EKS, RDS, MSK)
```

**Security model:**
- Credentials never leave your machine
- Proxy binds to `127.0.0.1` only
- CORS restricted to localhost origins
- No backend server, no data exfiltration
- Frontend is a static SPA — can be served from a CDN

## Project Structure

```
src/
├── data/
│   ├── infrastructure.js   ← Sample/fallback data model
│   └── fetchStatus.js      ← Auto-detects proxy, polls for live data
├── components/
│   ├── DataCenter.jsx      ← Scene layout (cages, racks, interconnects)
│   ├── Cage.jsx            ← AZ enclosure
│   ├── Rack.jsx            ← Server cabinet (splits at 12 units, max 10 wide)
│   ├── ServerBox.jsx       ← EC2 instance (orange chassis, blinking LEDs)
│   ├── ManagedServiceBox.jsx ← Managed service (colored slab, glow strip)
│   ├── Interconnect.jsx    ← 90° routed cross-AZ connection lines
│   ├── WASDControls.jsx    ← FPS camera movement
│   └── HUD.jsx             ← 2D overlay (connection status, server info)
├── App.jsx
└── main.jsx
server/
└── proxy.js                ← Local AWS API proxy
bin/
└── aws3d.js                ← CLI entry point
```

## AWS Permissions Required

The proxy calls these APIs (read-only):

- `ec2:DescribeInstances`
- `ec2:DescribeInstanceStatus`
- `eks:ListClusters`
- `eks:DescribeCluster`
- `rds:DescribeDBInstances`
- `kafka:ListClustersV2`

## Global Install (optional)

```bash
npm link
aws3d serve --profile my-profile --region us-east-1
```

## License

MIT
