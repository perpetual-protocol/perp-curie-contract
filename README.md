# lushan

## Usage

TODO

## Deployment

1. Deploy contracts

```bash
export ARBITRUM_RINKEBY_WEB3_ENDPOINT="YOUR_RPC_ENDPOINT"
export ARBITRUM_RINKEBY_DEPLOYER_MNEMONIC="YOUR_MNEMONIC"

npm run clean-deploy:staging

# only run the specific deployment script
npm run deploy:staging -- --tags Pool-vETHvUSD
```

2. Update CHANGELOG.md

3. Update `version` of `package.json` and `package-lock.json`

4. **Verify what's included in the packaged npm package**

```bash
npm pack
```

5. Publish npm package

```bash
# push tag to trigger "Publish NPM package" workflow
git tag vX.X.X
git push origin --tags

# create GitHub release
gh release create vX.X.X -t "vX.X.X" -F CHANGELOG.md
```
