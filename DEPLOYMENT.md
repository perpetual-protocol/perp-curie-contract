# Deployment

1. Verify what's included in the packed npm package

```bash
npm pack
```

2. Publish npm package

```bash
# push tag to trigger "Publish NPM package" workflow
git tag vX.X.X
git push origin --tags

# create GitHub release
gh release create vX.X.X -t "vX.X.X" -F CHANGELOG.md
```
