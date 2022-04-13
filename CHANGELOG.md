# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [unreleased]

## [1.1.0] - 2022-04-12
- Add `BaseToken.pause()` (only owner)
- Add `BaseToken.close(uint256)` (only owner)
- Add `IBaseToken.close()`
- Add `IBaseToken.getPausedTimestamp()`
- Add `IBaseToken.getPausedIndexPrice()`
- Add `IBaseToken.getClosedPrice()`
- Add `IBaseToken.isOpen()`
- Add `IBaseToken.isPaused()`
- Add `IBaseToken.isClosed()`
- Add `IVault.depositFor(address, address, uint256)`
- Add `IClearingHouse.quitMarket(address, address)`
- Add new event `PositionClosed` to `ClearingHouse`, will emit in `quitMarket(address, address)`

## [1.0.15] - 2022-02-09

### Changed
- emit `PositionChanged` event in `cancelExcessOrders` and `cancelAllExcessOrders`

## [1.0.14] - 2022-01-28

### Added
- Add `IClearingHouse.liquidate(address, address, uint)` to liquidate with slippage protection.
- 
## [1.0.13] - 2022-01-21
### Deploy
- Deploy `SOL` market to optimism

## [1.0.12] - 2022-01-20
### Deploy
- Deploy `LUNA` market to optimism

## [1.0.11] - 2022-01-18
### Deploy
- Deploy `AVAX` market to optimism

## [1.0.10] - 2022-01-17
### Changed
- Add _backstopLiquidityProviderMap in ClearingHouseConfigStorageV2. It's for only configured backstopLiquidityProvider can liquidate the trader's position who has bad debt.

### Deploy
- Upgrade AccountBalance, ClearingHouse, ClearingHouseConfig, Exchange, Vault

## [1.0.9] - 2022-01-14

### Changed
- Revert swap if _maxTickCrossedWithinBlockMap[baseToken] is 0

### Deploy
- Upgrade Exchange on **Optimism**

## [1.0.9-staging] - 2022-01-13

- Upgrade Exchange for zero tick crossing

## [1.0.8] - 2022-01-12

Code is same as `v1.0.8-staging`.

### Deploy
- Upgrade ClearingHouse on **Optimism**

## [1.0.8-staging] - 2022-01-11

### Fixed
- revert when reducing position with bad debt

### Deploy
- Upgrade ClearingHouse on **Optimism Kovan**

## [1.0.7] - 2022-01-06

### Deploy
- Upgrade vBTC and vETH on **Optimism**

## [1.0.7-staging] - 2022-01-05

### Added
- add `BaseToken.setPriceFeed()` to set address of price feed.

### Deploy
- Upgrade vBTC and vETH on **Optimism Kovan**

## [1.0.6] - 2022-01-05

- Only includes new deployments on **Optimism Kovan** compared with `1.0.5`.

## [1.0.6-staging] - 2022-01-04

- Clean deploy all contracts on **Optimism Kovan** except external contracts (DefaultProxyAdmin, USDC, UniswapV3Factory). Note that the contract proxy addresses has been changed. Can find all contract addresses in `./metadata/optimismKovan.json`.

## [1.0.5] - 2022-01-03

### Added
- Deploy `AVAXUSDBandPriceFeed` on **Optimism**.
- Deploy `LUNAUSDBandPriceFeed` on **Optimism**.
- Deploy `SOLUSDBandPriceFeed` on **Optimism**.

## [1.0.4] - 2021-12-23

- Add fluctuation limit on `exchange.swap`

## [1.0.3] - 2021-12-10

- Fix permission check in `setttleFunding` and `updateFundingGrowthAndLiquidityCoefficientInFundingPayment`

## [1.0.3-staging] - 2021-12-10

- Fix permission check in `setttleFunding` and `updateFundingGrowthAndLiquidityCoefficientInFundingPayment`

## [1.0.1] - 2021-11-25

- Code is the same as `1.0.0`, but it's a clean deploy to Optimism Mainnet.
- Contract source code is also included.

## [1.0.0] - 2021-11-24

- Code is the same as `1.0.0-staging`, but it's a clean deploy to Optimism Mainnet.

## [1.0.0-staging] - 2021-11-24

- Code is the same as `0.15.1-staging`, but it's a clean deploy to Optimism Kovan and Arbitrum Rinkeby.

## [0.15.1-staging] - 2021-11-23

- No public change in this version.

## [0.15.0-staging] - 2021-11-22

### Changed
- rename `ClearingHouse.settleAllFundingAndPendingFee` to `ClearingHouse.settleAllFunding`
- rename `AccountBalance.addTakerBalances` to `AccountBalance.modifyTakerBalance`
- rename params of `AccountBalance.modifyTakerBalance`
    1. `deltaTakerBase` to `base`
    2. `deltaTakerQuote` to `quote`
- rename params of `AccountBalance.settleBalanceAndDeregister`
    1. `deltaTakerBase` to `takerBase`
    2. `deltaTakerQuote` to `takerQuote`
- rename `AccountBalance.addOwedRealizedPnl` to `AccountBalance.modifyOwedRealizedPnl`
- rename param `delta` of `AccountBalance.modifyOwedRealizedPnl` as `amount`
- rename the param `sqrtPriceAfter` in the `ClearingHouse.PositionChanged` event to `sqrtPriceAfterX96`
- rename error codes in `ClearingHouse`
    1. `CH_NEO` to `CH_CLWTISO`
    2. `CH_PSC` to `CH_PSCF`
    3. `CH_ANC` to `CH_ENC`
    4. `CH_ANC` to `CH_TFNC`
- rename params of `ClearingHouse.openPosition`
    1. `deltaBase` to `base`
    2. `deltaQuote` to `quote`
- rename params of `ClearingHouse.closePosition`
    1. `deltaBase` to `base`
    2. `deltaQuote` to `quote`
- rename error code in `Exchange`: `EX_ANC` to `EX_BNC`
- rename params in struct `Exchange.SwapResponse`
    1. `deltaAvailableBase` to `base`
    2. `deltaAvailableQuote` to `quote`
- rename params in struct `Exchange.RealizePnlParams`
    1. `deltaAvailableBase` to `base`
    2. `deltaAvailableQuote` to `quote`
- rename `OrderBook.getOwedFee` as `OrderBook.getPendingFee`
- rename params in struct `OrderBook.RemoveLiquidityResponse`
    1. `deltaTakerBase` to `takerBase`
    2. `deltaTakerQuote` to `takerQuote`
- rename params of `OrderBook.updateOrderDebt`
    1. `deltaBaseDebt` to `base`
    2. `deltaQuoteDebt` to `quote`
- rename params in struct `AccountMarket.Info`
    1. `takerBaseBalance` to `takerPositionSize`
    2. `takerQuoteBalance` to `takerOpenNotional`
- rename error codes in `Vault`
    1. `V_ANC` to `V_CHNC`
    2. `V_ANC` to `V_TFNC`

- move event `FundingPaymentSettled` to ClearingHouse

### Added
- add a new parameter `insuranceFundArg` to `initialize` of ClearingHouse
- add a new parameter `orderBookArg` to `initialize` of AccountBalance

### Removed

- remove `AccountBalance.getNetQuoteBalanceAndPendingFee`
- remove parameter `exchangeArg` from `initialize` of AccountBalance
- remove parameter `insuranceFundArg` from `initialize` of Exchange
- remove `Exchange.getTick`
- remove `Exchange.getFundingGrowthGlobalAndTwaps`
- remove `OrderBook.getFeeGrowthGlobal`

## [0.14.0-staging] - 2021-11-17

### Added

- add `OrderBook.getTotalQuoteBalance()`
- add `OrderBook.getTotalOrderDebt()`
- add `OrderBook.getMakerBalance()`
- add `Clearinghouse.settleAllFundingAndPendingFee()`
### Changed

- move `PositionChanged` event from `Exchange` to `ClearingHouse`
- move `Exchange.getTotalOpenNotional` to `AccountBalance.getTotalOpenNotional`
- move `Exchange.getTakerOpenNotional` to `AccountBalance.getTakerOpenNotional`

- rename `OrderBook.getTotalTokenAmountInPool` to `OrderBook.getTotalTokenAmountInPoolAndPendingFee`
- rename `AccountBalance.getOwedAndUnrealizedPnl` to `AccountBalance.getPnlAndPendingFee`
- rename `AccountBalance.getNetQuoteBalance` to `AccountBalance.getNetQuoteBalanceAndPendingFee`
- rename `AccountBalance.settleQuoteToPnl` to `AccountBalance.settleQuoteToOwedRealizedPnl`

- add new second return value `pendingFee` of `AccountBalance.getOwedAndUnrealizedPnl`
- add new second return value `pendingFee` of `AccountBalance.getNetQuoteBalance`
- add new second return value `totalPendingFee` of `OrderBook.getTotalQuoteBalance`
- add new second return value `totalPendingFee` of `OrderBook.getTotalTokenAmountInPool`

### Removed

- remove `AccountBalance.getTakerQuote`

## [0.13.3-staging] - 2021-11-11

### Changed

- rename `useTakerPosition` to `useTakerBalance` in `ClearingHouse.AddLiquidityParams`

## [0.13.2-staging] - 2021-11-11

### Changed
- update artifacts

## [0.13.1-staging] - 2021-11-11

### Added

- add `optimismKovan.json` and `rinkeby.json` of `v0.12.7`

## [0.13.0-staging] - 2021-11-10

### Changed

- use the new NPM package name: `@perp/curie-contract`
- rename `AccountBalance.getLiquidateMarginRequirement` to `AccountBalance.getMarginRequirementForLiquidation`
- rename `Vault.balanceOf` to `Vault.getBalance`
- rename `AccountBalance.getPositionSize` to `AccountBalance.getTotalPositionSize`
- rename `AccountBalance.getPositionValue` to `AccountBalance.getTotalPositionValue`
- rename `Exchange.getOpenNotional` to `Exchange.getTotalOpenNotional`
- fix error codes in `Exchange`
    1. `EX_OPIBS` to `EX_OPLBS`
    2. `EX_OPIAS` to `EX_OPLAS`
- add field `useTakerPosition` to `ClearingHouse.AddLiquidityParams`
- move event `LiquidityChanged` from `OrderBook` to `ClearingHouse`

### Added

- add `AccountBalance.getTakerQuote()` to get taker's quote balance
- add `Exchange.getTakerOpenNotional()` to get taker's open notional
- add `ClearingHouseConfig.getMaxFundingRate()` and `ClearingHouseConfig.setMaxFundingRate()`
- add `MarketRegistry.hasPool()`
- add event `MaxFundingRateChanged` to `ClearingHouseConfig`
- add event `TrustedForwarderChanged` to `ClearingHouse`
- add event `TakerBalancesChanged` to `AccountBalance`
- add event `MaxTickCrossedWithinBlockChanged` to `Exchange`
- add event `AccountBalanceChanged` to `Exchange`
- add event `BorrowerChanged` to `InsuranceFund`

### Removed

- remove state `_versionRecipient` from `ClearingHouse` and `Vault`
- remove `Quoter` and `Multicall2` contracts from core.
    - You can find these contracts in [@perp/curie-periphery-contract](https://www.npmjs.com/package/@perp/curie-periphery-contract).

## [0.12.7] - 2021-11-09

- deploy on Optimism Kovan

## [0.12.6] - 2021-10-25

- bug fixes
  - rounding error at `ClearingHouse.closePosition()` and `Vault.withdraw()`

## [0.12.5] - 2021-10-22

- deploy 0.12.4 on Rinkeby

## [0.12.4] - 2021-10-21

### Changed

- changed the returned value of `ClearingHouse.getAccountValue` to 18 decimals

## [0.11.1] - 2021-10-08

### Added

- add `AccountBalance.getTotalAbsPositionValue()`

## [0.11.0] - 2021-10-08

### Added

- add `ClearingHouseConfig.getSettlementTokenBalanceCap()`
- add a new parameter `insuranceFundArg` to `initialize` of Exchange
- add a new event `SettlementTokenBalanceCapChanged` to ClearingHouseConfig
- add a new field `sqrtPriceAfter` to `PositionChanged` of Exchange

### Removed

- remove parameter `insuranceFundArg` from `initialize` of ClearingHouse
- remove event `PositionChanged` from ClearingHouse
- remove `getTotalAbsPositionValue` from `AccountBalance`
- remove parameter `marketRegistryArg` from `initialize` of AccountBalance

### Changed

- move event `PositionChanged` to Exchange
- combine `getTotalUnrealizedPnl` and `getOwedRealizedPnl` to `getOwedAndUnrealizedPnl`
- move `getLiquidateMarginRequirement` from `Vault` to `AccountBalance`
- rename `CleairngHouseConfig.liquidationPenaltyRatio` to `ClearingHouseConfig.getLiquidationPenaltyRatio`
- rename `CleairngHouseConfig.partialCloseRatio` to `ClearingHouseConfig.getPartialCloseRatio`
- rename `CleairngHouseConfig.twapInterval` to `ClearingHouseConfig.getTwapInterval`
- rename `CleairngHouseConfig.maxMarketsPerAccount` to `ClearingHouseConfig.getMaxMarketsPerAccount`
- rename `MarketRegistry.clearingHouse` to `MarketRegistry.getClearingHouse`
- rename `MarketRegistry.maxOrdersPerMarket` to `MarketRegistry.getMaxOrdersPerMarket`
- rename `Vault.totalDebt` to `Vault.getTotalDebt`

## [0.9.4] - 2021-09-28

### Changed

- Error messages emitted by ClearingHouse._checkSlippage()
    - `CH_TLR` to `CH_TLRS` or `CH_TLRL`, depending on the side
    - `CH_TMR` to `CH_TMRS` or `CH_TMRL`, depending on the side

## [0.9.3] - 2021-09-27

- bug fixing

## [0.9.2] - 2021-09-24

### Added

- add `AccountBalance.getBaseTokens()`
- add a new parameter `sqrtPriceX96` to `SwapResponse` of `Quoter.swap()`

## [0.9.0] - 2021-09-22

### Added

- add `ClearingHouseConfig` contract
- add `OrderBook` contract
- add `AccountBalance` contract
- add `MarketRegistry` contract

### Removed
- remove `getOwedRealizedPnlWithPendingFundingPayment` from AccountBalance
- remove `getLastUpdatedTick` from Exchange

### Changed

- `TwapIntervalChanged` now emitted by ClearingHouseConfig
- `LiquidationPenaltyRatioChanged` now emitted by ClearingHouseConfig
- `PartialCloseRatioChanged` now emitted by ClearingHouseConfig
- `ReferredPositionChanged` now emitted by ClearingHouseConfig
- `MaxMarketsPerAccountChanged` now emitted by ClearingHouseConfig
- The following function move from ClearingHouse to AccountBalance
  - `getOwedRealizedPnl`
  - `getTotalAbsPositionValue`
  - `getTotalDebtValue`
  - `getTotalUnrealizedPnl`
  - `getNetQuoteBalance`
  - `getPositionSize`
  - `getPositionValue`
- `getOpenNotional` moved to Exchange
- `setMaxTickCrossedWithinBlock` and `getMaxTickCrossedWithinBlock` moved to Exchange
- `getPendingFundingPayment` and `getAllPendingFundingPayment` moved to Exchange

## [0.5.3] - 2021-09-03

### Removed

- remove `twapIntervalArg` from `ClearinHouse.getPositionValue()`

## [0.5.2] - 2021-09-02

### Added

- add `Exchange` contract
- add `BaseToken` contract
- add `MetaTxGateway` contract

### Changed

- Set `ClearingHouse.setMaxMarketsPerAccount(10)`
- Set `Exchange.setMaxOrdersPerMarket(100)`
- Set `Exchange.setFeeRatio(baseToken, 1000)` (0.1%) for all BaseTokens
- Set `Exchange.setInsuranceFundFeeRatio(baseToken, 100000)` (10%) for all BaseTokens
- `PoolAdded` now emitted by `Exchange`
- `LiquidityChanged` now emitted by Exchange
- `Swapped` is renamed to `PositionChanged` and still emitted by `ClearingHouse`
    - event parameters also changed

```solidity
event PositionChanged(
    address indexed trader,
    address indexed baseToken,
    int256 exchangedPositionSize,
    int256 exchangedPositionNotional,
    uint256 fee,
    int256 openNotional,
    int256 realizedPnl
);
```

- `GlobalFundingGrowthUpdated` is renamed to `FundingUpdated` and still emitted by `ClearingHouse`
    - event parameters also changed

```solidity
event FundingUpdated(
    address indexed baseToken,
    uint256 markTwap,
    uint256 indexTwap
);
```

- `FundingSettled` is renamed to `FundingPaymentSettled` and still emitted by `ClearingHouse`
- QuoteToken inherits from `VirtualToken` contract
- All BaseTokens inherit from `BaseToken` contract

## [0.4.2] - 2021-08-24

### Added

- add `ClearingHouse.getTotalInitialMarginRequirement()`

## [0.4.0] - 2021-08-23

### Added

- add new global arguments to `ClearingHouse`:
    - `ClearingHouse.setMaxOrdersPerMarket()`
    - `ClearingHouse.setMaxMarketsPerAccount()`
    - `ClearingHouse.setPartialCloseRatio()`
    - `ClearingHouse.setLiquidationPenaltyRatio()`
    - `ClearingHouse.setTwapInterval()`
- add new market-specific arguments to `ClearingHouse`:
    - `ClearingHouse.setFeeRatio()`
    - `ClearingHouse.setInsuranceFundFeeRatio()`
    - `ClearingHouse.setMaxTickCrossedWithinBlock()`

### Changed

- replace hourly-based funding with block-based funding
- replace `cancelExcessOrders(maker, baseToken)` with `cancelAllExcessOrders(maker, baseToken)` and `cancelExcessOrders(maker, baseToken, orderIds)`
    - now `cancelAllExcessOrders()` will not automatically remove all liquidity

### Removed

- remove `ClearingHouse.updateFunding()`
- remove `fundingPayment` and `badDebt` from `Swapped` event

## [0.3.3] - 2021-08-13

### Fixed

- fix how realizedPnl and openNotional calculate for maker/taker

### Added

- add whitelist feature for `VirtualToken`
- add `Quoter` contract

## [0.2.0] - 2021-08-04

### Changed

- rename `ClearingHouse.getTotalMarketPnl` to `ClearingHouse.getTotalUnrealizedPnl`
- fix `Vault.getFreeCollateral` wrong numbers

## [0.1.5] - 2021-08-03

### Added

- add `InsuranceFund` contract
- add `ClearingHouse.getBuyingPower()`
- add `ClearingHouse.liquidate()`

### Changed

- change the interface of `ClearingHouse.addLiquidity()` and `ClearingHouse.removeLiquidity()`
    - support slippage protection

### Fixed

- fix `ClearingHouse.swap()`
    - fix `TransferHelper::SafeTransfer: Transfer Failed` when opening a short position
- fix `ClearingHouse.getAccountValue()`

## [0.1.4] - 2021-07-29

### Changed

- re-deployed all contracts

## [0.1.3] - 2021-07-28

### Changed

- implemented quote-only fee
- changed event parameters of `FundingRateUpdated`, `FundingSettled`, and `Swapped`:

```solidity
event FundingRateUpdated(address indexed baseToken, int256 rate, uint256 underlyingPrice);

event FundingSettled(
    address indexed trader,
    address indexed baseToken,
    uint256 nextPremiumFractionIndex,
    int256 amount
);

event Swapped(
    address indexed trader,
    address indexed baseToken,
    int256 exchangedPositionSize,
    int256 exchangedPositionNotional,
    uint256 fee,
    int256 settledFundingPayment,
    uint256 badDebt
);
```

## [0.1.1] - 2021-07-26

### Fixed

- fix `Vault` is missing from `@perp/curie-contract/artifacts/contracts`

## [0.1.0] - 2021-07-23

### Added

- add `Vault` contract

### Changed

- move `ClearingHouse.deposit` to `Vault.deposit`
- move `ClearingHouse.withdraw` to `Vault.withdraw`
- move `ClearingHouse.getFreeCollateral` to `Vault.getFreeCollateral`
