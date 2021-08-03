# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
