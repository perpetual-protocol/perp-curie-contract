# lushan

## Usage

TODO

## Deployment

1. deploy contracts

```bash
$ npm run deploy-staging
```

2. update CHANGELOG.md

3. update `version` of `package.json` and `package-lock.json`

4. publish npm package

```bash
# push tag to trigger "Publish NPM package" workflow
$ git tag vX.X.X
$ git push origin --tags

# create GitHub release
$ gh release create vX.X.X -t "vX.X.X" -F CHANGELOG.md
```
