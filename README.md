# perp-curie

[![@perp/curie-contract on npm](https://img.shields.io/npm/v/@perp/curie-contract?style=flat-square)](https://www.npmjs.com/package/@perp/curie-contract)
[![@perp/curie-deployments on npm](https://img.shields.io/npm/v/@perp/curie-deployments?style=flat-square)](https://www.npmjs.com/package/@perp/curie-deployments)

This repository contains the core smart contracts for [Perpetual Protocol Curie (v2)](https://perp.com/).

Contract source code and metadata are also published as npm packages:

- [@perp/curie-contract](https://www.npmjs.com/package/@perp/curie-contract) (source code)
- [@perp/curie-deployments](https://www.npmjs.com/package/@perp/curie-deployments) (artifacts and deployed addresses)

## Get Started

Please check out:

- [Perpetual Protocol v2 Smart Contract Documentation](https://perpetual-protocol.github.io/lushan-docs/docs/Contracts/ClearingHouse)
- [Perpetual Protocol v2 Docs](https://v2docs.perp.fi/)

## Deployments

Perpetual Protocol Curie (v2) are deployed on Optimism mainnet (an Ethereum Layer 2 network).

Contract addresses:

- https://metadata.perp.exchange/v2/optimism.json (Optimism mainnet)
- https://metadata.perp.exchange/v2/optimism-kovan.json (Optimism Kovan testnet)

You could also find the deployed contract addresses inside the npm package [@perp/curie-deployments](https://www.npmjs.com/package/@perp/curie-deployments).

## Local Development

You need Node.js 16+ to build. Use [nvm](https://github.com/nvm-sh/nvm) to install it.

Clone this repository, install Node.js dependencies, and build the source code:

```bash
git clone git@github.com:perpetual-protocol/perp-curie.git
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

## Audit Reports

- Trail of Bits (2022/03)
- Dedaub (2022/03)
- HashCloak (2021/11)
- ConsenSys (2021/10)
- ABDK (2021/09)

## Bug Bounty Program

This repository is subject to the Perpetual Protocol v2 bug bounty program, [per the terms defined on ImmuneFi](https://immunefi.com/bounty/perpetual/).

## Grant Program

Projects, ideas and events that benefit Perpetual Protocol and its ecosystem are eligible for [grants](https://perp.com/grants)!

## Related Projects

- [perp-oracle](https://github.com/perpetual-protocol/perp-oracle)
- [perp-curie-periphery](https://github.com/perpetual-protocol/perp-curie-periphery)
- [perp-curie-subgraph](https://github.com/perpetual-protocol/perp-curie-subgraph)
