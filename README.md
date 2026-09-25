# PG Escrow

PG Escrow is a prototype rental platform for paying rent and settling security-deposit disputes with a shared, on-chain escrow. Tenants and property owners can manage listings and tenancies, record move-in and move-out evidence, and follow a documented dispute process. The project combines a web app and API with Solidity contracts and an AI-assisted adjudication service.

The goal is to make the deposit process easier to inspect: neither party can move the escrowed deposit alone, and a dispute can be decided against submitted evidence and a published rubric. The adjudicator's signed result can then be settled by the escrow contract. This is a prototype; use the local chain and test configuration for evaluation.

## What’s included

- **Web app:** Next.js and React interface for listings, accounts, tenancy workflows, wallet, audit records, and the dispute rubric.
- **API:** Hono-based TypeScript API for application workflows, persistence, chain interaction, and evidence storage.
- **Escrow contracts:** Solidity `PGEscrow` contract and `MockINRC` token, developed and tested with Hardhat.
- **Adjudication:** AI-assisted dispute review with Gemini as the default provider, optional Anthropic configuration, and a clearly identified scripted fallback for rehearsals.
- **Evidence and audit:** Evidence framing and commitments, settlement logic, and stored decision/audit details.
- **Demo:** End-to-end local scenario showing the deposit-dispute lifecycle.

## Repository layout

```text
apps/
  api/          Hono API and server
  demo/         End-to-end local demo
  web/          Next.js web application
packages/
  contracts/    Solidity contracts and Hardhat tests
  core/         Shared domain and settlement logic
  db/           Database schema and persistence
  evidence/     Evidence framing and commitments
  judge/        Adjudication providers, rubric, and evaluations
scripts/        Local app runner
infra/          Deployment/security infrastructure
```

## Tech stack

- TypeScript, Node.js 20 or later, npm workspaces
- Next.js 16, React 19
- Hono, Drizzle ORM, libSQL
- Solidity, Hardhat, OpenZeppelin, viem
- Gemini or Anthropic for optional live adjudication
- AWS KMS and S3 options for deployed wallet-key protection and evidence storage

## Getting started

### Requirements

- Node.js 20+
- npm

### Install and configure

Clone the repository and install its workspace dependencies:

```bash
git clone https://github.com/psg-19/PG_Escrow.git
cd PG_Escrow
npm install
```

Create a local environment file from the example:

```bash
cp .env.example .env
```

The example configuration targets a local development chain and local development storage. The adjudicator can run in scripted mode without a provider key; set `GEMINI_API_KEY` to enable the Gemini provider. Google sign-in is optional and requires `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Review `.env.example` before configuring any hosted services. Do not commit real credentials or use the documented local development keys on a public chain.

### Run the end-to-end demo

```bash
npm run demo
```

The demo starts its own local chain, deploys the contracts, and runs a sample deposit-dispute scenario. It uses a scripted adjudicator when no live provider is configured.

### Run the web app and API

In one terminal, start the local Hardhat node:

```bash
npm run chain
```

In a second terminal, deploy the local contracts and record their addresses:

```bash
npm run deploy
```

In a third terminal, start the API and web app together:

```bash
npm run app
```

Open [http://localhost:3000](http://localhost:3000). The API listens on port `4000`; the web app proxies its `/api/*` requests to the API. Seed sample activity with `npm run demo` when needed.
