// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

/// @notice For future upgrades, do not change MarketRegistryStorageV1. Create a new
/// contract which implements MarketRegistryStorageV1 and following the naming convention
/// MarketRegistryStorageVX.
abstract contract MarketRegistryStorageV1 {
    address internal _uniswapV3Factory;
    address internal _quoteToken;

    uint8 internal _maxOrdersPerMarket;

    // key: baseToken, value: pool
    mapping(address => address) internal _poolMap;

    // key: baseToken, what insurance fund get = exchangeFee * insuranceFundFeeRatio
    mapping(address => uint24) internal _insuranceFundFeeRatioMap;

    // key: baseToken , uniswap fee will be ignored and use the exchangeFeeRatio instead
    mapping(address => uint24) internal _exchangeFeeRatioMap;

    // key: baseToken, _uniswapFeeRatioMap cache only
    mapping(address => uint24) internal _uniswapFeeRatioMap;
}

abstract contract MarketRegistryStorageV2 is MarketRegistryStorageV1 {
    // key: base token
    // value: the max price spread ratio of the market
    mapping(address => uint24) internal _marketMaxPriceSpreadRatioMap;
}

abstract contract MarketRegistryStorageV3 is MarketRegistryStorageV2 {
    // key: trader
    // value: discount ratio (percent-off)
    mapping(address => uint24) internal _feeDiscountRatioMap;
}

abstract contract MarketRegistryStorageV4 is MarketRegistryStorageV3 {
    mapping(address => bool) internal _feeManagerMap;
}
