// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { Collateral } from "../lib/Collateral.sol";

abstract contract CollateralManagerStorageV1 {
    // key: token address, value: collateral config
    mapping(address => Collateral.Config) internal _collateralConfigMap;

    address internal _clearingHouseConfig;

    address internal _vault;

    uint8 internal _maxCollateralTokensPerAccount;

    uint24 internal _mmRatioBuffer;

    uint24 internal _debtNonSettlementTokenValueRatio;

    uint24 internal _liquidationRatio;

    uint24 internal _clInsuranceFundFeeRatio;

    uint256 internal _debtThreshold;

    uint256 internal _collateralValueDust;
}

abstract contract CollateralManagerStorageV2 is CollateralManagerStorageV1 {
    // key: trader address, value: whitelisted debt threshold
    mapping(address => uint256) internal _whitelistedDebtThresholdMap;

    uint256 internal _totalWhitelistedDebtThreshold;
}
