[![banner](https://user-images.githubusercontent.com/105896/160323402-1e5854cb-e6cf-4c0a-9479-e4303c642720.png)](https://perp.com/)

# perp-curie-contract

[![@perp/curie-contract on npm](https://img.shields.io/npm/v/@perp/curie-contract?style=flat-square)](https://www.npmjs.com/package/@perp/curie-contract)
[![@perp/curie-deployments on npm](https://img.shields.io/npm/v/@perp/curie-deployments?style=flat-square)](https://www.npmjs.com/package/@perp/curie-deployments)

This repository contains the core smart contracts for [Perpetual Protocol Curie (v2)](https://perp.com/).

Contract source code and metadata are also published as npm packages:

- [@perp/curie-contract](https://www.npmjs.com/package/@perp/curie-contract) (source code)
- [@perp/curie-deployments](https://www.npmjs.com/package/@perp/curie-deployments) (artifacts and deployed addresses)

## Get Started

Please check out:

- [Perpetual Protocol v2 Smart Contract Documentation](https://docs.perp.com/)
- [Perpetual Protocol v2 User Docs](https://support.perp.com//)

## Deployments

Perpetual Protocol Curie (v2) are deployed on Optimism mainnet (an Ethereum Layer 2 network).

Contract addresses:

- https://metadata.perp.exchange/v2/optimism.json (Optimism mainnet)
- https://metadata.perp.exchange/v2/optimism-goerli.json (Optimism Goerli testnet)

You could also find the deployed contract addresses inside the npm package [@perp/curie-deployments](https://www.npmjs.com/package/@perp/curie-deployments).

## Local Development

You need Node.js 16+ to build. Use [nvm](https://github.com/nvm-sh/nvm) to install it.

Clone this repository, install Node.js dependencies, and build the source code:

```bash
git clone git@github.com:perpetual-protocol/perp-curie-contract.git
npm i
npm run build
```

If the installation failed on your machine, please try a vanilla install instead:

```bash
npm run clean
rm -rf node_modules/
rm package-lock.json
npm install
npm run build
```

Run all the test cases:

```bash
npm run test
```

## Changelog

See [CHANGELOG](https://github.com/perpetual-protocol/perp-curie-contract/blob/main/CHANGELOG.md).

## Audit Reports

See [audits](https://github.com/perpetual-protocol/perp-curie-contract/tree/main/audits).

## Bug Bounty Program

This repository is subject to the Perpetual Protocol v2 bug bounty program, [per the terms defined on ImmuneFi](https://immunefi.com/bounty/perpetual/).

## Grant Program

Projects, ideas and events that benefit Perpetual Protocol and its ecosystem are eligible for [grants](https://perp.com/grants)!

## Related Projects

- [perp-oracle-contract](https://github.com/perpetual-protocol/perp-oracle-contract)
- [perp-curie-periphery-contract](https://github.com/perpetual-protocol/perp-curie-periphery-contract)
- [perp-curie-subgraph](https://github.com/perpetual-protocol/perp-curie-subgraph)


---

> If any features/functionalities described in the Perpetual Protocol documentation, code comments, marketing, community discussion or announcements, pre-production or testing code, or other non-production-code sources, vary or differ from the code used in production, in case of any dispute, the code used in production shall prevail.

