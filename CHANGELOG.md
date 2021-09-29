# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- add parameter `insuranceFundArg` to `initialize` of Exchange 
### Removed
- remove parameter `insuranceFundArg` from `initialize` of ClearingHouse 
- remove event `PositionChanged` from ClearingHouse
### Changed
- move event `PositionChanged` to Exchange## [0.9.4] - 2021-09-28
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

- fix `Vault` is missing from `@perp/lushan/artifacts/contracts`

## [0.1.0] - 2021-07-23

### Added

- add `Vault` contract

### Changed

- move `ClearingHouse.deposit` to `Vault.deposit`
- move `ClearingHouse.withdraw` to `Vault.withdraw`
- move `ClearingHouse.getFreeCollateral` to `Vault.getFreeCollateral`
