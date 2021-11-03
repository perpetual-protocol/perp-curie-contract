# lushan

## Local development and testing

### Requirements

You should have Node 12 installed. Use [nvm](https://github.com/nvm-sh/nvm) to install it.

### Get started

Clone this repository, install NodeJS dependencies, and build the source code:

```bash
git clone git@github.com:perpetual-protocol/perp-lushan.git
npm i
npm run build
```

Since there are some runtime environment dependencies, if the installation failed on your machine, please try a vanilla install instead:

```bash
npm run clean
rm -rf node_modules/
rm package-lock.json
npm install
npm run build
```

### Testing

To run all the test cases:

```bash
npm run test
```

## Deployment

1. Deploy contracts

```bash
export ARBITRUM_RINKEBY_WEB3_ENDPOINT="YOUR_RPC_ENDPOINT"
export ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC="YOUR_MNEMONIC"

# deploy and WILL NOT reuse any existing contracts
npm run clean-deploy:arbitrumRinkeby
# deploy and WILL reuse existing contracts
npm run deploy:arbitrumRinkeby

# only run the specific deployment script
npm run deploy:arbitrumRinkeby -- --tags ClearingHouse

# transfer owners to gnosisSafeAddress
npm run transferOwner:arbitrumRinkeby
```

2. Update CHANGELOG.md

3. Update `version` of `package.json` and `package-lock.json`

4. Verify contracts on Tenderly
   - apply `access_key` from Tenderly settings
      - the access token on the Tenderly dashboard, under Settings -> Authorization.
   - create a `config.yaml` file at `$HOME/.tenderly/config.yaml` and add an access_key field to it:
        ```yaml
        access_key: super_secret_access_key
        ```
   - run `export RINKEBY_WEB3_ENDPOINT=YOUR_RPC_ENDPOINT`
   - run `npm run verify-tenderly:rinkeby`

5. Verify what's included in the packed npm package

```bash
npm pack
```

6. Publish npm package

```bash
# push tag to trigger "Publish NPM package" workflow
git tag vX.X.X
git push origin --tags

# create GitHub release
gh release create vX.X.X -t "vX.X.X" -F CHANGELOG.md
```
