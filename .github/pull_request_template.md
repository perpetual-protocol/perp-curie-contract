## PR Checklist
### Naming 
- [ ] Adjective first.
```javascript
✅ uint minBase = 1;  
❌ uint baseMin = 1;
```
- [ ] Abbreviation should follow the camel case rule.
```javascript
uint twapPrice = 1;
uint fakeAmm = 1;
```
- [ ] Use `_` prefix for every `private` or `internal` state and function.
- [ ] Acceptable suffix: [`Addr`, `Token`, `Pool`, `Local`, `Arg`].
- [ ] Prevent from using suffix: [`Param`, `Amount`, `Map`, `List`]
  

### Policies
- [ ] Always `throw exceptions` when something unexpected happened during the execution. DO NOT return a error code like 0 or -1.
- [ ] `Map` and `Array` should always be private. Set `state` or `function` to `private` if not sure.
- [ ] If using external contracts, following their contract name. For example, `uniswapV3`.
- [ ] Import should specify contract names, like `import { SafeMath } from "./SafeMath.sol";`.

### Source Files
- [ ] Use `singular` naming, DO NOT use the plural.


### Test
- [ ] `spec` extension name for `unitest`. `test` extension name for `integration test`.
- [ ] Add `UT` for unit test in the describe, and add `# function name` to indicate which is the function your are testing.
- [ ] Add `force error`, to indicate the exception.