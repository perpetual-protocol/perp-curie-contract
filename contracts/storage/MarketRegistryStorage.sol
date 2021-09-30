// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

abstract contract MarketRegistryStorageV1 {
    address public uniswapV3Factory;
    address public quoteToken;
    address public clearingHouse;
    uint8 public maxOrdersPerMarket;

    // key: baseToken, value: pool
    mapping(address => address) internal _poolMap;

    // key: baseToken, what insurance fund get = exchangeFee * insuranceFundFeeRatio
    mapping(address => uint24) internal _insuranceFundFeeRatioMap;

    // key: baseToken , uniswap fee will be ignored and use the exchangeFeeRatio instead
    mapping(address => uint24) internal _exchangeFeeRatioMap;

    // key: baseToken, _uniswapFeeRatioMap cache only
    mapping(address => uint24) internal _uniswapFeeRatioMap;
}
