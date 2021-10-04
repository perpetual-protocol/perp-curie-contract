// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

interface IMarketRegistry {
    //
    // STRUCT
    //
    struct MarketInfo {
        address pool;
        uint24 exchangeFeeRatio;
        uint24 uniswapFeeRatio;
        uint24 insuranceFundFeeRatio;
    }

    //
    // EVENT
    //
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);
    event ClearingHouseChanged(address indexed clearingHouse);
    event FeeRatioChanged(address baseToken, uint24 feeRatio);
    event InsuranceFundFeeRatioChanged(uint24 feeRatio);
    event MaxOrdersPerMarketChanged(uint8 maxOrdersPerMarket);

    //
    // FUNCTION
    //

    function addPool(address baseToken, uint24 feeRatio) external returns (address);

    function setClearingHouse(address clearingHouseArg) external;

    function setFeeRatio(address baseToken, uint24 feeRatio) external;

    function setInsuranceFundFeeRatio(address baseToken, uint24 insuranceFundFeeRatioArg) external;

    function setMaxOrdersPerMarket(uint8 maxOrdersPerMarketArg) external;

    //
    // EXTERNAL VIEW
    //
    function getPool(address baseToken) external view returns (address);

    function getFeeRatio(address baseToken) external view returns (uint24);

    function getInsuranceFundFeeRatio(address baseToken) external view returns (uint24);

    function getMarketInfo(address baseToken) external view returns (MarketInfo memory);

    function getClearingHouse() external view returns (address);

    function getMaxOrdersPerMarket() external view returns (uint8);
}
