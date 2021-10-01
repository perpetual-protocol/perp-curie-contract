// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IMarketRegistryStorageV1 } from "../interface/IMarketRegistryStorage.sol";

abstract contract MarketRegistryStorageV1 is IMarketRegistryStorageV1 {
    address internal uniswapV3Factory;
    address internal quoteToken;

    /// @inheritdoc IMarketRegistryStorageV1
    address public override clearingHouse;

    /// @inheritdoc IMarketRegistryStorageV1
    uint8 public override maxOrdersPerMarket;

    // key: baseToken, value: pool
    mapping(address => address) internal _poolMap;

    // key: baseToken, what insurance fund get = exchangeFee * insuranceFundFeeRatio
    mapping(address => uint24) internal _insuranceFundFeeRatioMap;

    // key: baseToken , uniswap fee will be ignored and use the exchangeFeeRatio instead
    mapping(address => uint24) internal _exchangeFeeRatioMap;

    // key: baseToken, _uniswapFeeRatioMap cache only
    mapping(address => uint24) internal _uniswapFeeRatioMap;
}
