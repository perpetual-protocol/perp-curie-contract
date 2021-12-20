# Deployment

1. Add required network settings or external addresses to `hardhat.config.ts`

```ts
const config: HardhatUserConfig = {
    networks: {
        hardhat: {
            allowUnlimitedContractSize: true,
        },
        arbitrumRinkeby: {
            chainId: ChainId.ARBITRUM_RINKEBY_CHAIN_ID,
            url: ARBITRUM_RINKEBY_WEB3_ENDPOINT,
            accounts: {
                mnemonic: ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC,
            },
        },
    },
    namedAccounts: {
        gnosisSafeAddress: {
            [ChainId.ARBITRUM_RINKEBY_CHAIN_ID]: "0x123",
        },
        ethUsdChainlinkAggregator: {
            [ChainId.ARBITRUM_RINKEBY_CHAIN_ID]: "0x456",
        },
    },
}
```

2. Deploy contracts

```bash
export ARBITRUM_RINKEBY_WEB3_ENDPOINT="YOUR_RPC_ENDPOINT"
export ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC="YOUR_MNEMONIC"

# deploy and WILL NOT reuse any existing contracts
npm run clean-deploy:arbitrumRinkeby
# deploy and WILL reuse existing contracts
npm run deploy:arbitrumRinkeby

# only run the specific deployment script
npm run deploy:arbitrumRinkeby -- --tags ClearingHouse
```

3. **Manually execute transactions if you see the following message during deploying**

```bash
---------------------------------------------------------------------------------------
No signer for MULTISIG_WALLET_ADDRESS
Please execute the following:

from: MULTISIG_WALLET_ADDRESS
to: PROXYADMIN_ADDRESS
method: upgrade
args:
  - PROXY_ADDRESS
  - NEW_IMPLEMENTATION_ADDRESS

(raw data: 0xabc123456789)
---------------------------------------------------------------------------------------
```

4. Update CHANGELOG.md

5. Update `version` of `package.json` and `package-lock.json`

6. Verify contracts on Tenderly
   - apply `access_key` from Tenderly settings
      - the access token on the Tenderly dashboard, under Settings -> Authorization.
   - create a `config.yaml` file at `$HOME/.tenderly/config.yaml` and add an access_key field to it:
        ```yaml
        access_key: super_secret_access_key
        ```
   - run `export OPTIMISM_KOVAN_WEB3_ENDPOINT=YOUR_OPTIMISM_KOVAN_WEB3_ENDPOINT`
   - run `npm run tenderly:optimismKovan -- [--contract contractName]`

7. Verify contracts on Etherscan
   - run `export ETHERSCAN_API_KEY=YOUR_ETHERSCAN_API_KEY`
   - run `npm run etherscan:optimismKovan -- [--contract contractName]`

8. Verify what's included in the packed npm package

```bash
npm pack
```

9. Publish npm package

```bash
# push tag to trigger "Publish NPM package" workflow
git tag vX.X.X
git push origin --tags

# create GitHub release
gh release create vX.X.X -t "vX.X.X" -F CHANGELOG.md
```
